// Scenarios 1-4, 15, 20: start-up, manifest refresh, rejection rules, cache hygiene, determinism.
#include "sim.h"
using namespace sim;

// 1. Cold start, no cache: the user never waits for the manifest; embedded is used; patches wait for the next VM.
SCENARIO(cold_start_no_cache_embedded_only) {
  Env env("cold_start");
  Patch p = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  ManifestSpec m; m.units["cabs"] = {entry(p)};
  publish(env, m);
  env.server.manifestLatency = 500;
  World w(env, baseConfig(env));
  Dump dump(&w);
  w.boot(10);
  auto r = w.open("cabs", "{\"a\":1}");
  w.advance(200);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");
  CHECK_EQ(w.log.texts("vm."), V({"vm.createVm host=embedded", "vm.created", "vm.evaluate ota://cabs/embedded.hbc",
                                  "vm.require 100", "vm.mount cabs {\"a\":1}"}));
  // the unit was mounted before the manifest even arrived
  CHECK(w.log.timeOf("vm.mount") >= 0 && w.log.timeOf("http.manifest.200") == -1);
  CHECK_EQ(w.rt->manifestVersion(), int64_t(0));
  w.advance(5000);  // manifest arrives, patch is prefetched, but the pinned unit stays embedded
  CHECK_EQ(w.rt->manifestVersion(), int64_t(1));
  CHECK_EQ(w.rt->artifactState("cabs-pr1"), std::string("ready"));
  CHECK_EQ(w.rt->pinOf("cabs"), std::string("embedded"));
  CHECK_EQ(w.log.count("vm.evaluate"), 1);
  CHECK_EQ(w.store->m["highestManifestVersion"], std::string("1"));
  CHECK_EQ(w.store->attempts("cabs-pr1"), 0);  // never attempted
}

// 2. Cached manifest is used immediately; the refresh happens in the background and honours ttlSec.
SCENARIO(cached_manifest_used_immediately_refresh_later) {
  Env env("cached_manifest");
  Patch p = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  ManifestSpec m; m.version = 5; m.units["cabs"] = {entry(p)};
  publish(env, m);
  env.server.manifestLatency = 800;  // slow server: must not matter
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m);
  seedBuilt(env, *st, p);
  World w(env, baseConfig(env), st);
  Dump dump(&w);
  w.boot(250);  // VM prewarmed (100ms) and the cached built unit hash-verified off-queue
  CHECK_EQ(w.rt->manifestVersion(), int64_t(5));  // known before any network answer
  auto r = w.open("cabs");
  w.advance(10);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "patch" && r->r.patchId == "cabs-pr1");
  CHECK(w.log.timeOf("vm.evaluate ota://cabs/cabs-pr1.hbc") >= 0 && w.log.timeOf("http.manifest.304") == -1);
  CHECK_EQ(w.store->attempts("cabs-pr1"), 1);  // counted before evaluate
  CHECK(w.log.inOrder({"store.put attempts/cabs-pr1=1", "vm.evaluate ota://cabs/cabs-pr1.hbc"}));
  CHECK_EQ(w.log.count("http.download"), 0);  // already built on disk
  w.advance(1000);
  CHECK_EQ(w.log.count("http.manifest inm"), 1);
  CHECK(w.log.texts("http.manifest inm=etag-5").size() == 1);  // conditional GET
  w.advance(140000);  // ttl 120s (+ up to 10% jitter) -> exactly one more refresh
  CHECK_EQ(w.log.count("http.manifest inm"), 2);
  CHECK_EQ(w.log.count("http.manifest.304"), 2);
}

// 3. Manifest fetch fails: jittered exponential backoff, embedded keeps working, recovery resets the backoff.
SCENARIO(manifest_fetch_fails_backs_off) {
  Env env("manifest_backoff");
  ManifestSpec m; m.ttl = 60;
  publish(env, m);
  env.server.manifestFailures = 3;
  World w(env, baseConfig(env));
  Dump dump(&w);
  w.boot();
  auto r = w.open("cabs");
  w.advance(100000);
  CHECK(r->calls == 1 && r->r.ok && r->r.source == "embedded");
  auto ts = w.log.times("http.manifest inm");
  CHECK(ts.size() >= 5);
  if (ts.size() >= 5) {
    // gap = server latency (50) + delay; delay in [d/2, d] with d = 5s, 10s, 20s
    auto gap = [&](size_t i) { return ts[i + 1] - ts[i] - 50; };
    CHECK(gap(0) >= 2500 && gap(0) <= 5000);
    CHECK(gap(1) >= 5000 && gap(1) <= 10000);
    CHECK(gap(2) >= 10000 && gap(2) <= 20000);
    CHECK(gap(3) >= 60000 && gap(3) <= 66000);  // success: back to ttl (+ up to 10% jitter)... ttl floor is 60s here
  }
  CHECK_EQ(w.log.count("http.manifest.fail"), 3);
  CHECK_EQ(w.log.count("ev.manifest-fetch-failed"), 3);
  CHECK_EQ(w.rt->manifestVersion(), int64_t(1));
}

// 4. Bad signature / invalid manifest / replay / wrong target are rejected and the old manifest is kept; restart rules.
SCENARIO(rejected_manifests_keep_old) {
  Env env("rejected");
  Patch p = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  ManifestSpec m10; m10.version = 10; m10.units["cabs"] = {entry(p)};
  publish(env, m10);
  auto st = std::make_shared<MemStore>();
  {
    World w(env, baseConfig(env), st);
    Dump dump(&w);
    w.boot(1000);
    CHECK_EQ(w.rt->manifestVersion(), int64_t(10));
    auto step = [&](const char* label, const std::string& detailPart, int64_t expectVersion) {
      int before = w.log.count("ev.manifest-rejected") + w.log.count("ev.manifest-same") + w.log.count("ev.manifest-accepted");
      bool got = w.until([&] {
        return w.log.count("ev.manifest-rejected") + w.log.count("ev.manifest-same") + w.log.count("ev.manifest-accepted") > before;
      }, 400000);
      CHECK(got);
      CHECK_EQ(w.rt->manifestVersion(), expectVersion);
      CHECK(w.log.countSub(detailPart) >= 1);
      if (w.log.countSub(detailPart) < 1) std::fprintf(stderr, "step %s missing '%s'\n", label, detailPart.c_str());
    };
    // a) valid body, broken signature
    publishRaw(env, env.server.body, "garbage", "e-a");
    step("bad signature", "ev.manifest-rejected   bad-signature", 10);
    // b) signed but invalid (overlapping ranges)
    ManifestSpec bad; bad.version = 11;
    EntrySpec e1 = ranged(entry(p), 0.0, 0.6);
    Patch p2 = env.makePatch("cabs", "cabs-pr2", withEdits(env.units["cabs"], 12));
    EntrySpec e2 = ranged(entry(p2), 0.5, 1.0);
    bad.units["cabs"] = {e1, e2};
    std::string bb = bad.build(env);
    publishRaw(env, bb, sigFor(bb), "e-b");
    step("invalid", "invalid:", 10);
    // c) replay of an older, correctly signed manifest
    ManifestSpec m9; m9.version = 9;
    std::string b9 = m9.build(env);
    publishRaw(env, b9, sigFor(b9), "e-c");
    step("replay", "replay v9", 10);
    // d) signed for another platform
    ManifestSpec ios; ios.version = 12; ios.platform = "ios";
    std::string bi = ios.build(env);
    publishRaw(env, bi, sigFor(bi), "e-d");
    step("wrong target", "wrong-target", 10);
    // e) same version again: idempotent
    std::string b10 = m10.build(env);
    publishRaw(env, b10, sigFor(b10), "e-e");
    step("same", "ev.manifest-same", 10);
    CHECK_EQ(w.store->m["highestManifestVersion"], std::string("10"));
    // f) a newer, valid manifest is accepted
    ManifestSpec m11; m11.version = 11; m11.units["cabs"] = {entry(p)};
    std::string b11 = m11.build(env);
    publishRaw(env, b11, sigFor(b11), "e-f");
    step("newer", "ev.manifest-accepted   v11", 11);
    CHECK_EQ(w.store->m["highestManifestVersion"], std::string("11"));
    CHECK_EQ(w.store->m["manifest.body"], b11);
  }
  // Restart: tampered cache is rejected (embedded only until a valid manifest arrives).
  {
    auto st2 = std::make_shared<MemStore>(*st);
    st2->m["manifest.body"] += " ";
    env.server.body.clear();  // offline
    World w(env, baseConfig(env), st2);
    Dump dump(&w);
    w.rt->start();
    CHECK_EQ(w.rt->manifestVersion(), int64_t(0));
    CHECK(w.log.countSub("cached: bad-signature") == 1);
  }
  // Restart: cached manifest older than the highest ever seen is a replay.
  {
    auto st3 = std::make_shared<MemStore>(*st);
    st3->m["highestManifestVersion"] = "20";
    env.server.body.clear();
    World w(env, baseConfig(env), st3);
    Dump dump(&w);
    w.rt->start();
    CHECK_EQ(w.rt->manifestVersion(), int64_t(0));
    CHECK(w.log.countSub("cached: replay v11 < 20") == 1);
  }
}

// 15. App upgrade: other version roots are deleted at start; GC removes everything the manifest no longer references.
SCENARIO(app_upgrade_and_cache_gc) {
  Env env("gc");
  Patch p3 = env.makePatch("cabs", "cabs-pr3", withEdits(env.units["cabs"], 31));
  Patch p4 = env.makePatch("cabs", "cabs-pr4", withEdits(env.units["cabs"], 32));
  ManifestSpec m3; m3.version = 3; m3.units["cabs"] = {entry(p3)};
  publish(env, m3);
  auto st = std::make_shared<MemStore>();
  seedCachedManifest(env, *st, m3);
  seedBuilt(env, *st, p3);
  std::string root = env.cacheDir + "/codepush/11.9.0-100";
  fs::create_directories(env.cacheDir + "/codepush/11.8.0-90");
  writeFile(env.cacheDir + "/codepush/11.8.0-90/old.bundle", Bytes{1, 2, 3});
  writeFile(root + "/stale-pr0.bundle", Bytes{1});
  writeFile(root + "/junk.patch.tmp", Bytes{1});
  st->m["attempts/stale-pr0"] = "1";
  st->m["built/stale-pr0"] = "1";
  World w(env, baseConfig(env), st);
  Dump dump(&w);
  w.boot(500);
  CHECK(!fs::exists(env.cacheDir + "/codepush/11.8.0-90"));  // other app version
  CHECK(!fs::exists(root + "/stale-pr0.bundle") && !fs::exists(root + "/junk.patch.tmp"));
  CHECK(fs::exists(root + "/cabs-pr3.bundle"));
  CHECK(st->m.count("attempts/stale-pr0") == 0 && st->m.count("built/stale-pr0") == 0);
  // v4 replaces pr3 by pr4: after the swap and the build, pr3 is deleted and pr4 is kept.
  ManifestSpec m4; m4.version = 4; m4.ttl = 20; m4.units["cabs"] = {entry(p4)};
  publish(env, m4);
  CHECK(w.until([&] { return fs::exists(root + "/cabs-pr4.bundle") && !fs::exists(root + "/cabs-pr3.bundle"); }, 200000));
  CHECK_EQ(w.rt->artifactState("cabs-pr3"), std::string("unknown"));
  CHECK_EQ(w.rt->artifactState("cabs-pr4"), std::string("ready"));
  CHECK(!fs::exists(root + "/cabs-pr4.patch"));  // patch files are deleted after the build
}

// 20. Determinism: the same event sequence yields an identical call log (no wall clock, no real randomness).
static std::string busyRun() {
  Env env("determinism");
  Patch hp = env.makePatch("host", "host-pr88", withEdits(env.host, 21));
  Patch cp = env.makePatch("cabs", "cabs-pr1", withEdits(env.units["cabs"], 11));
  Patch bp = env.makePatch("bus", "bus-pr2", withEdits(env.units["bus"], 12));
  ManifestSpec m; m.version = 2;
  m.host = {entry(hp)};
  m.units["cabs"] = {entry(cp)};
  m.units["bus"] = {entry(bp)};
  publish(env, m);
  env.server.latency[cp.url] = 1500;
  env.server.failTimes[bp.url] = 1;
  env.server.manifestFailures = 1;
  Config cfg = baseConfig(env);
  cfg.randomSeed = 42;
  World w(env, cfg);
  w.boot(100);
  w.open("cabs");
  w.advance(700);
  w.open("bus");
  w.advance(6000);
  w.unmountAll();
  w.advance(500);
  w.open("cabs");
  w.open("bus");
  w.advance(150000);
  return w.log.dump();
}
SCENARIO(determinism_same_events_same_log) {
  std::string a = busyRun(), b = busyRun();
  CHECK(a.size() > 500);
  CHECK(a == b);
  if (a != b) std::fprintf(stderr, "--- run A ---\n%s--- run B ---\n%s", a.c_str(), b.c_str());
  CHECK(a.find("vm.destroyVm") != std::string::npos);  // the run exercised a host recreate
}
