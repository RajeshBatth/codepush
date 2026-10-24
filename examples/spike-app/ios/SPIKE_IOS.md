# iOS spike (RN 0.78.3 bridgeless/Fabric, Hermes): build, run, status

Owner: iOS agent. Contract: `../SPIKE.md`. Versions actually used: RN 0.78.3, Hermes `hermes-ios-debug` 0.78.3 prebuilt tarball (bytecode version 96 per `spike.json`), Metro 0.81.5 (per `spike.json`), Xcode 26.6 / iphonesimulator26.5 SDK, CocoaPods 1.16.2.

## Files (all under `ios/`)
| File | Role |
|---|---|
| `OtaSpike/AppDelegate.m`, `main.m` | Plain `UIApplicationDelegate` (the template's Swift `RCTAppDelegate` subclass was removed). Shows the native screen only: **no React host at launch**. |
| `OtaSpike/NativeViewController.m` | Native first screen: segmented control (embedded / patched host), buttons **Run all spike tests**, **Open host**, **Open cabs**, results `UITextView`, a 90pt container where the runner mounts surfaces. "Open host/cabs" push a full-screen RN surface. |
| `OtaSpike/OtaSpikeReact.{h,mm}` | Lazy host: `RCTReactNativeFactory` + private `OtaSpikeFactoryDelegate` whose `-bundleURL` returns the embedded or patched URL (re-read on start and on every `RCTHost` reload). Map + pre-check (`mapAndCheck` = `checkOnlyPath:`), `evaluateUnitAtPath:...` (uses `otaspike::evaluateUnitAsync`), `probe:` (text eval of `JSON.stringify(...)`), identities (`bridgeAddress/runtimeAddress/invokerAddress`) for S7. |
| `OtaSpike/NativeOtaUnits.mm` | `RCT_EXPORT_MODULE(NativeOtaUnits)` with `load(name)` promise (S9). |
| `OtaSpike/OtaSpikeRunner.{h,mm}` | S1-S10 on a private serial queue. |
| `shared/*.cpp`, `native/otacore/src/sha256.cpp` | Compiled into the app target; `HEADER_SEARCH_PATHS` += `shared`, `native/otacore/include`. |

Bundle selection: **embedded host = bundle resource `ota/embedded/host.hbc` used through an explicit URL** (not `main.jsbundle`). Patched host = `Documents/ota/patched/host.hbc`. A Run Script phase ("Copy OTA spike assets") rsyncs `ios/../.spike-assets/ios/` to `<app>/ota/` at build time (warning, not error, if the dir is missing). The runner/buttons copy `ota/` to `Documents/ota/` before use (delete + copy); units and the patched host are evaluated only from Documents. Results are also written to `Documents/ota_spike_results.txt`.

## Build / run
```sh
N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH
cd examples/spike-app && node scripts/prepare-spike-assets.mjs     # JS agent's assets -> .spike-assets/ios
cd ios && pod install --repo-update                                  # first time needs --repo-update (SocketRocket 0.7.1)
open OtaSpike.xcworkspace   # run on a simulator or device; tap "Run all spike tests"
```
Reading results: Xcode console / `xcrun simctl spawn booted log stream --predicate 'eventMessage CONTAINS "OTA_SPIKE"'`, on-screen text view, or
`cat "$(xcrun simctl get_app_container booted <bundle id> data)/Documents/ota_spike_results.txt"`.
For a Release run use scheme config Release; "Bundle React Native code and images" phase then tries to build `main.jsbundle` from `index.js` (not used by the spike; the host is `ota/embedded/host.hbc`), so it is harmless but slow.

Command-line build that was actually used here (no simulator platform installed, see deviations):
```sh
SYM=$PWD/../../.work/ios-dd/Build/Products
xcodebuild -project Pods/Pods.xcodeproj -target Pods-OtaSpike -sdk iphonesimulator -configuration Debug ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO SYMROOT=$SYM OBJROOT=$PWD/../../.work/ios-dd/Intermediates build
xcodebuild -project OtaSpike.xcodeproj -target OtaSpike  -sdk iphonesimulator -configuration Debug ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO SYMROOT=$SYM OBJROOT=$PWD/../../.work/ios-dd/Intermediates build
```
Output: `.work/ios-dd/Build/Products/Debug-iphonesimulator/OtaSpike.app` (DerivedData deleted after the build; rebuild to recreate).

## What compiled / ran
| Step | Result |
|---|---|
| `pod install --repo-update` | OK (~15 s after the Hermes tarball is cached; first run also fetches it) |
| All 80+ Pods targets, Debug, iphonesimulator26.5, arm64 | BUILD SUCCEEDED (after the fmt patch below) |
| App target (my ObjC/ObjC++ + `shared/` + `sha256.cpp`, link) | BUILD SUCCEEDED; `nm` shows `NativeOtaUnits` and `otaspike::*` symbols; `.app/ota/embedded/host.hbc` (855 KB) present |
| `xcodebuild -workspace ... -scheme OtaSpike -destination 'generic/platform=iOS Simulator'` | FAILS in this environment: "Found no destinations / iOS 26.5 is not installed" (Xcode platform component absent), hence the two-step `-project`/`-target` build above |
| Launch / any test | NOT RUN (no simulator runtime, per instructions) |

| Test | implemented | compiled | run on device |
|---|---|---|---|
| S1 embedded host, mount SpikeHost, probe + rendered text | yes | yes | NOT RUN |
| S2 patched host via `bundleURL` (fresh VM) | yes | yes | NOT RUN |
| S3 embedded cabs after host, mount `cabs`, `CABS:v1` | yes | yes | NOT RUN |
| S4 four pre-check rejections, `pwned` false, Hermes-bypass for wrong-version only | yes | yes | NOT RUN |
| S5 bad-entry -> `RequireError`, then `bus` loads | yes | yes | NOT RUN |
| S6 patched cabs after v1 -> stays v1 | yes | yes | NOT RUN |
| S7 `RCTHost reload`, fresh runtime/invoker, pointer identity compare | yes | yes | NOT RUN |
| S8 timings (map, pre-check, sha256, eval, require, bytes; host bytes) | yes | yes | NOT RUN |
| S9 `import()`: tries `accessibilityActivate` on the "import() cabs" button in SpikeHost; falls back to calling `__loadBundleAsync('cabs')` directly (details say which path) | yes | yes | NOT RUN |
| S10 host swap embedded -> patched via reload, no surface mounted, then S3 again | yes | yes | NOT RUN |

Test order in the runner: S1, S4, S3, S6, S5, S2, S9, S7, S10, S8 (S2/S9/S8 start from a destroyed + recreated VM; S7/S10 use `RCTHost reload`). Final line `OTA_SPIKE SUMMARY pass=N fail=M`.

## Deviations from the contract
* Entry module is run by a second JS-thread task calling `globalThis.__otaRequire(entryId)` (the JS agent's rethrowing wrapper, per `spike.json` `js.requireFn`), NOT by `evaluateUnitAsync`'s built-in `__r` call (I pass `entryModuleId = -1` there). Reason: Metro's `__r` reports entry exceptions through `ErrorUtils.reportFatalError` and does not rethrow (fatal in release), so `RequireError` could never be produced. **Bug to report for `shared/ota_unit_jsi.h`:** it should call `__otaRequire` when present.
* Rendered text is read from the Fabric view tree (`accessibilityLabel` of `RCTParagraphComponentView`, which falls back to `attributedText.string`). Surfaces for tests are mounted in the small container on the native screen (needs to be in a window to lay out).
* S9 cannot invoke `import()` from native directly; see the table. Verify manually: Open host, tap "import() cabs".
* S4 "misaligned view" is the embedded cabs mapping at `+1`.
* Warnings only: overriding `bridgelessEnabled/fabricEnabled/turboModuleEnabled` in the delegate (deprecated protocol methods; harmless).
* Template changes: Swift `AppDelegate` and `LaunchScreen.storyboard` removed (ibtool needs the iOS platform component, absent here; `UILaunchScreen` dict used instead), `ENABLE_USER_SCRIPT_SANDBOXING=NO` (for the rsync phase).
* Podfile `post_install` patches `Pods/fmt/include/fmt/base.h` to `FMT_USE_CONSTEVAL 0`: Xcode 26's clang rejects fmt's consteval format strings (RN 0.78.3 ships that fmt). Needed for any Xcode 26 build of RN 0.78.

## API surprises vs `docs/research/rn-0.78-loader.md`
* `RCTBridge` has no `runtime` / `jsCallInvoker` declarations: declared via category as Re.Pack does. `[RCTBridge currentBridge]` is an `RCTBridgeProxy : NSProxy`, which implements `- (void *)runtime` and `- (std::shared_ptr<facebook::react::CallInvoker>)jsCallInvoker` (both log a "please migrate" warning in dev). `currentBridge` is declared in `<React/RCTBridge+Private.h>`.
* `RCTHost` public header (`<ReactCommon/RCTHost.h>`) has **no `reload`**; it is in `RCTHost+Internal.h` (`- (void)reload;`, `RCTHost.mm` L375). Declared via category. `RCTHost reload` re-reads the provider via `_setBundleURL:` (only adopts a URL that differs from the previous delegate URL).
* No public "create host without a surface": used `RCTRootViewFactory -createReactHost:` (public helper, creates + `[host start]`) and assigned `rootViewFactory.reactHost` myself, after calling `RCTEnableTurboModuleInterop(YES)` and `RCTEnableTurboModuleInteropBridgeProxy(YES)` (declared in `RCTBridge.h`; the factory's private path does the same). This is the "VM prewarm without a surface" of DESIGN 5.8.
* There is no way to destroy an `RCTHost` explicitly; destroying = dropping `RCTRootViewFactory.reactHost`/factory (`RCTHost dealloc` calls `[_instance invalidate]`).
* `RCTReactNativeFactory initWithDelegate:` weakly holds the delegate (keep a strong ref). The delegate must set `dependencyProvider` (`RCTAppDependencyProvider` from `ReactAppDependencyProvider`) and implements `-bundleURL`; `RCTDefaultReactNativeFactoryDelegate`'s default `-bundleURL` raises.
* `NativeOtaUnits` under bridgeless relies on TurboModule interop (legacy `RCT_EXPORT_MODULE` classes are found through `RCTGetModuleClasses()` when interop is enabled); no codegen spec. JS side: `TurboModuleRegistry.get('NativeOtaUnits')` / `NativeModules.NativeOtaUnits`. Unverified at runtime.
* `Debug` build: `RCT_DEV` dev menu / inspector active; fine with a file bundle URL.
