# Device spike: OTA unit loading in a hybrid RN 0.78.3 app (Fabric/bridgeless, Hermes)

Purpose: settle the open runtime questions in DESIGN.md 5.6 C / 5.8 *on a real device or emulator*. Everything here is a SPIKE, not product code. The app is **hybrid**: the first screen is NATIVE (Activity / UIViewController) with buttons; RN surfaces are opened from it.

## Layout and ownership

| Path | Owner | What |
|------|-------|------|
| `shared/` | done (read-only for agents; report bugs) | `ota_unit_loader.{h,cpp}` (mmap, magic/version/alignment/hash pre-checks, host-tested), `ota_unit_jsi.h` (evaluate on the JS thread via `CallInvoker`, then `__r(entryId)`; compile-checked against RN 0.78.3 headers) |
| JS side: `App.tsx`, `index.js`, `src/**`, `metro.config.js`, `scripts/**`, `.spike-assets/**`; `packages/unit-splitter`, `packages/ota-build` | **JS/bundler agent** | RN host + units, splitter on a real RN project, asset preparation |
| `android/**` | **Android agent** | native first page, JNI/C++ glue, test runner |
| `ios/**` | **iOS agent** | native first page, ObjC++ glue, test runner |

## Contract: what the JS/bundler agent produces

`node scripts/prepare-spike-assets.mjs` writes, for each platform `P` in {android, ios}, `.spike-assets/P/`:
```
spike.json                 { "hbcVersion": 96, "units": { "<unit>": { "entryId": <number>, "hash": "sha256:...", "file": "units/<unit>.hbc" } }, "host": { "file": "host.hbc", "hash": "sha256:..." }, "markers": {...} }
embedded/host.hbc          host compiled from the real RN app (the normal app bundle, as Hermes bytecode)
embedded/units/{cabs,bus,travelplex}.hbc
patched/host.hbc           same host with a visible change (host marker "HOST:patched")
patched/units/cabs.hbc     cabs v2 (marker "CABS:v2")
fixtures/unit-wrong-version.hbc   a valid unit with bytes 8..11 changed to another bytecode version
fixtures/unit-text.js             PLAIN JS source with a side effect: `globalThis.__otaProbe.pwned = true`  (must NEVER execute)
fixtures/unit-truncated.hbc       first 6 bytes of a unit
fixtures/unit-bad-entry.hbc       a unit whose ENTRY MODULE throws when required (registration succeeds, require fails)
```
JS-side conventions (all units/host): `globalThis.__otaProbe` is created by the host (`{ host: "embedded"|"patched", units: {}, pwned: false }`); each unit entry sets `__otaProbe.units.<unit> = "v1"|"v2"` and calls `AppRegistry.registerComponent("<unit>", ...)` (component renders `CABS:v1` etc.). The host registers `AppRegistry.registerComponent("SpikeHost", ...)` rendering `HOST:embedded` / `HOST:patched`. The host also defines `global.__loadBundleAsync = (name) => NativeOtaUnits.load(name)` ONLY if a native module `NativeOtaUnits` exists (guarded), so S9 can test the `import()` path.

## Native test runner (both platforms, identical IDs and log format)

Each platform has a native first screen with buttons: **Run all spike tests**, **Open host**, **Open cabs**, and a text view with the results. Every test logs one line `OTA_SPIKE RESULT <id> PASS|FAIL <details>` (Android: logcat tag `OTA_SPIKE`; iOS: `NSLog`) and appends it to the screen. A final line `OTA_SPIKE SUMMARY pass=<n> fail=<n>`.

Test files are bundled in the app (Android: `assets/ota/...`; iOS: bundle resource folder `ota/...`) and COPIED to the app files dir on demand (to emulate downloaded files); evaluation reads from the files dir only.

| ID | Test | PASS when |
|----|------|-----------|
| S1 | Boot with the EMBEDDED host (no override) and mount `SpikeHost` | surface renders; probe `host == "embedded"` |
| S2 | Boot with the PATCHED host file (Android: `jsBundleFilePath`; iOS: `bundleURL`) | probe `host == "patched"` |
| S3 | Evaluate `embedded/units/cabs.hbc` (aligned mmap) AFTER the host in the same runtime, run `__r(entryId)`, mount surface `cabs` | probe `units.cabs == "v1"`, surface shows `CABS:v1` |
| S4 | Pre-checks reject: wrong version, text JS, truncated, misaligned view; and the text unit is NOT executed | all four rejected by `preEvaluateChecks`; `pwned` stays false. Also record what Hermes itself does if the pre-check is bypassed for wrong-version (expect a clear error, nothing executed) |
| S5 | Entry module throws on require (`unit-bad-entry`) | `RequireError` returned, app does not crash, a later load of another unit still works |
| S6 | Evaluate `patched/units/cabs.hbc` (v2) AFTER v1 is already loaded in the same VM | v1 stays (`units.cabs == "v1"`): define is first-wins, so a unit cannot be swapped in a live VM |
| S7 | Reload/recreate the VM (Android `ReactHost.reload()` or recreate; iOS `RCTHost` reload), then load a unit again using FRESHLY obtained runtime + call invoker | no crash, load succeeds, probe fresh; also record whether the previously cached runtime pointer is invalid (do NOT dereference a stale pointer; just compare identity) |
| S8 | Timing: map + pre-checks + sha256 + evaluate + require for each unit (and the host file size) | numbers logged (ms, bytes); no PASS/FAIL threshold, just data |
| S9 | `import()` path: JS calls `import('./units/cabs/entry')`, which hits `__loadBundleAsync('cabs')` -> native -> evaluate | Suspense/promise resolves, surface renders |
| S10 | VM recreate with a different host while no surfaces are mounted (host swap, DESIGN 5.4) | new VM boots from the patched host; previously loaded unit state is gone (probe empty), then S3 works again |

### S11-S15: delta-built bytecode and the on-device patch apply

`prepare-spike-assets.mjs` now also builds `patched/host.hbc` and `patched/units/cabs.hbc` in hermesc DELTA mode (`bundle --base-build <embedded build>`, i.e. `-base-bytecode=<embedded .hbc>`; `spike.json` `patched.deltaBuilt=true`, `patched.deltaBaseBuild`, `patched.deltaFiles`) and writes `patches/{host,cabs}.hdiff` (HDiffPatch zstd via `createPatches`, round trip through `ota_apply`; `spike.json` `patches.<key>.{builtHash,baseHash,size,plainBuiltPatchSize}`). The patched host differs by a changed string (`'embedded'`->`'patched'`), a NEW function `hostPatchedFn` and new strings; `probe.js` publishes `__otaProbe.hostFn = hostPatchedFn(7)` = `"HOSTFN:v2:91:PATCHED"`. The cabs v2 unit renders `CABS:v2` and sets `units.cabs = "v2"`.

| ID | Test | PASS when |
|----|------|-----------|
| S11 | Patched unit runs: fresh VM (embedded host), delta-built `patched/units/cabs.hbc` is the FIRST definition of cabs (embedded cabs never loaded) | `units` is `{}` before; probe `units.cabs == "v2"`; surface `CABS:v2`; file sha256 equals spike.json and differs from embedded |
| S12 | Patched host runs: embedded host has no `hostFn`; boot delta-built `patched/host.hbc` | `host == "patched"`, `hostFn == "HOSTFN:v2:91:PATCHED"` (new function ran), surface `HOST:patched`; delta-built cabs v2 then loads on top (`CABS:v2`) |
| S13 | Apply on device: otacore `applyPatch(FileSource(embedded), patches/*.hdiff, out, expectedBuiltHash)` for cabs and host | status Ok, sha256(out) == expected built hash == delta-built file hash, no `.tmp`; time and peak RSS logged; the BUILT cabs loads (v2) and the BUILT host boots (`hostFn` ok) |
| S14 | Bad patch rejected: one byte flipped / file truncated to half (cabs and host) | PatchCorrupt or HashMismatch; no output file; a pre-existing output file is untouched |
| S15 | Wrong expected hash | HashMismatch, no output file, no `.tmp` |

### S16-S18: a UNIT edit that adds a function and strings never needs a host patch

`prepare-spike-assets.mjs` also builds `patched/units/cabs-v3.hbc` (hermesc DELTA mode vs the embedded build) + `patches/cabs-v3.hdiff`. The v3 edit touches ONLY the cabs unit: (a) NEW function `fareChecksum()` in `fares.js`, (b) NEW string literals, (c) a CHANGED existing string (`Mini 120` -> `Mini fare: 120`), (d) a NEW module file `unitfn.js` (new module id) appended to the unit. The entry publishes `__otaProbe.unitFn = "UNITFN:v3:560:V3:newmod"` and the unit renders `CABS:v3`. The script asserts `createPatches` reports `hostChanged=false, changedUnits=[cabs]` AND that `host.hbc` is byte-identical between the base and v3 builds; both are recorded in `spike.json` (`patched.cabsV3.{deltaBuilt,hostChanged,changedUnits,hostBytesIdentical,hostHashBase,hostHashV3}`, `patches.cabs-v3`). `node scripts/prepare-spike-big.mjs android` (run after the main script) adds the S18 assets (`big/`, `spike.json` `big`).

| ID | Test | PASS when |
|----|------|-----------|
| S16 | Fresh VM on the EMBEDDED host (`SpikeHost.Src.Embedded`), delta-built `cabs-v3.hbc` loaded FIRST (embedded cabs never loaded) | host file sha256 == embedded host hash in spike.json == v3-build host hash and unchanged afterwards; `units` was `{}`; `units.cabs == "v3"`; `unitFn` exactly as expected; surface `CABS:v3`; the changed string row (`Mini fare:`) is rendered |
| S17 | `applyPatch(embedded cabs, patches/cabs-v3.hdiff)` on device (like S13), then the BUILT file in a fresh VM on the embedded host | status Ok, sha256(out) == expected built hash == delta-built file, no `.tmp`; all S16 properties hold for the built file; apply time + RSS logged |
| S18 | Realistic size: unit `biglib` (lodash + dayjs + semver + ajv and their deps, ~260 KB hbc) through the real splitter/ota-build; probe value is computed with those libs | cold/warm map + check+sha256 + evaluate + require timings; on-device apply of the one-string-edit delta patch (sha256 == built hash), built file loads in a fresh VM (`BIGLIB:b2`) |

Record for the report, per platform: RN/Hermes/Metro versions actually used, any API that did not exist or behaved differently from `docs/research/rn-0.78-loader.md`, and the exact manual steps to run.

## How to run (the agents fill in exact commands)

Android: `cd android && ./gradlew :app:installDebug` on an emulator/device, then open the app and tap **Run all spike tests**; read `adb logcat -s OTA_SPIKE`.
iOS: `bundle exec pod install` (or `pod install`) in `ios/`, open the workspace in Xcode, run on a simulator, tap the button; read the Xcode console.
