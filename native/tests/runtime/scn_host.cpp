// Scenarios 10, 11: crash-loop guard (unit and host) and the host / VM lifecycle (prewarm, recreate lock).
#include "sim.h"
using namespace sim;

namespace {
struct HostFix {
  Env env;
  Patch host, cabs;
  ManifestSpec m;
  std::shared_ptr<MemStore> st = std::make_shared<MemStore>();
  explicit HostFix(const char* name, Millis hostLatency) : env(name) {
    host = env.makePatch("host", "host-pr88", withEdits(env.host, 21));
    cabs = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
    m.version = 1;
    m.host = {entry(host)};
    m.units["cabs"] = {entry(cabs)};
    publish(env, m);
    env.server.latency[host.url] = hostLatency;
    seedCachedManifest(env, *st, m);
  }
};
}  // namespace

// 10a. Unit crash loop: the patch is attempted in K=2 processes that "die" without markReady, then blacklisted.
SCENARIO(crash_loop_unit_blacklists_after_k_attempts) {
  Env env("crash_unit");
  Patch p = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  ManifestSpec m; m.units["cabs"] = {entry(p)};
  publish(env, m);
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m);
  for (int proc = 1; proc <= 2; proc++) {
    World w(env, baseConfig(env), st);  // new Runtime on the same Store = process restart
    Dump dump(&w);
    w.boot(1500);
    auto r = w.open("cabs");
    w.advance(10);
    CHECK(r->r.ok && r->r.source == "patch");
    CHECK_EQ(st->attempts("cabs-pr1"), proc);
    CHECK(!st->bad("cabs-pr1"));
    // process dies here: no markReady
  }
  World w(env, baseConfig(env), st);
  Dump dump(&w);
  w.boot(1500);
  CHECK(st->bad("cabs-pr1"));
  CHECK(w.rt->isBlacklisted("cabs-pr1"));
  CHECK_EQ(w.log.countSub("ev.blacklisted"), 1);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.countSub("cabs-pr1.hbc"), 0);
  CHECK_EQ(w.log.count("http.download"), 0);
  // a different patch id for the same unit is eligible again
  Patch p2 = env.makePatch("cabs", "cabs-pr2", withEdits(env.units["cabs"], 12));
  ManifestSpec m2; m2.version = 2; m2.ttl = 20; m2.units["cabs"] = {entry(p2)};
  publish(env, m2);
  CHECK(w.until([&] { return w.rt->artifactState("cabs-pr2") == "ready"; }, 300000));
}

// 10b. markReady confirms the patch and clears the counter: it survives any number of restarts.
SCENARIO(mark_ready_clears_attempts) {
  Env env("mark_ready");
  Patch p = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  ManifestSpec m; m.units["cabs"] = {entry(p)};
  publish(env, m);
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m);
  for (int proc = 1; proc <= 5; proc++) {
    World w(env, baseConfig(env), st);
    Dump dump(&w);
    w.boot(1500);
    auto r = w.open("cabs");
    w.advance(10);
    CHECK(r->r.ok && r->r.source == "patch");
    CHECK_EQ(st->attempts("cabs-pr1"), 1);
    w.rt->markReady("cabs");
    CHECK_EQ(st->attempts("cabs-pr1"), 0);
    CHECK_EQ(w.log.countSub("ev.confirmed"), 1);
  }
  CHECK(!st->bad("cabs-pr1"));
}

// 10c. Host crash loop: the boot counter is written BEFORE createVm with a patched host.
SCENARIO(crash_loop_host_boot_guard) {
  HostFix f("crash_host", 100);
  for (int proc = 1; proc <= 2; proc++) {
    World w(f.env, baseConfig(f.env), f.st);
    Dump dump(&w);
    w.boot(1500);
    CHECK(w.log.inOrder({"store.put attempts/host-pr88=" + std::to_string(proc), "vm.createVm host=host-pr88"}));
    CHECK_EQ(w.rt->runningHostId(), std::string("host-pr88"));
    // no markReady: the "app" dies
  }
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(1500);
  CHECK(f.st->bad("host-pr88"));
  CHECK_EQ(w.log.texts("vm.createVm"), V({"vm.createVm host=embedded"}));
  CHECK_EQ(w.rt->runningHostId(), std::string("embedded"));
  CHECK_EQ(w.log.count("http.download"), 0);
}

// 10d. A patched host that fails to boot is blacklisted and the VM is recreated once from embedded (no loop).
SCENARIO(patched_host_boot_failure_falls_back_once) {
  HostFix f("host_boot_fail", 100);
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.vmCreateFailPatched = true;
  w.boot(1500);
  CHECK_EQ(w.log.texts("vm.createVm"), V({"vm.createVm host=host-pr88", "vm.createVm host=embedded"}));
  CHECK_EQ(w.rt->vmState(), VmState::Running);
  CHECK(f.st->bad("host-pr88"));
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok);
}

// 11a. Host patch arrives during the hostSettleMs wait: the VM is created once, with the patched host.
SCENARIO(host_patch_before_prewarm_single_vm) {
  HostFix f("host_before_prewarm", 300);
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(2000);
  CHECK_EQ(w.log.texts("vm.createVm"), V({"vm.createVm host=host-pr88"}));
  CHECK(w.log.timeOf("vm.createVm") < 800);  // did not wait the full settle time
  CHECK_EQ(w.log.count("vm.destroyVm"), 0);
  CHECK_EQ(w.rt->runningHostId(), std::string("host-pr88"));
  CHECK_EQ(w.log.countSub("ev.prewarm-settle-expired"), 0);
  CHECK_EQ(f.st->attempts("host-pr88"), 1);
  w.rt->markReady("cabs");  // not loaded: no effect
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok);
  w.rt->markReady("cabs");  // first healthy surface confirms the host patch
  CHECK_EQ(f.st->attempts("host-pr88"), 0);
}

// 11b. Host too slow for the settle window and no views mounted: VM created from disk first, recreated on arrival.
SCENARIO(host_patch_after_prewarm_no_views_recreates) {
  HostFix f("host_after_prewarm", 3000);
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(5000);
  CHECK_EQ(w.log.texts("vm."), V({"vm.createVm host=embedded", "vm.created", "vm.destroyVm", "vm.destroyed", "vm.createVm host=host-pr88", "vm.created"}));
  CHECK(w.log.timeOf("vm.createVm host=embedded") >= 800);  // waited hostSettleMs first
  CHECK_EQ(w.rt->runningHostId(), std::string("host-pr88"));
  CHECK_EQ(w.rt->vmState(), VmState::Running);
}

// 11c. Host patch arrives while views are mounted: VM untouched; recreated at the next zero-views moment.
SCENARIO(host_patch_with_views_waits_for_zero_views) {
  HostFix f("host_with_views", 3000);
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.boot(1000);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->r.ok);
  w.advance(4000);  // host is ready now
  CHECK_EQ(w.rt->artifactState("host-pr88"), std::string("ready"));
  CHECK_EQ(w.log.count("vm.destroyVm"), 0);
  CHECK_EQ(w.rt->runningHostId(), std::string("embedded"));
  w.unmountAll();
  w.advance(500);
  CHECK_EQ(w.log.count("vm.destroyVm"), 1);
  CHECK_EQ(w.rt->runningHostId(), std::string("host-pr88"));
  CHECK_EQ(w.rt->pinOf("cabs"), std::string(""));  // pins are per VM
}

// 11c'. With recreateAtZeroViews=false the VM is left to the lifecycle manager.
SCENARIO(host_patch_with_views_flag_off_never_recreates) {
  HostFix f("host_flag_off", 3000);
  Config cfg = baseConfig(f.env);
  cfg.recreateAtZeroViews = false;
  World w(f.env, cfg, f.st);
  Dump dump(&w);
  w.boot(1000);
  w.open("cabs");
  w.advance(4000);
  w.unmountAll();
  w.advance(2000);
  CHECK_EQ(w.log.count("vm.destroyVm"), 0);
  w.rt->onVmDestroyed();  // lifecycle manager
  auto r = w.open("cabs");
  w.advance(1000);
  CHECK_EQ(w.rt->runningHostId(), std::string("host-pr88"));  // the next VM boots the new host
  CHECK(r->r.ok);
}

// 11d. openUnit during a recreate is queued behind the recreate lock and served by the new VM.
SCENARIO(open_during_recreate_is_queued) {
  HostFix f("open_during_recreate", 3000);
  World w(f.env, baseConfig(f.env), f.st);
  Dump dump(&w);
  w.vmDestroyMs = 500;  // wide window for the recreate lock
  w.boot(500);
  w.advance(500);  // VM (embedded) exists at ~900
  CHECK_EQ(w.rt->vmState(), VmState::Running);
  CHECK(w.until([&] { return w.rt->vmState() == VmState::Destroying; }, 5000));
  auto r = w.open("cabs", "{\"q\":1}");
  w.advance(1);
  CHECK(!r->done());
  CHECK_EQ(w.rt->vmState(), VmState::Destroying);
  w.advance(1000);
  CHECK(r->calls == 1 && r->r.ok);
  CHECK(w.log.inOrder({"vm.destroyVm", "vm.createVm host=host-pr88", "vm.created", "vm.evaluate ota://cabs/", "vm.mount cabs {\"q\":1}"}));
  CHECK_EQ(w.log.count("vm.evaluate"), 1);  // nothing was evaluated into the doomed VM
  CHECK_EQ(w.log.count("vm.createVm"), 2);
}

// A load in flight defers the recreate (never tear down a VM under a pending open), then views block it.
SCENARIO(recreate_waits_for_inflight_load) {
  HostFix f("recreate_inflight", 1500);
  f.env.server.latency[f.cabs.url] = 2500;  // cabs patch in flight when the host becomes ready
  Config cfg = baseConfig(f.env);
  cfg.hostSettleMs = 100;
  World w(f.env, cfg, f.st);
  Dump dump(&w);
  w.boot(300);
  auto r = w.open("cabs");  // budget 1000 -> expires before the patch lands
  w.advance(1800);          // host ready at ~1500 while the load is pending
  CHECK_EQ(w.log.count("vm.destroyVm"), 0);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.count("vm.destroyVm"), 0);  // the surface is mounted now
  w.unmountAll();
  w.advance(500);
  CHECK_EQ(w.log.count("vm.destroyVm"), 1);
}

// Entry module missing after a patch evaluated: the VM is poisoned, the patch blacklisted, VM replaced at zero views.
SCENARIO(entry_failure_poisons_vm) {
  Env env("entry_failure");
  Patch p = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  ManifestSpec m; m.units["cabs"] = {entry(p)};
  publish(env, m);
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m);
  World w(env, baseConfig(env), st);
  Dump dump(&w);
  w.failEntryContains = {"cabs-pr1"};
  w.boot(1500);
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->calls == 1 && !r->r.ok);
  CHECK(st->bad("cabs-pr1"));
  w.advance(500);
  CHECK_EQ(w.log.count("vm.destroyVm"), 1);
  auto r2 = w.open("cabs");
  w.advance(500);
  CHECK(r2->r.ok && r2->r.source == "embedded");
}
