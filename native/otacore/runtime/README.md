# otaruntime: OTA runtime orchestrator

Platform-neutral C++17 implementation of the loader state machine of `DESIGN.md` 5.2-5.5 and 5.8. Kotlin and
ObjC++ only implement the interfaces in `include/otaruntime/interfaces.h` and forward events.

```
include/otaruntime/interfaces.h   Clock Scheduler Worker Http FileSystem Store SignatureVerifier
                                  EmbeddedAssets PatchBuilder VmController Observer
include/otaruntime/runtime.h      Config, Deps, Runtime
include/otaruntime/hermes.h       bytecode header check (magic, version, alignment)
include/otaruntime/defaults.h     StdFileSystem, DefaultPatchBuilder (otacore::applyPatch), aligned Buffer
src/runtime.cpp                   the whole state machine (one file, pimpl)
```

## Threading model

One serial "ota queue". Every `Runtime` method, every `Clock` timer callback, every `Scheduler` task, every
`Worker` `done` callback and every `Runtime::on*` event must run on it. No locks, no atomics, no exceptions. Only
`Worker` `work` closures run elsewhere (hashing, `applyPatch`, file size/canonical path); they capture plain data.
Interface calls never complete synchronously (the Runtime is never re-entered from inside its own call), and
`openUnit/loadUnit` callbacks are always delivered through `Scheduler::post`.

## API

```cpp
Runtime rt(Config, Deps);
rt.start();                           // cache setup (+ other-version roots deleted), cached manifest (verify ->
                                      // validate -> anti-replay), crash-loop scan, prefetch plan, first refresh
rt.onFirstPageInteractive();          // VM prewarm (waits <= hostSettleMs only for an in-flight host patch)
rt.setEntryPointPriority({"cabs"});   // prefetch order after the host
rt.openUnit("cabs", propsJson, cb);   // 5.8 entry point path; cb(OpenResult{ok,error,source,patchId}) once
rt.loadUnit("cabs", cb);              // lazyUnit fallback: same resolution, no surface mount, needs a VM
rt.markReady("cabs");                 // JS rendered: confirms the patch and the booted host patch
// events: onVmCreated(ok) onVmDestroyed() onSurfaceMounted() onSurfaceUnmounted() onNetworkChanged()
//         onManifestFetched(token,resp) onManifestFailed(token,why) onDownloadDone(token,bytes) onDownloadFailed(token,why)
```

`Http` is request/event style: `fetchManifest(req)` and `download(req)` return immediately; the glue later calls
the matching `Runtime::on*` with `req.token`. `VmController::createVm/destroyVm` are asynchronous the same way
(`onVmCreated/onVmDestroyed`); `evaluateUnit/requireEntry/mountSurface/mountedSurfaceCount` are synchronous
(`mountedSurfaceCount()` must already include a surface whose `mountSurface` returned true).

`Store` keys used: `deviceId`, `highestManifestVersion`, `manifest.body|sig|keyId|etag` (last good manifest),
`attempts/<id>`, `bad/<id>` (blacklist and bad builds), `built/<id>` (size of the verified built file).
`Store::put` must be durable when it returns true; a failed `attempts/` write makes the runtime use embedded.

## Behaviour (all covered by `tests/runtime/`)

* Never waits for the manifest; VM host comes from disk only; the manifest snapshot is one `shared_ptr` swapped
  atomically; each unit is pinned (embedded or patch id) for the lifetime of a VM; an opt-in per-unit policy can lock it for the process (below).
* Manifest accept = signature -> `parseManifest` -> platform/appVersion match -> `version >= highest` (equal is
  idempotent) -> persist `highest` (fail closed) -> swap -> replan -> GC. Any failure keeps the old manifest.
  Refresh: conditional GET, next fetch after `ttlSec` (+0..10%, clamped), failures use equal-jitter exponential backoff.
* Patches (host and units; the per-patch progress record is `PatchState`): Queued -> Downloading -> Downloaded -> Building -> Ready, or (built file already on disk)
  VerifyPending -> Verifying -> Ready. Hash verified once per process on a worker, never at tap time. IO errors are
  transient (bounded retries, never persisted); hash/corrupt/pre-evaluate failures are persisted as bad.
  Download order: host, `setEntryPointPriority` list, the rest; a tapped unit's patch is promoted. Over the
  cellular size cap on a metered network: deferred until `onNetworkChanged`.
* `openUnit`: ensure VM -> select (current snapshot, running host id) -> patch Ready: pre-evaluate checks, bump
  `attempts` (persisted first), evaluate; patch in flight: wait the unit's `loadBudgetMs` (default `unitBudgetMs`; 0 = never wait) then embedded; evaluate failure of a
  patch: mark bad, evaluate embedded; embedded failure: error to the caller, pin is `failed` for this VM (no loop).
* Host: recreate when a newer host is Ready and `mountedSurfaceCount()==0` and no unit load is in flight; otherwise,
  with `recreateAtZeroViews` (default true), at the next zero-views moment. While recreating, `openUnit` calls queue.
* Crash-loop guard: a patch's counter counts *processes* that tried it without `markReady` (once per process per id,
  so a VM recreate in the same process does not double count). At `start()` and at first selection, `attempts >=
  crashLimitK` blacklists the id (persisted). Host: counter written before `createVm`; a patched host whose VM fails
  to create is blacklisted and the VM is created once more from embedded.

## Unit policy

Version stability and load behaviour are a policy PER UNIT: `Config::defaultPolicy` plus `Config::unitPolicy[unit]`
(a unit's set fields override the default's, field by field; unset fields fall through to the built-in defaults).

| field | values | default | meaning |
|---|---|---|---|
| `pin` | `Pin::Vm` / `Pin::Process` | `Vm` | lock scope of the unit's selection |
| `loadBudgetMs` | ms | `Config::unitBudgetMs` | how long `openUnit/loadUnit` waits for a SELECTED patch that is not built yet; `0` = latency-first (never wait: embedded at once if the patch is not already built; the download/build goes on, the next resolution uses it) |
| `fetch` | `Fetch::Eager` / `Fetch::Lazy` | `Eager` | `Lazy`: no prefetch download; it starts at the unit's first request, bounded by `loadBudgetMs` (a patch already on disk is still verified in the background; the cellular size cap applies unchanged) |

Presets: `UnitPolicy::latencyFirst()` {Vm, 0, Eager}, `UnitPolicy::freshnessFirst(ms)` {Vm, ms, Eager},
`UnitPolicy::stable()` {Process}. Example: `cfg.unitPolicy["chat"] = UnitPolicy::stable();`.

### pin = Vm (default)

A unit's selection is decided when it is first loaded into a VM and is fixed for that VM's life (a newer patch is
not adopted inside the VM). A NEW VM re-resolves from the latest manifest: it adopts a newer patch and naturally
drops blacklisted or halted entries, so one process can change a unit's version across VMs. A failed pin stays
failed for that VM (no loop). Observer: `selection-frozen` (detail `<patch|embedded>:<reason> scope=vm`) at each load.

### pin = Process (opt-in, for units that hold live state across VM recreation)

1. The first time a unit is requested its selection is decided as usual and then FROZEN: the outcome (a patch entry
   id, or embedded, plus the reason) is memoized for the process. Concurrent requests share one decision. Prefetch
   keeps following the latest manifest but never changes the frozen choice.
2. A later manifest swap does not change it in this process; it takes effect in the next process (a new `Runtime`
   on the same `Store`).
3. VM recreation (host swap, lifecycle destroy) keeps the frozen selection. A freeze to embedded (no patch, budget
   expired, requires-host mismatch, bad patch fallback) is kept like any other. The attempt counter is bumped once
   per process.
4. Safety exceptions, checked only when a NEW VM resolves the unit (never inside a live VM). The freeze is dropped,
   `selection-dropped` carries the reason, and the normal selection runs against the latest manifest, if
   (a) the frozen patch is blacklisted (`blacklisted`; hash/corrupt/evaluate/pre-evaluate failure, crash-loop),
   (b) its entry is no longer in the current manifest (`removed-from-manifest`: halt, rollback, superseded), changed
   hash (`entry-changed`), or the selection no longer picks it for this device (`no-range-match`,
   `requires-host-mismatch`, `base-mismatch`, `algo-unsupported`),
   (c) the file is missing or fails the pre-evaluate checks (`file-missing`, `pre-evaluate-failed:<why>`), or an
   evaluate/attempt-persist of it fails in the new VM.
5. A failed resolution (embedded failed too) is never frozen: the next request re-decides, but only in a CLEAN VM
   (see the poisoned-VM rule).
6. Observer: `selection-frozen` (once per new freeze), `selection-reused`, `selection-dropped`; detail ends with
   `scope=process`. `frozenOf(unit)` returns `""`, `"embedded"` or `"patch:<id>"`.

Poisoned-VM rule (every policy): a patch whose entry threw after its modules registered poisons the VM; a failed
pin re-decides only in a clean (replaced) VM.

Lazy fetch: implemented (`replan` skips the unit unless the patch is already on disk; `resolve` promotes and
downloads at the request). Freshness then shifts to the next resolution unless `loadBudgetMs` covers the download.

Tests: `tests/runtime/scn_policy.cpp` (policy) and `scn_freeze.cpp` (pin=Process, set explicitly). Suite-wide
default override: `RT_PIN=process|vm` (alias `RT_FREEZE=1|0`).

## Not in this library

Real `Http/Store/VmController/Worker/Clock` implementations, Ed25519, mmap-based `FileSystem::map`, entry-point
tables, lifecycle-manager policy, pause/resume of the refresh timer when the app is backgrounded.
