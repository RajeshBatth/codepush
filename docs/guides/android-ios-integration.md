# Android and iOS integration (taking the spike glue as a template)

**Purpose:** Tell a native engineer which spike files to copy, which are throwaway, the RN 0.78.3 API facts learned the hard way, and the build fixes.
**Audience:** Android/iOS engineers building the production SDK; AI assistants.
**Source of truth:** `examples/spike-app/android/SPIKE_ANDROID.md`, `examples/spike-app/ios/SPIKE_IOS.md`, `examples/spike-app/SPIKE.md`, `examples/spike-app/JS_FINDINGS.md`, [docs/research/rn-0.78-loader.md](../research/rn-0.78-loader.md), the glue sources listed below, DESIGN 5.6 C, 5.8, 5.9.

Status: Android glue ran S1-S10 on an arm64 API 33 emulator (debug). iOS glue compiled for the simulator SDK but **never ran** (no simulator runtime installed). Nothing here is production code and **neither glue calls `otaruntime::Runtime`**; they use only `shared/` and `native/otacore/src/sha256.cpp`. The reusable library and pod are not extracted yet ([adopting guide](adopting-in-your-monorepo.md), "NOT DONE YET"). Orchestrator and interfaces: [05](../architecture/05-client-runtime.md), [native-api](../reference/native-api.md).

## 1. Files, and what to do with them

Root: `examples/spike-app/` (abbreviated `S/`).

| File | Role | Verdict |
|---|---|---|
| `S/shared/ota_unit_loader.{h,cpp}` | mmap (never unmapped), magic/version/alignment/sha256 pre-checks, `LoadStatus` | Reusable idea; overlaps `otaruntime/hermes.h` + `FileSystem::map`. Tested by `shared/test_loader_core.cpp` |
| `S/shared/ota_unit_jsi.h` | `evaluateUnitAsync` via `CallInvoker::invokeAsync`, `jsi::Buffer` over the mapping, optional entry run | Reusable; core of a `VmController::evaluateUnit` |
| `S/android/otaspike_native/src/main/cpp/{CMakeLists.txt,otaspike_jni.cpp}` | JNI: map+check, evaluate (holder -> `CallInvoker`), JS probe; separate Gradle module so RN's own CMake (`libappmodules.so`) is untouched | Template for the JNI layer |
| `S/android/app/src/main/java/com/otaspike/SpikeHost.kt` | lazy `ReactHostImpl` with a dynamic `JSBundleLoader`; start/reload; surfaces | **Most valuable Android file**: host swap without a process restart |
| `.../OtaNative.kt`, `OtaUnitsModule.kt` | Kotlin face of the JNI; `NativeOtaUnits.load(name)` module (legacy module, served by interop) | Template |
| `.../Ota.kt`, `SpikeTests.kt`, `MainActivity.kt`, `RnActivity.kt`, `MainApplication.kt` | copy assets to `filesDir/ota`, S1-S10 runner, native first screen | Spike only (test harness) |
| `S/android/app/build.gradle` | `syncOtaAssets` Sync task hooked before `merge*Assets`; `androidResources.noCompress += ["hbc"]` | Template for embedded units as uncompressed assets |
| `S/ios/OtaSpike/OtaSpikeReact.{h,mm}` | lazy `RCTReactNativeFactory` + delegate whose `-bundleURL` is re-read; map/check; evaluate; identities | **Most valuable iOS file** |
| `S/ios/OtaSpike/NativeOtaUnits.mm` | `RCT_EXPORT_MODULE(NativeOtaUnits)` promise `load(name)` | Template (unverified at runtime) |
| `S/ios/OtaSpike/{OtaSpikeRunner.mm,NativeViewController.m,AppDelegate.m,main.m}` | S1-S10 runner, native first screen, plain UIApplicationDelegate with no React host at launch | Spike only |
| `S/ios/Podfile` | `fmt` consteval patch in `post_install` | Needed for any Xcode 26 build of RN 0.78.3 |
| `S/src/host/loader.js` | defines `__loadBundleAsync` and `__otaRequire` | Must ship in the real host bundle (pre-module) |
| `S/scripts/prepare-spike-assets.mjs` | produces `.spike-assets/<platform>/` (embedded, patched, fixtures, `spike.json`) | Spike only; the product uses `ota-build` ([02](../architecture/02-build-and-patch-pipeline.md)) |

Gaps to fill for production: implement the `otaruntime` interfaces (`Http`, `Store`, `VmController`, `EmbeddedAssets`, `SignatureVerifier`, `Worker`, `Clock`, `Scheduler`) on top of this glue; Ed25519; mmap `FileSystem::map`; entry-point table; extraction into an AAR / pod.

## 2. Android facts (RN 0.78.3, bridgeless/Fabric)

* `DefaultReactHost.getDefaultReactHost(...)` caches the host in a static; the first `jsBundleFilePath` wins forever. To swap hosts build `ReactHostImpl(context, delegate, ComponentFactory, allowPackagerServerAccess, useDevSupport)` yourself (public ctor) with `DefaultReactHostDelegate(jsMainModulePath, jsBundleLoader, reactPackages, jsRuntimeFactory, bindingsInstaller, exceptionHandler, turboModuleManagerDelegateBuilder)` (`@UnstableReactNativeAPI`, needs `@OptIn`) and call `DefaultComponentsRegistry.register(factory)`.
* `ReactHostImpl` re-asks `delegate.jsBundleLoader` on every (re)creation of the instance, so a `JSBundleLoader` subclass that decides its source inside `loadScript(delegate)` makes `ReactHost.reload()` pick up a new host in-process (S2, S10). `JSBundleLoader` has one abstract method; the delegate offers `loadScriptFromAssets(AssetManager, assetURL, sync)` and `loadScriptFromFile(path, sourceURL, sync)`.
* `ReactHost.createSurface(Context, name, Bundle?)`, `ReactSurface.view/start()/stop()/detach()`, `reload(reason)` returns a task (`waitForCompletion()`, `getError()`).
* The first surface did not render until `ReactHost.onHostResume(activity)` was called: call it for each hosting activity.
* Evaluating a unit: `reactContext.getJSCallInvokerHolder()` and `getJavaScriptContextHolder()` are public. Pass them to JNI as `Object` and use fbjni (`CallInvokerHolder::javaobject` -> `cthis()->getCallInvoker()`); no Kotlin `@FrameworkAPI` opt-in needed. `JNI_OnLoad` must call `facebook::jni::initialize`. Then `invoker->invokeAsync([](jsi::Runtime& rt){ rt.evaluateJavaScript(buf, "unit://cabs"); })`.
* The `jsi::Runtime&` given to the `invokeAsync` callback is not the same pointer value as `JavaScriptContextHolder.get()`: use the holder only for lifetime/identity (it returns 0 after a reload), always use the callback's `rt`.
* `BridgelessCatalystInstance.loadScriptFromFile/registerSegment` throw `UnsupportedOperationException`; `ReactInstance` is package-private. `ReactContext.registerSegment` is the public fallback (no error signal, sourceURL `seg-<id>.js`): research doc section A3.
* Run the entry module through `globalThis.__otaRequire` in a second `invokeAsync` hop (the glue passes `entryModuleId=-1` to `evaluateUnitAsync`). Metro's `__r` reports a throwing module to `ErrorUtils.reportFatalError` (fatal in release) instead of throwing.
* `NativeOtaUnits` as a legacy `ReactContextBaseJavaModule` works under bridgeless via interop (S9).
* Embedded assets: `androidResources.noCompress += ["hbc"]`; the spike loads the embedded host explicitly from `assets://ota/embedded/host.hbc` (not `index.android.bundle`).

## 3. iOS facts (compiled, not run)

* Delegate `-bundleURL` is re-read on start and on every `RCTHost` reload; `reload` adopts only a URL that differs from the previous one (`_setBundleURL:`).
* `[RCTBridge currentBridge]` is an `RCTBridgeProxy` (an `NSProxy`); `currentBridge` is declared in `<React/RCTBridge+Private.h>`. `runtime` and `jsCallInvoker` are not declared on `RCTBridge`: declare them in a category (as Re.Pack does). They log a "please migrate" warning in dev and the selectors may change.
* `RCTHost` public header has no `reload`; it lives in `RCTHost+Internal.h`, declare via category.
* Host without a surface (VM prewarm): `[rootViewFactory createReactHost:nil]` after `RCTEnableTurboModuleInterop(YES)` and `RCTEnableTurboModuleInteropBridgeProxy(YES)`; assign `rootViewFactory.reactHost` yourself. There is no explicit destroy: drop the host and factory (`RCTHost dealloc` invalidates the instance).
* `RCTReactNativeFactory initWithDelegate:` holds the delegate weakly: keep a strong reference. The delegate must set `dependencyProvider` and implement `-bundleURL` (default raises).
* `NativeOtaUnits` under bridgeless relies on TurboModule interop; JS reads `TurboModuleRegistry.get('NativeOtaUnits')` / `NativeModules.NativeOtaUnits`. Unverified at runtime.
* Unverified on iOS: every test result, whether Hermes accepts the mmap'd bytecode, whether `RCTHost reload` picks up a changed URL, the S9 `accessibilityActivate` tap path.

## 4. Build fixes (both platforms)

| Problem | Fix |
|---|---|
| Android: RN's CMake auto-uses Homebrew `ccache`, which is broken (missing libfmt) | build with ccache off `PATH` (`export PATH=/usr/bin:/bin:/usr/sbin:/sbin:<node bin>`) and delete `app/.cxx` if it cached it |
| Android build command | `export JAVA_HOME=~/.sdkman/candidates/java/current` (JDK 17); `cd examples/spike-app/android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64`; `adb install -r app/build/outputs/apk/debug/app-debug.apk`; read `adb logcat -d -s OTA_SPIKE` |
| Android toolchain used | Gradle 8.12 wrapper, compileSdk 35, build-tools 35.0.0, NDK 27.1.12297006, CMake 3.22.1 |
| iOS: Xcode 26 clang rejects fmt consteval (fmt shipped with RN 0.78.3) | `Podfile` `post_install` rewrites `Pods/fmt/include/fmt/base.h` to `FMT_USE_CONSTEVAL 0` |
| iOS: first `pod install` | `pod install --repo-update` (SocketRocket 0.7.1) |
| iOS: launch storyboard needs the platform component | spike uses a `UILaunchScreen` dict; `ENABLE_USER_SCRIPT_SANDBOXING=NO` for the rsync phase |
| iOS: `xcodebuild -workspace ... -destination 'generic/platform=iOS Simulator'` fails without an installed runtime | build with `-project Pods/Pods.xcodeproj -target Pods-OtaSpike` then `-project OtaSpike.xcodeproj -target OtaSpike` (exact commands in `S/ios/SPIKE_IOS.md`) |
| Metro with symlinked `node_modules` | copy it (`cp -Rc` on APFS); see [troubleshooting](troubleshooting.md) |
| node/npm not on PATH in subprocesses (lazy nvm) | `N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH` |

## 5. Do not regress these invariants (each was found by the spike)

1. Never evaluate bytes without the magic number: Hermes compiles them as JavaScript source and would run unverified text.
2. 4-byte aligned buffer, never freed/unmapped while the process lives.
3. Hash is verified by the SDK (Hermes checks its bytecode hash only in debug builds).
4. Entry module ids are 48-bit: carry them as `double`/int64.
5. Evaluate only on the JS thread (`CallInvoker`), with the `Runtime&` from the callback.
6. Embedded and patched units must not be assumed swappable inside a live VM (S6): the pin is per VM.
7. Deleting a VM requires the glue to call `Runtime::onVmDestroyed()` and re-derive runtime handles afterwards (S7).

Spike measurements and caveats: [spikes/summary.md](../spikes/summary.md).
