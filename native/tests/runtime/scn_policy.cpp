// Per-unit policy (README "Unit policy"): pin scope (vm default | process), loadBudgetMs, fetch (eager | lazy), presets.
#include "sim.h"
using namespace sim;

namespace {
// Cached manifest v1 (ttl 20 => refresh timer at 10 s) with cabs-pr1 and bus-pr5; v2 patches are built for the tests.
struct PX {
  Env env;
  Patch cabs, cabs2, bus, bus2;
  ManifestSpec m;
  std::shared_ptr<MemStore> st = std::make_shared<MemStore>();
  explicit PX(const char* name) : env(name) {
    cabs = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
    cabs2 = env.makePatch("cabs", "cabs-pr2", withEdits(env.units["cabs"], 12));
    bus = env.makePatch("bus", "bus-pr5", withEdits(env.units["bus"], 13));
    bus2 = env.makePatch("bus", "bus-pr6", withEdits(env.units["bus"], 14));
    m.version = 1;
    m.ttl = 20;
    m.units["cabs"] = {entry(cabs)};
    m.units["bus"] = {entry(bus)};
    publish(env, m);
    seedCachedManifest(env, *st, m);
  }
  void publishV2(World& w, bool cabsToo = true, bool busToo = true) {
    ManifestSpec m2;
    m2.version = 2; m2.ttl = 20;
    m2.units["cabs"] = {cabsToo ? entry(cabs2) : entry(cabs)};
    m2.units["bus"] = {busToo ? entry(bus2) : entry(bus)};
    publish(env, m2);
    CHECK(w.until([&] { return w.rt->manifestVersion() == 2; }, 100000));
  }
};
void destroyVm(World& w) {
  w.surfaces = 0;
  w.rt->onVmDestroyed();
}
}  // namespace

// P1. Default (pin=vm): inside a VM a newer patch is not adopted; a RECREATED VM adopts it, so one process changes
// version across VMs. Nothing is memoized (frozenOf empty).
SCENARIO(policy_default_vm_pin_new_vm_adopts_newer_patch) {
  PX x("pol_vm_adopt");
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();  // library defaults, whatever RT_PIN says
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  x.publishV2(w);
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr2") == "ready"; }, 20000));
  auto live = w.load("cabs");
  w.advance(10);
  CHECK(live->r.ok && live->r.patchId == "cabs-pr1");  // same VM: pinned
  CHECK_EQ(w.log.countSub("cabs-pr2.hbc"), 0);
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr2");  // new VM, same process
  CHECK(w.rt->frozenOf("cabs").empty());
  CHECK_EQ(w.log.count("vm.createVm"), 2);
}

// P2. Default pin=vm: a halted entry (and a blacklisted one) is simply not selected by the next VM.
SCENARIO(policy_default_vm_pin_new_vm_drops_halted_patch) {
  PX x("pol_vm_halt");
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.patchId == "cabs-pr1");
  ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {}; m2.units["bus"] = {entry(x.bus)};
  publish(x.env, m2);
  CHECK(w.until([&] { return w.rt->manifestVersion() == 2; }, 100000));
  auto live = w.load("cabs");
  w.advance(10);
  CHECK(live->r.ok && live->r.patchId == "cabs-pr1");  // live VM untouched
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "embedded");
  CHECK(w.rt->frozenOf("cabs").empty());
}

// P3. Mixed policies in one process: cabs (process) keeps its version across a VM recreate, bus (vm) adopts the newer one.
SCENARIO(policy_mixed_process_and_vm_pins) {
  PX x("pol_mixed");
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitPolicy["cabs"] = UnitPolicy::stable();
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(2000);
  auto a = w.open("cabs");
  auto b = w.open("bus");
  w.advance(10);
  CHECK(a->r.ok && a->r.patchId == "cabs-pr1");
  CHECK(b->r.ok && b->r.patchId == "bus-pr5");
  x.publishV2(w, false, true);  // cabs entry unchanged (a superseded entry would drop the process pin: freeze_superseded_*)
  CHECK(w.until([&] { return w.rt->artifactState("bus-pr6") == "ready"; }, 30000));
  destroyVm(w);
  auto a2 = w.open("cabs");
  auto b2 = w.open("bus");
  w.advance(500);
  CHECK(a2->r.ok && a2->r.source == "patch" && a2->r.patchId == "cabs-pr1");
  CHECK(b2->r.ok && b2->r.source == "patch" && b2->r.patchId == "bus-pr6");
  CHECK_EQ(w.rt->frozenOf("cabs"), std::string("patch:cabs-pr1"));
  CHECK(w.rt->frozenOf("bus").empty());
  CHECK_EQ(w.log.countSub("ev.selection-reused cabs cabs-pr1"), 1);
  CHECK_EQ(w.log.countSub("ev.selection-reused bus"), 0);
}

// P4. latency-first (loadBudgetMs 0): the patch is still downloading when the unit is requested => embedded at once
// (no timer wait), the download continues and the NEXT VM uses the patch.
SCENARIO(policy_latency_first_never_waits) {
  PX x("pol_latency");
  x.env.server.latency[x.cabs.url] = 3000;
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitPolicy["cabs"] = UnitPolicy::latencyFirst();
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(300);
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("downloading"));
  const Millis t0 = w.sim.now_;
  auto r = w.open("cabs");
  w.advance(1);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.timeOf("vm.evaluate ota://cabs/embedded.hbc"), int64_t(t0));  // elapsed 0: no wait
  CHECK_EQ(w.log.countSub("ev.budget-exceeded cabs  no-wait"), 1);
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr1") == "ready"; }, 20000));  // background work carried on
  CHECK_EQ(w.rt->pinOf("cabs"), std::string("embedded"));  // fixed for this VM
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr1");
}

// P5. latency-first still uses a patch that is already built, immediately.
SCENARIO(policy_latency_first_uses_built_patch) {
  PX x("pol_latency_built");
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy::latencyFirst();
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.source == "patch" && r->r.patchId == "cabs-pr1");
  CHECK_EQ(w.log.countSub("ev.budget-exceeded"), 0);
}

// P6. freshness-first: waits up to its budget and gets a patch that lands within it; the default budget would have lost it.
SCENARIO(policy_freshness_first_waits_for_the_patch) {
  PX x("pol_fresh");
  x.env.server.latency[x.cabs.url] = 2500;
  x.env.server.latency[x.bus.url] = 2500;
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitPolicy["cabs"] = UnitPolicy::freshnessFirst(4000);
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(300);
  const Millis t0 = w.sim.now_;
  auto a = w.open("cabs");
  auto b = w.open("bus");  // default budget (1000 ms)
  w.advance(4000);
  CHECK(a->calls == 1 && a->r.ok && a->r.source == "patch" && a->r.patchId == "cabs-pr1");
  CHECK(b->calls == 1 && b->r.ok && b->r.source == "embedded");
  const int64_t te = w.log.timeOf("vm.evaluate ota://cabs/cabs-pr1.hbc");
  CHECK(te > t0 + 1000 && te < t0 + 4000);
}

// P7. A per-unit budget overrides the global one, and defaultPolicy.loadBudgetMs overrides Config::unitBudgetMs.
SCENARIO(policy_per_unit_budget_overrides_global) {
  PX x("pol_budget");
  x.env.server.latency[x.cabs.url] = 1500;
  x.env.server.latency[x.bus.url] = 1500;
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitBudgetMs = 500;
  c.unitPolicy["bus"].loadBudgetMs = 3000;  // only this field is overridden; pin etc. fall through to the default
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(300);
  auto a = w.open("cabs");
  auto b = w.open("bus");
  w.advance(3000);
  CHECK(a->r.ok && a->r.source == "embedded");
  CHECK(b->r.ok && b->r.source == "patch" && b->r.patchId == "bus-pr5");
  CHECK(w.log.timeOf("ev.budget-exceeded cabs") >= 0);
  CHECK_EQ(w.log.countSub("ev.budget-exceeded bus"), 0);

  PX y("pol_budget2");
  y.env.server.latency[y.cabs.url] = 1500;
  Config c2 = baseConfig(y.env);
  c2.defaultPolicy = UnitPolicy();
  c2.unitBudgetMs = 500;
  c2.defaultPolicy.loadBudgetMs = 3000;  // beats the global tunable
  World w2(y.env, c2, y.st);
  w2.boot(300);
  auto r = w2.open("cabs");
  w2.advance(3000);
  CHECK(r->r.ok && r->r.source == "patch");
}

// P8. Presets.
SCENARIO(policy_presets) {
  UnitPolicy l = UnitPolicy::latencyFirst();
  CHECK(l.pin && *l.pin == Pin::Vm);
  CHECK(l.loadBudgetMs && *l.loadBudgetMs == 0);
  CHECK(l.fetch && *l.fetch == Fetch::Eager);
  UnitPolicy f = UnitPolicy::freshnessFirst(2500);
  CHECK(f.pin && *f.pin == Pin::Vm);
  CHECK(f.loadBudgetMs && *f.loadBudgetMs == 2500);
  CHECK(f.fetch && *f.fetch == Fetch::Eager);
  UnitPolicy s = UnitPolicy::stable();
  CHECK(s.pin && *s.pin == Pin::Process);
  CHECK(!s.loadBudgetMs && !s.fetch);  // stable() only decides the lock scope
  UnitPolicy d;
  CHECK(!d.pin && !d.loadBudgetMs && !d.fetch);
}

// P9. Observer events carry the scope in their detail.
SCENARIO(policy_observer_scope_detail) {
  PX x("pol_scope");
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitPolicy["cabs"] = UnitPolicy::stable();
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(2000);
  w.open("cabs");
  w.open("bus");
  w.advance(10);
  CHECK(w.log.texts("ev.selection-frozen cabs") == V({"ev.selection-frozen cabs cabs-pr1 patch:ok scope=process"}));
  CHECK(w.log.texts("ev.selection-frozen bus") == V({"ev.selection-frozen bus bus-pr5 patch:ok scope=vm"}));
  destroyVm(w);
  w.open("cabs");
  w.open("bus");
  w.advance(500);
  CHECK(w.log.texts("ev.selection-reused") == V({"ev.selection-reused cabs cabs-pr1 patch scope=process"}));
  ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {}; m2.units["bus"] = {};
  publish(x.env, m2);
  CHECK(w.until([&] { return w.rt->manifestVersion() == 2; }, 100000));
  destroyVm(w);
  w.open("cabs");
  w.open("bus");
  w.advance(500);
  CHECK(w.log.texts("ev.selection-dropped") == V({"ev.selection-dropped cabs cabs-pr1 removed-from-manifest scope=process"}));
}

// P10. Determinism with mixed policies: the same event sequence yields an identical call log.
SCENARIO(policy_deterministic_call_log) {
  std::string logs[2];
  for (int i = 0; i < 2; i++) {
    PX x(i == 0 ? "pol_det_a" : "pol_det_b");
    x.env.server.latency[x.bus.url] = 2000;
    Config c = baseConfig(x.env);
    c.defaultPolicy = UnitPolicy();
    c.unitPolicy["cabs"] = UnitPolicy::stable();
    c.unitPolicy["bus"] = UnitPolicy::latencyFirst();
    World w(x.env, c, x.st);
    w.boot(300);
    w.open("cabs");
    w.open("bus");
    w.advance(100);
    x.publishV2(w);
    w.until([&] { return w.rt->artifactState("bus-pr6") == "ready"; }, 30000);
    destroyVm(w);
    w.open("cabs");
    w.open("bus");
    w.advance(500);
    logs[i] = w.log.dump();
  }
  CHECK(!logs[0].empty());
  CHECK(logs[0] == logs[1]);
  CHECK(logs[0].find("no-wait") != std::string::npos);
}

// P11. fetch=lazy: no prefetch download; the download starts at the first request, bounded by loadBudgetMs.
SCENARIO(policy_lazy_fetch_starts_at_first_request) {
  PX x("pol_lazy");
  x.env.server.latency[x.cabs.url] = 600;
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitPolicy["cabs"].fetch = Fetch::Lazy;
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(3000);
  CHECK_EQ(w.log.countSub("http.download cabs"), 0);
  CHECK_EQ(w.log.countSub("cabs-pr1"), 0);
  CHECK(w.log.countSub("http.download ") >= 1);  // bus (eager) was prefetched
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("unknown"));
  const Millis t0 = w.sim.now_;
  auto r = w.open("cabs");
  w.advance(1500);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "patch" && r->r.patchId == "cabs-pr1");
  const int64_t td = w.log.timeOf("download-start cabs");
  CHECK(td >= t0 && td <= t0 + 5);
}

// P12. fetch=lazy + budget too small: embedded now, the download finishes, the next VM uses the patch.
SCENARIO(policy_lazy_fetch_budget_then_next_vm) {
  PX x("pol_lazy2");
  x.env.server.latency[x.cabs.url] = 3000;
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitPolicy["cabs"].fetch = Fetch::Lazy;
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(2000);
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("unknown"));
  auto r = w.open("cabs");
  w.advance(1200);
  CHECK(r->r.ok && r->r.source == "embedded");
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr1") == "ready"; }, 20000));
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "patch" && r2->r.patchId == "cabs-pr1");
}

// P13. fetch=lazy + latency-first (budget 0): the first resolution is embedded, the request still starts the download.
SCENARIO(policy_lazy_with_zero_budget) {
  PX x("pol_lazy3");
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitPolicy["cabs"] = UnitPolicy::latencyFirst();
  c.unitPolicy["cabs"].fetch = Fetch::Lazy;
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(2000);
  auto r = w.open("cabs");
  w.advance(5);
  CHECK(r->r.ok && r->r.source == "embedded");
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr1") == "ready"; }, 20000));
  destroyVm(w);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "patch");
}

// P14. fetch=lazy: a patch already built on disk (previous session) is verified in the background, not re-downloaded.
SCENARIO(policy_lazy_fetch_uses_built_file_from_disk) {
  PX x("pol_lazy4");
  seedBuilt(x.env, *x.st, x.cabs);
  Config c = baseConfig(x.env);
  c.defaultPolicy = UnitPolicy();
  c.unitPolicy["cabs"] = UnitPolicy::latencyFirst();
  c.unitPolicy["cabs"].fetch = Fetch::Lazy;
  World w(x.env, c, x.st);
  Dump dump(&w);
  w.boot(2000);
  CHECK_EQ(w.log.countSub("http.download cabs"), 0);
  auto r = w.open("cabs");
  w.advance(5);
  CHECK(r->r.ok && r->r.source == "patch" && r->r.patchId == "cabs-pr1");
}
