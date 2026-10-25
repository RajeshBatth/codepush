// Per-process selection freeze (README "Per-process selection freeze"): a unit's selection is decided once per
// process, survives VM recreation, and is dropped only by the safety exceptions when a NEW VM is created.
#include "sim.h"
using namespace sim;

namespace {
Config cfgFor(Env& env, bool freeze = true) {
  Config c = baseConfig(env);
  c.defaultPolicy.pin = freeze ? Pin::Process : Pin::Vm;
  return c;
}

// Fix: cached manifest v1 with cabs-pr1 (and optionally bus-pr5); `ttl` 20 => the refresh timer runs at 10 s.
struct FX {
  Env env;
  Patch cabs, bus, cabs2;
  ManifestSpec m;
  std::shared_ptr<MemStore> st = std::make_shared<MemStore>();
  explicit FX(const char* name) : env(name) {
    cabs = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
    cabs2 = env.makePatch("cabs", "cabs-pr2", withEdits(env.units["cabs"], 12));
    bus = env.makePatch("bus", "bus-pr5", withEdits(env.units["bus"], 13));
    m.version = 1;
    m.ttl = 20;
    m.units["cabs"] = {entry(cabs)};
    publish(env, m);
    seedCachedManifest(env, *st, m);
  }
};

// What a lifecycle manager does: the VM goes away with no views mounted (a new one is created by the next open).
void destroyVm(World& w) {
  w.surfaces = 0;
  w.rt->onVmDestroyed();
}
bool accepted(World& w, int64_t v) { return w.until([&] { return w.rt->manifestVersion() == v; }, 100000); }
}  // namespace

// F1. Two simultaneous requests (surface open + lazy load) share ONE decision, even while the patch is in flight.
SCENARIO(freeze_two_simultaneous_opens_share_one_decision) {
  FX f("fz_simul");
  f.env.server.latency[f.cabs.url] = 600;
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(200);
  auto a = w.open("cabs", "{\"v\":1}");
  auto b = w.open("cabs", "{\"v\":2}");
  w.advance(900);
  CHECK(a->calls == 1 && a->r.ok && a->r.source == "patch" && a->r.patchId == "cabs-pr1");
  CHECK(b->calls == 1 && b->r.ok && b->r.source == "patch" && b->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.count("vm.evaluate"), 1);
  CHECK_EQ(w.log.countSub("ev.selection-frozen"), 1);
  CHECK_EQ(w.rt->frozenOf("cabs"), std::string("patch:cabs-pr1"));
  auto c = w.load("cabs");
  w.advance(10);
  CHECK(c->r.ok && c->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.count("vm.evaluate"), 1);
  CHECK_EQ(w.log.countSub("ev.selection-frozen"), 1);
}

// F2. A newer patch arrives mid-process: downloaded and built in the background, NOT adopted in this process.
// A new Runtime on the same Store (= the next process) adopts it.
SCENARIO(freeze_newer_patch_adopted_only_by_next_process) {
  FX f("fz_next_process");
  {
    World w(f.env, cfgFor(f.env), f.st);
    Dump dump(&w);
    w.boot(2000);
    auto r = w.open("cabs");
    w.advance(10);
    CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
    ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {entry(f.cabs2)};
    publish(f.env, m2);
    CHECK(accepted(w, 2));
    CHECK(w.until([&] { return w.rt->artifactState("cabs-pr2") == "ready"; }, 20000));  // prefetch follows the latest manifest
    auto r2 = w.open("cabs");  // same live VM
    auto r3 = w.load("cabs");
    w.advance(10);
    CHECK(r2->r.ok && r2->r.patchId == "cabs-pr1");
    CHECK(r3->r.ok && r3->r.patchId == "cabs-pr1");
    CHECK_EQ(w.log.countSub("cabs-pr2.hbc"), 0);
    CHECK_EQ(w.rt->frozenOf("cabs"), std::string("patch:cabs-pr1"));
  }
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.source == "patch" && r->r.patchId == "cabs-pr2");
  CHECK_EQ(w.rt->frozenOf("cabs"), std::string("patch:cabs-pr2"));
}

// F3. VM recreation inside the process keeps the frozen entry even though the manifest moved on (here: a bus
// patch and a version bump; the cabs entry is unchanged). The attempt counter is still bumped once per process.
SCENARIO(freeze_vm_recreate_keeps_unit_version) {
  FX f("fz_recreate");
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  ManifestSpec m2; m2.version = 2; m2.ttl = 20;
  m2.units["cabs"] = {entry(f.cabs)};
  m2.units["bus"] = {entry(f.bus)};
  publish(f.env, m2);
  CHECK(accepted(w, 2));
  destroyVm(w);
  auto r2 = w.open("cabs");
  auto rb = w.open("bus");
  w.advance(500);
  CHECK(r2->calls == 1 && r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.count("vm.createVm"), 2);
  CHECK_EQ(w.log.count("vm.evaluate ota://cabs/cabs-pr1.hbc"), 2);
  CHECK_EQ(w.log.countSub("ev.selection-reused cabs cabs-pr1"), 1);
  CHECK_EQ(w.log.countSub("ev.selection-frozen cabs"), 1);  // announced once
  CHECK_EQ(f.st->attempts("cabs-pr1"), 1);
  CHECK(rb->r.ok && rb->r.source == "patch" && rb->r.patchId == "bus-pr5");  // first request of bus: latest manifest
}

// F3b. Host swap (patched host arrives, no views mounted): the recreated VM loads the same unit version.
SCENARIO(freeze_host_swap_keeps_unit_version) {
  FX f("fz_host_swap");
  Patch host = f.env.makePatch("host", "host-pr88", withEdits(f.env.host, 21));
  f.m.host = {entry(host)};
  publish(f.env, f.m);
  seedCachedManifest(f.env, *f.st, f.m);
  f.env.server.latency[host.url] = 3000;
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(1500);  // settle expires: embedded-host VM
  CHECK_EQ(w.rt->runningHostId(), std::string("embedded"));
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  w.unmountAll();  // no views: the host swap may recreate as soon as the host patch is ready
  w.advance(4000);
  CHECK_EQ(w.rt->runningHostId(), std::string("host-pr88"));
  CHECK_EQ(w.log.count("vm.destroyVm"), 1);
  auto r2 = w.open("cabs");
  w.advance(10);
  CHECK(r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.count("vm.evaluate ota://cabs/cabs-pr1.hbc"), 2);
}

// F4. Halt: the entry disappears from the manifest. The live VM is untouched; the NEXT VM drops the freeze
// and the normal selection (latest manifest) runs: embedded.
SCENARIO(freeze_halt_drops_freeze_at_next_vm) {
  FX f("fz_halt");
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {};
  publish(f.env, m2);
  CHECK(accepted(w, 2));
  w.advance(100);
  auto live = w.load("cabs");  // live VM: never changes
  w.advance(10);
  CHECK(live->r.ok && live->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.countSub("ev.selection-dropped"), 0);
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "embedded");
  CHECK_EQ(w.log.countSub("ev.selection-dropped cabs cabs-pr1 removed-from-manifest"), 1);
  CHECK_EQ(w.rt->frozenOf("cabs"), std::string("embedded"));
  CHECK_EQ(w.log.count("vm.evaluate ota://cabs/cabs-pr1.hbc"), 1);
}

// F4b. Superseded (newer entry replaced the old one, the old file is garbage-collected): the next VM drops the
// freeze and adopts the newer patch.
SCENARIO(freeze_superseded_entry_dropped_at_next_vm) {
  FX f("fz_superseded");
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {entry(f.cabs2)};
  publish(f.env, m2);
  CHECK(accepted(w, 2));
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr2") == "ready"; }, 20000));
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr2");
  CHECK_EQ(w.log.countSub("ev.selection-dropped cabs cabs-pr1 removed-from-manifest"), 1);
  CHECK_EQ(w.rt->frozenOf("cabs"), std::string("patch:cabs-pr2"));
}

// F4c. The device left the entry's range (ramp lowered): dropped at the next VM.
SCENARIO(freeze_range_excluded_dropped_at_next_vm) {
  FX f("fz_range");
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  ManifestSpec m2; m2.version = 2; m2.ttl = 20;
  m2.units["cabs"] = {excluding(entry(f.cabs), f.env.bucket("cabs"))};
  publish(f.env, m2);
  CHECK(accepted(w, 2));
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "embedded");
  CHECK_EQ(w.log.countSub("ev.selection-dropped cabs cabs-pr1 no-range-match"), 1);
}

// F5. Blacklist: the frozen file fails the pre-evaluate checks in a later VM => persistent bad, freeze dropped,
// normal selection (blacklisted => embedded). A missing file is dropped without blame.
SCENARIO(freeze_blacklist_drops_freeze_at_next_vm) {
  FX f("fz_blacklist");
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  writeFile(w.builtFile("cabs-pr1"), Bytes(10, 7));  // corrupt behind the runtime's back
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "embedded");
  CHECK(w.rt->isBlacklisted("cabs-pr1") && f.st->bad("cabs-pr1"));
  CHECK_EQ(w.log.countSub("ev.selection-dropped cabs cabs-pr1 pre-evaluate-failed:size-mismatch"), 1);
  CHECK_EQ(w.log.count("vm.evaluate ota://cabs/cabs-pr1.hbc"), 1);
  CHECK_EQ(w.rt->frozenOf("cabs"), std::string("embedded"));
}
SCENARIO(freeze_missing_file_drops_freeze_without_blame) {
  FX f("fz_missing");
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  fs::remove(w.builtFile("cabs-pr1"));
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "embedded");
  CHECK(!f.st->bad("cabs-pr1"));
  CHECK_EQ(w.log.countSub("ev.selection-dropped cabs cabs-pr1"), 1);
}

// F5b. A frozen patch that fails to evaluate in the recreated VM: blacklisted, freeze moves to embedded.
SCENARIO(freeze_evaluate_failure_in_new_vm_drops_freeze) {
  FX f("fz_eval_fail");
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  w.failEvalContains = {"cabs-pr1"};
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "embedded");
  CHECK(f.st->bad("cabs-pr1"));
  CHECK_EQ(w.log.countSub("ev.selection-dropped cabs cabs-pr1 evaluate-failed"), 1);
  CHECK_EQ(w.rt->frozenOf("cabs"), std::string("embedded"));
}

// F6. A freeze to EMBEDDED is kept like any other: a patch that shows up later waits for the next process.
SCENARIO(freeze_embedded_kept) {
  FX f("fz_embedded");
  ManifestSpec empty; empty.version = 1; empty.ttl = 20;
  publish(f.env, empty);
  seedCachedManifest(f.env, *f.st, empty);
  {
    World w(f.env, cfgFor(f.env), f.st);
    Dump dump(&w);
    w.boot(500);
    auto r = w.open("cabs");
    w.advance(10);
    CHECK(r->r.ok && r->r.source == "embedded");
    CHECK_EQ(w.rt->frozenOf("cabs"), std::string("embedded"));
    CHECK_EQ(w.log.countSub("ev.selection-frozen cabs  embedded:unit-not-in-manifest"), 1);
    ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {entry(f.cabs)};
    publish(f.env, m2);
    CHECK(accepted(w, 2));
    CHECK(w.until([&] { return w.rt->artifactState("cabs-pr1") == "ready"; }, 20000));
    destroyVm(w);
    auto r2 = w.open("cabs");
    w.advance(500);
    CHECK(r2->r.ok && r2->r.source == "embedded");
    CHECK_EQ(w.log.countSub("ev.selection-reused cabs  embedded"), 1);
    CHECK_EQ(w.log.countSub("ev.selection-dropped"), 0);
  }
  World w(f.env, cfgFor(f.env), f.st);  // next process
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.source == "patch" && r->r.patchId == "cabs-pr1");
}

// F7. A failed resolution (embedded also failed) is NOT frozen: the retry re-decides, even inside the same VM.
SCENARIO(freeze_failure_is_not_frozen) {
  FX f("fz_failure");
  ManifestSpec empty; empty.version = 1; empty.ttl = 20;
  publish(f.env, empty);
  seedCachedManifest(f.env, *f.st, empty);
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.failEvalContains = {"cabs"};
  w.boot(500);
  auto r = w.open("cabs");
  w.advance(50);
  CHECK(r->calls == 1 && !r->r.ok);
  CHECK(w.rt->frozenOf("cabs").empty());
  CHECK_EQ(w.log.countSub("ev.selection-frozen"), 0);
  w.failEvalContains.clear();
  auto r2 = w.open("cabs");
  w.advance(50);
  CHECK(r2->calls == 1 && r2->r.ok && r2->r.source == "embedded");
  CHECK_EQ(w.rt->frozenOf("cabs"), std::string("embedded"));
  CHECK_EQ(w.log.countSub("ev.selection-frozen"), 1);
}

// F8. Flag off == the old per-VM pin: a recreated VM re-resolves from the latest manifest, no freeze events.
SCENARIO(freeze_flag_off_is_per_vm_pin) {
  FX f("fz_off");
  World w(f.env, cfgFor(f.env, false), f.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {entry(f.cabs2)};
  publish(f.env, m2);
  CHECK(accepted(w, 2));
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr2") == "ready"; }, 20000));
  auto live = w.load("cabs");
  w.advance(10);
  CHECK(live->r.ok && live->r.patchId == "cabs-pr1");  // per-VM pin still holds inside the VM
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr2");
  CHECK(w.rt->frozenOf("cabs").empty());
  CHECK_EQ(w.log.countSub("scope=process"), 0);  // pin=vm: only vm-scope announcements
}

// F9. unitPolicy pin=Vm: the unit keeps the per-VM pin while the other unit is frozen.
SCENARIO(freeze_exempt_unit_repins_per_vm) {
  FX f("fz_exempt");
  f.m.units["bus"] = {entry(f.bus)};
  publish(f.env, f.m);
  seedCachedManifest(f.env, *f.st, f.m);
  f.env.server.latency[f.cabs.url] = 3000;  // both patches miss the 1 s budget => both start on embedded
  f.env.server.latency[f.bus.url] = 3000;
  Config c = cfgFor(f.env);
  c.unitPolicy["cabs"].pin = Pin::Vm;
  World w(f.env, c, f.st);
  Dump dump(&w);
  w.boot(200);
  auto a = w.open("cabs");
  auto b = w.open("bus");
  w.advance(1100);
  CHECK(a->r.ok && a->r.source == "embedded");
  CHECK(b->r.ok && b->r.source == "embedded");
  CHECK(w.rt->frozenOf("cabs").empty());
  CHECK_EQ(w.rt->frozenOf("bus"), std::string("embedded"));
  w.advance(4000);
  destroyVm(w);
  auto a2 = w.open("cabs");
  auto b2 = w.open("bus");
  w.advance(500);
  CHECK(a2->r.ok && a2->r.source == "patch" && a2->r.patchId == "cabs-pr1");
  CHECK(b2->r.ok && b2->r.source == "embedded");
}

// F10. Observer events: kind, unit, id, detail.
SCENARIO(freeze_observer_events) {
  FX f("fz_events");
  World w(f.env, cfgFor(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  w.open("cabs");
  w.advance(10);
  CHECK(w.log.texts("ev.selection-frozen") == V({"ev.selection-frozen cabs cabs-pr1 patch:ok scope=process"}));
  destroyVm(w);
  w.open("cabs");
  w.advance(500);
  CHECK(w.log.texts("ev.selection-reused") == V({"ev.selection-reused cabs cabs-pr1 patch scope=process"}));
  ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {};
  publish(f.env, m2);
  CHECK(accepted(w, 2));
  destroyVm(w);
  w.open("cabs");
  w.advance(500);
  CHECK(w.log.texts("ev.selection-dropped") == V({"ev.selection-dropped cabs cabs-pr1 removed-from-manifest scope=process"}));
  CHECK(w.log.texts("ev.selection-frozen") ==
        V({"ev.selection-frozen cabs cabs-pr1 patch:ok scope=process", "ev.selection-frozen cabs  embedded:no-range-match scope=process"}));
}

// F11. Determinism: the same event sequence yields an identical call log (two independent worlds).
SCENARIO(freeze_deterministic_call_log) {
  std::string logs[2];
  for (int i = 0; i < 2; i++) {
    FX f(i == 0 ? "fz_det_a" : "fz_det_b");
    World w(f.env, cfgFor(f.env), f.st);
    w.boot(2000);
    w.open("cabs");
    w.advance(10);
    ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {entry(f.cabs2)};
    publish(f.env, m2);
    w.until([&] { return w.rt->artifactState("cabs-pr2") == "ready"; }, 20000);
    destroyVm(w);
    w.open("cabs");
    w.load("cabs");
    w.advance(500);
    destroyVm(w);
    w.open("cabs");
    w.advance(500);
    logs[i] = w.log.dump();
  }
  CHECK(!logs[0].empty());
  CHECK(logs[0] == logs[1]);
  CHECK(logs[0].find("selection-dropped") != std::string::npos);
}
