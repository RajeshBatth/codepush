# Android spike: build, run, results

Status: **built and RUN on the existing AVD `Pixel_7_Pro_API_33` (arm64, API 33, headless `-no-window -gpu swiftshader_indirect`): S1-S15 all PASS (`pass=15 fail=0`)** (S1-S10 first run; S11-S15 added in the delta/apply run below), debug build, RN 0.78.3 bridgeless/Fabric, Hermes (HBC v96).

## Build / install / run
```
node scripts/prepare-spike-assets.mjs                 # JS agent: writes .spike-assets/android (gradle copies it to assets/ota/)
export JAVA_HOME=~/.sdkman/candidates/java/current    # JDK 17
# IMPORTANT: no ccache on PATH (Homebrew ccache here is broken: missing libfmt; RN's CMake auto-uses it).
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:<node bin>
cd examples/spike-app/android
./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -c; adb shell am start -n com.otaspike/.MainActivity
# tap "Run all spike tests" (or: adb shell input tap <x> <y>), then:
adb logcat -d -s OTA_SPIKE
```
Requirements met locally: Gradle 8.12 wrapper, AGP from RN plugin, compileSdk 35, build-tools 35.0.0, NDK 27.1.12297006 and CMake 3.22.1 (all were installed; nothing had to be installed). Prebuilt APK copy: `.work/otaspike-debug.apk` (arm64-v8a + x86_64).

## What is where
- `app/src/main/java/com/otaspike/`: `MainActivity` (native first screen: Run all / Open host / Open cabs / results TextView / 260dp surface box), `RnActivity` (full-screen surface), `SpikeHost` (lazy ReactHost), `SpikeTests` (S1-S10), `OtaNative` (JNI face), `Ota` (assets->filesDir copy, spike.json), `OtaUnitsModule` (`NativeOtaUnits`).
- `otaspike_native/` : separate library module with CMake building `libotaspike.so` from `src/main/cpp/otaspike_jni.cpp` + `shared/ota_unit_loader.cpp` + `native/otacore/src/sha256.cpp` (prefab `ReactAndroid::reactnative`, `ReactAndroid::jsi`, `fbjni::fbjni`). Separate module so RN's default app CMake (`libappmodules.so`) is untouched.
- `app/build.gradle`: `syncOtaAssets` (Sync `<spike-app>/.spike-assets/android` -> `build/generated/otaAssets/ota`, hooked before every `merge*Assets`), `androidResources.noCompress += "hbc"`.
- Embedded host: the app does NOT use `index.android.bundle`; `SpikeHost` loads `assets://ota/embedded/host.hbc` explicitly. Patched host: `filesDir/ota/patched/host.hbc` (file loader, sourceURL = path). Evaluation reads only from `filesDir/ota/**`.

## Compiled / ran
| Item | Result |
|---|---|
| `:app:assembleDebug` (arm64-v8a, x86_64) | OK |
| libotaspike.so (links shared loader + sha256 + ota_unit_jsi.h against RN 0.78.3 prefab) | compiled, linked, loaded on device |
| Emulator run (API 33 arm64, swiftshader) | S1-S10 PASS; "Open cabs" button shows CABS:v1 full screen |
| Release build / real device / x86 emulator | NOT run |

## Tests (all implemented, compiled, run on emulator)
Execution order (state dependent): S1 S3 S6 S4 S5 S7 S8 S9 S2 S10. Log: `OTA_SPIKE RESULT <id> PASS|FAIL <details>`, final `OTA_SPIKE SUMMARY pass=10 fail=0`.
- S1 embedded host, surface `HOST:embedded`, probe embedded. PASS
- S3 cabs v1 evaluated after host, entry run, surface `CABS:v1`. PASS
- S6 patched cabs v2 into VM holding v1: eval Ok, probe stays `v1`. PASS
- S4 wrong-version/text/truncated/misaligned(offset 1) rejected by pre-checks; `pwned=false`. Bypass of the version check: Hermes throws `Compiling JS failed: Wrong bytecode version. Expected 96 but got 98` (EvalError), nothing executed. PASS
- S5 bad-entry -> `RequireError` ("OTA_SPIKE bad entry module"), no crash, bus loads afterwards. PASS
- S7 reload: new ReactContext, new JavaScriptContextHolder pointer, new `jsi::Runtime` address, OLD holder `get()==0` (cleared, so a stale pointer is detectable), fresh invoker loads cabs. PASS
- S8 timing (warm, emulator): cabs 3328 B, map 0.02 ms, check+sha256 0.08 ms, eval ~0.02-0.04 ms, require ~0.06-0.10 ms; host.hbc 860712 B. First (cold page cache) cabs run: map 8.6 ms, eval 1.5 ms, require 3.3 ms. Total incl. JS-thread hops 0.7-23 ms.
- S9 `import()` -> `__loadBundleAsync('cabs')` -> `NativeOtaUnits.load` -> evaluate -> surface `CABS:v1` (native module called once; legacy module worked through bridgeless interop). The runner taps the "import() cabs" button with synthetic MotionEvents. PASS
- S2 patched host via reload with dynamic loader: `HOST:patched`. PASS
- S10 host swap with no surfaces: new VM patched, `__otaProbe.units == {}`, cabs loads again. PASS

## Deviations from contract
- S2/S7/S10 use `ReactHost.reload()` on a long-lived `ReactHostImpl` with a dynamic `JSBundleLoader`, not a fresh process boot via `getDefaultReactHost(jsBundleFilePath=...)` (static cache makes that impossible in-process). This also answers research unknown H5: **reload() does re-ask the loader** (host swap in-process works).
- Surfaces are mounted in an in-activity container by the runner; the Open buttons use `RnActivity`.
- S4 text unit is never evaluated, even in bypass.

## API notes vs docs/research/rn-0.78-loader.md (actual 0.78.3)
- `ReactHostImpl(Context, ReactHostDelegate, ComponentFactory, boolean allowPackagerServerAccess, boolean useDevSupport)` is public; `DefaultReactHostDelegate(jsMainModulePath, jsBundleLoader, reactPackages, jsRuntimeFactory, bindingsInstaller, exceptionHandler, turboModuleManagerDelegateBuilder)` (`@UnstableReactNativeAPI`, needs `@OptIn`); `DefaultComponentsRegistry.register(ComponentFactory)` must be called.
- `JSBundleLoader` is an abstract class with one method `String loadScript(JSBundleLoaderDelegate)`; delegate has `loadScriptFromAssets(AssetManager, String assetURL, boolean)`, `loadScriptFromFile(String, String sourceURL, boolean)`.
- `ReactHost.createSurface(Context, String, Bundle?) : ReactSurface`; `ReactSurface.view/start()/stop()/detach()`; `reload(reason): TaskInterface<Void>` (`waitForCompletion()`, `getError()`).
- `ReactContext.getJSCallInvokerHolder(): CallInvokerHolder` (interface) and `getJavaScriptContextHolder(): JavaScriptContextHolder` (`get(): long`) both work; the holder is passed to JNI as `Object` and cast via fbjni (`CallInvokerHolder::javaobject` -> `cthis()->getCallInvoker()`), so NO Kotlin `@FrameworkAPI` opt-in was needed. `CallInvokerHolder.h` is available from the `reactnative` prefab; `JNI_OnLoad` must call `facebook::jni::initialize`.
- Text `evaluateJavaScript` works in this Hermes (probe uses it); `jsi::Runtime&` from `invokeAsync` is not the same pointer value as `JavaScriptContextHolder.get()` (compared: `0x-4bff...` vs `0xb400...`; holder value looks like a different object, only use it for lifetime/identity, never as the runtime).
- First surface needs `ReactHost.onHostResume(activity)` after host creation (otherwise the first surface did not render within 10 s in our first run).
- **[FIXED after this report: `shared/ota_unit_jsi.h` now prefers `__otaRequire` and falls back to `__r`; the workaround below still works but is no longer required.]** `shared/ota_unit_jsi.h` bug found by this spike: it ran the entry with `__r(entryId)`; Metro's `__r` routes exceptions to `ErrorUtils.reportFatalError` (fatal in release) instead of throwing, so `RequireError` can never be returned. Android works around it by calling evaluateUnitAsync with entryModuleId=-1 and running `globalThis.__otaRequire(id)` (fallback `__r`) in a second `invokeAsync` hop. Also `LoadDone` receives no `jsi::Runtime&`.
- Build env: Homebrew ccache broken, remove from PATH and delete `app/.cxx` if CMake cached it.

## S11-S15: delta-built bytecode + on-device `applyPatch` (run on the same AVD, all PASS, `pass=15 fail=0`)
Assets: `node scripts/prepare-spike-assets.mjs` now builds `patched/*` with `bundle --base-build` (hermesc `-base-bytecode=<embedded .hbc>`) and produces `patches/{host,cabs}.hdiff` (see SPIKE.md). Build: same `:app:assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64` (33 s incremental).

How otacore was added to CMake (`otaspike_native/src/main/cpp/CMakeLists.txt`, nothing under `native/` edited): three static libs compiled from the repo by path, mirroring `native/CMakeLists.txt` for `OTACORE_ZSTD=ON OTACORE_ZSTD_SMALL=ON OTACORE_LZMA=OFF`: `hpatch_core` (`HDiffPatch/libHDiffPatch/HPatch/patch.c` + `hpatch_mt/hpatch_mt.c`, defs `_IS_USED_MULTITHREAD=0 _HPATCH_IS_USED_MULTITHREAD=0 _IS_NEED_CACHE_OLD_BY_COVERS=0 _LARGEFILE_SOURCE _FILE_OFFSET_BITS=64`), `zstd_dec` (the 10 decoder .c files, `ZSTD_DISABLE_ASM=1 ZSTD_HAVE_WEAK_SYMBOLS=0 ZSTD_TRACE=0 ZSTD_STRIP_ERROR_STRINGS=1 ZSTD_LEGACY_SUPPORT=0 ZSTD_MULTITHREAD=0 HUF_FORCE_DECOMPRESS_X1 ZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT`), `otacore_patch` (`otacore/src/sha256.cpp` + `patch.cpp`, `OTACORE_WITH_ZSTD`); linked into `libotaspike.so`. It compiled and linked for arm64-v8a and x86_64 on the first try (C++17 core inside the C++20 module is fine). JNI: `nativeApplyPatch` (FileSource on the embedded file copied to filesDir, `applyPatch`, timing, /proc/self/status RSS; `VmHWM` is reset via `/proc/self/clear_refs`=5, which worked for the app uid) and `nativeSha256File`.

Results (verbatim, shortened):
```
S11 PASS fresh VM units-before={} eval(delta-built v2)=Ok probe.units.cabs="v2" surface=CABS:v2 deltaBuilt=true file=sha256:cd03bb0df660 (embedded=sha256:a8f06918ea1d) hashMatchesSpikeJson=true
S12 PASS embedded host typeof hostFn="undefined" | patched host (delta-built, sha256:36c24f1113d7) surface=HOST:patched probe.host="patched" hostFn="HOSTFN:v2:91:PATCHED" | then cabs v2: Ok probe.units.cabs="v2" surface=CABS:v2
S13 PASS cabs{patch=139B base=3328B built=3340B status=Ok time=34.46ms rss=145804kB peak=145992kB (+188kB) out=true tmp=false sha256(out)=sha256:cd03bb0df660 ==expected&delta-built:true} host{patch=5470B base=860712B built=860928B status=Ok time=162.47ms rss=146180kB peak=146520kB (+340kB) out=true tmp=false sha256(out)=sha256:36c24f1113d7 ==expected&delta-built:true} | built cabs: Ok probe="v2" surface=CABS:v2 | built host: surface=HOST:patched hostFn="HOSTFN:v2:91:PATCHED"
S14 PASS cabs-flip->HashMismatch cabs-trunc->PatchCorrupt host-flip->PatchCorrupt host-trunc->PatchCorrupt (no output; pre-existing output file untouched)
S15 PASS cabs->HashMismatch out=false tmp=false host->HashMismatch out=false tmp=false
```
Reading: the delta-built bytes are what runs (the unit's old v1 never loaded in S11; `hostFn` exists only in the patched host); the patch applied on the device reproduces the delta-built file bit for bit (sha256 equal), and that built output loads and runs too. Apply cost on an emulator (NOT representative of phones): 34 ms cabs (cold, first call) and 162 ms for the 860 KB host, peak RSS +0.2 / +0.3 MB above the process RSS (step buffer 256 KB; the old file is read through FileSource, never held whole in memory).
APK: debug APK 64.67 MB -> 66.11 MB (+1.44 MB, mostly the new assets: patched host/cabs, two .hdiff, spike.json growth; `libotaspike.so` as packaged +280 KB arm64-v8a / +352 KB x86_64 for hpatch + zstd decoder + patch.cpp, debug build). For a release size measurement see native/README.md.
Surprises: none in the build or the apply. The spike uses `createPatches(fullThreshold: 100)` because the production policy would turn the 139 B cabs patch into a `full` update (delta patch > 0.6 x zstd(new) for such a tiny unit); the spike wants the real delta-against-embedded path.
Run: `zsh .work/android-build.sh` (JDK 17, no ccache on PATH), emulator headless, `adb install -r`, tap "Run all spike tests", `adb logcat -d -s OTA_SPIKE`.

## S16-S18: unit-only edit (new function + new strings + changed string + new module) on the EMBEDDED host (all PASS, `pass=18 fail=0`)
Question: can a unit patch that ADDS A FUNCTION AND STRINGS force a host patch? No: each unit is its own bytecode file with its own string/function tables; the host file is never touched. Proven on the emulator (Pixel_7_Pro_API_33, API 33, arm64): S16 boots the embedded host, asserts its sha256 equals `spike.json` `host.hash` (and the host hash of the v3 build, `hostChanged=false`, host.hbc byte-identical to the base build), then loads the delta-built cabs v3 FIRST. Results (verbatim, shortened):
```
S16 PASS delta-built file fresh VM on EMBEDDED host (host sha256 sha256:896c4da52456 == embedded sha256:896c4da52456 == v3-build host sha256:896c4da52456, unchanged after=true, hostChanged(spike.json)=false) units-before={} probe.host="embedded" eval=Ok bytes=4012 probe.units.cabs="v3" unitFn="UNITFN:v3:560:V3:newmod" (expected "UNITFN:v3:560:V3:newmod") surface=CABS:v3 changed-string-row=Mini fare: 120.00 deltaBuilt=true eval map=0.01 check+sha=0.09 eval=0.03 require=0.08 ms
S17 PASS apply: patch=886B (plain-built patch would be 1557B) base=3328B built=4012B status=Ok time=23.70ms rss=168216kB peak=168304kB (+88kB) rssAfter=168304kB out=true tmp=false sha256(out)=sha256:b81b614507dc ==expected&delta-built:true | on-device BUILT file fresh VM on EMBEDDED host (...same host hashes..., unchanged after=true) probe.units.cabs="v3" unitFn="UNITFN:v3:560:V3:newmod" surface=CABS:v3 ...
S18 PASS probe="b1|385|2024-03-07|true|true" unit=262568B | cold: map=0.01 check+sha256=6.50 eval=0.13 require=41.01 total=51.94 ms | warm(median of 4): map=0.02 check+sha256=5.98 eval=0.10 require=27.11 total=34.63 ms | apply(one-string edit, patch=426B delta-built vs 2919B plain-built, built=262592B): first status=Ok time=13.39ms rss=178532kB peak=179360kB (+828kB) | later ms=13.42, 17.71 | sha256(out)==expected:true | built b2: Ok probe="b2|385|2024-03-07|true|true" surface=BIGLIB:b2
SUMMARY pass=18 fail=0
```
Reading: (1) the new function ran (`UNITFN` value computed by the new module calling the new `fareChecksum()`), the new/changed strings are visible, and the host never changed, so no host patch/store release is needed for such a unit edit. (2) `hdiff` for v3 against the embedded cabs: 886 B delta-built vs 1 557 B plain-built (unit 3 328 -> 4 012 B); apply on the emulator 24-36 ms, peak RSS +88..340 kB. (3) S18 (~260 KB unit, emulator, swiftshader, NOT representative of a phone): mmap ~0.01 ms, check+sha256 ~6 ms, evaluate ~0.1 ms (lazy bytecode), require of the entry (runs lodash/ajv/dayjs/semver module bodies) 41 ms cold / 27 ms warm; delta apply of a one-string edit ~13 ms, peak RSS +0.8 MB, patch 426 B (delta-built) vs 2 919 B (plain-built) for a 262 KB unit.
Gotcha found while building S18: packages are owned by the unit only if listed in its `roots`; a transitive dependency not listed (here `fast-deep-equal` of ajv) stays HOST-owned and the unit fails at require with `Requiring unknown module "<id>"` on a host that does not contain it. List the whole dependency closure as roots (the S18 script does). Also the splitter only sees units reachable through a host `import()`; the S18 build adds a temporary host reference (big builds only, restored afterwards).
Run: `node scripts/prepare-spike-assets.mjs android && node scripts/prepare-spike-big.mjs android`, then build/run as above.
