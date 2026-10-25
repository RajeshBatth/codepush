# 05 - Client runtime

**Purpose:** How a device decides which host and unit bytes to run, loads them into the Hermes VM and protects itself; what is implemented in C++ and what is still platform glue.
**Audience:** Native engineers (Android/iOS), SDK implementers, AI assistants editing `native/`.
**Source of truth:** `native/otacore/runtime/{README.md,include/otaruntime/*,src/runtime.cpp}`, `native/otacore/include/otacore/`, `native/tests/runtime/*` (53 scenarios), `examples/spike-app/shared/*`, DESIGN.md sections 5.1-5.9 ([DESIGN.md](../../DESIGN.md)).

Related: [native-api reference](../reference/native-api.md), [platform integration guide](../guides/android-ios-integration.md), [spike results](../spikes/summary.md), [safety table](06-safety-and-failure-modes.md), [manifest and signing](03-manifest-state-and-signing.md), [glossary](../glossary.md).

## 1. What exists vs what is planned

| Piece | Status | Where |
|---|---|---|
| Portable core `otacore` (sha256, bucket, manifest parse/validate, `selectUnit`/`selectHost`, atomic hash-verified `applyPatch`, `Cache`) | implemented, 4 CTest suites | `native/otacore/src`, `native/tests` |
| Orchestrator `otaruntime::Runtime` (state machine of DESIGN 5.8) | implemented, 53 scenario tests on a virtual clock | `native/otacore/runtime` |
| Loader primitives for one platform (mmap, pre-checks, JSI evaluate) | implemented as spike code | `examples/spike-app/shared/` |
| Android/iOS glue that drives the spike | spike quality, **does not use `otaruntime::Runtime`** (it only uses `shared/` and `otacore/src/sha256.cpp`) | `examples/spike-app/android`, `examples/spike-app/ios` |
| Production `Http`, `Store`, `VmController`, `Worker`, `Clock`, `Scheduler`, `EmbeddedAssets` implementations, Ed25519 verify, mmap `FileSystem::map`, entry-point table | **planned / not started** (listed under "Not in this library" in `native/otacore/runtime/README.md`) | n/a |
| Reusable Android library / iOS pod | **planned** (see [adopting guide](../guides/adopting-in-your-monorepo.md)) | n/a |
| `lazyUnit` JS runtime package | spike versions only: `examples/spike-app/src/host/lazyUnit.js`, `examples/demo-app/src/host/lazyUnit.js` | |

## 2. Hybrid lifecycle

The app's first screen is native; no RN VM is needed to render it (DESIGN section 1, 5.8). The design goals in priority order: never delay the native first page; never run unverified code; every failure degrades to the embedded bundle; minimal tap-to-render latency; one C++ implementation of the decisions.

```
app start        Runtime.start()                      cache root, cached manifest (verify -> validate -> anti-replay),
                                                      crash-loop scan, prefetch plan, first (conditional) manifest refresh
first page up    Runtime.onFirstPageInteractive()     VM prewarm (waits <= hostSettleMs only if a host patch is in flight)
entry tap        Runtime.openUnit("cabs", props, cb)  ensure VM -> select -> evaluate -> require entry -> mount surface
JS rendered      Runtime.markReady("cabs")            confirms the patch and the booted host patch
JS inside RN     lazyUnit -> import() -> __loadBundleAsync(name) -> native -> Runtime.loadUnit(name, cb)   (no mount)
```

Native-driven loading (`openUnit`) is the primary path; `lazyUnit` is the fallback for navigation inside RN ([ADR: native-driven loading](decisions/README.md)).

### The ota queue
All decisions run on one serial queue. Every `Runtime` method, `Clock` timer callback, `Scheduler` task, `Worker` `done` callback and `Runtime::on*` event must run on it. Only `Worker` `work` closures run elsewhere (hashing, `applyPatch`, file size, canonical path) and capture plain data. Interface calls never complete synchronously, and `openUnit/loadUnit` callbacks fire exactly once, via `Scheduler::post` (`interfaces.h` header comment, `runtime.h`).

## 3. Resolution, unit policy and pin scope

`Runtime::resolve` (runtime.cpp) implements DESIGN 5.2 for one unit:

1. Use the in-memory manifest snapshot (a `shared_ptr`, swapped atomically); never wait for the network. No manifest or cache unavailable: embedded.
2. `otacore::selectUnit(manifest, unit, ctx)` with `ctx.bucket = bucket(deviceId, unit)`, `embeddedHash`, `supportedAlgos`, `runningHostId`. Reasons: `ok`, `unit-not-in-manifest`, `base-mismatch`, `algo-unsupported`, `no-range-match`, `requires-host-mismatch`. Anything but a usable patch: `select-embedded` event, embedded unit.
3. Patch `Ready` (built and verified on disk): load it. In flight: wait up to the unit's `loadBudgetMs` (default `unitBudgetMs` = 1000 ms; `0` = never wait, counted from resolution start, after the VM exists), then `budget-exceeded` and embedded; the download continues for next time.
4. The result is the unit's **pin** for this VM: `pinOf(unit)` is `""`, `"loading"`, `"embedded"`, `"patch:<id>"` or `"failed"`. Later manifest changes do not affect a pinned unit. Reason it is inherent: Metro's `define` ignores a second definition of an existing module id (spike S6 proved it).
5. Manifest swaps mid-session only affect units not yet loaded, so unit A can be pinned from an older snapshot than unit B (consistency is per unit, not per session; DESIGN 5.5; test `mixed_snapshots_per_unit_pin`).
6. **Unit policy** (`Config::defaultPolicy`, `Config::unitPolicy[unit]`, fields override individually): `pin` (`Vm` default | `Process`), `loadBudgetMs` (default `unitBudgetMs`; `0` = latency-first, load embedded at once if the patch is not already built, the patch is used by the next resolution; larger = freshness-first), `fetch` (`Eager` default | `Lazy`: no prefetch, the download starts at the first request and is bounded by `loadBudgetMs`). Presets: `UnitPolicy::latencyFirst()`, `freshnessFirst(ms)`, `stable()`.
7. **pin = Vm (default)**: step 4 as written: fixed for the VM's life, a NEW VM re-resolves from the latest manifest (adopts a newer patch, drops a blacklisted or halted one), so a process can change a unit's version across VMs. **pin = Process (opt-in, for units with live state across VM recreation)**: the outcome of step 4 (patch id, or embedded, with its reason) is memoized for the process; a recreated VM loads the same entry, a manifest swap takes effect in the next process (prefetch still follows the latest manifest), two simultaneous requests share one decision, a failed resolution is not frozen. Safety exceptions, checked only when a NEW VM resolves the unit: the frozen patch is blacklisted (including the crash-limit), its entry is gone from the current manifest or changed hash or no longer covers this device / host, or the file is missing or fails the pre-evaluate checks. The freeze is then dropped and the normal selection runs. A freeze to embedded is kept. `frozenOf(unit)` reports it; events `selection-frozen`, `selection-reused`, `selection-dropped` carry `scope=vm|process` in the detail. A failed pin re-decides only in a clean VM (poisoned-VM rule, every policy). Tests: `native/tests/runtime/scn_policy.cpp`, `scn_freeze.cpp`.

`requiresHost` entries are only used if `runningHostId` equals it (test `requires_host_skipped_until_vm_runs_host`). Prefetch resolves `requiresHost` against the host the runtime is heading to.

## 4. Patches: download, build, verify

Every host or unit patch entry becomes a patch (tracked by `PatchState`) with stages `absent|queued|downloading|downloaded|verify-pending|building|verifying|ready|failed|bad` (`Runtime::artifactState`). Flow: download patch -> `PatchBuilder::build(old=embedded source, patch, out=cache/<id>.bundle, expectedHash=entry.hash)` on a `Worker` -> `ready`. A built file already on disk goes `verify-pending -> verifying -> ready` (sha256 once per process, on a worker, never at tap time). `updateType: "full"` uses an empty old source with the same apply code (test `full_update_type_uses_empty_old_source`).

* Download order: host, then `setEntryPointPriority` list, then the rest; a tapped unit's patch is promoted. `maxConcurrentDownloads=2`, `maxConcurrentBuilds=1`.
* Metered network and patch size above `patchSizeCapCellular` (512 KiB): deferred until `onNetworkChanged` (`download-blocked-metered`).
* Manifest `size` is the **patch** size (download size); built size is stored locally under `built/<id>`.
* IO errors are transient: jittered backoff up to `maxRetries` (3), reset on the next manifest swap, never persisted as bad. Hash mismatch, corrupt patch and pre-evaluate failures are persisted (`bad/<id>`).
* After each manifest swap the cache is garbage collected (`gc` event): everything the manifest no longer references, plus sibling roots of other app versions (done in `Cache` constructor).

## 5. Pre-evaluate checks (`Runtime::preEvaluate`)

All must pass before bytes reach Hermes; failure persists the id as bad and loads embedded:

1. patch stage is `ready`; path under the cache root, no `..` (`path-escape`);
2. `FileSystem::map` succeeds (`map-failed` is transient, not persisted);
3. size equals the recorded built size (`size-mismatch`);
4. `checkHermesBytecode` (`hermes.h`): 4-byte aligned (`misaligned`), at least 12 bytes (`too-small`), magic `0x1F1903C103BC1FC6` at offset 0 (`bad-magic`; otherwise Hermes would compile the bytes as JS **source**), u32 LE version at offset 8 equals `Config::bytecodeVersion` (`bad-version`).
5. sha256 of the built file was verified in the build stage.

Then `bumpAttempt(id)` (persisted first; failure uses embedded, event `attempt-persist-failed`), `VmController::evaluateUnit`, `VmController::requireEntry`. An `evaluateUnit` failure registered nothing, so the VM is clean and embedded is evaluated. A `requireEntry` failure after a successful evaluate **pollutes the VM** (modules are registered; embedded cannot override): the patch is marked bad, that call fails, `poisoned=true` and the VM is recreated at the next zero-views moment (test `entry_failure_poisons_vm`). If the embedded unit itself fails, the pin is `failed` and the error is reported once, no loop.

## 6. Crash-loop guard

Persisted in `Store` as `attempts/<id>`. The counter counts **processes**, not VM creations: bumped once per process per id. `markReady(unit)` erases it for the unit's patch and for the booted host patch. At `start()` and at first selection, `attempts >= crashLimitK` (default 2) persists `bad/<id>` (`blacklisted` event, detail `crash-loop`); so a patch survives two unconfirmed processes and is blacklisted at the third start. Host: counter written before `createVm`; if creating a patched host fails (`onVmCreated(false)`), the host is blacklisted and the VM is created once more from embedded (test `patched_host_boot_failure_falls_back_once`). A blacklisted id is retried only if the manifest offers a different id. Tests: `crash_loop_unit_blacklists_after_k_attempts`, `crash_loop_host_boot_guard`, `mark_ready_clears_attempts`.

## 7. Host (mainBundle) swap

The host is chosen from disk at VM creation, never from the network. If a newer host becomes `ready` after a VM exists:

| Situation | Behaviour | Test |
|---|---|---|
| host patch ready before prewarm | one VM, from the patched host | `host_patch_before_prewarm_single_vm` |
| ready, `mountedSurfaceCount()==0`, no unit load in flight | `destroyVm`, then `createVm` from the new host (`vm-recreate`) | `host_patch_after_prewarm_no_views_recreates` |
| surfaces mounted | wait; with `recreateAtZeroViews` (default true) recreate at next zero-views moment | `host_patch_with_views_waits_for_zero_views`, `..._flag_off_never_recreates` |
| unit load in flight | defer | `recreate_waits_for_inflight_load` |
| `openUnit` during recreate | queued until the new VM is ready | `open_during_recreate_is_queued` |

`hostBucketKey` (default `"mainBundle"`) is the second input of the host's bucket. All pins are cleared on VM destroy and re-resolve from the latest manifest. Host patches in production are Phase 2 (DESIGN 7.4); the runtime and manifest already support them.

## 8. Manifest acceptance

Order (README "Behaviour"): signature (`SignatureVerifier`) -> `parseManifest` -> `platform`/`appVersion` equal the binary's -> `version >= highestManifestVersion` (equal is idempotent) -> persist `highestManifestVersion` first (fail closed) -> swap snapshot -> replan -> GC. Any failure keeps the old manifest (events `manifest-rejected`, `manifest-fetch-failed`). Refresh is a conditional GET (`ifNoneMatch`), next fetch after `ttlSec` (+0..10%, clamped to `minRefreshMs`..`maxRefreshMs`), failures use equal-jitter exponential backoff (`backoffBaseMs=5000`, max 300000). Cold start with no cache uses embedded only. Tests: `scn_manifest.cpp`. Signing format: [03](03-manifest-state-and-signing.md).

## 9. Events

`Observer::onEvent(Event{kind, unit, id, detail})` is the SDK's telemetry hook (DESIGN 8, 9: no built-in telemetry). Kinds emitted by `runtime.cpp`: `patch-bad`, `blacklisted`, `crash-suspected`, `cache-unavailable`, `manifest-accepted|rejected|same|not-modified|fetch-failed|persist-failed`, `download-start|done|failed|blocked-metered`, `build-start|ok|failed`, `verify-start|ok`, `gc`, `prewarm-settle-expired`, `vm-create|created|create-failed|destroyed|recreate`, `select-embedded`, `selection-frozen|reused|dropped`, `budget-exceeded`, `pre-evaluate-failed`, `attempt-persist-failed`, `evaluate-failed`, `entry-failed`, `unit-loaded`, `unit-failed`, `confirmed`. The DESIGN callbacks `onApplied/onConfirmed/onRolledBack` and `getActivePatch(unit)` are **planned** SDK-facing wrappers; today `Runtime::pinOf` and these events are the available data.

## 10. JS-side contract with the host bundle

* `global.__loadBundleAsync = (name) => NativeOtaUnits.load(name)` (defined by the host only if the native module exists; RN defines its own only under `__DEV__`, so do not split dev builds): `examples/spike-app/src/host/loader.js`.
* `globalThis.__otaRequire(id)`: hides `ErrorUtils`, calls `__r(id)`, restores in `finally`, so an exception in an entry module reaches native instead of `reportFatalError` (release crash). `ota_unit_jsi.h` prefers it and falls back to `__r`. Details: [native-api](../reference/native-api.md).
* Entry module ids are 48-bit numbers: pass as `double`. Units contain only `__d(...)`, so a failure before registration leaves the VM clean.

## 11. What the spike proved (Android, emulator) and did not

Proved (S1-S10 pass): aligned mmap'd `.hbc` evaluates after the host through `invokeAsync`; wrong version fails inside Hermes with nothing executed; throwing entry is catchable via `__otaRequire`; second definition ignored (pin is real); stale runtime handles detectable; in-process host swap works when the host uses a dynamic `JSBundleLoader`; `import()` through `NativeOtaUnits`. Not proved: any iOS run, release builds, physical devices, cold-process patched-host boot, large units, and the `otaruntime::Runtime` driving real glue. See [spikes/summary.md](../spikes/summary.md).

## 12. Known limits of the C++ tests
Real-thread behaviour of `Worker` (serialised in tests), real `Http/Store/VmController/EmbeddedAssets`, Ed25519, mmap, backgrounding the refresh timer, and the entry-point table feeding `setEntryPointPriority` are untested (README "Not in this library"; DESIGN 5.8 "Not yet covered").
