# Android spike: build, run, results

Status: **built and RUN on the existing AVD `Pixel_7_Pro_API_33` (arm64, API 33): S1-S10 all PASS (`pass=10 fail=0`)**, debug build, RN 0.78.3 bridgeless/Fabric, Hermes (HBC v96).

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
