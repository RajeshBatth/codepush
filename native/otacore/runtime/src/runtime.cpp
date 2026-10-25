// OTA runtime orchestrator. Everything here runs on the single ota queue (see interfaces.h).
//
// ====================================================================================================
// READING GUIDE (written for people who are not fluent in C++)
// ====================================================================================================
// WHAT THIS FILE IS
//   The "brain" of the on-device OTA client. It decides, for every unit (a patchable slice of the app) and
//   for the host bundle, whether to run the code that is EMBEDDED in the app binary or a downloaded PATCH,
//   and it drives everything needed to get there: fetching the manifest, downloading and building patches,
//   creating/replacing the React Native VM, and evaluating unit code into it.
//
//   It does NO real I/O itself. Every side effect goes through an interface from interfaces.h held in `d`
//   (d.http, d.fs, d.store, d.vm, d.clock, ...). Android/iOS implement those; tests use fakes. That is why
//   you will see calls like `d.vm->createVm(...)`: "ask the platform to do X". The answer usually comes back
//   LATER as an event (onVmCreated, onDownloadDone, ...), never as a return value.
//
//   Single thread: all code here runs on one serial queue, so there are no locks. Slow work (applying a
//   patch) is handed to d.worker and its result is posted back to the queue.
//
// VOCABULARY
//   embedded  the copy of a bundle that ships inside the app binary. Always the safe fallback.
//   host      the main JS bundle (everything outside units). Booting a VM uses embedded or a patched host.
//   unit      a separately patchable JS slice (e.g. "travelplex"), loaded into a running VM on demand.
//   patch     one update we ship for a unit or the host. It is listed in the signed manifest, rolled out by
//             percentage, and can be halted. Our local progress record for it is `PatchState`
//             (queued -> downloading -> building -> ready).
//   diff file the small file downloaded from the CDN for a patch.
//   built     the result of applying the diff file to the embedded bundle: the bytecode we actually run.
//   manifest entry  one patch as listed in the signed manifest. `snap` is the latest verified manifest.
//   pin       the decision "unit X runs embedded / patch P in this VM" (struct UnitPin). Fixed per VM.
//   prewarm   creating the VM in the background before the user taps, so the first tap is fast.
//   poisoned  a VM in which a patch half-registered its modules and then threw; it must be replaced.
//
// C++ SYNTAX YOU WILL MEET
//   `d.vm->createVm(x)`        call a method through a pointer (`->` instead of `.`).
//   `auto it = m.find(k);`     look a key up in a map; `it == m.end()` means "not found", `it->second` is the value.
//   `[this, id] { ... }`       a "lambda": a small unnamed function written inline, usually a callback that runs
//                              LATER. The `[...]` lists what it captures from the surrounding code.
//   `std::move(x)`             hand x over to someone else without copying it (x is empty afterwards).
//   `const std::string&`       a read-only reference: the string is not copied.
//   `std::optional<T>`         a value that may be unset; `.value_or(d)` = the value, or d when unset.
//   `std::shared_ptr<T>`       a reference-counted pointer; the object is freed when the last holder drops it.
//   `alive` (see Impl)         callbacks can fire after the Runtime is destroyed; each checks `*alive` first.
//   `Impl`                     the real implementation. The public class `Runtime` (runtime.h) just forwards
//                              to it (bottom of this file) so the header stays small.
//
// MAP OF THIS FILE (top to bottom)
//   1. small types            PatchState / Op / UnitPin / Frozen
//   2. helpers                events, timers, policy lookups
//   3. crash-loop guard       blacklist + "attempt" counters
//   4. start-up               restore saved state, first manifest fetch
//   5. manifest               verify -> accept -> refresh timer
//   6. patch pipeline         plan what to fetch, download, build, verify, settle, cache GC
//   7. pre-evaluate checks    last safety net before bytes reach Hermes
//   8. prewarm + VM lifecycle create / replace the VM
//   9. openUnit / loadUnit    decide embedded vs patch for one unit, evaluate it, answer the caller
//
// TYPICAL LAUNCH, IN ORDER
//   start()                   -> restore cached manifest, kick off a refresh      (never blocks the UI)
//   onFirstPageInteractive()  -> maybe prewarm the VM
//   onManifestFetched()       -> verified manifest -> replan() -> pump() downloads/builds patches
//   openUnit("chat")          -> resolve(): patch ready? use it. Still building? wait up to the unit's budget,
//                                then fall back to embedded. -> evaluate -> mount the screen
//   markReady("chat")         -> JS rendered its first frame: the patch is confirmed healthy
// ====================================================================================================
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

// Stage of a patch. Lifecycle: Queued -> Downloading -> Downloaded -> Building -> Ready
//                     (built file already on disk) VerifyPending -> Verifying -> Ready
//                     transient IO trouble -> Failed (maybe retried), corrupt/unsafe -> Bad (persisted)
enum class Stage { Absent, Queued, Downloading, Downloaded, VerifyPending, Building, Verifying, Ready, Failed, Bad };

const char* stageName(Stage s) {
  switch (s) {
    case Stage::Absent: return "absent";
    case Stage::Queued: return "queued";
    case Stage::Downloading: return "downloading";
    case Stage::Downloaded: return "downloaded";
    case Stage::VerifyPending: return "verify-pending";
    case Stage::Building: return "building";
    case Stage::Verifying: return "verifying";
    case Stage::Ready: return "ready";
    case Stage::Failed: return "failed";
    case Stage::Bad: return "bad";
  }
  return "?";
}
// States in which the patch is expected to become Ready soon (a load may wait for it).
bool waitable(Stage s) {
  return s == Stage::Queued || s == Stage::Downloading || s == Stage::Downloaded || s == Stage::VerifyPending ||
         s == Stage::Building || s == Stage::Verifying;
}
// States that touch files on disk right now (cache GC must not run).
bool busy(Stage s) { return s == Stage::Downloading || s == Stage::Downloaded || s == Stage::Building || s == Stage::Verifying; }

// Progress record for one patch we are tracking (host or unit). Created by considerEntry().
struct PatchState {
  Stage s = Stage::Absent;
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

// A request from native code that is waiting for an answer: openUnit (open=true: also mount the screen) or loadUnit
// (open=false: only evaluate the unit into the running VM). `cb` is called exactly once with the outcome.
struct Op {
  bool open = false;
  std::string unit, props;
  OpenCallback cb;
};

// The decision for one unit in the CURRENT VM: Loading (still deciding/waiting), Loaded (done, `patch` says which
// code runs) or Failed. `waiters` are the requests to answer once the state settles. Discarded with the VM.
struct UnitPin {
  enum St { Loading, Loaded, Failed } st = Loading;
  bool patch = false;
  std::string patchId, error, waitingArt;
  TimerId timer = 0;
  std::vector<Op> waiters;
  std::string reason;  // why this outcome (for the freeze event)
};

// Remembered choice for units with pin=Process: survives VM recreation within one process (see UnitPolicy::pin).
// Units with the default pin=Vm never use this; they re-decide for every new VM.
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
  // Becomes false when this object is destroyed. Timers/worker callbacks may still fire afterwards, so each one
  // checks `*alive` before touching `this` (otherwise it would use freed memory).
  std::shared_ptr<bool> alive = std::make_shared<bool>(true);

  bool started = false, cacheOk = false, firstPage = false;
  std::unique_ptr<otacore::Cache> cache;
  std::string deviceId;
  uint64_t rngState;

  // manifest
  std::shared_ptr<const otacore::Manifest> snap;  // latest VERIFIED manifest (null until one is accepted)
  int64_t highest = 0;                            // highest manifest version ever accepted; older ones are replays
  std::string etag;
  uint64_t tokenCtr = 0, mfToken = 0;
  int mfFailures = 0;
  TimerId refreshTimer = 0;

  // persisted-state mirrors (the durable copy lives in d.store; these are the in-memory view)
  std::set<std::string> bad;        // patch ids that must never run again (blacklist)
  std::set<std::string> attempted;  // patch ids already counted as an "attempt" in THIS process
  std::map<std::string, double> buckets;  // cache of this device's rollout bucket per unit

  // patches
  std::map<std::string, PatchState> patches;  // patch id -> its progress
  std::map<uint64_t, std::string> tokenToPatch;
  int activeDl = 0, activeBuild = 0;
  uint64_t patchSeq = 0;
  std::vector<std::string> priority;  // units reachable from visible entry points, most important first
  bool gcPending = false, gcScheduled = false;

  // VM
  VmState vm = VmState::None;
  std::string runningHost = kEmbedded, pendingHost = kEmbedded;  // host id the VM runs / is being created from
  std::map<std::string, UnitPin> pins;   // unit -> decision in the current VM (cleared when the VM goes away)
  std::map<std::string, Frozen> frozen;  // process lifetime; survives VM recreation (pin=Process units only)
  std::vector<Op> pendingOps;            // requests that arrived while the VM was being created/replaced
  bool pendingRecreate = false;          // we want to replace the VM as soon as it is safe (no screens open)
  bool poisoned = false;                 // current VM is unusable (see vocabulary); replace it
  bool settleExpired = false;            // we already waited hostSettleMs for a host patch; never wait again
  TimerId settleTimer = 0;               // the hostSettleMs wait (0 = none running)

  Impl(Config c, Deps deps) : cfg(std::move(c)), d(deps), rngState(cfg.randomSeed ? cfg.randomSeed : 88172645463325252ull) {}
  ~Impl() {
    *alive = false;
    if (refreshTimer) d.clock->cancel(refreshTimer);
    if (settleTimer) d.clock->cancel(settleTimer);
    for (auto& kv : patches) if (kv.second.retryTimer) d.clock->cancel(kv.second.retryTimer);
    for (auto& kv : pins) if (kv.second.timer) d.clock->cancel(kv.second.timer);
  }

  // ------------------------------------------------------------------ small helpers
  uint64_t rnd() {
    rngState ^= rngState >> 12; rngState ^= rngState << 25; rngState ^= rngState >> 27;
    return rngState * 2685821657736338717ull;
  }
  double r01() { return double(rnd() >> 11) * (1.0 / 9007199254740992.0); }

  // Report something that happened to the app's Observer (logging/telemetry). Purely informational.
  void emit(const char* kind, const std::string& unit = "", const std::string& id = "", const std::string& detail = "") {
    if (d.observer) d.observer->onEvent(Event{kind, unit, id, detail});
  }
  // Run `fn` after `ms` milliseconds, unless this object was destroyed meanwhile. Returns a timer id for cancelTimer.
  TimerId after(Millis ms, std::function<void()> fn) {
    auto a = alive;
    return d.clock->schedule(ms, [a, fn = std::move(fn)] { if (*a) fn(); });
  }
  void cancelTimer(TimerId& t) {
    if (t) d.clock->cancel(t);
    t = 0;
  }
  // Answer a caller. Always deferred via the scheduler (posted), never called inline, so callers can rely on
  // "the callback never runs inside the method I just called".
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
  // Retry delay after the n-th failure: base * 2^(n-1), capped, then randomized to [50%,100%] so that many devices
  // that failed together do not all retry at the same instant.
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
  // This device's stable position (0..1) for a unit; a rollout of "30%" reaches devices whose bucket is below 0.3.
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
  // How many units are currently deciding/waiting. A VM must not be replaced while any load is in flight.
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
  // true for units with pin=Process ("freeze" is the older name for the process-wide lock).
  bool freezes(const std::string& unit) const { return pinOfUnit(unit) == Pin::Process; }
  const char* scopeName(const std::string& unit) const { return freezes(unit) ? "process" : "vm"; }
  // Called when a unit finished loading: report the decision, and for pin=Process units also remember it
  // in `frozen` so the next VM in this process reuses it.
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
  // How we protect users from a patch that crashes the app:
  //   1. BEFORE running a patch we persist "attempts[id] += 1" (bumpAttempt).
  //   2. When JS renders its first frame, markReady() erases the counter: the patch is proven healthy.
  //   3. If the process dies first, the counter survives. On the next start, a counter >= crashLimitK means the
  //      patch crashed us K times without ever confirming: it is blacklisted for good (`bad/<id>`) and embedded
  //      code runs instead.
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
    auto it = patches.find(id);
    if (it != patches.end()) {
      it->second.s = Stage::Bad;
      cancelTimer(it->second.retryTimer);
      settle(id);
    }
  }
  int attemptsOf(const std::string& id) {
    std::string v;
    if (!d.store->get(kAttempts(id), v)) return 0;
    return std::atoi(v.c_str());
  }
  // Usable = we may consider running this patch: not blacklisted, and the cache works. Also applies the crash limit to ids first seen after start().
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
  // App launch. Restores everything saved by earlier runs (device id, last good manifest, blacklist, crash
  // counters), then asks the network for a fresh manifest. Nothing here waits for the network: the app keeps
  // running on embedded code (or on a patch that is already on disk) while the refresh happens.
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

  // Re-verify and adopt the manifest saved by the last run, so patches already on disk can be used on a cold
  // start before (or without) any network. It goes through the same signature/replay checks as a fresh one.
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

  // Ask the CDN for the manifest (conditional request: "only if changed", via the saved ETag).
  // Only one request at a time (`mfToken` is nonzero while one is running).
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

  // Network answer for the manifest. `token` identifies which request this answers; stale tokens are ignored.
  // On success the device re-plans its patches; on any rejection the OLD manifest stays in force (fail safe).
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

  // A newer manifest was adopted: recompute what to download, maybe schedule a VM replace (new host patch),
  // and clean up cache files the new manifest no longer references.
  void afterSwap() {
    gcPending = true;
    replan(true);
    considerRecreate(true);
    scheduleGc();
  }

  // ------------------------------------------------------------------ patches: plan, download, build
  // Which host the VM will run (or runs): the selected host patch if usable, else the currently running host.
  // Used so unit selection ("requiresHost") matches the host that the unit will actually load into.
  std::string targetHostId() {
    if (snap && cacheOk) {
      auto sel = otacore::selectHost(*snap, hostCtx());
      if (sel.source == otacore::Source::Patch && !bad.count(sel.entry->id)) return sel.entry->id;
    }
    return runningHost;
  }

  // Make sure there is an patch record for this manifest entry. A patch already built on disk goes straight to
  // verification (VerifyPending); otherwise it is Queued for download. `rank` is its download priority (lower =
  // sooner); -1 means a user is waiting for it right now and sticks.
  void considerEntry(const otacore::Entry& e, bool isHost, const std::string& target, int rank, bool resetFailed) {
    if (!usable(e)) return;
    auto it = patches.find(e.id);
    if (it != patches.end() && it->second.hash != e.hash) {  // same id, different content: start over
      if (busy(it->second.s)) return;
      cancelTimer(it->second.retryTimer);
      if (cacheOk) d.fs->remove(cache->builtPath(e.id));
      patches.erase(it);
      it = patches.end();
    }
    if (it == patches.end()) {
      PatchState a;
      a.id = e.id; a.url = e.patchUrl; a.hash = e.hash; a.updateType = e.updateType; a.size = e.size;
      a.target = target; a.isHost = isHost; a.rank = rank; a.seq = ++patchSeq;
      if (cache->has(e.id)) {
        a.s = Stage::VerifyPending;
        std::string v;
        if (d.store->get(kBuilt(e.id), v)) a.builtSize = std::atoll(v.c_str());
      } else a.s = Stage::Queued;
      patches[e.id] = a;
      return;
    }
    PatchState& a = it->second;
    if (a.rank >= 0) a.rank = rank;  // rank -1 (promoted: a user is waiting) sticks
    if (resetFailed && a.s == Stage::Failed) {
      cancelTimer(a.retryTimer);
      a.retries = 0;
      a.s = cache->has(e.id) ? Stage::VerifyPending : Stage::Queued;
    }
  }

  // (Re)computes which patches this device wants, in prefetch order: host, priority units, the rest.
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
      if (sel.source == otacore::Source::Patch && fetchOf(u->name) == Fetch::Lazy && !patches.count(sel.entry->id) &&
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
      for (auto& kv : patches) if (!kv.second.isHost && kv.second.target == n && kv.second.rank >= 0) kv.second.rank = rank;
      rank++;
    }
    pump();
  }

  // Of all patches in state s1 or s2, the one to work on next: lowest rank, then oldest.
  PatchState* pickBest(Stage s1, Stage s2) {
    PatchState* best = nullptr;
    for (auto& kv : patches) {
      PatchState& a = kv.second;
      if (a.s != s1 && a.s != s2) continue;
      if (!best || a.rank < best->rank || (a.rank == best->rank && a.seq < best->seq)) best = &a;
    }
    return best;
  }

  // The work scheduler: start as many builds and downloads as the concurrency limits allow. Called after
  // anything that could unblock work (plan changed, download finished, build finished, network changed).
  // Builds are started before downloads; on a metered network, downloads over the cellular size cap are held back.
  void pump() {
    if (!cacheOk) return;
    while (activeBuild < cfg.maxConcurrentBuilds) {
      PatchState* a = pickBest(Stage::Downloaded, Stage::VerifyPending);
      if (!a) break;
      startWork(*a);
    }
    while (activeDl < cfg.maxConcurrentDownloads) {
      PatchState* a = pickBest(Stage::Queued, Stage::Queued);
      if (!a) break;
      if (d.http->isMetered() && a->size > cfg.patchSizeCapCellular) {
        a->s = Stage::Absent;
        a->blocked = true;
        emit("download-blocked-metered", "", a->id);
        settle(a->id);
        continue;
      }
      startDownload(*a);
    }
  }

  // Ask the platform to download the patch file into the cache. The result arrives as onDownloadDone/Failed.
  void startDownload(PatchState& a) {
    a.s = Stage::Downloading;
    a.blocked = false;
    a.token = ++tokenCtr;
    tokenToPatch[a.token] = a.id;
    activeDl++;
    std::string dest = cache->patchPath(a.id);
    d.fs->remove(dest);
    emit("download-start", a.target, a.id);
    DownloadRequest r;
    r.token = a.token; r.url = a.url; r.destPath = dest; r.maxBytes = a.size;
    d.http->download(r);
  }

  // The platform finished a download. Size must match the manifest exactly; otherwise treat as a transient failure.
  void onDownloadDone(uint64_t token, int64_t bytes) {
    auto t = tokenToPatch.find(token);
    if (t == tokenToPatch.end()) return;
    std::string id = t->second;
    tokenToPatch.erase(t);
    activeDl--;
    auto it = patches.find(id);
    if (it == patches.end() || it->second.s != Stage::Downloading) { pump(); return; }
    PatchState& a = it->second;
    if (bytes != a.size || d.fs->fileSize(cache->patchPath(id)) != a.size) {
      d.fs->remove(cache->patchPath(id));
      emit("download-failed", a.target, id, "size-mismatch");
      failTransient(id, Stage::Queued);
    } else {
      emit("download-done", a.target, id);
      a.s = Stage::Downloaded;
    }
    pump();
  }
  void onDownloadFailed(uint64_t token, const std::string& reason) {
    auto t = tokenToPatch.find(token);
    if (t == tokenToPatch.end()) return;
    std::string id = t->second;
    tokenToPatch.erase(t);
    activeDl--;
    auto it = patches.find(id);
    if (it != patches.end() && it->second.s == Stage::Downloading) {
      d.fs->remove(cache->patchPath(id));
      emit("download-failed", it->second.target, id, reason);
      failTransient(id, Stage::Queued);
    }
    pump();
  }

  // Transient failure: retry with jittered backoff up to maxRetries, then stay Failed until the next
  // manifest swap resets it. Never persisted as bad.
  void failTransient(const std::string& id, Stage retryTo) {
    auto it = patches.find(id);
    if (it == patches.end()) return;
    PatchState& a = it->second;
    a.retries++;
    a.s = Stage::Failed;
    cancelTimer(a.retryTimer);
    if (a.retries <= cfg.maxRetries) {
      a.retryTimer = after(backoff(a.retries), [this, id, retryTo] {
        auto i = patches.find(id);
        if (i == patches.end() || i->second.s != Stage::Failed) return;
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

  // Slow step, done OFF the ota queue on a worker thread:
  //   build  : apply the downloaded diff to the embedded file -> writes the "built" file, sha256-checked by applyPatch
  //   verify : a built file from an earlier run is on disk; re-check its size and sha256 before trusting it
  // The worker only touches local copies (never `this`); the outcome comes back to finishWork on the ota queue.
  void startWork(PatchState& a) {
    const bool build = a.s == Stage::Downloaded;
    a.s = build ? Stage::Building : Stage::Verifying;
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

  // Back on the ota queue with the worker's outcome. IO trouble => retry later (transient). Corrupt/unsafe
  // result => the patch is blacklisted for good. Success => Ready, and anyone waiting for it is woken (settle).
  void finishWork(const std::string& id, bool build, const WorkResult& r) {
    activeBuild--;
    auto it = patches.find(id);
    if (build && cacheOk) d.fs->remove(cache->patchPath(id));  // patch file is not needed after the build
    if (it == patches.end()) { pump(); return; }
    PatchState& a = it->second;
    using S = otacore::Status;
    if (r.st == S::IoError) {
      emit("build-failed", a.target, id, "io-error");
      failTransient(id, build ? Stage::Queued : Stage::VerifyPending);
    } else if (r.st != S::Ok || !r.pathOk || !r.hashOk || r.size < 0) {
      std::string why = r.st != S::Ok ? otacore::statusName(r.st) : !r.pathOk ? "path-escape" : "hash-or-size-mismatch";
      emit("build-failed", a.target, id, why);
      markBad(id, why);
    } else {
      a.builtSize = r.size;
      d.store->put(kBuilt(id), std::to_string(r.size));
      a.s = Stage::Ready;
      a.retries = 0;
      emit(build ? "build-ok" : "verify-ok", a.target, id);
      settle(id);
    }
    pump();
  }

  // An patch reached Ready/Bad/Failed/blocked: wake loads, prewarm and host recreate; schedule GC.
  void settle(const std::string& id) {
    auto it = patches.find(id);
    if (it == patches.end()) return;
    const Stage st = it->second.s;
    const bool isHost = it->second.isHost;
    std::vector<std::string> units;
    for (auto& kv : pins) if (kv.second.st == UnitPin::Loading && kv.second.waitingArt == id) units.push_back(kv.first);
    for (auto& u : units) {
      UnitPin& pin = pins[u];
      if (st == Stage::Ready) {
        cancelTimer(pin.timer);
        pin.waitingArt.clear();
        loadPatchIntoPin(u, id);
      } else if (!waitable(st)) {
        cancelTimer(pin.timer);
        pin.waitingArt.clear();
        evaluateEmbedded(u, "patch-unavailable");
      }
    }
    if (isHost) {
      tryPrewarm();
      considerRecreate(true);
    }
    scheduleGc();
  }

  // Cache garbage collection: delete files for patches that the current manifest no longer lists. Deferred to a
  // later queue turn, and skipped while any file is being written.
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
    for (auto& kv : patches) if (busy(kv.second.s)) return;  // retried when the busy patch settles
    std::vector<std::string> keep = otacore::allEntryIds(*snap);
    std::set<std::string> ref(keep.begin(), keep.end());
    size_t removed = cache->gc(keep);
    for (auto it = patches.begin(); it != patches.end();) {
      if (!ref.count(it->first)) { cancelTimer(it->second.retryTimer); it = patches.erase(it); }
      else ++it;
    }
    for (auto& k : d.store->keys("attempts/")) if (!ref.count(k.substr(9))) d.store->erase(k);
    for (auto& k : d.store->keys("built/")) if (!ref.count(k.substr(6))) d.store->erase(k);
    gcPending = false;
    emit("gc", "", "", std::to_string(removed));
  }

  // Network type changed (e.g. cellular -> Wi-Fi): retry downloads that were held back by the cellular size cap.
  void onNetworkChanged() {
    bool any = false;
    for (auto& kv : patches) {
      if (kv.second.s == Stage::Absent && kv.second.blocked) { kv.second.s = Stage::Queued; any = true; }
    }
    if (any) pump();
  }

  // ------------------------------------------------------------------ pre-evaluate checks (DESIGN 5.8)
  // Last safety net before bytes are handed to Hermes (which would execute them). `persistent` in the result says
  // whether a failure is the PATCH's fault (blacklist it) or a passing environment problem (don't blame it).
  struct Check {
    bool ok = false, persistent = false;
    std::string why;
    std::shared_ptr<const Buffer> buf;
  };
  // The once-per-process content checks (hash, size, canonical path) already ran when the patch became
  // Ready; here: lexical path, map, expected size, 4-byte alignment, Hermes magic and version.
  Check preEvaluate(const std::string& id) {
    Check c;
    auto it = patches.find(id);
    if (it == patches.end() || it->second.s != Stage::Ready) { c.why = "not-ready"; return c; }
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
  // True when the manifest picked a host patch for this device and it is still on its way (queued, downloading,
  // building or verifying). False if there is no manifest yet, no host patch, it is blacklisted, or already done.
  bool hostWaiting() {
    if (!snap || !cacheOk) return false;
    auto sel = otacore::selectHost(*snap, hostCtx());
    if (sel.source != otacore::Source::Patch || bad.count(sel.entry->id)) return false;
    auto it = patches.find(sel.entry->id);
    return it != patches.end() && waitable(it->second.s);
  }

  // Native tells us: "the first (native) page of the app is on screen and usable".
  //
  // Why this exists: creating the React Native VM costs hundreds of milliseconds and a lot of CPU. If we did it
  // during app start-up it would slow the very first screen, which is native and must never wait on anything. If we
  // waited for the user to tap an RN entry point (e.g. "Chat"), the first tap would pay the full VM startup.
  // So we create the VM in the background right AFTER the first page is interactive ("prewarm"): out of the way of
  // start-up, but usually ready before the first tap. This method just records that moment and tries to prewarm.
  void onFirstPageInteractive() {
    firstPage = true;
    tryPrewarm();
  }

  // Create the VM in the background if (and only if) now is a good moment. Safe to call repeatedly; it is called
  // again whenever something changes (first page up, host patch became ready, wait timer fired).
  //
  // The one real decision: should we create the VM from the EMBEDDED host or wait briefly for a PATCHED host?
  //   * A VM runs exactly one host bundle for its whole life; changing the host means destroying the VM and
  //     creating a new one (see considerRecreate). So if a host patch is just about to be ready and we prewarm
  //     right now, we boot the old host, then throw that VM away moments later: wasted work and a visible stall.
  //   * But we also must not delay prewarm indefinitely: the patch may be big, the network slow, or the CDN down.
  // Compromise: if a host patch is selected and still in flight (hostWaiting), wait at most hostSettleMs
  // (~800 ms). If it becomes ready sooner, settle() calls us again and we boot straight from the patched host.
  // If the timer fires first, we prewarm with what is on disk (usually embedded); the patch will be picked up
  // at the next safe moment (VM replaced when no screen is open). We never wait on a manifest that has not arrived
  // (no manifest => hostWaiting() is false => prewarm immediately), and we only ever wait ONCE per process
  // (settleExpired), so this adds at most hostSettleMs to prewarm and never delays the first page or any tap.
  //
  // If the user taps an entry point while we are waiting, submit() creates the VM at once and cancels the wait.
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
  // Patched host used only if: selected for this device, not blacklisted, already built, passes pre-evaluate
  // checks, and its "attempt" was persisted (so a crash while booting it is counted). Otherwise: embedded host.
  void startCreate() {
    cancelTimer(settleTimer);
    vm = VmState::Creating;
    poisoned = false;
    HostSource hs;
    if (snap && cacheOk) {
      auto sel = otacore::selectHost(*snap, hostCtx());
      if (sel.source == otacore::Source::Patch && usable(*sel.entry)) {
        const std::string id = sel.entry->id;
        auto it = patches.find(id);
        if (it != patches.end() && it->second.s == Stage::Ready) {
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

  // The platform reports the result of createVm. On success, answer all requests that queued up meanwhile. If a
  // PATCHED host failed to boot, blacklist it and immediately retry once with the embedded host (never leave the
  // app without a working VM because of a bad patch).
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

  // The VM is gone, so every per-VM decision is void: forget the pins and fail requests still waiting on them.
  void dropPins(const char* err) {
    auto old = std::move(pins);
    pins.clear();
    for (auto& kv : old) {
      cancelTimer(kv.second.timer);
      for (auto& op : kv.second.waiters) fail(op, err);
    }
  }

  // The VM was destroyed (by us, the OS, or the app's lifecycle manager). If WE destroyed it to switch hosts
  // (state Destroying), create the replacement now; otherwise go back to "no VM" until someone needs one.
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

  // Is a better host ready than the one running? (a different, usable, fully built host patch)
  bool hostUpgradeAvailable() {
    if (!snap || !cacheOk) return false;
    auto sel = otacore::selectHost(*snap, hostCtx());
    if (sel.source != otacore::Source::Patch || sel.entry->id == runningHost) return false;
    if (bad.count(sel.entry->id) || !usable(*sel.entry)) return false;
    auto it = patches.find(sel.entry->id);
    return it != patches.end() && it->second.s == Stage::Ready;
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
  // Destroy the VM so onVmDestroyed can create a new one from the new host. While Destroying, new requests queue.
  void beginRecreate() {
    pendingRecreate = false;
    vm = VmState::Destroying;  // recreate lock: openUnit calls queue until the new VM is up
    emit("vm-recreate", kHost, "", poisoned ? "poisoned" : "new-host");
    d.vm->destroyVm();
  }

  // ------------------------------------------------------------------ openUnit / loadUnit
  // Entry point for native requests. If the VM is ready, handle now; if it is being created/replaced, queue until it
  // is up; if there is no VM, an openUnit creates one (a tap never waits for prewarm), a loadUnit fails ("no-vm").
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

  // Handle one request on a running VM. The first request for a unit starts the decision (resolve); requests that
  // arrive while it is pending just wait on the same decision, so the unit is evaluated at most once per VM.
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
    auto it = patches.find(f.id);
    if (it == patches.end() || it->second.s != Stage::Ready) return "file-missing";
    Check c = preEvaluate(f.id);
    if (!c.ok) {
      if (c.persistent) markBad(f.id, c.why);
      return "pre-evaluate-failed:" + c.why;
    }
    return "";
  }

  // THE central decision for one unit in this VM: embedded or patch? In order:
  //   1. pin=Process and a remembered choice exists  -> reuse it if still safe (frozenPatchProblem), else drop it.
  //   2. no verified manifest / no cache             -> embedded.
  //   3. manifest selects embedded for this device   -> embedded (not in rollout, halted, wrong host, ...).
  //   4. selected patch is blacklisted               -> embedded.
  //   5. patch already built                         -> load it now.
  //   6. patch unusable (bad/failed)                 -> embedded.
  //   7. patch still downloading/building            -> latency-first unit (budget 0): embedded now, the patch is
  //      used by a later resolution; otherwise wait up to `loadBudgetMs`, loading the patch the moment it is
  //      ready (settle) or falling back to embedded when the timer expires. The user is waiting, so the patch
  //      is promoted to the front of the download queue (rank -1).
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
    auto it = patches.find(e.id);
    if (it == patches.end()) { evaluateEmbedded(unit, "patch-missing"); return; }
    it->second.rank = -1;  // the user is waiting: promote ahead of prefetch
    if (it->second.s == Stage::Absent) it->second.s = Stage::Queued;
    if (it->second.s == Stage::Queued) pump();
    it = patches.find(e.id);
    if (it == patches.end()) { evaluateEmbedded(unit, "patch-missing"); return; }
    switch (it->second.s) {
      case Stage::Ready: pins[unit].reason = "ok"; loadPatchIntoPin(unit, e.id); return;
      case Stage::Bad: case Stage::Failed: case Stage::Absent: evaluateEmbedded(unit, "patch-unavailable"); return;
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

  // Run the built patch in the VM: pre-evaluate checks -> persist the crash-guard attempt -> evaluate the bytecode
  // -> run the unit's entry module. Each failure blacklists the patch and falls back to embedded. The exception:
  // if the ENTRY module throws, the patch's modules are already registered in the VM and Metro ignores a second
  // definition, so embedded cannot override them; the VM is marked poisoned and replaced, and this request fails.
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

  // Run the unit's embedded (shipped-in-the-binary) bytecode. `why` records the reason for the choice (events only).
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

  // The unit's decision is final (Loaded or Failed): answer every request waiting on it. openUnit also mounts the
  // screen (mountSurface); loadUnit just reports success. Callbacks are posted, not called inline (see complete).
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

  // JS rendered the unit's first frame: the code is healthy. Clear the crash-guard counter of the patch (and of
  // the booted host patch, which is also proven by a healthy RN surface).
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
  auto it = p_->patches.find(id);
  return it == p_->patches.end() ? "unknown" : stageName(it->second.s);
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
