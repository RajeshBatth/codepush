// Scenarios 5-9, 12-14, 16-19 (+ extras): per-unit resolution, budgets, checks, fallbacks, pinning.
#include "sim.h"
using namespace sim;

namespace {
// One cabs patch in a cached manifest (not yet on disk), server serves the same manifest.
struct Fix {
  Env env;
  Patch cabs;
  ManifestSpec m;
  std::shared_ptr<MemStore> st = std::make_shared<MemStore>();
  explicit Fix(const char* name) : env(name) {
    cabs = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
    m.version = 1;
    m.units["cabs"] = {entry(cabs)};
    publish(env, m);
    seedCachedManifest(env, *st, m);
  }
};
}  // namespace

// 5. Patch ready before the entry point is tapped: loaded from the patch.
SCENARIO(patch_ready_before_tap) {
  Fix f("patch_ready");
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("ready"));
  auto r = w.open("cabs", "{\"x\":2}");
  w.advance(1);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "patch" && r->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.texts("vm."), V({"vm.createVm host=embedded", "vm.created", "vm.evaluate ota://cabs/cabs-pr1.hbc",
                                  "vm.require 100", "vm.mount cabs {\"x\":2}"}));
  CHECK_EQ(w.log.count("http.download "), 1);
  CHECK_EQ(readFile(w.builtFile("cabs-pr1")), f.cabs.built);
  CHECK(!fs::exists(f.env.cacheDir + "/codepush/11.9.0-100/cabs-pr1.patch"));
  CHECK_EQ(w.rt->pinOf("cabs"), std::string("patch:cabs-pr1"));
  w.rt->markReady("cabs");
  CHECK_EQ(w.store->attempts("cabs-pr1"), 0);
}

// 6a. Patch in flight when tapped and arriving within unitBudgetMs: the user gets the patch.
SCENARIO(inflight_patch_arrives_within_budget) {
  Fix f("inflight_within");
  f.env.server.latency[f.cabs.url] = 600;
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(200);  // VM up at 100; download completes at ~600
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("downloading"));
  auto r = w.open("cabs");
  w.advance(900);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "patch");
  int64_t tOpen = 200, tEval = w.log.timeOf("vm.evaluate ota://cabs/cabs-pr1.hbc");
  CHECK(tEval > 600 && tEval - tOpen < 1000);
  CHECK_EQ(w.log.count("vm.evaluate"), 1);
}

// 6b. Patch arrives later than the budget: embedded now, the patch is used by the NEXT VM.
SCENARIO(inflight_patch_exceeds_budget_next_vm_uses_patch) {
  Fix f("inflight_exceeds");
  f.env.server.latency[f.cabs.url] = 3000;
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(200);
  auto r = w.open("cabs");
  w.advance(900);
  CHECK(!r->done());  // still within the budget
  w.advance(200);     // budget (1000ms from t=200) expires at 1200
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.timeOf("vm.evaluate ota://cabs/embedded.hbc"), int64_t(1200));
  CHECK_EQ(w.rt->pinOf("cabs"), std::string("embedded"));
  w.advance(3000);  // download finishes in the background
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("ready"));
  CHECK_EQ(w.rt->pinOf("cabs"), std::string("embedded"));  // pin is for the VM's lifetime
  CHECK_EQ(w.log.count("vm.evaluate"), 1);
  // lifecycle manager destroys the VM; the next VM resolves from the stored patch
  w.surfaces = 0;
  w.rt->onVmDestroyed();
  auto r2 = w.open("cabs");
  w.advance(500);
  // Per-VM pin (freeze off): the next VM adopts the patch. Per-process freeze (default): the budget-expired
  // EMBEDDED outcome is frozen for the process and kept by the recreated VM; the patch waits for the next process.
  if (processPinned(w.cfg)) {
    CHECK(r2->calls == 1 && r2->r.ok && r2->r.source == "embedded");
    CHECK_EQ(w.rt->frozenOf("cabs"), std::string("embedded"));
  } else {
    CHECK(r2->calls == 1 && r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr1");
  }
}

// 7. Corrupt patch (manifest hash does not match the built result): marked bad, persisted, embedded used.
SCENARIO(corrupt_patch_hash_mismatch_is_bad_and_persisted) {
  Fix f("corrupt_patch");
  f.m.units["cabs"][0].lieAboutHash = true;
  publish(f.env, f.m);
  seedCachedManifest(f.env, *f.st, f.m);
  {
    World w(f.env, baseConfig(f.env), f.st);
    Dump dump(&w);
    w.boot(1000);
    CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("bad"));
    CHECK(f.st->bad("cabs-pr1"));
    CHECK(!fs::exists(w.builtFile("cabs-pr1")) && !fs::exists(w.builtFile("cabs-pr1") + ".tmp"));
    auto r = w.open("cabs");
    w.advance(10);
    CHECK(r->r.ok && r->r.source == "embedded");
    CHECK_EQ(w.log.countSub("cabs-pr1.hbc"), 0);  // never evaluated
    CHECK_EQ(w.store->attempts("cabs-pr1"), 0);
  }
  {  // next process: blacklisted, not downloaded again
    World w(f.env, baseConfig(f.env), f.st);
    Dump dump(&w);
    w.boot(1000);
    CHECK_EQ(w.log.count("http.download"), 0);
    auto r = w.open("cabs");
    w.advance(300);
    CHECK(r->r.ok && r->r.source == "embedded");
    CHECK(w.rt->isBlacklisted("cabs-pr1"));
  }
}

// 8. Pre-evaluate checks: wrong bytecode version, missing Hermes magic, too small, misaligned buffer.
SCENARIO(pre_evaluate_checks_reject_before_evaluate) {
  struct Case { const char* name; std::function<Bytes(Env&)> mk; bool misalign; };
  std::vector<Case> cases = {
      {"version", [](Env&) { return makeHbc(kBytecodeVersion + 1, 99); }, false},
      {"magic", [](Env&) { Bytes b = makeHbc(kBytecodeVersion, 98); b[0] ^= 0xFF; return b; }, false},
      {"js-source", [](Env&) { std::string s = "__d(function(){console.log('unverified text')},1,[]);"; return Bytes(s.begin(), s.end()); }, false},
      {"too-small", [](Env&) { return Bytes{1, 2, 3, 4, 5, 6, 7, 8}; }, false},
      {"misaligned", [](Env&) { return makeHbc(kBytecodeVersion, 97); }, true},
  };
  for (auto& c : cases) {
    Env env(std::string("pre_eval_") + c.name);
    Patch p = env.makePatch("cabs", "cabs-pr1", c.mk(env));
    ManifestSpec m; m.units["cabs"] = {entry(p)};
    publish(env, m);
    auto st = std::make_shared<MemStore>();
    seedCachedManifest(env, *st, m);
    World w(env, baseConfig(env), st);
    Dump dump(&w);
    w.fsys.shiftBuffers = c.misalign;
    w.boot(1500);
    auto r = w.open("cabs");
    w.advance(10);
    if (!(r->r.ok && r->r.source == "embedded")) std::fprintf(stderr, "case %s\n", c.name);
    CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");
    CHECK_EQ(w.log.countSub("cabs-pr1.hbc"), 0);  // rejected BEFORE evaluate
    CHECK_EQ(w.log.count("vm.evaluate"), 1);
    CHECK(st->bad("cabs-pr1"));
    CHECK_EQ(st->attempts("cabs-pr1"), 0);
    CHECK_EQ(w.log.countSub("ev.pre-evaluate-failed"), 1);
    CHECK(!fs::exists(w.builtFile("cabs-pr1")));
  }
}

// 9a. Evaluate fails for the patch: the embedded unit is evaluated instead; the patch is blacklisted.
SCENARIO(evaluate_fails_for_patch_falls_back_to_embedded) {
  Fix f("eval_fails_patch");
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.failEvalContains = {"cabs-pr1"};
  w.boot(1500);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.texts("vm.evaluate"), V({"vm.evaluate ota://cabs/cabs-pr1.hbc", "vm.evaluate ota://cabs/embedded.hbc"}));
  CHECK(f.st->bad("cabs-pr1"));
  CHECK_EQ(w.log.count("vm.mount"), 1);
}

// 9b. Evaluate fails for the embedded unit too: one error per caller, no retry loop, other units unaffected.
SCENARIO(evaluate_fails_for_embedded_reports_error_once) {
  Fix f("eval_fails_embedded");
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.failEvalContains = {"cabs"};
  w.boot(1500);
  auto r = w.open("cabs");
  w.advance(100);
  CHECK(r->calls == 1 && !r->r.ok && r->r.error.find("embedded-evaluate-failed") == 0);
  CHECK_EQ(w.log.count("vm.evaluate"), 2);  // patch, then embedded; nothing else
  auto r2 = w.open("cabs");
  w.advance(100);
  CHECK(r2->calls == 1 && !r2->r.ok);
  // Freeze off: the failed pin is final for this VM (no loop). Freeze on: a failure is never frozen, so the
  // retry re-decides (patch is blacklisted now, so: one more embedded attempt, which fails again).
  CHECK_EQ(w.log.count("vm.evaluate"), processPinned(w.cfg) ? 3 : 2);
  CHECK(w.rt->frozenOf("cabs").empty());
  CHECK_EQ(w.log.count("vm.mount"), 0);
  auto r3 = w.open("bus");
  w.advance(100);
  CHECK(r3->r.ok && r3->r.source == "embedded");
  CHECK_EQ(w.rt->pinOf("cabs"), std::string("failed"));
}

// 12. Mixed snapshots: unit A stays pinned to the old manifest's patch while unit B resolves from the new one.
SCENARIO(mixed_snapshots_per_unit_pin) {
  Env env("mixed");
  Patch a1 = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  Patch a2 = env.makePatch("cabs", "cabs-pr2", withEdits(env.units["cabs"], 12));
  Patch b1 = env.makePatch("bus", "bus-pr5", withEdits(env.units["bus"], 13));
  ManifestSpec m1; m1.version = 1; m1.ttl = 20; m1.units["cabs"] = {entry(a1)};
  publish(env, m1);
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m1);
  seedBuilt(env, *st, a1);
  World w(env, baseConfig(env), st);
  Dump dump(&w);
  w.boot(300);
  auto ra = w.open("cabs");
  w.advance(10);
  CHECK(ra->r.ok && ra->r.patchId == "cabs-pr1");
  ManifestSpec m2; m2.version = 2; m2.ttl = 20;
  m2.units["cabs"] = {entry(a2)};
  m2.units["bus"] = {entry(b1)};
  publish(env, m2);
  CHECK(w.until([&] { return w.rt->manifestVersion() == 2 && w.rt->artifactState("bus-pr5") == "ready"; }, 100000));
  auto rb = w.open("bus");
  auto ra2 = w.open("cabs");
  w.advance(100);
  CHECK(rb->r.ok && rb->r.source == "patch" && rb->r.patchId == "bus-pr5");     // from snapshot 2
  CHECK(ra2->r.ok && ra2->r.source == "patch" && ra2->r.patchId == "cabs-pr1");  // pinned from snapshot 1
  CHECK_EQ(w.log.count("vm.evaluate"), 2);
  // The next VM resolves everything from the latest snapshot.
  w.advance(1000);
  w.surfaces = 0;
  w.rt->onVmDestroyed();
  auto ra3 = w.open("cabs");
  w.advance(1000);
  CHECK(ra3->r.ok && ra3->r.patchId == "cabs-pr2");
}

// 13. A requiresHost entry is skipped (embedded) until the VM runs that host.
SCENARIO(requires_host_skipped_until_vm_runs_host) {
  Env env("requires_host");
  Patch host = env.makePatch("host", "host-pr88", withEdits(env.host, 21));
  Patch cabs = env.makePatch("cabs", "cabs-pr9", withEdits(env.units["cabs"], 19));
  ManifestSpec m; m.version = 1;
  m.host = {entry(host)};
  EntrySpec ce = entry(cabs);
  ce.requiresHost = "host-pr88";
  m.units["cabs"] = {ce};
  publish(env, m);
  env.server.latency[host.url] = 5000;  // host arrives long after the VM was prewarmed
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m);
  World w(env, baseConfig(env), st);
  Dump dump(&w);
  w.boot(1500);  // settle expires at 800 -> VM from embedded host
  CHECK_EQ(w.rt->runningHostId(), std::string("embedded"));
  CHECK_EQ(w.rt->artifactState("cabs-pr9"), std::string("ready"));  // prefetched for the host we are heading to
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");  // no wait: the entry is ineligible on this VM
  CHECK_EQ(w.log.countSub("cabs-pr9.hbc"), 0);
  w.advance(6000);  // host ready; the surface is mounted -> VM untouched
  CHECK_EQ(w.rt->artifactState("host-pr88"), std::string("ready"));
  CHECK_EQ(w.log.count("vm.destroyVm"), 0);
  w.unmountAll();   // zero-views moment -> recreate with the new host
  w.advance(500);
  CHECK_EQ(w.rt->runningHostId(), std::string("host-pr88"));
  auto r2 = w.open("cabs");
  w.advance(10);
  if (processPinned(w.cfg)) {  // frozen to embedded (requires-host-mismatch) before the host swap
    CHECK(r2->r.ok && r2->r.source == "embedded");
  } else {
    CHECK(r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr9");
  }
}

// 14. updateType "full": same applyPatch with an empty old source.
SCENARIO(full_update_type_uses_empty_old_source) {
  Env env("full_update");
  Bytes whole = makeHbc(kBytecodeVersion, 77, 5000);  // unrelated to the embedded unit
  Patch p = env.makePatch("cabs", "cabs-pr1", whole, "full");
  ManifestSpec m; m.units["cabs"] = {entry(p)};
  publish(env, m);
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m);
  World w(env, baseConfig(env), st);
  Dump dump(&w);
  w.boot(1500);
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("ready"));
  CHECK_EQ(readFile(w.builtFile("cabs-pr1")), whole);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.source == "patch");
}

// 16. Rollout changes mid-session (ramp up / halt) affect only units not yet loaded in this VM.
SCENARIO(rollout_change_affects_only_unloaded_units) {
  Env env("rollout");
  Patch a1 = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  Patch b1 = env.makePatch("bus", "bus-pr2", withEdits(env.units["bus"], 12));
  const double bc = env.bucket("cabs"), bb = env.bucket("bus");
  ManifestSpec m1; m1.version = 1; m1.ttl = 20;
  m1.units["cabs"] = {including(entry(a1), bc)};
  m1.units["bus"] = {excluding(entry(b1), bb)};  // 0% for this device
  publish(env, m1);
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m1);
  seedBuilt(env, *st, a1);
  World w(env, baseConfig(env), st);
  Dump dump(&w);
  w.boot(500);
  CHECK(w.open("cabs")->calls == 0);
  w.advance(10);
  CHECK_EQ(w.rt->pinOf("cabs"), std::string("patch:cabs-pr1"));
  // halt cabs (entry removed), ramp bus up to this device
  ManifestSpec m2; m2.version = 2; m2.ttl = 20;
  m2.units["cabs"] = {};
  m2.units["bus"] = {including(entry(b1), bb)};
  publish(env, m2);
  CHECK(w.until([&] { return w.rt->manifestVersion() == 2 && w.rt->artifactState("bus-pr2") == "ready"; }, 100000));
  CHECK(w.until([&] { return !fs::exists(w.builtFile("cabs-pr1")); }, 5000));  // built unit deleted by GC
  CHECK_EQ(w.rt->pinOf("cabs"), std::string("patch:cabs-pr1"));  // loaded unit keeps running (5.3)
  auto rb = w.open("bus");
  auto rc = w.open("cabs");
  w.advance(100);
  CHECK(rb->r.ok && rb->r.source == "patch");
  CHECK(rc->r.ok && rc->r.source == "patch" && rc->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.count("vm.destroyVm"), 0);  // halts never recreate the VM
  // new VM: the halted patch is gone
  w.surfaces = 0;
  w.rt->onVmDestroyed();
  auto rc2 = w.open("cabs");
  w.advance(500);
  CHECK(rc2->r.ok && rc2->r.source == "embedded");
}

// 17. The lazy loadUnit path has openUnit's semantics (budget, pin, fallbacks) minus the surface mount.
SCENARIO(lazy_load_unit_equals_open_unit_semantics) {
  Fix f("lazy_load");
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.rt->start();
  auto none = w.load("cabs");  // no VM yet: JS cannot be asking
  w.advance(10);
  CHECK(none->calls == 1 && !none->r.ok && none->r.error == "no-vm");
  w.rt->onFirstPageInteractive();
  w.advance(2000);
  auto r = w.load("cabs");
  w.advance(10);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "patch" && r->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.count("vm.mount"), 0);
  auto r2 = w.open("cabs");  // already pinned and loaded: mount only
  w.advance(10);
  CHECK(r2->r.ok && r2->r.source == "patch");
  CHECK_EQ(w.log.count("vm.evaluate"), 1);
  CHECK_EQ(w.log.count("vm.mount"), 1);
  auto r3 = w.load("cabs");
  w.advance(10);
  CHECK(r3->r.ok);
  CHECK_EQ(w.log.count("vm.evaluate"), 1);
  // budget semantics for a unit whose patch is still in flight
  Fix g("lazy_load_budget");
  g.env.server.latency[g.cabs.url] = 5000;
  World w2(g.env, baseConfig(g.env), g.st);
  Dump dump2(&w2);
  w2.boot(200);
  auto l = w2.load("cabs");
  w2.advance(1100);
  CHECK(l->calls == 1 && l->r.ok && l->r.source == "embedded");
}

// 18. Re-entrancy / ordering: concurrent opens of one unit evaluate it once; callbacks run once, never inline.
SCENARIO(duplicate_open_evaluates_once) {
  Fix f("dup_open");
  f.env.server.latency[f.cabs.url] = 400;
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.rt->start();
  auto a = w.open("cabs", "{\"n\":1}");  // before any VM exists
  CHECK(a->calls == 0);                  // callbacks are never invoked inside the call
  auto b = w.open("cabs", "{\"n\":2}");
  auto c = w.open("bus", "{}");
  w.advance(1500);
  CHECK(a->calls == 1 && b->calls == 1 && c->calls == 1);
  CHECK(a->r.ok && b->r.ok && c->r.ok);
  CHECK_EQ(a->r.patchId, std::string("cabs-pr1"));
  CHECK_EQ(w.log.countSub("vm.evaluate ota://cabs/"), 1);
  CHECK_EQ(w.log.count("vm.createVm"), 1);
  CHECK_EQ(w.log.texts("vm.mount"), V({"vm.mount bus {}", "vm.mount cabs {\"n\":1}", "vm.mount cabs {\"n\":2}"}));
  w.advance(1000);
  auto d = w.open("cabs");
  w.advance(10);
  CHECK(d->calls == 1);
  CHECK_EQ(w.log.countSub("vm.evaluate ota://cabs/"), 1);
}

// 19. Disk full / IO error during the build: graceful fallback, nothing persisted as bad, retry later.
SCENARIO(io_error_during_build_falls_back_then_recovers) {
  Fix f("disk_full");
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.builder.failIoTimes = 1;
  w.boot(400);
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("failed"));
  auto r = w.open("cabs");
  w.advance(10);  // failed artifact is not waited for
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.timeOf("vm.evaluate ota://cabs/embedded.hbc") < 600, true);
  CHECK(!f.st->bad("cabs-pr1"));
  CHECK(!fs::exists(w.builtFile("cabs-pr1")) && !fs::exists(w.builtFile("cabs-pr1") + ".tmp"));
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr1") == "ready"; }, 20000));  // backoff retry re-downloads and builds
  CHECK_EQ(w.log.count("http.download "), 2);
  CHECK_EQ(w.builder.calls, 2);
  w.surfaces = 0;
  w.rt->onVmDestroyed();
  auto r2 = w.open("cabs");
  w.advance(500);
  if (processPinned(w.cfg)) CHECK(r2->r.ok && r2->r.source == "embedded");  // embedded outcome frozen
  else CHECK(r2->r.ok && r2->r.source == "patch");
}

// 19b. Persistent IO failure: bounded retries, then Failed until the next manifest swap; embedded throughout.
SCENARIO(io_error_retries_are_bounded) {
  Fix f("disk_full_forever");
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.builder.failIoTimes = 1000;
  w.boot(0);
  w.advance(200000);
  CHECK_EQ(w.builder.calls, 1 + 3);  // first try + maxRetries
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("failed"));
  CHECK(!f.st->bad("cabs-pr1"));
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.source == "embedded");
}

// Extra: download failures are retried with backoff and then succeed.
SCENARIO(download_failure_retries_with_backoff) {
  Fix f("download_retry");
  f.env.server.failTimes[f.cabs.url] = 2;
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(0);
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr1") == "ready"; }, 60000));
  CHECK_EQ(w.log.count("http.download "), 3);
  auto ts = w.log.times("http.download ");
  CHECK(ts[1] - ts[0] - 100 >= 2500 && ts[1] - ts[0] - 100 <= 5000);
  CHECK(ts[2] - ts[1] - 100 >= 5000 && ts[2] - ts[1] - 100 <= 10000);
}

// Extra: cellular size cap; the artifact waits for an unmetered network.
SCENARIO(cellular_size_cap_defers_download) {
  Fix f("cellular_cap");
  f.env.server.metered = true;
  Config cfg = baseConfig(f.env);
  cfg.patchSizeCapCellular = 10;  // bytes: smaller than any patch
  World w(f.env, cfg, f.st);
  Dump dump(&w);
  w.boot(1000);
  CHECK_EQ(w.log.count("http.download"), 0);
  auto r = w.open("cabs");
  w.advance(10);  // blocked artifacts are not waited for
  CHECK(r->r.ok && r->r.source == "embedded");
  f.env.server.metered = false;
  w.rt->onNetworkChanged();
  w.advance(500);
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("ready"));
}

// Extra: prefetch order is host, then the entry-point priority list, then the rest.
SCENARIO(prefetch_order_follows_priority) {
  Env env("prefetch_order");
  Patch hp = env.makePatch("host", "host-pr1", withEdits(env.host, 21));
  Patch cp = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  Patch bp = env.makePatch("bus", "bus-pr2", withEdits(env.units["bus"], 12));
  ManifestSpec m; m.host = {entry(hp)}; m.units["cabs"] = {entry(cp)}; m.units["bus"] = {entry(bp)};
  publish(env, m);
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m);
  Config cfg = baseConfig(env);
  cfg.maxConcurrentDownloads = 1;
  World w(env, cfg, st);
  Dump dump(&w);
  w.rt->setEntryPointPriority({"bus", "cabs"});
  w.rt->start();
  w.advance(2000);
  CHECK_EQ(w.log.texts("http.download "), V({"http.download host-pr1.patch", "http.download bus-pr2.patch", "http.download cabs-pr1.patch"}));
}

// Extra: a built file tampered with on disk between sessions is caught by the once-per-process hash check.
SCENARIO(tampered_built_file_is_detected) {
  Fix f("tampered");
  Bytes evil = f.cabs.built;
  evil[100] ^= 1;  // same size, different content
  fs::create_directories(f.env.cacheDir + "/codepush/11.9.0-100");
  writeFile(f.env.cacheDir + "/codepush/11.9.0-100/cabs-pr1.bundle", evil);
  f.st->m["built/cabs-pr1"] = std::to_string(evil.size());
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(1000);
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("bad"));
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.countSub("cabs-pr1.hbc"), 0);
}

// Extra: if the attempt counter cannot be persisted, the patch is not used (safety over freshness).
SCENARIO(attempt_persist_failure_uses_embedded) {
  Fix f("attempt_persist");
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  f.st->failPut = [](const std::string& k) { return k.compare(0, 9, "attempts/") == 0; };
  w.boot(1500);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.countSub("cabs-pr1.hbc"), 0);
  CHECK(!f.st->bad("cabs-pr1"));  // not the patch's fault
}
