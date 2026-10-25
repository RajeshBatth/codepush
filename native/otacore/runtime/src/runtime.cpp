// OTA runtime orchestrator. Everything here runs on the single ota queue (see interfaces.h).
#include "otaruntime/runtime.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <set>
#include <utility>

#include "otaruntime/hermes.h"

namespace otaruntime {
namespace {

const char kEmbedded[] = "embedded";
const char kHost[] = "host";

std::string kAttempts(const std::string& id) { return "attempts/" + id; }
std::string kBad(const std::string& id) { return "bad/" + id; }
std::string kBuilt(const std::string& id) { return "built/" + id; }

// Artifact lifecycle: Queued -> Downloading -> Downloaded -> Building -> Ready
//                     (built file already on disk) VerifyPending -> Verifying -> Ready
//                     transient IO trouble -> Failed (maybe retried), corrupt/unsafe -> Bad (persisted)
enum class AS { Absent, Queued, Downloading, Downloaded, VerifyPending, Building, Verifying, Ready, Failed, Bad };

const char* asName(AS s) {
  switch (s) {
    case AS::Absent: return "absent";
    case AS::Queued: return "queued";
    case AS::Downloading: return "downloading";
    case AS::Downloaded: return "downloaded";
    case AS::VerifyPending: return "verify-pending";
    case AS::Building: return "building";
    case AS::Verifying: return "verifying";
    case AS::Ready: return "ready";
    case AS::Failed: return "failed";
    case AS::Bad: return "bad";
  }
  return "?";
}
// States in which the artifact is expected to become Ready soon (a load may wait for it).
bool waitable(AS s) {
  return s == AS::Queued || s == AS::Downloading || s == AS::Downloaded || s == AS::VerifyPending ||
         s == AS::Building || s == AS::Verifying;
}
// States that touch files on disk right now (cache GC must not run).
bool busy(AS s) { return s == AS::Downloading || s == AS::Downloaded || s == AS::Building || s == AS::Verifying; }

struct Art {
  AS s = AS::Absent;
  std::string id, url, hash, updateType, target;  // target: "host" or unit name (embedded asset name)
  int64_t size = 0;                               // patch size from the manifest
  int64_t builtSize = -1;                         // size of the built file (recorded at build time)
  bool isHost = false;
  int rank = 0;
  uint64_t seq = 0;
  int retries = 0;
  uint64_t token = 0;
  TimerId retryTimer = 0;
  bool blocked = false;  // held back by the cellular size cap
};

struct Op {
  bool open = false;
  std::string unit, props;
  OpenCallback cb;
};

struct UnitPin {
  enum St { Loading, Loaded, Failed } st = Loading;
  bool patch = false;
  std::string patchId, error, waitingArt;
  TimerId timer = 0;
  std::vector<Op> waiters;
  std::string reason;  // why this outcome (for the freeze event)
};

// Per-process selection freeze (README "Per-process selection freeze").
struct Frozen {
  bool patch = false;
  std::string id, hash;
};

enum class Acc { Applied, Same, BadSig, Invalid, WrongTarget, Replay, StoreFail };

}  // namespace

const char* vmStateName(VmState s) {
  switch (s) {
    case VmState::None: return "none";
    case VmState::Creating: return "creating";
    case VmState::Running: return "running";
    case VmState::Destroying: return "destroying";
  }
  return "?";
}

struct Runtime::Impl {
  Config cfg;
  Deps d;
  std::shared_ptr<bool> alive = std::make_shared<bool>(true);

  bool started = false, cacheOk = false, firstPage = false;
  std::unique_ptr<otacore::Cache> cache;
  std::string deviceId;
  uint64_t rngState;

  // manifest
  std::shared_ptr<const otacore::Manifest> snap;
  int64_t highest = 0;
  std::string etag;
  uint64_t tokenCtr = 0, mfToken = 0;
  int mfFailures = 0;
  TimerId refreshTimer = 0;

  // persisted-state mirrors
  std::set<std::string> bad, attempted;
  std::map<std::string, double> buckets;

  // artifacts
  std::map<std::string, Art> arts;
  std::map<uint64_t, std::string> tokenToArt;
  int activeDl = 0, activeBuild = 0;
  uint64_t artSeq = 0;
  std::vector<std::string> priority;
  bool gcPending = false, gcScheduled = false;

  // VM
  VmState vm = VmState::None;
  std::string runningHost = kEmbedded, pendingHost = kEmbedded;
  std::map<std::string, UnitPin> pins;
  std::map<std::string, Frozen> frozen;  // process lifetime; survives VM recreation
  std::vector<Op> pendingOps;
  bool pendingRecreate = false, poisoned = false, settleExpired = false;
  TimerId settleTimer = 0;

  Impl(Config c, Deps deps) : cfg(std::move(c)), d(deps), rngState(cfg.randomSeed ? cfg.randomSeed : 88172645463325252ull) {}
  ~Impl() {
    *alive = false;
    if (refreshTimer) d.clock->cancel(refreshTimer);
    if (settleTimer) d.clock->cancel(settleTimer);
    for (auto& kv : arts) if (kv.second.retryTimer) d.clock->cancel(kv.second.retryTimer);
    for (auto& kv : pins) if (kv.second.timer) d.clock->cancel(kv.second.timer);
  }

  // ------------------------------------------------------------------ small helpers
  uint64_t rnd() {
    rngState ^= rngState >> 12; rngState ^= rngState << 25; rngState ^= rngState >> 27;
    return rngState * 2685821657736338717ull;
  }
  double r01() { return double(rnd() >> 11) * (1.0 / 9007199254740992.0); }

  void emit(const char* kind, const std::string& unit = "", const std::string& id = "", const std::string& detail = "") {
    if (d.observer) d.observer->onEvent(Event{kind, unit, id, detail});
  }
  TimerId after(Millis ms, std::function<void()> fn) {
    auto a = alive;
    return d.clock->schedule(ms, [a, fn = std::move(fn)] { if (*a) fn(); });
  }
  void cancelTimer(TimerId& t) {
    if (t) d.clock->cancel(t);
    t = 0;
  }
  void complete(OpenCallback& cb, OpenResult r) {
    if (!cb) return;
    auto a = alive;
    d.scheduler->post([a, cb = std::move(cb), r = std::move(r)] { if (*a) cb(r); });
  }
  void fail(Op& op, const std::string& err) {
    OpenResult r;
    r.error = err;
    complete(op.cb, std::move(r));
  }
  Millis backoff(int n) {
    Millis dl = cfg.backoffBaseMs;
    for (int i = 1; i < n && dl < cfg.backoffMaxMs; i++) dl *= 2;
    dl = std::min(dl, cfg.backoffMaxMs);
    return Millis(double(dl) * (0.5 + 0.5 * r01()));  // equal jitter: [d/2, d]
  }
  const UnitConfig* findUnit(const std::string& n) const {
    for (auto& u : cfg.units) if (u.name == n) return &u;
    return nullptr;
  }
  double bucketOf(const std::string& key) {
    auto it = buckets.find(key);
    if (it != buckets.end()) return it->second;
    return buckets[key] = otacore::bucket(deviceId, key);
  }
  otacore::SelectContext unitCtx(const UnitConfig& u, const std::string& running) {
    otacore::SelectContext c;
    c.bucket = bucketOf(u.name);
    c.embeddedHash = u.embeddedHash;
    c.supportedAlgos = cfg.supportedAlgos;
    c.runningHostId = running;
    return c;
  }
  otacore::SelectContext hostCtx() {
    otacore::SelectContext c;
    c.bucket = bucketOf(cfg.hostBucketKey);
    c.embeddedHash = cfg.hostEmbeddedHash;
    c.supportedAlgos = cfg.supportedAlgos;
    c.runningHostId = kEmbedded;
    return c;
  }
  int loadsInFlight() const {
    int n = 0;
    for (auto& kv : pins) if (kv.second.st == UnitPin::Loading) n++;
    return n;
  }

  // Effective policy of a unit: per-unit field, else defaultPolicy field, else the built-in default.
  Pin pinOfUnit(const std::string& unit) const {
    auto it = cfg.unitPolicy.find(unit);
    if (it != cfg.unitPolicy.end() && it->second.pin) return *it->second.pin;
    return cfg.defaultPolicy.pin.value_or(Pin::Vm);
  }
  Millis budgetOf(const std::string& unit) const {
    auto it = cfg.unitPolicy.find(unit);
    if (it != cfg.unitPolicy.end() && it->second.loadBudgetMs) return std::max<Millis>(0, *it->second.loadBudgetMs);
    return std::max<Millis>(0, cfg.defaultPolicy.loadBudgetMs.value_or(cfg.unitBudgetMs));
  }
  Fetch fetchOf(const std::string& unit) const {
    auto it = cfg.unitPolicy.find(unit);
    if (it != cfg.unitPolicy.end() && it->second.fetch) return *it->second.fetch;
    return cfg.defaultPolicy.fetch.value_or(Fetch::Eager);
  }
  bool freezes(const std::string& unit) const { return pinOfUnit(unit) == Pin::Process; }
  const char* scopeName(const std::string& unit) const { return freezes(unit) ? "process" : "vm"; }
  void freezeNow(const std::string& unit, const UnitPin& pin) {
    const std::string detail = std::string(pin.patch ? "patch" : "embedded") + ":" + pin.reason + " scope=" + scopeName(unit);
    if (!freezes(unit)) {  // pin=vm: the selection is fixed for this VM only (nothing is memoized)
      emit("selection-frozen", unit, pin.patchId, detail);
      return;
    }
    Frozen f;
    f.patch = pin.patch;
    f.id = pin.patchId;
    if (pin.patch && snap) {
      for (auto& u : snap->units) {
        if (u.unitName != unit) continue;
        for (auto& e : u.entries) if (e.id == f.id) f.hash = e.hash;
      }
    }
    auto old = frozen.find(unit);
    const bool same = old != frozen.end() && old->second.patch == f.patch && old->second.id == f.id;
    frozen[unit] = f;
    if (same) return;  // a reused freeze is not announced again
    emit("selection-frozen", unit, f.id, detail);
  }
  void dropFreeze(const std::string& unit, const std::string& reason) {
    auto it = frozen.find(unit);
    if (it == frozen.end()) return;
    emit("selection-dropped", unit, it->second.id, reason + " scope=process");
    frozen.erase(it);
  }
  // Drops the freeze when it points at patch `id` (a failure while loading that very patch).
  void dropFreezeIfPatch(const std::string& unit, const std::string& id, const std::string& reason) {
    auto it = frozen.find(unit);
    if (it != frozen.end() && it->second.patch && it->second.id == id) dropFreeze(unit, reason);
  }

  // ------------------------------------------------------------------ crash-loop guard / blacklist
  void markBadId(const std::string& id, const std::string& why) {
    bad.insert(id);
    d.store->put(kBad(id), why);  // best effort: in-memory flag already protects this process
    d.store->erase(kBuilt(id));
    if (cacheOk) {
      std::string p = cache->builtPath(id);
      if (!p.empty()) d.fs->remove(p);
    }
    emit("patch-bad", "", id, why);
  }
  void markBad(const std::string& id, const std::string& why) {
    markBadId(id, why);
    auto it = arts.find(id);
    if (it != arts.end()) {
      it->second.s = AS::Bad;
      cancelTimer(it->second.retryTimer);
      settle(id);
    }
  }
  int attemptsOf(const std::string& id) {
    std::string v;
    if (!d.store->get(kAttempts(id), v)) return 0;
    return std::atoi(v.c_str());
  }
  // Usable = not blacklisted. Also applies the crash limit to ids first seen after start().
  bool usable(const otacore::Entry& e) {
    if (!cacheOk || cache->builtPath(e.id).empty()) return false;
    if (bad.count(e.id)) return false;
    if (!attempted.count(e.id) && attemptsOf(e.id) >= cfg.crashLimitK) {
      markBadId(e.id, "crash-loop");
      emit("blacklisted", "", e.id, "crash-loop");
      return false;
    }
    return true;
  }
  // Persist attempts[id]+1 BEFORE using a patch. Once per process per id.
  bool bumpAttempt(const std::string& id) {
    if (attempted.count(id)) return true;
    if (!d.store->put(kAttempts(id), std::to_string(attemptsOf(id) + 1))) return false;
    attempted.insert(id);
    return true;
  }

  // ------------------------------------------------------------------ start-up
  void start() {
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

  void loadCached() {
    std::string body, sig, key, et;
    if (!d.store->get("manifest.body", body) || !d.store->get("manifest.sig", sig)) return;
    d.store->get("manifest.keyId", key);
    d.store->get("manifest.etag", et);
    std::string detail;
    Acc r = accept(body, sig, key, et, true, detail);
    if (r == Acc::Applied) emit("manifest-accepted", "", "", "cached v" + std::to_string(snap->version));
    else emit("manifest-rejected", "", "", "cached: " + detail);
  }

  // ------------------------------------------------------------------ manifest
  // Signature -> parse/validate -> target -> anti-replay -> persist -> swap. Any failure keeps the old snapshot.
  Acc accept(const std::string& body, const std::string& sig, const std::string& key, const std::string& et,
             bool cached, std::string& detail) {
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

  void doRefresh() {
    if (mfToken) return;
    mfToken = ++tokenCtr;
    ManifestRequest r;
    r.token = mfToken;
    r.url = cfg.manifestUrl;
    r.sigUrl = cfg.manifestUrl + ".sig";
    if (snap) r.ifNoneMatch = etag;
    d.http->fetchManifest(r);
  }
  void scheduleRefresh(Millis delay) {
    cancelTimer(refreshTimer);
    refreshTimer = after(delay, [this] { refreshTimer = 0; doRefresh(); });
  }
  void refreshOk() {
    mfFailures = 0;
    Millis ttl = snap ? snap->ttlSec * 1000 : 0;
    ttl = std::max(cfg.minRefreshMs, std::min(cfg.maxRefreshMs, ttl));
    scheduleRefresh(ttl + Millis(double(ttl) * 0.1 * r01()));
  }
  void refreshFailed() {
    mfFailures++;
    scheduleRefresh(backoff(mfFailures));
  }

  void onManifestFetched(uint64_t token, const ManifestResponse& r) {
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
  void onManifestFailed(uint64_t token, const std::string& reason) {
    if (token != mfToken || !token) return;
    mfToken = 0;
    emit("manifest-fetch-failed", "", "", reason);
    refreshFailed();
  }

  void afterSwap() {
    gcPending = true;
    replan(true);
    considerRecreate(true);
    scheduleGc();
  }

  // ------------------------------------------------------------------ artifacts: plan, download, build
  std::string targetHostId() {
    if (snap && cacheOk) {
      auto sel = otacore::selectHost(*snap, hostCtx());
      if (sel.source == otacore::Source::Patch && !bad.count(sel.entry->id)) return sel.entry->id;
    }
    return runningHost;
  }

  void considerEntry(const otacore::Entry& e, bool isHost, const std::string& target, int rank, bool resetFailed) {
    if (!usable(e)) return;
    auto it = arts.find(e.id);
    if (it != arts.end() && it->second.hash != e.hash) {  // same id, different content: start over
      if (busy(it->second.s)) return;
      cancelTimer(it->second.retryTimer);
      if (cacheOk) d.fs->remove(cache->builtPath(e.id));
      arts.erase(it);
      it = arts.end();
    }
    if (it == arts.end()) {
      Art a;
      a.id = e.id; a.url = e.patchUrl; a.hash = e.hash; a.updateType = e.updateType; a.size = e.size;
      a.target = target; a.isHost = isHost; a.rank = rank; a.seq = ++artSeq;
      if (cache->has(e.id)) {
        a.s = AS::VerifyPending;
        std::string v;
        if (d.store->get(kBuilt(e.id), v)) a.builtSize = std::atoll(v.c_str());
      } else a.s = AS::Queued;
      arts[e.id] = a;
      return;
    }
    Art& a = it->second;
    if (a.rank >= 0) a.rank = rank;  // rank -1 (promoted: a user is waiting) sticks
    if (resetFailed && a.s == AS::Failed) {
      cancelTimer(a.retryTimer);
      a.retries = 0;
      a.s = cache->has(e.id) ? AS::VerifyPending : AS::Queued;
    }
  }

  // (Re)computes which artifacts this device wants, in prefetch order: host, priority units, the rest.
  void replan(bool resetFailed) {
    if (!snap || !cacheOk) return;
    auto hs = otacore::selectHost(*snap, hostCtx());
    if (hs.source == otacore::Source::Patch) considerEntry(*hs.entry, true, kHost, 0, resetFailed);
    std::string tgt = targetHostId();
    std::vector<const UnitConfig*> order;
    std::set<std::string> seen;
    for (auto& n : priority) {
      const UnitConfig* u = findUnit(n);
      if (u && seen.insert(n).second) order.push_back(u);
    }
    for (auto& u : cfg.units) if (seen.insert(u.name).second) order.push_back(&u);
    int rank = 1;
    for (const UnitConfig* u : order) {
      auto sel = otacore::selectUnit(*snap, u->name, unitCtx(*u, tgt));
      // fetch=lazy: no download before the first request; a patch already on disk is only verified.
      if (sel.source == otacore::Source::Patch && fetchOf(u->name) == Fetch::Lazy && !arts.count(sel.entry->id) &&
          !cache->has(sel.entry->id)) { rank++; continue; }
      if (sel.source == otacore::Source::Patch) considerEntry(*sel.entry, false, u->name, rank, resetFailed);
      rank++;
    }
    // Ranks are recomputed from scratch when the priority list changes.
    pump();
  }

  void setPriority(const std::vector<std::string>& units) {
    priority = units;
    int rank = 1;
    std::set<std::string> seen;
    std::vector<std::string> names = units;
    for (auto& u : cfg.units) names.push_back(u.name);
    for (auto& n : names) {
      if (!seen.insert(n).second) continue;
      for (auto& kv : arts) if (!kv.second.isHost && kv.second.target == n && kv.second.rank >= 0) kv.second.rank = rank;
      rank++;
    }
    pump();
  }

  Art* pickBest(AS s1, AS s2) {
    Art* best = nullptr;
    for (auto& kv : arts) {
      Art& a = kv.second;
      if (a.s != s1 && a.s != s2) continue;
      if (!best || a.rank < best->rank || (a.rank == best->rank && a.seq < best->seq)) best = &a;
    }
    return best;
  }

  void pump() {
    if (!cacheOk) return;
    while (activeBuild < cfg.maxConcurrentBuilds) {
      Art* a = pickBest(AS::Downloaded, AS::VerifyPending);
      if (!a) break;
      startWork(*a);
    }
    while (activeDl < cfg.maxConcurrentDownloads) {
      Art* a = pickBest(AS::Queued, AS::Queued);
      if (!a) break;
      if (d.http->isMetered() && a->size > cfg.patchSizeCapCellular) {
        a->s = AS::Absent;
        a->blocked = true;
        emit("download-blocked-metered", "", a->id);
        settle(a->id);
        continue;
      }
      startDownload(*a);
    }
  }

  void startDownload(Art& a) {
    a.s = AS::Downloading;
    a.blocked = false;
    a.token = ++tokenCtr;
    tokenToArt[a.token] = a.id;
    activeDl++;
    std::string dest = cache->patchPath(a.id);
    d.fs->remove(dest);
    emit("download-start", a.target, a.id);
    DownloadRequest r;
    r.token = a.token; r.url = a.url; r.destPath = dest; r.maxBytes = a.size;
    d.http->download(r);
  }

  void onDownloadDone(uint64_t token, int64_t bytes) {
    auto t = tokenToArt.find(token);
    if (t == tokenToArt.end()) return;
    std::string id = t->second;
    tokenToArt.erase(t);
    activeDl--;
    auto it = arts.find(id);
    if (it == arts.end() || it->second.s != AS::Downloading) { pump(); return; }
    Art& a = it->second;
    if (bytes != a.size || d.fs->fileSize(cache->patchPath(id)) != a.size) {
      d.fs->remove(cache->patchPath(id));
      emit("download-failed", a.target, id, "size-mismatch");
      failTransient(id, AS::Queued);
    } else {
      emit("download-done", a.target, id);
      a.s = AS::Downloaded;
    }
    pump();
  }
  void onDownloadFailed(uint64_t token, const std::string& reason) {
    auto t = tokenToArt.find(token);
    if (t == tokenToArt.end()) return;
    std::string id = t->second;
    tokenToArt.erase(t);
    activeDl--;
    auto it = arts.find(id);
    if (it != arts.end() && it->second.s == AS::Downloading) {
      d.fs->remove(cache->patchPath(id));
      emit("download-failed", it->second.target, id, reason);
      failTransient(id, AS::Queued);
    }
    pump();
  }

  // Transient failure: retry with jittered backoff up to maxRetries, then stay Failed until the next
  // manifest swap resets it. Never persisted as bad.
  void failTransient(const std::string& id, AS retryTo) {
    auto it = arts.find(id);
    if (it == arts.end()) return;
    Art& a = it->second;
    a.retries++;
    a.s = AS::Failed;
    cancelTimer(a.retryTimer);
    if (a.retries <= cfg.maxRetries) {
      a.retryTimer = after(backoff(a.retries), [this, id, retryTo] {
        auto i = arts.find(id);
        if (i == arts.end() || i->second.s != AS::Failed) return;
        i->second.retryTimer = 0;
        i->second.s = retryTo;
        pump();
      });
    }
    settle(id);
  }

  struct WorkResult {
    otacore::Status st = otacore::Status::Ok;
    bool pathOk = false, hashOk = false;
    int64_t size = -1;
  };

  void startWork(Art& a) {
    const bool build = a.s == AS::Downloaded;
    a.s = build ? AS::Building : AS::Verifying;
    activeBuild++;
    emit(build ? "build-start" : "verify-start", a.target, a.id);
    auto res = std::make_shared<WorkResult>();
    const std::string id = a.id, hash = a.hash, target = a.target;
    const std::string builtPath = cache->builtPath(id), patchPath = cache->patchPath(id), root = cache->root();
    const bool full = a.updateType == "full";
    const int64_t expectSize = a.builtSize;
    FileSystem* fsys = d.fs;
    EmbeddedAssets* assets = d.assets;
    PatchBuilder* builder = d.builder;
    auto work = [=] {
      auto underRoot = [&] {
        std::string c = fsys->canonical(builtPath), r = fsys->canonical(root);
        return !c.empty() && !r.empty() && c.size() > r.size() && c.compare(0, r.size(), r) == 0 && c[r.size()] == '/';
      };
      if (build) {
        otacore::MemorySource empty(nullptr, 0);  // `full`: same applyPatch, empty old source
        std::unique_ptr<otacore::RandomAccessSource> src;
        otacore::RandomAccessSource* old = &empty;
        if (!full) {
          src = assets->openSource(target);
          if (!src) { res->st = otacore::Status::IoError; return; }
          old = src.get();
        }
        res->st = builder->build(*old, patchPath, builtPath, hash);
        if (res->st != otacore::Status::Ok) return;
        res->size = fsys->fileSize(builtPath);
        res->pathOk = underRoot();
        res->hashOk = true;  // applyPatch verified sha256 while writing
      } else {
        res->size = fsys->fileSize(builtPath);
        res->pathOk = underRoot();
        if (res->size < 0) { res->st = otacore::Status::IoError; return; }
        if (expectSize >= 0 && res->size != expectSize) return;  // hashOk stays false
        std::string h;
        if (!fsys->sha256File(builtPath, h)) { res->st = otacore::Status::IoError; return; }
        res->hashOk = (h == hash);
      }
    };
    auto al = alive;
    d.worker->run(work, [this, al, id, build, res] {
      if (!*al) return;
      finishWork(id, build, *res);
    });
  }

  void finishWork(const std::string& id, bool build, const WorkResult& r) {
    activeBuild--;
    auto it = arts.find(id);
    if (build && cacheOk) d.fs->remove(cache->patchPath(id));  // patch file is not needed after the build
    if (it == arts.end()) { pump(); return; }
    Art& a = it->second;
    using S = otacore::Status;
    if (r.st == S::IoError) {
      emit("build-failed", a.target, id, "io-error");
      failTransient(id, build ? AS::Queued : AS::VerifyPending);
    } else if (r.st != S::Ok || !r.pathOk || !r.hashOk || r.size < 0) {
      std::string why = r.st != S::Ok ? otacore::statusName(r.st) : !r.pathOk ? "path-escape" : "hash-or-size-mismatch";
      emit("build-failed", a.target, id, why);
      markBad(id, why);
    } else {
      a.builtSize = r.size;
      d.store->put(kBuilt(id), std::to_string(r.size));
      a.s = AS::Ready;
      a.retries = 0;
      emit(build ? "build-ok" : "verify-ok", a.target, id);
      settle(id);
    }
    pump();
  }

  // An artifact reached Ready/Bad/Failed/blocked: wake loads, prewarm and host recreate; schedule GC.
  void settle(const std::string& id) {
    auto it = arts.find(id);
    if (it == arts.end()) return;
    const AS st = it->second.s;
    const bool isHost = it->second.isHost;
    std::vector<std::string> units;
    for (auto& kv : pins) if (kv.second.st == UnitPin::Loading && kv.second.waitingArt == id) units.push_back(kv.first);
    for (auto& u : units) {
      UnitPin& pin = pins[u];
      if (st == AS::Ready) {
        cancelTimer(pin.timer);
        pin.waitingArt.clear();
        loadPatchIntoPin(u, id);
      } else if (!waitable(st)) {
        cancelTimer(pin.timer);
        pin.waitingArt.clear();
        evaluateEmbedded(u, "artifact-unavailable");
      }
    }
    if (isHost) {
      tryPrewarm();
      considerRecreate(true);
    }
    scheduleGc();
  }

  void scheduleGc() {
    if (!gcPending || gcScheduled) return;
    gcScheduled = true;
    auto al = alive;
    d.scheduler->post([this, al] {
      if (!*al) return;
      gcScheduled = false;
      runGc();
    });
  }
  void runGc() {
    if (!gcPending || !cacheOk || !snap) return;
    for (auto& kv : arts) if (busy(kv.second.s)) return;  // retried when the busy artifact settles
    std::vector<std::string> keep = otacore::allEntryIds(*snap);
    std::set<std::string> ref(keep.begin(), keep.end());
    size_t removed = cache->gc(keep);
    for (auto it = arts.begin(); it != arts.end();) {
      if (!ref.count(it->first)) { cancelTimer(it->second.retryTimer); it = arts.erase(it); }
      else ++it;
    }
    for (auto& k : d.store->keys("attempts/")) if (!ref.count(k.substr(9))) d.store->erase(k);
    for (auto& k : d.store->keys("built/")) if (!ref.count(k.substr(6))) d.store->erase(k);
    gcPending = false;
    emit("gc", "", "", std::to_string(removed));
  }

  void onNetworkChanged() {
    bool any = false;
    for (auto& kv : arts) {
      if (kv.second.s == AS::Absent && kv.second.blocked) { kv.second.s = AS::Queued; any = true; }
    }
    if (any) pump();
  }

  // ------------------------------------------------------------------ pre-evaluate checks (DESIGN 5.8)
  struct Check {
    bool ok = false, persistent = false;
    std::string why;
    std::shared_ptr<const Buffer> buf;
  };
  // The once-per-process content checks (hash, size, canonical path) already ran when the artifact became
  // Ready; here: lexical path, map, expected size, 4-byte alignment, Hermes magic and version.
  Check preEvaluate(const std::string& id) {
    Check c;
    auto it = arts.find(id);
    if (it == arts.end() || it->second.s != AS::Ready) { c.why = "not-ready"; return c; }
    std::string path = cache->builtPath(id);
    const std::string root = cache->root() + "/";
    if (path.compare(0, root.size(), root) != 0 || path.find("..") != std::string::npos) {
      c.why = "path-escape"; c.persistent = true; return c;
    }
    c.buf = d.fs->map(path);
    if (!c.buf) { c.why = "map-failed"; return c; }  // transient: no persistent blame
    c.persistent = true;
    if (it->second.builtSize >= 0 && int64_t(c.buf->size()) != it->second.builtSize) { c.why = "size-mismatch"; return c; }
    if (const char* e = checkHermesBytecode(c.buf->data(), c.buf->size(), cfg.bytecodeVersion)) { c.why = e; return c; }
    c.ok = true;
    return c;
  }

  // ------------------------------------------------------------------ prewarm and VM lifecycle
  bool hostWaiting() {
    if (!snap || !cacheOk) return false;
    auto sel = otacore::selectHost(*snap, hostCtx());
    if (sel.source != otacore::Source::Patch || bad.count(sel.entry->id)) return false;
    auto it = arts.find(sel.entry->id);
    return it != arts.end() && waitable(it->second.s);
  }

  void onFirstPageInteractive() {
    firstPage = true;
    tryPrewarm();
  }
  void tryPrewarm() {
    if (!started || !cfg.prewarm || !firstPage || vm != VmState::None) return;
    if (hostWaiting() && !settleExpired) {
      if (!settleTimer) {
        settleTimer = after(cfg.hostSettleMs, [this] {
          settleTimer = 0;
          settleExpired = true;
          emit("prewarm-settle-expired");
          if (vm == VmState::None) startCreate();
        });
      }
      return;
    }
    cancelTimer(settleTimer);
    startCreate();
  }

  // Chooses the host from disk only (never the network) and asks the platform to create the VM.
  void startCreate() {
    cancelTimer(settleTimer);
    vm = VmState::Creating;
    poisoned = false;
    HostSource hs;
    if (snap && cacheOk) {
      auto sel = otacore::selectHost(*snap, hostCtx());
      if (sel.source == otacore::Source::Patch && usable(*sel.entry)) {
        const std::string id = sel.entry->id;
        auto it = arts.find(id);
        if (it != arts.end() && it->second.s == AS::Ready) {
          Check c = preEvaluate(id);
          if (!c.ok) {
            if (c.persistent) markBad(id, c.why);
          } else if (bumpAttempt(id)) {  // host boot guard: persisted BEFORE createVm
            hs.hostId = id;
            hs.path = cache->builtPath(id);
            hs.buffer = c.buf;
          }
        }
      }
    }
    pendingHost = hs.hostId;
    emit("vm-create", kHost, hs.hostId);
    d.vm->createVm(hs);
  }

  void onVmCreated(bool ok) {
    if (vm != VmState::Creating) return;
    if (ok) {
      vm = VmState::Running;
      runningHost = pendingHost;
      emit("vm-created", kHost, runningHost);
      auto ops = std::move(pendingOps);
      pendingOps.clear();
      for (auto& op : ops) runOp(std::move(op));
      considerRecreate(true);
      return;
    }
    emit("vm-create-failed", kHost, pendingHost);
    if (pendingHost != kEmbedded) {  // patched host failed to boot: blacklist it, retry once with embedded
      markBad(pendingHost, "vm-create-failed");
      startCreate();
      return;
    }
    vm = VmState::None;
    auto ops = std::move(pendingOps);
    pendingOps.clear();
    for (auto& op : ops) fail(op, "vm-create-failed");
  }

  void dropPins(const char* err) {
    auto old = std::move(pins);
    pins.clear();
    for (auto& kv : old) {
      cancelTimer(kv.second.timer);
      for (auto& op : kv.second.waiters) fail(op, err);
    }
  }

  void onVmDestroyed() {
    const bool recreating = vm == VmState::Destroying;
    dropPins("vm-destroyed");
    runningHost = kEmbedded;
    emit("vm-destroyed");
    if (recreating) { startCreate(); return; }
    if (vm == VmState::Creating || vm == VmState::Running) {
      vm = VmState::None;
      auto ops = std::move(pendingOps);
      pendingOps.clear();
      for (auto& op : ops) fail(op, "vm-destroyed");
    }
  }

  bool hostUpgradeAvailable() {
    if (!snap || !cacheOk) return false;
    auto sel = otacore::selectHost(*snap, hostCtx());
    if (sel.source != otacore::Source::Patch || sel.entry->id == runningHost) return false;
    if (bad.count(sel.entry->id) || !usable(*sel.entry)) return false;
    auto it = arts.find(sel.entry->id);
    return it != arts.end() && it->second.s == AS::Ready;
  }

  // 5.4: recreate only with zero mounted views and no load in flight; remember the wish for the next
  // zero-views moment when `recreateAtZeroViews`. `readyMoment`: the new host just became ready.
  void considerRecreate(bool readyMoment) {
    if (vm != VmState::Running) return;
    if (!poisoned && !hostUpgradeAvailable()) { pendingRecreate = false; return; }
    const bool loads = loadsInFlight() > 0;
    const bool views = d.vm->mountedSurfaceCount() > 0;
    if (!loads && !views) { beginRecreate(); return; }
    pendingRecreate = poisoned || cfg.recreateAtZeroViews || (loads && (pendingRecreate || readyMoment));
  }
  void beginRecreate() {
    pendingRecreate = false;
    vm = VmState::Destroying;  // recreate lock: openUnit calls queue until the new VM is up
    emit("vm-recreate", kHost, "", poisoned ? "poisoned" : "new-host");
    d.vm->destroyVm();
  }

  // ------------------------------------------------------------------ openUnit / loadUnit
  void submit(Op op) {
    if (!started) { fail(op, "not-started"); return; }
    switch (vm) {
      case VmState::Running: runOp(std::move(op)); return;
      case VmState::Creating:
      case VmState::Destroying: pendingOps.push_back(std::move(op)); return;
      case VmState::None:
        if (!op.open) { fail(op, "no-vm"); return; }
        pendingOps.push_back(std::move(op));
        startCreate();
        return;
    }
  }

  void runOp(Op op) {
    const std::string unit = op.unit;
    if (!findUnit(unit)) { fail(op, "unknown-unit"); return; }
    auto it = pins.find(unit);
    // A failure is never frozen: with the freeze on, a new request re-decides instead of replaying the error, but ONLY in a
    // CLEAN VM. A poisoned VM (a patch entry threw after its modules registered; Metro ignores re-registration) must not be
    // asked to evaluate anything until it is replaced, so there the failed pin stays failed (DESIGN.md 5.8 decision 5).
    if (it != pins.end() && it->second.st == UnitPin::Failed && freezes(unit) && !poisoned) { pins.erase(it); it = pins.end(); }
    const bool fresh = it == pins.end();
    UnitPin& pin = fresh ? pins[unit] : it->second;
    pin.waiters.push_back(std::move(op));
    if (fresh) resolve(unit);
    else if (pin.st != UnitPin::Loading) serve(unit);
  }

  // 5.2 steps 2-3 for one unit, pinned for the lifetime of this VM.
  // Re-validates a frozen patch selection when a NEW VM resolves the unit (safety exceptions a, b, c).
  // Returns "" when the freeze holds, otherwise the reason it was dropped.
  std::string frozenPatchProblem(const std::string& unit, const Frozen& f) {
    if (!snap || !cacheOk) return "no-manifest";
    if (bad.count(f.id)) return "blacklisted";
    const otacore::Entry* found = nullptr;
    for (auto& u : snap->units) {
      if (u.unitName != unit) continue;
      for (auto& e : u.entries) if (e.id == f.id) found = &e;
    }
    if (!found) return "removed-from-manifest";
    if (found->hash != f.hash) return "entry-changed";
    auto sel = otacore::selectUnit(*snap, unit, unitCtx(*findUnit(unit), runningHost));
    if (sel.source != otacore::Source::Patch || sel.entry->id != f.id) {
      return sel.source == otacore::Source::Patch ? "range-excluded" : sel.reason;
    }
    if (!usable(*found)) return "blacklisted";  // crash-loop limit applied now
    auto it = arts.find(f.id);
    if (it == arts.end() || it->second.s != AS::Ready) return "file-missing";
    Check c = preEvaluate(f.id);
    if (!c.ok) {
      if (c.persistent) markBad(f.id, c.why);
      return "pre-evaluate-failed:" + c.why;
    }
    return "";
  }

  void resolve(const std::string& unit) {
    const UnitConfig* uc = findUnit(unit);
    if (freezes(unit)) {
      auto f = frozen.find(unit);
      if (f != frozen.end()) {
        if (!f->second.patch) {
          emit("selection-reused", unit, "", "embedded scope=process");
          evaluateEmbedded(unit, "frozen");
          return;
        }
        const Frozen fz = f->second;
        std::string why = frozenPatchProblem(unit, fz);
        if (why.empty()) {
          emit("selection-reused", unit, fz.id, "patch scope=process");
          pins[unit].reason = "frozen";
          loadPatchIntoPin(unit, fz.id);
          return;
        }
        dropFreeze(unit, why);  // then the normal selection runs against the latest manifest
      }
    }
    if (!snap || !cacheOk) { evaluateEmbedded(unit, "no-manifest"); return; }
    auto sel = otacore::selectUnit(*snap, unit, unitCtx(*uc, runningHost));
    if (sel.source != otacore::Source::Patch || !usable(*sel.entry)) {
      const std::string why = sel.source != otacore::Source::Patch ? sel.reason : "blacklisted";
      emit("select-embedded", unit, "", sel.reason);
      evaluateEmbedded(unit, why);
      return;
    }
    const otacore::Entry e = *sel.entry;
    considerEntry(e, false, unit, -1, false);
    auto it = arts.find(e.id);
    if (it == arts.end()) { evaluateEmbedded(unit, "artifact-missing"); return; }
    it->second.rank = -1;  // the user is waiting: promote ahead of prefetch
    if (it->second.s == AS::Absent) it->second.s = AS::Queued;
    if (it->second.s == AS::Queued) pump();
    it = arts.find(e.id);
    if (it == arts.end()) { evaluateEmbedded(unit, "artifact-missing"); return; }
    switch (it->second.s) {
      case AS::Ready: pins[unit].reason = "ok"; loadPatchIntoPin(unit, e.id); return;
      case AS::Bad: case AS::Failed: case AS::Absent: evaluateEmbedded(unit, "artifact-unavailable"); return;
      default: break;
    }
    const Millis budget = budgetOf(unit);
    if (budget <= 0) {  // latency-first: never wait; the (promoted) download/build continues for the next resolution
      emit("budget-exceeded", unit, "", "no-wait");
      evaluateEmbedded(unit, "budget-exceeded");
      return;
    }
    UnitPin& pin = pins[unit];
    pin.waitingArt = e.id;
    pin.reason = "ok";
    pin.timer = after(budget, [this, unit] {
      auto p = pins.find(unit);
      if (p == pins.end() || p->second.st != UnitPin::Loading || p->second.waitingArt.empty()) return;
      p->second.timer = 0;
      p->second.waitingArt.clear();
      emit("budget-exceeded", unit, "");
      evaluateEmbedded(unit, "budget-exceeded");
    });
  }

  void loadPatchIntoPin(const std::string& unit, const std::string& id) {
    const UnitConfig* uc = findUnit(unit);
    UnitPin& pin = pins[unit];
    Check c = preEvaluate(id);
    if (!c.ok) {
      emit("pre-evaluate-failed", unit, id, c.why);
      if (c.persistent) markBad(id, c.why);
      dropFreezeIfPatch(unit, id, "pre-evaluate-failed:" + c.why);
      evaluateEmbedded(unit, "pre-evaluate-failed");
      return;
    }
    if (!bumpAttempt(id)) {
      emit("attempt-persist-failed", unit, id);
      dropFreezeIfPatch(unit, id, "attempt-persist-failed");
      evaluateEmbedded(unit, "attempt-persist-failed");
      return;
    }
    std::string err;
    if (!d.vm->evaluateUnit(*c.buf, "ota://" + unit + "/" + id + ".hbc", err)) {
      emit("evaluate-failed", unit, id, err);
      markBad(id, "evaluate-failed");
      dropFreezeIfPatch(unit, id, "evaluate-failed");
      evaluateEmbedded(unit, "evaluate-failed");  // a failed evaluate registered nothing: the VM is clean
      return;
    }
    if (!d.vm->requireEntry(uc->entryModuleId, err)) {
      // Modules of the patch are already registered; embedded would not override them. Blame the
      // patch, fail this load, and replace the VM at the next zero-views moment.
      emit("entry-failed", unit, id, err);
      markBad(id, "entry-failed");
      dropFreezeIfPatch(unit, id, "entry-failed");
      poisoned = true;
      failPin(unit, "entry-failed: " + err);
      considerRecreate(true);
      return;
    }
    pin.st = UnitPin::Loaded;
    pin.patch = true;
    pin.patchId = id;
    emit("unit-loaded", unit, id, "patch");
    if (pin.reason == "frozen") pin.reason = "ok";
    freezeNow(unit, pin);
    serve(unit);
  }

  void evaluateEmbedded(const std::string& unit, const std::string& why) {
    const UnitConfig* uc = findUnit(unit);
    UnitPin& pin = pins[unit];
    pin.reason = why;
    std::string err;
    auto buf = d.assets->open(unit);
    if (!buf) { failPin(unit, "embedded-missing"); return; }
    if (!d.vm->evaluateUnit(*buf, "ota://" + unit + "/embedded.hbc", err)) { failPin(unit, "embedded-evaluate-failed: " + err); return; }
    if (!d.vm->requireEntry(uc->entryModuleId, err)) { failPin(unit, "embedded-entry-failed: " + err); return; }
    pin.st = UnitPin::Loaded;
    pin.patch = false;
    pin.patchId.clear();
    emit("unit-loaded", unit, "", "embedded");
    freezeNow(unit, pin);
    serve(unit);
  }

  void failPin(const std::string& unit, const std::string& err) {
    UnitPin& pin = pins[unit];
    pin.st = UnitPin::Failed;
    pin.error = err;
    emit("unit-failed", unit, "", err);
    serve(unit);
  }

  void serve(const std::string& unit) {
    auto ws = std::move(pins[unit].waiters);
    pins[unit].waiters.clear();
    for (auto& op : ws) {
      UnitPin& pin = pins[unit];
      OpenResult r;
      r.source = pin.patch ? "patch" : "embedded";
      r.patchId = pin.patchId;
      if (pin.st == UnitPin::Failed) {
        r.error = pin.error;
        r.source.clear();
      } else if (op.open) {
        std::string err;
        if (d.vm->mountSurface(unit, op.props, err)) r.ok = true;
        else r.error = "mount-failed: " + err;
      } else {
        r.ok = true;
      }
      complete(op.cb, std::move(r));
    }
    if (pendingRecreate) considerRecreate(false);
  }

  void markReady(const std::string& unit) {
    auto it = pins.find(unit);
    if (it == pins.end() || it->second.st != UnitPin::Loaded) return;
    if (it->second.patch) {
      d.store->erase(kAttempts(it->second.patchId));
      attempted.erase(it->second.patchId);
      emit("confirmed", unit, it->second.patchId);
    }
    if (runningHost != kEmbedded) {  // the first healthy RN surface also confirms the booted host patch
      d.store->erase(kAttempts(runningHost));
      attempted.erase(runningHost);
      emit("confirmed", kHost, runningHost);
    }
  }

  void onSurfaceUnmounted() {
    if (pendingRecreate && vm == VmState::Running) considerRecreate(false);
  }
};

// ---------------------------------------------------------------------- public API forwarding
Runtime::Runtime(Config cfg, Deps deps) : p_(new Impl(std::move(cfg), deps)) {}
Runtime::~Runtime() = default;

void Runtime::start() { p_->start(); }
void Runtime::onFirstPageInteractive() { p_->onFirstPageInteractive(); }
void Runtime::setEntryPointPriority(const std::vector<std::string>& u) { p_->setPriority(u); }
void Runtime::openUnit(const std::string& unit, const std::string& props, OpenCallback cb) {
  Op op;
  op.open = true; op.unit = unit; op.props = props; op.cb = std::move(cb);
  p_->submit(std::move(op));
}
void Runtime::loadUnit(const std::string& unit, OpenCallback cb) {
  Op op;
  op.unit = unit; op.cb = std::move(cb);
  p_->submit(std::move(op));
}
void Runtime::markReady(const std::string& unit) { p_->markReady(unit); }
void Runtime::onVmCreated(bool ok) { p_->onVmCreated(ok); }
void Runtime::onVmDestroyed() { p_->onVmDestroyed(); }
void Runtime::onSurfaceMounted() {}
void Runtime::onSurfaceUnmounted() { p_->onSurfaceUnmounted(); }
void Runtime::onNetworkChanged() { p_->onNetworkChanged(); }
void Runtime::onManifestFetched(uint64_t t, const ManifestResponse& r) { p_->onManifestFetched(t, r); }
void Runtime::onManifestFailed(uint64_t t, const std::string& why) { p_->onManifestFailed(t, why); }
void Runtime::onDownloadDone(uint64_t t, int64_t bytes) { p_->onDownloadDone(t, bytes); }
void Runtime::onDownloadFailed(uint64_t t, const std::string& why) { p_->onDownloadFailed(t, why); }

VmState Runtime::vmState() const { return p_->vm; }
std::string Runtime::runningHostId() const { return p_->runningHost; }
int64_t Runtime::manifestVersion() const { return p_->snap ? p_->snap->version : 0; }
std::string Runtime::deviceId() const { return p_->deviceId; }
std::string Runtime::artifactState(const std::string& id) const {
  auto it = p_->arts.find(id);
  return it == p_->arts.end() ? "unknown" : asName(it->second.s);
}
bool Runtime::isBlacklisted(const std::string& id) const { return p_->bad.count(id) > 0; }
std::string Runtime::frozenOf(const std::string& unit) const {
  auto it = p_->frozen.find(unit);
  if (it == p_->frozen.end()) return "";
  return it->second.patch ? "patch:" + it->second.id : "embedded";
}
std::string Runtime::pinOf(const std::string& unit) const {
  auto it = p_->pins.find(unit);
  if (it == p_->pins.end()) return "";
  switch (it->second.st) {
    case UnitPin::Loading: return "loading";
    case UnitPin::Failed: return "failed";
    case UnitPin::Loaded: return it->second.patch ? "patch:" + it->second.patchId : "embedded";
  }
  return "";
}

}  // namespace otaruntime
