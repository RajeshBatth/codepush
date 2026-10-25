// INTERNAL header of the runtime orchestrator (not part of the public API; include "otaruntime/runtime.h" instead).
// It holds the shared state (`Runtime::Impl`) and the list of its methods. The method bodies live in runtime_*.cpp files:
//   runtime_support.cpp  helpers, policy lookup     crash_guard.cpp   attempt counters + blacklist
//   manifest_sync.cpp    start-up + manifest        patch_pipeline.cpp  download/build/verify + safety checks
//   vm_lifecycle.cpp     prewarm + VM create/replace   unit_loader.cpp  openUnit/loadUnit + resolve
// Everything runs on the single ota queue (see interfaces.h).
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
#pragma once

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <set>
#include <utility>

#include "otaruntime/runtime.h"

namespace otaruntime {
namespace internal {
const char kEmbedded[] = "embedded";
const char kHost[] = "host";

inline std::string kAttempts(const std::string& id) { return "attempts/" + id; }
inline std::string kBad(const std::string& id) { return "bad/" + id; }
inline std::string kBuilt(const std::string& id) { return "built/" + id; }

// Stage of a patch. Lifecycle: Queued -> Downloading -> Downloaded -> Building -> Ready
//                     (built file already on disk) VerifyPending -> Verifying -> Ready
//                     transient IO trouble -> Failed (maybe retried), corrupt/unsafe -> Bad (persisted)
enum class Stage { Absent, Queued, Downloading, Downloaded, VerifyPending, Building, Verifying, Ready, Failed, Bad };

inline const char* stageName(Stage s) {
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
inline bool waitable(Stage s) {
  return s == Stage::Queued || s == Stage::Downloading || s == Stage::Downloaded || s == Stage::VerifyPending ||
         s == Stage::Building || s == Stage::Verifying;
}
// States that touch files on disk right now (cache GC must not run).
inline bool busy(Stage s) { return s == Stage::Downloading || s == Stage::Downloaded || s == Stage::Building || s == Stage::Verifying; }

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

struct WorkResult {
  otacore::Status st = otacore::Status::Ok;
  bool pathOk = false, hashOk = false;
  int64_t size = -1;
};

// Last safety net before bytes are handed to Hermes (which would execute them). `persistent` in the result says
// whether a failure is the PATCH's fault (blacklist it) or a passing environment problem (don't blame it).
struct Check {
  bool ok = false, persistent = false;
  std::string why;
  std::shared_ptr<const Buffer> buf;
};

}  // namespace internal
using namespace internal;

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

  // ---- methods (bodies: see the runtime_*.cpp files named in the header comment) ----

  // runtime_support.cpp
  uint64_t rnd();
  double r01();
  void emit(const char* kind, const std::string& unit = "", const std::string& id = "", const std::string& detail = "");
  TimerId after(Millis ms, std::function<void()> fn);
  void cancelTimer(TimerId& t);
  void complete(OpenCallback& cb, OpenResult r);
  void fail(Op& op, const std::string& err);
  Millis backoff(int n);
  const UnitConfig* findUnit(const std::string& n) const;
  double bucketOf(const std::string& key);
  otacore::SelectContext unitCtx(const UnitConfig& u, const std::string& running);
  otacore::SelectContext hostCtx();
  int loadsInFlight() const;
  Pin pinOfUnit(const std::string& unit) const;
  Millis budgetOf(const std::string& unit) const;
  Fetch fetchOf(const std::string& unit) const;
  bool freezes(const std::string& unit) const;
  const char* scopeName(const std::string& unit) const;
  void freezeNow(const std::string& unit, const UnitPin& pin);
  void dropFreeze(const std::string& unit, const std::string& reason);
  void dropFreezeIfPatch(const std::string& unit, const std::string& id, const std::string& reason);

  // crash_guard.cpp
  void markBadId(const std::string& id, const std::string& why);
  void markBad(const std::string& id, const std::string& why);
  int attemptsOf(const std::string& id);
  bool usable(const otacore::Entry& e);
  bool bumpAttempt(const std::string& id);

  // manifest_sync.cpp
  void start();
  void loadCached();
  Acc accept(const std::string& body, const std::string& sig, const std::string& key, const std::string& et, bool cached, std::string& detail);
  void doRefresh();
  void scheduleRefresh(Millis delay);
  void refreshOk();
  void refreshFailed();
  void onManifestFetched(uint64_t token, const ManifestResponse& r);
  void onManifestFailed(uint64_t token, const std::string& reason);
  void afterSwap();

  // patch_pipeline.cpp
  std::string targetHostId();
  void considerEntry(const otacore::Entry& e, bool isHost, const std::string& target, int rank, bool resetFailed);
  void replan(bool resetFailed);
  void setPriority(const std::vector<std::string>& units);
  PatchState* pickBest(Stage s1, Stage s2);
  void pump();
  void startDownload(PatchState& a);
  void onDownloadDone(uint64_t token, int64_t bytes);
  void onDownloadFailed(uint64_t token, const std::string& reason);
  void failTransient(const std::string& id, Stage retryTo);
  void startWork(PatchState& a);
  void finishWork(const std::string& id, bool build, const WorkResult& r);
  void settle(const std::string& id);
  void scheduleGc();
  void runGc();
  void onNetworkChanged();
  Check preEvaluate(const std::string& id);

  // vm_lifecycle.cpp
  bool hostWaiting();
  void onFirstPageInteractive();
  void tryPrewarm();
  void startCreate();
  void onVmCreated(bool ok);
  void dropPins(const char* err);
  void onVmDestroyed();
  bool hostUpgradeAvailable();
  void considerRecreate(bool readyMoment);
  void beginRecreate();

  // unit_loader.cpp
  void submit(Op op);
  void runOp(Op op);
  std::string frozenPatchProblem(const std::string& unit, const Frozen& f);
  void resolve(const std::string& unit);
  void loadPatchIntoPin(const std::string& unit, const std::string& id);
  void evaluateEmbedded(const std::string& unit, const std::string& why);
  void failPin(const std::string& unit, const std::string& err);
  void serve(const std::string& unit);
  void markReady(const std::string& unit);
  void onSurfaceUnmounted();
};

}  // namespace otaruntime
