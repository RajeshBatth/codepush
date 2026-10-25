// otaruntime: platform-neutral OTA runtime orchestrator (DESIGN 5.2-5.5, 5.8).
// See native/otacore/runtime/README.md. Single-threaded: every member must be called on the ota queue.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "otaruntime/interfaces.h"

namespace otaruntime {

struct UnitConfig {
  std::string name;           // unit name == RN component / surface name
  std::string embeddedHash;   // "sha256:..." of the unit bundle embedded in this binary
  std::string entryModuleId;  // module the unit registers its component from
};

// Lock scope of a unit's selection (which patch id, or embedded).
enum class Pin {
  Vm,       // default: decided when the unit is first loaded into a VM, fixed for that VM's life; a NEW VM re-resolves
            // from the latest manifest (adopts a newer patch, drops a blacklisted/halted one)
  Process,  // opt-in: decided once per process and kept across VM recreation (units with live state outside the VM),
            // dropped only by the safety exceptions when a new VM resolves the unit
};
// When a selected patch is downloaded and applied.
enum class Fetch {
  Eager,  // default: prefetched in the background as soon as the manifest selects it
  Lazy,   // no prefetch: the download+apply starts at the unit's first request (bounded by loadBudgetMs); a patch already
          // on disk is still verified in the background. Wifi/cellular size cap applies unchanged.
};
// Every field is optional so that a per-unit policy overrides only what it names.
struct UnitPolicy {
  std::optional<Pin> pin;
  // How long openUnit/loadUnit waits for a SELECTED patch that is not built yet. Unset = Config::unitBudgetMs.
  // 0 = latency-first: never wait, load embedded at once; the patch is used by the next resolution.
  std::optional<Millis> loadBudgetMs;
  std::optional<Fetch> fetch;

  static UnitPolicy latencyFirst() { UnitPolicy p; p.pin = Pin::Vm; p.loadBudgetMs = 0; p.fetch = Fetch::Eager; return p; }
  static UnitPolicy freshnessFirst(Millis ms) { UnitPolicy p; p.pin = Pin::Vm; p.loadBudgetMs = ms; p.fetch = Fetch::Eager; return p; }
  static UnitPolicy stable() { UnitPolicy p; p.pin = Pin::Process; return p; }
};

struct Config {
  // identity of this binary (must match the signed manifest)
  std::string platform, appVersion, buildNumber;
  std::string cacheBaseDir;  // app-private, non-purgeable
  std::string manifestUrl;   // <cdn>/<platform>/<app-version>/manifest.json
  std::vector<std::string> supportedAlgos{"v1"};
  uint32_t bytecodeVersion = 0;  // Hermes HBC version of this runtime
  std::string hostEmbeddedHash;
  std::string hostBucketKey = "mainBundle";  // bucket(deviceId, key) decides the host rollout
  std::vector<UnitConfig> units;

  // Version stability and load behaviour are a POLICY PER UNIT (README "Unit policy"). `defaultPolicy` applies to every
  // unit; `unitPolicy[unit]` overrides it field by field (unset fields fall through to defaultPolicy, then to the
  // built-in defaults: pin=Vm, loadBudgetMs=unitBudgetMs, fetch=Eager).
  UnitPolicy defaultPolicy;
  std::map<std::string, UnitPolicy> unitPolicy;

  // tunables (DESIGN 5.8 [DECIDE]s)
  Millis hostSettleMs = 800;
  Millis unitBudgetMs = 1000;  // default loadBudgetMs of a unit
  bool prewarm = true;
  bool recreateAtZeroViews = true;  // 5.4 open question: recreate VM at the next zero-views moment
  int crashLimitK = 2;              // unconfirmed process attempts before a patch is blacklisted
  int64_t patchSizeCapCellular = 512 * 1024;
  int maxConcurrentDownloads = 2;
  int maxConcurrentBuilds = 1;
  int maxRetries = 3;  // per artifact: download and build/verify IO failures
  Millis backoffBaseMs = 5000, backoffMaxMs = 300000;
  Millis minRefreshMs = 10000, maxRefreshMs = 3600000;
  uint64_t randomSeed = 1;  // jitter + generated deviceId; the platform should pass a random seed
  std::string deviceId;     // optional override; otherwise persisted/generated
};

// Non-owning references; all must outlive the Runtime. `observer` may be null.
struct Deps {
  Clock* clock = nullptr;
  Scheduler* scheduler = nullptr;
  Worker* worker = nullptr;
  Http* http = nullptr;
  FileSystem* fs = nullptr;
  Store* store = nullptr;
  SignatureVerifier* verifier = nullptr;
  VmController* vm = nullptr;
  EmbeddedAssets* assets = nullptr;
  PatchBuilder* builder = nullptr;
  Observer* observer = nullptr;
};

struct OpenResult {
  bool ok = false;
  std::string error;    // when !ok
  std::string source;   // "embedded" | "patch"
  std::string patchId;  // when source == "patch"
};
// Always invoked exactly once, asynchronously via Scheduler::post (never inside the calling method).
using OpenCallback = std::function<void(const OpenResult&)>;

enum class VmState { None, Creating, Running, Destroying };
const char* vmStateName(VmState s);

class Runtime {
 public:
  Runtime(Config cfg, Deps deps);
  ~Runtime();
  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;

  // ---- commands
  void start();  // app launch; idempotent
  void onFirstPageInteractive();
  // Units reachable from visible native entry points, most important first (prefetch order after the host).
  void setEntryPointPriority(const std::vector<std::string>& units);
  // Native entry point (DESIGN 5.8): ensure VM, resolve, evaluate, run entry module, mount the surface.
  void openUnit(const std::string& unit, const std::string& propsJson, OpenCallback cb);
  // lazyUnit fallback (JS asked for a unit inside a running VM): same resolution, no surface mount.
  void loadUnit(const std::string& unit, OpenCallback cb);
  // JS rendered the unit's first frame: confirms the patch (and the booted host patch), clears attempts.
  void markReady(const std::string& unit);

  // ---- events from the platform
  void onVmCreated(bool ok);
  void onVmDestroyed();  // also for VM destruction not initiated by the runtime (lifecycle manager, OS)
  void onSurfaceMounted();
  void onSurfaceUnmounted();
  void onNetworkChanged();  // e.g. metered -> Wi-Fi: retries artifacts blocked by the cellular cap
  void onManifestFetched(uint64_t token, const ManifestResponse& r);
  void onManifestFailed(uint64_t token, const std::string& reason);
  void onDownloadDone(uint64_t token, int64_t bytes);
  void onDownloadFailed(uint64_t token, const std::string& reason);

  // ---- introspection (tests, diagnostics)
  VmState vmState() const;
  std::string runningHostId() const;  // "embedded" when no VM or embedded host
  int64_t manifestVersion() const;    // 0 when no manifest is loaded
  std::string deviceId() const;
  // Artifact state for an entry id: "absent|queued|downloading|downloaded|verify-pending|building|
  // verifying|ready|failed|bad" or "unknown".
  std::string artifactState(const std::string& entryId) const;
  bool isBlacklisted(const std::string& entryId) const;
  // "" (not pinned) | "loading" | "embedded" | "patch:<id>" | "failed"
  std::string pinOf(const std::string& unit) const;
  // "" (nothing frozen) | "embedded" | "patch:<id>": the process-wide frozen selection of a unit (pin=Process only).
  std::string frozenOf(const std::string& unit) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> p_;
};

}  // namespace otaruntime
