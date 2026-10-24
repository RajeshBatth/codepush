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
  atomically; each unit is pinned (embedded or patch id) for the lifetime of a VM.
* Manifest accept = signature -> `parseManifest` -> platform/appVersion match -> `version >= highest` (equal is
  idempotent) -> persist `highest` (fail closed) -> swap -> replan -> GC. Any failure keeps the old manifest.
  Refresh: conditional GET, next fetch after `ttlSec` (+0..10%, clamped), failures use equal-jitter exponential backoff.
* Artifacts (host and units): Queued -> Downloading -> Downloaded -> Building -> Ready, or (built file already on disk)
  VerifyPending -> Verifying -> Ready. Hash verified once per process on a worker, never at tap time. IO errors are
  transient (bounded retries, never persisted); hash/corrupt/pre-evaluate failures are persisted as bad.
  Download order: host, `setEntryPointPriority` list, the rest; a tapped unit's artifact is promoted. Over the
  cellular size cap on a metered network: deferred until `onNetworkChanged`.
* `openUnit`: ensure VM -> select (current snapshot, running host id) -> patch Ready: pre-evaluate checks, bump
  `attempts` (persisted first), evaluate; patch in flight: wait `unitBudgetMs` then embedded; evaluate failure of a
  patch: mark bad, evaluate embedded; embedded failure: error to the caller, pin is `failed` for this VM (no loop).
* Host: recreate when a newer host is Ready and `mountedSurfaceCount()==0` and no unit load is in flight; otherwise,
  with `recreateAtZeroViews` (default true), at the next zero-views moment. While recreating, `openUnit` calls queue.
* Crash-loop guard: a patch's counter counts *processes* that tried it without `markReady` (once per process per id,
  so a VM recreate in the same process does not double count). At `start()` and at first selection, `attempts >=
  crashLimitK` blacklists the id (persisted). Host: counter written before `createVm`; a patched host whose VM fails
  to create is blacklisted and the VM is created once more from embedded.

## Not in this library

Real `Http/Store/VmController/Worker/Clock` implementations, Ed25519, mmap-based `FileSystem::map`, entry-point
tables, lifecycle-manager policy, pause/resume of the refresh timer when the app is backgrounded.
