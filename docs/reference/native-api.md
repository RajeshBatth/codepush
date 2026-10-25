# Native API reference

**Purpose:** Exact C/C++ APIs of `otacore` and `otaruntime`, the interfaces platform glue must implement, and the JS-facing contract.
**Audience:** Android/iOS engineers writing glue; AI assistants editing `native/`.
**Source of truth:** `native/otacore/include/otacore/{otacore.h,otacore_c.h}`, `native/otacore/runtime/include/otaruntime/{interfaces.h,runtime.h,hermes.h,defaults.h}`, `native/otacore/runtime/src/{runtime.cpp,defaults.cpp}`, `examples/spike-app/shared/*`, `examples/spike-app/src/host/loader.js`. Behaviour narrative: [05-client-runtime](../architecture/05-client-runtime.md).

Rules common to both libraries: C++17, no exceptions across the API, no platform headers, all free functions reentrant, a `Manifest` is immutable after parsing. Build/test commands: [native/README.md](../../native/README.md) (note the broken-ccache compiler flags in [troubleshooting](../guides/troubleshooting.md)).

## 1. `otacore` (namespace `otacore`, `otacore.h`)

| Area | API | Contract |
|---|---|---|
| sha256 | `Sha256{update,finish,reset}`, `sha256Hash(ptr,len)`, `sha256File(path,out)`, `isHash(s)` | strings are `"sha256:<64 lowercase hex>"` |
| bucket | `double bucket(deviceId, unit)` | `sha256(utf8(deviceId) 0x0A utf8(unit))`, first 4 bytes big-endian / 2^32, in [0,1). Wrappers must pass UTF-8. Vectors: `packages/ota-core/vectors/bucket.json` (24 cases) |
| manifest | `ParseResult parseManifest(json)` | validates schema, hash format, ranges in [0,1] and disjoint, duplicate ids, `requiresHost` refs, ttl/version. On `!ok` keep the old manifest. **Does not verify the signature**: call only on bytes that passed `SignatureVerifier` |
| select | `selectUnit(m, unit, SelectContext)`, `selectHost(m, ctx)` -> `Selection{source, entry*, reason}` | reasons: `ok`, `unit-not-in-manifest`, `base-mismatch`, `algo-unsupported`, `no-range-match`, `requires-host-mismatch`. `entry` points into the `Manifest` (keep it alive). Vectors: `vectors/select.json` (32 cases) |
| patch | `applyPatch(RandomAccessSource&, patchFile, outFile, expectedBuiltHash)`, file-path overload, `applyPatchMemory` | writes `outFile.tmp`, hashes while writing, fsyncs, renames atomically; on any failure no temp file remains and an existing `outFile` is untouched. `Status`: `Ok, IoError, PatchCorrupt, HashMismatch, UnsupportedAlgo` |
| sources | `RandomAccessSource{size(),read(off,buf,len)}`, `FileSource`, `MemorySource` | platform wrappers implement it over `AAsset` / bundle files; `read` returns false on any failure/out of range |
| cache | `Cache(baseDir, versionName, buildNumber)`, `root()`, `builtPath(id)`, `patchPath(id)`, `has(id)`, `gc(keepIds)`, `allEntryIds(m)` | layout `<base>/codepush/<ver>-<build>/<id>.bundle`; the constructor deletes sibling roots of other versions; ids containing `/` or `..` rejected |
| misc | `compiledPatchCompressors()` | e.g. `{"none","zstd","lzma"}` |

Patch format: HDiffPatch "single compressed diff" (`patchAlgoVer` `v1`), applied by streaming (`patch_single_stream`); memory bounded by `stepMemSize` (256 KiB default, capped at 64 MiB on untrusted headers).

### C API (`otacore_c.h`, for JNI/ObjC/Swift)
Strings are UTF-8; returned `char*` is malloc'ed, release with `otacore_free`.

| Function | Returns |
|---|---|
| `otacore_sha256(data,len)`, `otacore_sha256_file(path)` | `"sha256:<hex>"` or NULL on IO error |
| `otacore_bucket(device_id, unit)` | double |
| `otacore_validate_manifest(json,len,&errors)` | 1 valid / 0 (errors newline separated) |
| `otacore_select(json,len,unit_or_NULL,bucket,embedded_hash,"v1,..",running_host_id)` | JSON `{"source","reason","entry":{id,patchUrl,hash,size,updateType}}`; invalid manifest -> reason `invalid-manifest`, source `embedded` |
| `otacore_apply_patch(old,patch,out,expected)` | `OTACORE_OK=0, IO_ERROR=1, PATCH_CORRUPT=2, HASH_MISMATCH=3, UNSUPPORTED_ALGO=4` |
| `otacore_apply_patch_source(const otacore_source*,patch,out,expected)` | same codes; `otacore_source{ctx,size,read(ctx,off,buf,len)->1/0}` |

The C API result JSON omits `requiresHost` and the range (it carries only id/patchUrl/hash/size/updateType).

## 2. `otaruntime` (namespace `otaruntime`)

### 2.1 Threading contract (interfaces.h header)
One serial "ota queue". `Runtime` methods, `Clock` timer callbacks, `Scheduler` tasks, `Worker` `done` callbacks and every `Runtime::on*` event run on it, never concurrently. Only `Worker::run`'s `work` runs elsewhere and must not touch the `Runtime`. Interface calls never invoke completions synchronously. No exceptions cross any interface.

### 2.2 Interfaces the platform implements

| Interface | Methods | Notes for implementers |
|---|---|---|
| `Clock` | `Millis nowMs()` (monotonic); `TimerId schedule(delayMs, Task)`; `cancel(TimerId)` | timer callback on the ota queue; id 0 invalid; cancel of fired/unknown id is a no-op |
| `Scheduler` | `post(Task)` | run on the ota queue after the current task |
| `Worker` | `run(Task work, Task done)` | `work` on a background thread, then `done` on the ota queue |
| `Http` | `fetchManifest(ManifestRequest)`, `download(DownloadRequest)`, `cancel(token)`, `isMetered()` | return immediately; report later with `Runtime::onManifestFetched/onManifestFailed/onDownloadDone/onDownloadFailed(token, ...)`. `ManifestRequest{token,url,sigUrl,ifNoneMatch}`; `ManifestResponse{notModified, body, sigBase64, keyId, etag}` (`body` = exact served bytes, `sigBase64` = exact `.sig` content); `DownloadRequest{token,url,destPath,maxBytes}`: write atomically (temp + rename), leave nothing on failure, abort above `maxBytes` |
| `FileSystem` | `fileSize` (-1 missing), `remove`, `canonical` ("" on failure), `sha256File`, `map` (whole file, aligned; nullptr on failure) | `sha256File`, `canonical`, `fileSize` are called from Worker threads: thread-safe |
| `Store` | `get`, `put`, `erase`, `keys(prefix)` | `put` must be durable and atomic when it returns true; binary-safe values. A failed `attempts/` write makes the runtime use embedded (fail closed) |
| `SignatureVerifier` | `verify(bytes, sigBase64, keyIdHint)` | Ed25519 over the exact served bytes ([03](../architecture/03-manifest-state-and-signing.md)). **No implementation in `native/`** (CryptoKit / `java.security` planned) |
| `EmbeddedAssets` | `open(name)` -> `Buffer` (ota queue); `openSource(name)` -> `unique_ptr<RandomAccessSource>` (Worker threads, thread-safe) | `name` is `"host"` or a unit name; nullptr if unknown |
| `PatchBuilder` | `build(old, patchFile, outFile, expectedHash)` -> `otacore::Status` | called on Worker threads; `DefaultPatchBuilder` wraps `otacore::applyPatch`; injectable for fault tests |
| `VmController` | async: `createVm(HostSource)`, `destroyVm()`; sync: `evaluateUnit(Buffer, sourceUrl, err)`, `requireEntry(entryModuleId, err)`, `mountSurface(moduleName, propsJson, err)`, `mountedSurfaceCount()` | `createVm`/`destroyVm` complete via `onVmCreated(ok)` / `onVmDestroyed()`; the sync calls may hop to the JS thread and wait (bounded). `mountedSurfaceCount()` must already include a surface whose `mountSurface` returned true. `HostSource{hostId ("embedded" or entry id), path, buffer (pre-checked), patched()}` |
| `Observer` (optional, may be null) | `onEvent(Event{kind,unit,id,detail})` | event kinds listed in [05, section 9](../architecture/05-client-runtime.md) |
| `Buffer` | `data()`, `size()` | immutable; typically an mmap or aligned heap copy; 4-byte alignment required for Hermes |

### 2.3 `Config` (runtime.h)

| Field | Default | Meaning |
|---|---|---|
| `platform, appVersion, buildNumber` | - | must match the signed manifest |
| `cacheBaseDir` | - | app-private, non-purgeable dir |
| `manifestUrl` | - | `<cdn>/<platform>/<app-version>/manifest.json` |
| `supportedAlgos` | `{"v1"}` | |
| `bytecodeVersion` | 0 | Hermes HBC version of the runtime (96 on RN 0.78.3) |
| `hostEmbeddedHash`, `hostBucketKey` | -, `"mainBundle"` | |
| `units[]` (`UnitConfig{name, embeddedHash, entryModuleId}`) | - | name == RN component == surface name |
| `hostSettleMs` | 800 | max wait for an in-flight host patch before prewarm |
| `unitBudgetMs` | 1000 | default `loadBudgetMs`: wait for an in-flight selected patch before falling back to embedded |
| `prewarm`, `recreateAtZeroViews` | true, true | |
| `defaultPolicy`, `unitPolicy[unit]` | `pin=Vm`, `loadBudgetMs=unitBudgetMs`, `fetch=Eager` | per-unit `UnitPolicy` ([05, section 3](../architecture/05-client-runtime.md)); fields are optional and a unit overrides the default field by field; presets `UnitPolicy::latencyFirst()`, `freshnessFirst(ms)`, `stable()` |
| `crashLimitK` | 2 | unconfirmed process attempts before blacklist |
| `patchSizeCapCellular` | 512 KiB | larger patches wait for non-metered |
| `maxConcurrentDownloads`, `maxConcurrentBuilds`, `maxRetries` | 2, 1, 3 | |
| `backoffBaseMs`, `backoffMaxMs`, `minRefreshMs`, `maxRefreshMs` | 5000, 300000, 10000, 3600000 | |
| `randomSeed`, `deviceId` | 1, "" | pass a random seed; `deviceId` empty -> persisted in `Store`, else generated from `randomSeed` as 32 hex chars (so pass a random seed) |

`Deps{clock, scheduler, worker, http, fs, store, verifier, vm, assets, builder, observer}` are non-owning and must outlive the `Runtime`.

### 2.4 `Runtime` commands and events
Commands: `start()` (idempotent), `onFirstPageInteractive()`, `setEntryPointPriority(units)`, `openUnit(unit, propsJson, cb)`, `loadUnit(unit, cb)`, `markReady(unit)`. `OpenResult{ok, error, source ("embedded"|"patch"), patchId}`; callback exactly once, asynchronously. Platform events: `onVmCreated(ok)`, `onVmDestroyed()` (also for destruction not initiated by the runtime), `onSurfaceMounted/Unmounted()`, `onNetworkChanged()`, `onManifestFetched/Failed`, `onDownloadDone(token, bytes)/Failed`. Introspection: `vmState()`, `runningHostId()`, `manifestVersion()`, `deviceId()`, `artifactState(id)`, `isBlacklisted(id)`, `pinOf(unit)` (per VM), `frozenOf(unit)` (`""`, `"embedded"`, `"patch:<id>"`: per process).

`Store` keys: `deviceId`, `highestManifestVersion`, `manifest.body|sig|keyId|etag`, `attempts/<id>`, `bad/<id>`, `built/<id>`.

### 2.5 Provided defaults (`defaults.h`)
`StdFileSystem` (std::filesystem/stdio; `map` reads into a 4-byte-aligned heap buffer, not an mmap), `DefaultPatchBuilder`, `makeAlignedBuffer(data,n)`. Everything else is platform work.

### 2.6 Hermes pre-checks (`hermes.h`)
`checkHermesBytecode(p, n, expectedVersion)` returns nullptr or `"misaligned"|"too-small"|"bad-magic"|"bad-version"`. Magic `0x1F1903C103BC1FC6` little-endian at offset 0, u32 LE version at offset 8. The spike has an equivalent (`otaspike::preEvaluateChecks`, adds `HashMismatch`) in `examples/spike-app/shared/ota_unit_loader.h`.

## 3. Platform glue checklist
1. Serial queue + `Clock`, `Scheduler`, `Worker` over it.
2. `Http` with conditional GET and atomic downloads; `Store` with durable writes (the contract is durable and atomic on return; the choice of backing store per platform is open).
3. `SignatureVerifier` (Ed25519, key rotation by `keyId` is a DESIGN [DECIDE]).
4. `EmbeddedAssets` over `AAssetManager` (assets must be stored uncompressed: `androidResources.noCompress += ["hbc"]`) or bundle files; `openSource` returns a thread-safe `RandomAccessSource`.
5. `VmController` per [android-ios-integration](../guides/android-ios-integration.md): host boot through a dynamic bundle loader / `bundleURL`, evaluate through `CallInvoker::invokeAsync`, entry through `__otaRequire`, call `onHostResume` on Android.
6. Forward lifecycle events (`onVmDestroyed`, surface counts, network) to the runtime.

## 4. JS-facing contract (spike implementation)
| Name | Defined by | Behaviour |
|---|---|---|
| `global.__loadBundleAsync(name)` | host bundle (`src/host/loader.js`), only if `NativeOtaUnits` exists | returns `NativeOtaUnits.load(name)` promise; Metro's `asyncRequire` calls it with `paths[entryId] === unitName` then `require.importAll(id)` |
| `NativeOtaUnits.load(name)` | native module: Android `OtaUnitsModule.kt` (legacy `ReactContextBaseJavaModule`), iOS `NativeOtaUnits.mm` (`RCT_EXPORT_MODULE`) | evaluates the unit without running its entry; works under bridgeless via TurboModule interop on Android (S9); iOS unverified |
| `globalThis.__otaRequire(id)` | host bundle (`loader.js`) | hides `ErrorUtils`, calls `__r(id)`, restores in `finally`; exceptions propagate |
| `globalThis.__otaProbe` | spike host only | test probe, not product |
| `registerComponent(<unitName>)` | each unit entry | surface `moduleName` equals unit name (rule `register-component`, [rules catalog](rules-catalog.md)) |

JSI adapter (`ota_unit_jsi.h`): `evaluateUnitAsync(invoker, MappedFile, sourceUrl, double entryModuleId, LoadDone)` runs `invokeAsync` -> `rt.evaluateJavaScript(MappedBuffer, sourceUrl)` in try/catch -> optional entry (prefers `__otaRequire`, else `__r`). `LoadStatus`: `Ok, IoError, TooSmall, NotHermesBytecode, BytecodeVersionMismatch, Misaligned, HashMismatch, EvalError, RequireError, NoRuntime`. `mapFile` mmaps read-only and never unmaps (Hermes may reference bytecode lazily). `entryModuleId < 0` skips the entry (both spike glues use -1 and run the entry in a second JS-thread task).
