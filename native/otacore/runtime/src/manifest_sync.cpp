// Start-up (restore saved state) and the signed manifest: verify, accept, refresh schedule.
// Part of the runtime orchestrator: shared state and the method list are in runtime_impl.h; the reading guide
// (vocabulary, C++ syntax notes, launch order) is at the top of runtime_impl.h.
#include "runtime_impl.h"

#include <cstdio>
#include <cstdlib>

namespace otaruntime {

// App launch. Restores everything saved by earlier runs (device id, last good manifest, blacklist, crash
// counters), then asks the network for a fresh manifest. Nothing here waits for the network: the app keeps
// running on embedded code (or on a patch that is already on disk) while the refresh happens.
void Runtime::Impl::start() {
  if (started) return;
  started = true;
  if (!cfg.deviceId.empty()) deviceId = cfg.deviceId;
  else {
    std::string v;
    if (d.store->get("deviceId", v) && !v.empty()) deviceId = v;
    else {
      char buf[40];
      std::snprintf(buf, sizeof buf, "%016llx%016llx", (unsigned long long)rnd(), (unsigned long long)rnd());
      deviceId = buf;
      d.store->put("deviceId", deviceId);
    }
  }
  cache = std::make_unique<otacore::Cache>(cfg.cacheBaseDir, cfg.appVersion, cfg.buildNumber);  // drops other app versions' roots
  cacheOk = cache->ok();
  if (!cacheOk) emit("cache-unavailable");
  std::string v;
  if (d.store->get("highestManifestVersion", v)) highest = std::atoll(v.c_str());
  for (auto& k : d.store->keys("bad/")) bad.insert(k.substr(4));
  for (auto& k : d.store->keys("attempts/")) {  // survivors of earlier processes were never confirmed
    std::string id = k.substr(9);
    int n = attemptsOf(id);
    if (n <= 0) continue;
    if (n >= cfg.crashLimitK && !bad.count(id)) {
      markBadId(id, "crash-loop");
      emit("blacklisted", "", id, "crash-loop");
    } else if (!bad.count(id)) {
      emit("crash-suspected", "", id, std::to_string(n));
    }
  }
  loadCached();
  if (snap) { gcPending = true; scheduleGc(); }
  replan(false);
  doRefresh();
}

// Re-verify and adopt the manifest saved by the last run, so patches already on disk can be used on a cold
// start before (or without) any network. It goes through the same signature/replay checks as a fresh one.
void Runtime::Impl::loadCached() {
  std::string body, sig, key, et;
  if (!d.store->get("manifest.body", body) || !d.store->get("manifest.sig", sig)) return;
  d.store->get("manifest.keyId", key);
  d.store->get("manifest.etag", et);
  std::string detail;
  Acc r = accept(body, sig, key, et, true, detail);
  if (r == Acc::Applied) emit("manifest-accepted", "", "", "cached v" + std::to_string(snap->version));
  else emit("manifest-rejected", "", "", "cached: " + detail);
}

// Signature -> parse/validate -> target -> anti-replay -> persist -> swap. Any failure keeps the old snapshot.
Acc Runtime::Impl::accept(const std::string& body, const std::string& sig, const std::string& key, const std::string& et, bool cached, std::string& detail) {
  if (!d.verifier->verify(body, sig, key)) { detail = "bad-signature"; return Acc::BadSig; }
  otacore::ParseResult pr = otacore::parseManifest(body);
  if (!pr.ok) { detail = "invalid: " + (pr.errors.empty() ? std::string("?") : pr.errors[0]); return Acc::Invalid; }
  otacore::Manifest& m = pr.manifest;
  if (m.platform != cfg.platform || m.appVersion != cfg.appVersion) { detail = "wrong-target"; return Acc::WrongTarget; }
  if (m.version < highest) { detail = "replay v" + std::to_string(m.version) + " < " + std::to_string(highest); return Acc::Replay; }
  if (snap && snap->version == m.version) { detail = "same-version"; return Acc::Same; }
  if (m.version > highest) {  // fail closed: never adopt a version we could not record
    if (!d.store->put("highestManifestVersion", std::to_string(m.version))) { detail = "store-failed"; return Acc::StoreFail; }
    highest = m.version;
  }
  if (!cached) {
    bool ok = d.store->put("manifest.body", body) && d.store->put("manifest.sig", sig) &&
              d.store->put("manifest.keyId", key) && d.store->put("manifest.etag", et);
    if (!ok) emit("manifest-persist-failed");  // still usable this session
  }
  detail = "v" + std::to_string(m.version);
  snap = std::make_shared<const otacore::Manifest>(std::move(m));
  etag = et;
  return Acc::Applied;
}

// Ask the CDN for the manifest (conditional request: "only if changed", via the saved ETag).
// Only one request at a time (`mfToken` is nonzero while one is running).
void Runtime::Impl::doRefresh() {
  if (mfToken) return;
  mfToken = ++tokenCtr;
  ManifestRequest r;
  r.token = mfToken;
  r.url = cfg.manifestUrl;
  r.sigUrl = cfg.manifestUrl + ".sig";
  if (snap) r.ifNoneMatch = etag;
  d.http->fetchManifest(r);
}

void Runtime::Impl::scheduleRefresh(Millis delay) {
  cancelTimer(refreshTimer);
  refreshTimer = after(delay, [this] { refreshTimer = 0; doRefresh(); });
}

void Runtime::Impl::refreshOk() {
  mfFailures = 0;
  Millis ttl = snap ? snap->ttlSec * 1000 : 0;
  ttl = std::max(cfg.minRefreshMs, std::min(cfg.maxRefreshMs, ttl));
  scheduleRefresh(ttl + Millis(double(ttl) * 0.1 * r01()));
}

void Runtime::Impl::refreshFailed() {
  mfFailures++;
  scheduleRefresh(backoff(mfFailures));
}

// Network answer for the manifest. `token` identifies which request this answers; stale tokens are ignored.
// On success the device re-plans its patches; on any rejection the OLD manifest stays in force (fail safe).
void Runtime::Impl::onManifestFetched(uint64_t token, const ManifestResponse& r) {
  if (token != mfToken || !token) return;
  mfToken = 0;
  if (r.notModified) {
    if (snap) { emit("manifest-not-modified"); refreshOk(); }
    else refreshFailed();
    return;
  }
  std::string detail;
  Acc a = accept(r.body, r.sigBase64, r.keyId, r.etag, false, detail);
  if (a == Acc::Applied) {
    emit("manifest-accepted", "", "", detail);
    afterSwap();
    refreshOk();
  } else if (a == Acc::Same) {
    emit("manifest-same", "", "", detail);
    refreshOk();
  } else {
    emit("manifest-rejected", "", "", detail);
    refreshFailed();
  }
}

void Runtime::Impl::onManifestFailed(uint64_t token, const std::string& reason) {
  if (token != mfToken || !token) return;
  mfToken = 0;
  emit("manifest-fetch-failed", "", "", reason);
  refreshFailed();
}

// A newer manifest was adopted: recompute what to download, maybe schedule a VM replace (new host patch),
// and clean up cache files the new manifest no longer references.
void Runtime::Impl::afterSwap() {
  gcPending = true;
  replan(true);
  considerRecreate(true);
  scheduleGc();
}

}  // namespace otaruntime
