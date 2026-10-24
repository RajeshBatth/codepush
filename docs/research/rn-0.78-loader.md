# RN 0.78 bridgeless: how to boot a patched host bundle and evaluate unit .hbc

Research only. Source studied: `facebook/react-native` tag **v0.78.3** (latest 0.78.x on npm as of this writing; tag object `8635d536...`, commit `026ea353de04230f2a82800c49528c06744667e9`). All RN paths below are relative to `packages/react-native/` in that tag. Hermes: `sdks/.hermesversion` = `hermes-2025-01-13-RNv0.78.0-a942ef374897d85da38e9c8904574f8376555388`; Hermes paths are at commit `a942ef37...` of `facebook/hermes`.

Rule used: "UNVERIFIED" means I could not confirm it from source.

## 0. Verdict

| | Option 1: RN's own loaders (`ReactInstance.loadJSBundle`, `RCTInstance _loadJSBundle`) | Option 2: own JSI `runtime.evaluateJavaScript(buffer, "unit://cabs")` from a TurboModule |
|---|---|---|
| **Android** | **Boot of patched host: YES** (public, `getDefaultReactHost(jsBundleFilePath=...)`). **Second script: no direct API.** `ReactInstance.loadJSBundle` is package-private (`final class ReactInstance`), and `BridgelessCatalystInstance.loadScriptFromFile/loadSplitBundleFromFile` throw `UnsupportedOperationException`. The only public route is `ReactContext.registerSegment(int, String, Callback)` (see below). | **Viable**, and proven by Re.Pack's `NativeScriptLoader.cpp` (same technique). Needs `@FrameworkAPI` opt-in for `CallInvokerHolderImpl`. |
| **iOS** | **Boot of patched host: YES** (`bundleURL` / `RCTRootViewFactoryConfiguration.bundleURLBlock`, re-read on reload). **Second script: only `registerSegmentWithId:path:`** (declared on `RCTBridge`, forwarded by `RCTBridgeProxy` to `ReactInstance::registerSegment`). `RCTInstance _loadJSBundle` is private. | **Viable**, proven by Re.Pack `ScriptManager.mm` (`[bridge runtime]`, `[bridge jsCallInvoker]`). Same caveats. |

Recommendation: **host boot = Option 1 (supported paths). Unit evaluate = Option 2 (own JSI call), with `registerSegment` as a cheaper fallback/spike candidate.** `registerSegment` is public-ish and already evaluates a file via mmap with Hermes bytecode detection, but it gives no completion/error signal and fixes `sourceURL` to `seg-<id>.js` (details in A and B). Option 2 gives a result/exception per unit and our own sourceURL, at the cost of using framework-only/unofficial surface (`FrameworkAPI` on Android; undeclared `[RCTBridge runtime]`/`jsCallInvoker` selectors on iOS).

## A. Android bridgeless

### A1. Startup bundle load
`ReactHostImpl.getOrCreateReactInstance()` (`ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.java`, ~L1185-1215) creates `new ReactInstance(...)`, then `instance.loadJSBundle(bundleLoader)`, where `bundleLoader` is `mReactHostDelegate.getJsBundleLoader()` (unless dev support + Metro running, ~L1295-1305, then `loadJSBundleFromMetro()`).

`ReactHostDelegate.kt` (same dir): `public val jsBundleLoader: JSBundleLoader` (fixed per delegate; not re-read from disk by path).

`ReactInstance.loadJSBundle` (`.../runtime/ReactInstance.java` L345):
```java
public void loadJSBundle(JSBundleLoader bundleLoader) {
  bundleLoader.loadScript(new JSBundleLoaderDelegate() {
    public void loadScriptFromFile(String fileName, String sourceURL, boolean loadSynchronously) {
      mBridgelessReactContext.setSourceURL(sourceURL);
      loadJSBundleFromFile(fileName, sourceURL);
    }
    public void loadSplitBundleFromFile(String fileName, String sourceURL) { loadJSBundleFromFile(fileName, sourceURL); }
    public void loadScriptFromAssets(AssetManager assetManager, String assetURL, boolean loadSynchronously) {
      mBridgelessReactContext.setSourceURL(assetURL);
      loadJSBundleFromAssets(assetManager, assetURL);
    }
    ...
```
`JReactInstance::loadJSBundleFromFile` (`ReactAndroid/src/main/jni/react/runtime/jni/JReactInstance.cpp` L150): `script = JSBigFileString::fromPath(fileName); instance_->loadScript(std::move(script), sourceURL);`

`ReactInstance::loadScript` (`ReactCommon/react/runtime/ReactInstance.cpp` L223):
```cpp
runtimeScheduler_->scheduleWork([...](jsi::Runtime& runtime) {
  ...
  runtime.evaluateJavaScript(buffer, sourceURL);
  if (!jsErrorHandler_->hasHandledFatalError()) { jsErrorHandler_->setRuntimeReady(); }
  ...
  strongBufferedRuntimeExecuter->flush();
```
So the main bundle is evaluated on the **JS thread** via `RuntimeScheduler::scheduleWork`, after which the `BufferedRuntimeExecutor` is flushed (anything queued via the *buffered* executor waits for this).

### A2. `DefaultReactHost.getDefaultReactHost` (0.78.3)
`ReactAndroid/src/main/java/com/facebook/react/defaults/DefaultReactHost.kt`, the full overload:
```kotlin
@JvmStatic
public fun getDefaultReactHost(
    context: Context,
    packageList: List<ReactPackage>,
    jsMainModulePath: String = "index",
    jsBundleAssetPath: String = "index",
    jsBundleFilePath: String? = null,
    isHermesEnabled: Boolean = true,
    useDevSupport: Boolean = ReactBuildConfig.DEBUG,
    cxxReactPackageProviders: List<(ReactContext) -> CxxReactPackage> = emptyList(),
    exceptionHandler: (Exception) -> Unit = { throw it },
    bindingsInstaller: BindingsInstaller? = null,
): ReactHost
```
Body:
```kotlin
val bundleLoader =
  if (jsBundleFilePath != null) {
    if (jsBundleFilePath.startsWith("assets://")) JSBundleLoader.createAssetLoader(context, jsBundleFilePath, true)
    else JSBundleLoader.createFileLoader(jsBundleFilePath)
  } else JSBundleLoader.createAssetLoader(context, "assets://$jsBundleAssetPath", true)
```
Facts: (1) docs say `jsBundleFilePath` is "composed in a `file://...` URL" but the code passes the raw path to `createFileLoader(fileName)` = `createFileLoader(fileName, fileName, false)`, so **sourceURL == the file path** (`JSBundleLoader.java`). (2) The host is cached in a static `reactHost` (`if (reactHost == null)`); a second call with other args is ignored. So the patched path must be decided before the first call; later switches need a new process, or a custom `ReactHostDelegate`. (3) `DefaultReactHostDelegate` takes a `JSBundleLoader` instance (marked `@UnstableReactNativeAPI`), so a custom delegate can supply a loader that resolves the path lazily on each `ReactHost.reload()` (recreate instance) -- UNVERIFIED on-device whether `reload()` re-asks the delegate's loader (code suggests yes, `getOrCreateReactInstance` reads `mReactHostDelegate.getJsBundleLoader()` each time, but the `val` itself is fixed so the loader object must be dynamic).
`JSBundleLoader` factories (all in `ReactAndroid/src/main/java/com/facebook/react/bridge/JSBundleLoader.java`): `createAssetLoader(Context, String assetUrl, boolean loadSynchronously)`, `createFileLoader(String)`, `createFileLoader(String fileName, String assetUrl, boolean)`, `createCachedBundleFromNetworkLoader`, `createCachedSplitBundleFromNetworkLoader`, `createRemoteDebuggerBundleLoader`.

Patched-host boot: write the patched host `.hbc` to disk and pass its absolute path as `jsBundleFilePath`; keep an `assets://index.android.bundle` fallback by choosing the argument at app start. Embedded-asset path = `jsBundleAssetPath` (or `jsBundleFilePath = "assets://..."`).

### A3. Evaluating a second script in a running bridgeless instance
- `ReactInstance` is `final class ReactInstance` (package-private, `@ThreadSafe`). `loadJSBundle`, `registerSegment(int, String)`, `getBufferedRuntimeExecutor()`, `getJSCallInvokerHolder()` are not reachable from app code without reflection.
- `ReactHostImpl.loadBundle(JSBundleLoader)` and `registerSegment(int,String,Callback)` are package-private (`/* package */`).
- **Public:** `ReactContext` (`bridge/ReactContext.java` L526):
  ```java
  public abstract void registerSegment(int segmentId, String path, Callback callback);
  public abstract @Nullable JavaScriptContextHolder getJavaScriptContextHolder();   // L497
  public abstract @Nullable CallInvokerHolder getJSCallInvokerHolder();             // L503
  ```
  `BridgelessReactContext.registerSegment` -> `mReactHost.registerSegment(...)` -> `ReactHostImpl.registerSegment` (runs on the default ReactInstance executor, i.e. background, then `reactInstance.registerSegment`, then **invokes `callback` immediately after enqueueing**, not after evaluation).
- `ReactInstance::registerSegment` (`ReactInstance.cpp` L334):
  ```cpp
  runtimeScheduler_->scheduleWork([=](jsi::Runtime& runtime) {
    auto script = JSBigFileString::fromPath(segmentPath);
    if (script->size() == 0) throw std::invalid_argument("Empty segment registered with ID ...");
    auto buffer = std::make_shared<BigStringBuffer>(std::move(script));
    runtime.evaluateJavaScript(buffer, JSExecutor::getSyntheticBundlePath(segmentId, segmentPath));
  ```
  `getSyntheticBundlePath` (`ReactCommon/cxxreact/JSExecutor.cpp` L20): returns `bundlePath` for main bundle id, else **`"seg-<id>.js"`**. So `sourceURL` cannot be `unit://cabs`; it is `seg-N.js` (unit identity must be encoded in the segment id). Runs on the JS thread; errors thrown inside `scheduleWork` are not surfaced to the caller (what the RuntimeScheduler does with a thrown JSError there: UNVERIFIED).
- `BridgelessCatalystInstance` (`runtime/BridgelessCatalystInstance.kt`) throws `UnsupportedOperationException` for `loadScriptFromAssets`, `loadScriptFromFile`, `loadSplitBundleFromFile`, `registerSegment`. So do not call through `reactContext.catalystInstance`.
- Public vs internal: `ReactContext.registerSegment` is a plain public method (no opt-in annotation); `getJSCallInvokerHolder`/`getJavaScriptContextHolder` are public too; the concrete `CallInvokerHolderImpl` is `@FrameworkAPI` (opt-in required, "can change between minor versions", `common/annotations/FrameworkAPI.kt`).
- Hermes bytecode: yes, via `runtime.evaluateJavaScript` auto-detection (section E).

## B. iOS bridgeless

### B1. Startup
0.78 has the factory classes: `Libraries/AppDelegate/` contains `RCTAppDelegate.h/.mm`, `RCTReactNativeFactory.h/.mm`, `RCTDefaultReactNativeFactoryDelegate.h/.mm`, `RCTRootViewFactory.h/.mm`.
- `RCTAppDelegate : RCTDefaultReactNativeFactoryDelegate` with `@property RCTReactNativeFactory *reactNativeFactory`.
- `RCTDefaultReactNativeFactoryDelegate.mm`: `- (NSURL *_Nullable)bundleURL` raises "RCTAppDelegate::bundleURL not implemented" unless overridden (app returns the URL). `sourceURLForBridge:` also (legacy bridge).
- `RCTRootViewFactory.mm` L250-262 (`createReactHost:`):
  ```objc
  RCTHost *reactHost = [[RCTHost alloc] initWithBundleURLProvider:self->_configuration.bundleURLBlock
                                    hostDelegate:_hostDelegate turboModuleManagerDelegate:... jsEngineProvider:^{ return [weakSelf createJSRuntimeFactory]; } launchOptions:launchOptions];
  [reactHost setBundleURLProvider:^NSURL *() { return [weakSelf bundleURL]; }];
  [reactHost start];
  ```
  `RCTRootViewFactoryConfiguration` has `initWithBundleURL:newArchEnabled:` and `initWithBundleURLBlock:newArchEnabled:` (`RCTRootViewFactory.h`). `RCTReactNativeFactory.mm` L193 feeds `strongSelf.bundleURL` from the delegate.
- `RCTHost.mm`: `_bundleURLProvider()` is invoked in `start` (L206) and again on reload (L428), so **a dynamic block that returns the patched `file://` URL (else `[NSBundle.mainBundle URLForResource:@"main" withExtension:@"jsbundle"]`) is re-evaluated on reload**; no process restart needed on iOS.
- Typical debug `RCTBundleURLProvider` (`React/Base/RCTBundleURLProvider.h`: `jsBundleURLForBundleRoot:`) is irrelevant for release.

### B2. Load path
`RCTHost.h`: `initWithBundleURLProvider:hostDelegate:turboModuleManagerDelegate:jsEngineProvider:launchOptions:`; `RCTHostDelegate` has optional `loadBundleAtURL:onProgress:onComplete:` (host can supply its own loader; default is `RCTJavaScriptLoader`). `RCTInstance.mm`: `_loadJSBundle:` -> `[_delegate loadBundleAtURL:...]` -> `_loadScriptFromSource:` -> `_reactInstance->loadScript(std::make_unique<NSDataBigString>(source.data), url, completion)` (same `ReactInstance::loadScript`, JS thread, then flush of buffered executor).
`RCTJavaScriptLoader.mm` (`React/Base/`): for `file://` URLs reads the first 4 bytes; only the RAM magic `0xFB0BD1E5` is special, anything else is `ScriptTag::String` (`ReactCommon/cxxreact/JSBundleType.cpp` `parseTypeFromHeader`) and loaded as mmap'd `NSData` (`NSDataReadingMappedIfSafe`). So an `.hbc` file works as a host bundle; `RCT_ENABLE_INSPECTOR` off => sync load refused with `CannotBeLoadedSynchronously` and falls back to the async path (still works).

### B3. Second script
- `RCTInstance.h` (internal, in `ReactCommon/react/runtime/platform/ios/ReactCommon/`): `callFunctionOnBufferedRuntimeExecutor:`, `registerSegmentWithId:path:` (L77), not on `RCTHost`'s public surface except `RCTHost.mm` L360 `registerSegmentWithId:path:` (declared in the `.mm`; whether exported in `RCTHost.h`: UNVERIFIED, not in the grep of `RCTHost.h`).
- Public route: `RCTBridge.h` L140 `- (void)registerSegmentWithId:(NSUInteger)segmentId path:(NSString *)path;`. In bridgeless, `[RCTBridge currentBridge]` is an `RCTBridgeProxy` (`RCTInstance.mm` ~L255-275 `[RCTBridge setCurrentBridge:(RCTBridge *)bridgeProxy]`) whose `registerSegmentWithId:path:` (RCTBridgeProxy.mm L188) calls the block that forwards to `_reactInstance->registerSegment(...)`. Same semantics as Android: file mmap, `seg-N.js` sourceURL, JS thread, no completion/error.
- No `RCTBridge loadAndExecuteSplitBundleURL` in the bridgeless path (legacy API on `RCTCxxBridge`; not usable with the proxy: UNVERIFIED but nothing in `RCTBridgeProxy.h` implements it).
- Own JSI: `RCTBridgeProxy` implements `- (void *)runtime` (L97) and `- (std::shared_ptr<CallInvoker>)jsCallInvoker` (L103; property declared in `RCTBridgeProxy.mm` class extension, not the header). Re.Pack declares categories `@interface RCTBridge (JSIRuntime) - (void *)runtime;` and `RCTBridge (RCTTurboModule) - (std::shared_ptr<CallInvoker>)jsCallInvoker;` and calls them on `self.bridge` (`packages/repack/ios/ScriptManager.mm` L16-22, L383-417). C++ TurboModules additionally get `jsInvoker` via `ObjCTurboModule::InitParams` (`RCTTurboModule.h` L52-59).

## C. C++ / JSI

- `CallInvoker` in 0.78 (`ReactCommon/callinvoker/ReactCommon/CallInvoker.h`):
  ```cpp
  using CallFunc = std::function<void(jsi::Runtime&)>;
  virtual void invokeAsync(CallFunc&& func) noexcept = 0;
  virtual void invokeAsync(SchedulerPriority, CallFunc&& func) noexcept;
  virtual void invokeSync(CallFunc&& func) = 0;
  // plus std::function<void()> compat overloads
  ```
  So **yes**: `invokeAsync(std::function<void(jsi::Runtime&)>)` exists (it is `CallFunc`).
- Bridgeless implementation: `RuntimeSchedulerCallInvoker` (`ReactCommon/react/renderer/runtimescheduler/RuntimeSchedulerCallInvoker.cpp`): `invokeAsync` -> `runtimeScheduler->scheduleWork(...)`; `invokeSync` -> `executeNowOnTheSameThread(...)`. It is created in `JReactInstance` ctor (`JReactInstance.cpp` L95) and exposed as `getJSCallInvokerHolder()`. Note it is **unbuffered**: work may run before the main bundle finishes (the bundle itself is a scheduled task, so ordering follows the queue, but `BufferedRuntimeExecutor` is what guarantees "after main bundle").
- `RuntimeExecutor` (`ReactCommon/runtimeexecutor/ReactCommon/RuntimeExecutor.h`): `std::function<void(std::function<void(jsi::Runtime&)>&&)>`. `ReactInstance::getUnbufferedRuntimeExecutor()` / `getBufferedRuntimeExecutor()` (`ReactInstance.cpp` L176/L187); Java `ReactInstance.getBufferedRuntimeExecutor()` is package-private (`/* package */ native`), the unbuffered one `private native`. Not reachable from a TurboModule without reflection. `ReactHostImpl.getRuntimeExecutor()` is package-private too.
- Handle available to TurboModule code: Android `ReactContext.getJSCallInvokerHolder()` (-> `CallInvokerHolderImpl`, `@FrameworkAPI`) and `getJavaScriptContextHolder().get()` (raw `jsi::Runtime*`, from `JReactInstance::getJavaScriptContext`). iOS: C++ TurboModule `jsInvoker`, `[bridge jsCallInvoker]`, `[bridge runtime]`.
- How TurboModule methods get `jsi::Runtime&`: C++ TurboModule methods are `jsi::HostFunction`s (`TurboModule.h`: `TurboModule(std::string name, std::shared_ptr<CallInvoker> jsInvoker)`; method signature `(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t)`), so they run on the JS thread with `rt` in hand: **sync C++ method => can call `rt.evaluateJavaScript` directly.** ObjC/Java modules' async/promise methods run on the module queue/thread; they must hop to JS via `jsInvoker->invokeAsync([](jsi::Runtime& rt){...})` and resolve/reject the promise from there (UNVERIFIED which thread Java `@ReactMethod` promise methods use in 0.78; assume not JS). Safer pattern (as Re.Pack): capture `jsi::Runtime*` once (valid only for this ReactInstance lifetime; must be dropped on reload/destroy) and always use it inside `invokeAsync`.
- `jsi::Runtime` (`ReactCommon/jsi/jsi/jsi.h` L186-210):
  ```cpp
  virtual Value evaluateJavaScript(const std::shared_ptr<const Buffer>& buffer, const std::string& sourceURL) = 0;
  virtual std::shared_ptr<const PreparedJavaScript> prepareJavaScript(const std::shared_ptr<const Buffer>& buffer, std::string sourceURL) = 0;
  virtual Value evaluatePreparedJavaScript(const std::shared_ptr<const PreparedJavaScript>& js) = 0;
  ```
  `prepareJavaScript` does the bytecode parse/validate off the final evaluate (and "may be passed to multiple VM instances"); useful to validate version/alignment before committing, but both must be called on the JS thread for Hermes (UNVERIFIED that Hermes `prepareJavaScript` is thread-safe w.r.t. the runtime: it does not touch `runtime_` in the bytecode path, but I did not prove it).
- Hermes implementation (a942ef37, `API/hermes/hermes.cpp` L1476-1560): `HermesRuntimeImpl::evaluateJavaScript` -> `evaluateJavaScriptWithSourceMap` -> `evaluatePreparedJavaScript(prepareJavaScriptWithSourceMap(...))`; in `prepare...`: `bool isBytecode = isHermesBytecode(data,size); if (isBytecode) bcErr = hbc::BCProviderFromBuffer::createBCProviderFromBuffer(std::make_unique<BufferAdapter>(jsiBuffer)); else ... createBCProviderFromSrc(...)` (source is compiled on device). Then `runtime_.runBytecode(provider, runtimeFlags, sourceURL, nullptr env)`. **So HBC `jsi::Buffer`s are accepted** by plain `evaluateJavaScript`, and `sourceURL` is whatever we pass.
- Buffer requirement: the buffer's `data()` must be 4-byte aligned (`BYTECODE_ALIGNMENT`; `sanityCheck`: "Buffer misaligned."). `std::string`-backed `jsi::StringBuffer` (what Re.Pack uses for text) is not guaranteed aligned for bytecode; use an mmap'd buffer (like `BigStringBuffer`/`JSBigFileString`) or an aligned allocation. Also the buffer must outlive execution (provider references it; `runtimeFlags.persistent = true`): keep the `shared_ptr<const Buffer>` alive for the process lifetime, or use an mmap'd buffer that is never unmapped.

## D. Metro runtime side (0.78.3)

- `Libraries/Core/setUpDeveloperTools.js`: the only definition of the global is inside `if (__DEV__) {`, at L79-81:
  ```js
  global[`${global.__METRO_GLOBAL_PREFIX__ ?? ''}__loadBundleAsync`] = require('./Devtools/loadBundleFromServer');
  ```
  A grep of all of `packages/` finds `__loadBundleAsync`/`asyncRequire` only in `setUpDeveloperTools.js` and `metro-config/src/index.flow.js`. So **in production builds RN does not define `global.__loadBundleAsync`**; our definition cannot conflict with RN's. (In dev it would be overwritten by RN's `loadBundleFromServer` at `InitializeCore` time; define ours only in release, or after InitializeCore.)
- `packages/metro-config/src/index.flow.js` (`@react-native/metro-config` 0.78.3): `transformer.asyncRequireModulePath: require.resolve('metro-runtime/src/modules/asyncRequire')` -- **set by default**.
- `metro-runtime@0.81.5` (matches `^0.81.3` required by RN 0.78.3) `src/modules/asyncRequire.js`:
  ```js
  function maybeLoadBundle(moduleID, paths) {
    const loadBundle = global[`${__METRO_GLOBAL_PREFIX__}__loadBundleAsync`];
    if (loadBundle != null) { ... const bundlePath = paths[String(moduleID)]; if (bundlePath != null) return loadBundle(bundlePath); }
    return undefined;
  }
  function asyncRequireImpl(moduleID, paths) { const p = maybeLoadBundle(moduleID, paths); const importAll = () => require.importAll(moduleID);
    return p != null ? p.then(importAll) : importAll(); }
  ```
  Consequence: if `__loadBundleAsync` is undefined (release), `import()` just does `require.importAll(moduleID)` synchronously (works only if the module is already in the registry). If we define `global.__loadBundleAsync = (bundlePath) => Promise`, `asyncRequire` will call it with the string from the `paths` map (`paths` is only populated by Metro when the serializer emits per-module bundle paths, i.e. our splitter must emit them), wait for it, then `importAll`. This is the intended extension point. Honoring `__METRO_GLOBAL_PREFIX__`: the global name is `${__METRO_GLOBAL_PREFIX__}__loadBundleAsync` (prefix is `''` unless configured in `serializer`/`transformer`), so our definition must use the same key.

## E. Hermes bytecode validation

Hermes @ a942ef37:
- `include/hermes/BCGen/HBC/BytecodeVersion.h`: `const static uint32_t BYTECODE_VERSION = 96;` (at this revision; confirm vs. the shipped `hermesc` with `HermesRuntime::getBytecodeVersion()`, `hermes.cpp` L1096: `return hbc::BYTECODE_VERSION;`).
- `lib/BCGen/HBC/BytecodeDataProvider.cpp` `sanityCheck` (L53-118), invoked from `BytecodeFileFields::populateFromBuffer` (L205) i.e. from `BCProviderFromBuffer` construction, **before any code runs**:
  - size < header -> "Buffer smaller than a bytecode file header..."
  - alignment -> "Buffer misaligned."
  - `header->magic != MAGIC` -> "Incorrect magic number"
  - `header->version != hbc::BYTECODE_VERSION` -> **"Wrong bytecode version. Expected 96 but got N"**
  - `functionCount == 0` -> "Bytecode does not contain any functions"; `aref.size() < header->fileLength` -> size error.
  - The SHA1 hash (`hashIsValid`) is checked **only under `HERMES_SLOW_DEBUG`**, so release builds do not verify integrity; we must verify the unit hash ourselves (already in the design).
- Error surfaced: `prepareJavaScriptWithSourceMap` -> `throw jsi::JSINativeException("Compiling JS failed: " + error)` (L1500-1506), i.e. e.g. `Compiling JS failed: Wrong bytecode version. Expected 96 but got 94`. It is a C++ `jsi::JSINativeException`, not a JS exception; the try/catch in our native loader must catch `std::exception`/`jsi::JSIException`.
- **Pitfall:** `isHermesBytecode` only checks the magic (`isBytecodeStream`: `size >= sizeof(header) && header->magic == MAGIC`). A buffer without the magic is treated as **JS source and compiled on device** (RN's Hermes includes the compiler; not `HERMESVM_LEAN` -- UNVERIFIED for 0.78 prebuilt binaries). So a truncated or wrong-format file may produce a SyntaxError instead of a version error. Pre-check with `HermesRuntime::isHermesBytecode(data,len)` or our own header check before evaluating.

## F. Prior art

- **Re.Pack `ScriptManager` (Callstack)** -- closest match to Option 2 on both platforms. Repo `callstack/repack`, commit `32c32c0660650b559ed61312a9eb29fc5f328235`:
  - Android: `packages/repack/android/src/versioned/CallInvoker/latest/com/callstack/repack/NativeScriptLoader.kt` (`reactContext.catalystInstance?.jsCallInvokerHolder as? CallInvokerHolderImpl`; `reactContext.javaScriptContextHolder?.get()` for the raw runtime pointer; comment "RN 0.74: CatalystInstance or BridgelessCatalystInstance"; `@OptIn(FrameworkAPI::class)`), and `android/src/main/cpp/NativeScriptLoader.cpp` (`callInvoker->invokeAsync([...]{ rt->evaluateJavaScript(std::make_unique<jsi::StringBuffer>(source), sourceUrl); resolve(...)} catch -> reject("ScriptEvalFailure", ...))`).
  - iOS: `packages/repack/ios/ScriptManager.mm` (L16-22 category declarations, L383-417 `callInvoker->invokeAsync(... runtime->evaluateJavaScript(StringBuffer, sourceUrl))`).
  - Note: it evaluates **text JS** via `StringBuffer`; HBC-specific alignment is not handled there. Whether `reactContext.catalystInstance` is non-null in 0.78 bridgeless: `BridgelessReactContext` returns a `BridgelessCatalystInstance` whose `jsCallInvokerHolder` is `reactHost.getJSCallInvokerHolder()!!` (`BridgelessCatalystInstance.kt` L101-103), consistent with their comment.
- **Microsoft react-native-code-push 9.0.1** (`microsoft/react-native-code-push`, commit `50a7ed5b...`): `android/.../CodePushNativeModule.java` uses reflection on `ReactInstanceManager` (`setJSBundle`, `resolveInstanceManager`, L112-217); a repo-wide grep for `ReactHost|RCTHost|bridgeless` finds **no matches**. So no bridgeless-native reload path; do not use as prior art for 0.76+ (known not to support bridgeless: from the grep, not from an issue thread).
- **Expo Updates:** UNVERIFIED from source (I did not read `expo-updates`). Secondary sources only: Callstack brownfield docs (<https://oss.callstack.com/react-native-brownfield/docs/guides/expo-updates/expo-54>) describe expo-updates restart via a stored `ReactHost` in `UpdatesController`; Cresc docs (<https://cresc.dev/docs/brownfield>) describe `jsBundleFilePath` for cold start and `ReactHost` for in-process restart. Expo only boots a different full bundle; it does not evaluate additional units.
- `react-native-multibundle`, other forks: not checked (UNVERIFIED).

## G. Recommended call sequences

### Android (RN 0.78 bridgeless)
(i) Boot from patched host file
1. Early in `Application.onCreate` (before first `getDefaultReactHost`), resolve the active host file: `File("<filesDir>/units/host/<hash>.hbc")` if its hash verifies and `bytecodeVersion` matches, else `null`.
2. `reactHost = DefaultReactHost.getDefaultReactHost(context, packages, jsMainModulePath="index", jsBundleAssetPath="index.android.bundle", jsBundleFilePath = activeHostPathOrNull, isHermesEnabled=true)`; null falls back to `assets://index.android.bundle`. (Check how your template names the asset: `createAssetLoader` is given `"assets://$jsBundleAssetPath"`.)
3. Because the host is cached and the loader is fixed, switching host versions = next cold start (or build a custom `DefaultReactHostDelegate` with a dynamic `JSBundleLoader` and call `reactHost.reload(...)`: spike).
4. A crash-loop guard must run before step 2 (not covered by RN).

(ii) Evaluate a unit .hbc
1. `ReactContext` from `ReactHost.currentReactContext` (or from the TurboModule's `reactApplicationContext`), after the main bundle has started.
2. Java side of our TurboModule: read/verify the unit file (hash, `HermesRuntime::isHermesBytecode`/version header), get `reactContext.jsCallInvokerHolder as CallInvokerHolderImpl` (`@OptIn(FrameworkAPI)`) and `reactContext.javaScriptContextHolder.get()`; pass to JNI (Re.Pack pattern).
3. C++: mmap the unit file into an aligned, never-freed `jsi::Buffer`; `callInvoker->invokeAsync([rt, buf, url, promise]{ try { rt->evaluateJavaScript(buf, "unit://cabs"); resolve } catch (const std::exception&){ reject } })`.
4. Fallback: `reactContext.registerSegment(segId, unitPath, Callback)` (public API, no error signal, sourceURL `seg-<id>.js`).

### iOS (RN 0.78 bridgeless)
(i) Boot from patched host file
1. Use `RCTReactNativeFactory`/`RCTRootViewFactory` as in the template; override `- (NSURL *)bundleURL` (or pass `bundleURLBlock`) to return `[NSURL fileURLWithPath:activePatchedHostPath]` after verifying hash and version, else `[NSBundle.mainBundle URLForResource:@"main" withExtension:@"jsbundle"]`.
2. `RCTHost` re-calls this block on `start` and on reload, so a reload after applying a patch picks up the new file in-process (verify on device).

(ii) Evaluate a unit .hbc
1. In our TurboModule (ObjC++ or C++): get `facebook::jsi::Runtime*` from `[RCTBridge currentBridge]` (`- (void*)runtime`, via category declaration as Re.Pack does) or from the C++ TurboModule `jsInvoker`; get `std::shared_ptr<CallInvoker>` from `[bridge jsCallInvoker]`/`InitParams.jsInvoker`.
2. Verify and mmap the unit as an aligned, never-freed `jsi::Buffer`; `callInvoker->invokeAsync([=]{ rt->evaluateJavaScript(buf, "unit://cabs"); ... })`, catching `std::exception` and rejecting the promise.
3. Fallback: `[[RCTBridge currentBridge] registerSegmentWithId:id path:path]`.

## H. Unknowns requiring an on-device spike

1. Does `rt->evaluateJavaScript(<aligned mmap HBC buffer>, "unit://cabs")` from `invokeAsync` work in a 0.78.3 bridgeless release build on both OSes (Re.Pack proves text only)? Confirm no `Buffer misaligned` and no GC/lifetime issue with a never-freed mmap.
2. Exact error text/exception type for a wrong-version `.hbc` at runtime, and that a wrong-magic file is silently compiled as source (E pitfall).
3. What happens on a thrown exception in `registerSegment`'s `scheduleWork` (crash vs JS error handler) -- UNVERIFIED.
4. Lifetime of the captured `jsi::Runtime*`: invalidated on `ReactHost.reload()`/RCTHost reload; verify the module is torn down (`invalidate`) first and that stale pointers cannot be used.
5. Android: whether `ReactHost.reload()` re-queries a dynamic `JSBundleLoader` (so that a patched host can be applied in-process) vs. cold start only; `DefaultReactHost` static caching.
6. iOS: whether `RCTHost.reload` really re-reads `_bundleURLProvider()` for a changed `file://` URL (code at `RCTHost.mm` L428 suggests yes).
7. Whether `[RCTBridge currentBridge]` runtime/jsCallInvoker selectors remain stable in 0.78.x and are not stripped (Re.Pack relies on them: runtime check `respondsToSelector:`).
8. Ordering: is `invokeAsync` (unbuffered) safe at app start before the host bundle finished? Probably queue-ordered after the main bundle task, but a unit load should wait for a JS-side "host ready" signal.
9. `Callback` of `ReactContext.registerSegment` fires at enqueue, not completion (ReactHostImpl L879-880) -- confirm on device.
10. `global.__loadBundleAsync` in dev builds is overwritten by RN's version when `setUpDeveloperTools` runs; decide the dev strategy (disable units in dev, or define ours after InitializeCore).
11. Does `jsi::Runtime` handed out by `getJavaScriptContext` / `[bridge runtime]` differ from the one used by `scheduleWork` (decorator layers)? Same pointer assumed (Re.Pack does this).
12. Sync-vs-async TurboModule thread for Java/ObjC methods in 0.78 -- UNVERIFIED.
