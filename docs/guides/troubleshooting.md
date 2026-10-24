# Troubleshooting

**Purpose:** Symptom -> cause -> fix for the build pipeline, native build, Android/iOS spike builds and the CLIs.
**Audience:** Engineers and AI assistants running the repo on a developer machine or an agent shell.
**Source of truth:** `scripts/{env,doctor,native-build,test-all}.sh`, `packages/ota-build/src/{doctor,tools,bundle,patch,handoff,util}.ts` (error codes and messages), `packages/unit-splitter/src/{cli,build,metro-compat,config}.js`, `examples/spike-app/{JS_FINDINGS.md,android/SPIKE_ANDROID.md,ios/SPIKE_IOS.md}`, `native/README.md`, `packages/ota-cli/README.md`, DESIGN.md 5.9.

First step for anything environmental: `bash scripts/doctor.sh` (machine) and `node packages/ota-build/src/cli.ts doctor --project <app>` (project). Commands: [CLI reference](../reference/cli-reference.md). Rule ids (`cycle`, `host-export-missing`, ...) are explained in the [rules catalog](../reference/rules-catalog.md).

## 1. Environment (machine and shell)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `node: command not found` / `npm: command not found` inside a script, subprocess, `sh`, or agent shell; works in your interactive terminal | nvm is loaded lazily by shell functions (`node`/`npm` are functions defined in the rc file), so child processes and `sh` do not see them | `. scripts/env.sh` (puts the newest `~/.nvm/versions/node/v24*/bin` on PATH), or `N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH` (same line the spike docs use). For `sh packages/unit-splitter/scripts/metro-matrix.sh` put an absolute node on PATH first. `ota-build fetch-tools` already looks for `npm` next to `process.execPath` for this reason (`npmBin()` in `tools.ts`). |
| `cmake` configure fails: compiler check fails / `clang` crashes with a missing `libfmt` dylib | `/usr/local/bin/clang` and `clang++` are broken symlinks to a Homebrew `ccache` (missing libfmt) and come first on PATH | Never use bare `clang`. `scripts/native-build.sh` passes `-DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++`; by hand: `cmake -S native -B native/build -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++`. `scripts/doctor.sh` WARNs `ccache symlinks` when it detects them. |
| `cmake: command not found` | Homebrew bin not on PATH | `export PATH=/opt/homebrew/bin:$PATH` (`scripts/env.sh` does it); `brew install cmake` |
| Android Gradle build fails inside CMake (`.cxx`), ccache/libfmt error | RN's CMake auto-uses Homebrew's broken `ccache` if it is on PATH; the failure can be cached | Build with ccache off PATH: `export PATH=/usr/bin:/bin:/usr/sbin:/sbin:<node bin>`; delete `examples/spike-app/android/app/.cxx`; then `./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64` (`SPIKE_ANDROID.md`; DESIGN 5.9 item 4) |
| `ota-build doctor` / `scripts/doctor.sh`: `node` FAIL "< 22.12" | Node too old | Install Node 24 (`nvm install 24`). 22.12 is enough for `require(esm)` of the splitter from `metro.config.js`, but `ota-build`/`ota-cli` declare `>=24` (TypeScript by type stripping, no build step), so 22.x only warns. |
| Commands hang or print odd output in an agent shell when listing directories | **Not documented in this repo; from the project owner's notes:** shell aliases such as `ls` -> `eza` can hang or behave differently in non-interactive agent shells | Bypass aliases: `command ls`, `\ls`, or use the agent's file tools; run scripts with `bash scripts/<name>.sh` (the repo scripts do not rely on aliases). Treat as unverified. |
| Disk full / slow builds | `.work/` and `native/build*` accumulate; native + Android builds need many GB | `bash scripts/clean.sh --dry-run`, then `bash scripts/clean.sh` (removes `.work` and `native/build*`; keeps `node_modules`, `.tools`, sources). `doctor.sh` FAILs under 3 GB free, WARNs under 10 GB. Rebuild `native/build-ota-tools` with `scripts/native-build.sh --tools`. |
| Scripts leave temp dirs in `/tmp` | tests use `os.tmpdir()` | Expected for test suites; use `OTA_WORK_DIR` / `--work-dir` to keep scratch inside the repo's `.work/` |

## 2. Tools missing (hermesc, hdiffz_tool, ota_apply)

| Symptom (error code / message) | Cause | Fix |
|--------------------------------|-------|-----|
| `NO_HERMESC: hermesc not found at ...` | tools not fetched | `bash scripts/fetch-tools.sh` (network once: `npm pack react-native@0.78.3`) or set `OTA_HERMESC` / `OTA_TOOLS_DIR` |
| `HERMESC_SHA: ... not the pinned ...; refusing` | a different hermesc binary (another RN) is being used | `fetch-tools --force`. To support another RN, update `RN_VERSION` and the pin table in `packages/ota-build/src/pins.ts` (see [pipeline doc](../architecture/02-build-and-patch-pipeline.md)). `--allow-unpinned-hermesc` only for experiments: output will not match the shipped Hermes. |
| `HBC_VERSION: hermesc reports bytecode version N, expected 96` | wrong compiler | same as above; bytecode must match the app's Hermes exactly (a v98 file is rejected by a v96 runtime) |
| `UNSUPPORTED_PLATFORM: no pinned hermesc for <os>/<arch>` | host not in the pin table (pins: osx arm64/x64, linux64 x64, win64 x64) | `fetch-tools --platform osx` to fetch another OS's pin for hashing, or add a pin |
| `NO_TOOL: hdiffz_tool not found ...` / `ota_apply not found` | native tools not built | `bash scripts/native-build.sh --tools` (output `native/build-ota-tools/`), or `OTA_HDIFFZ` / `OTA_APPLY` |
| `ota-build` suite shows SKIP in `test-all.sh` | one of the three tools is missing (the skip reason names it) | install the named tool as above |
| `fetch-tools` fails at `npm pack` | no network, or npm not found | check network; ensure node/npm on PATH (section 1) |

## 3. Bundling and the splitter

| Symptom | Cause | Fix |
|---------|-------|-----|
| `unsupported Metro X ... Fix: align the app to React Native 0.78` (`MetroCompatError`) or doctor `metro` FAIL | the Metro-internals adapter accepts only 0.81.x and 0.87.x, and requires metro = metro-config = metro-runtime exactly | pin the three packages to one version of a supported line in the app; for a new line extend `metro-compat.js` and run `packages/unit-splitter/scripts/metro-matrix.sh <version>` |
| Metro cannot resolve `react-native` / modules; works with a normal install | `node_modules` is a **symlink**. Metro's crawler/watcher does not follow it (JS_FINDINGS.md). Doctor: `node-modules` FAIL | use a real install, or `cp -Rc` (APFS clone) the directory; use workspaces/`watchFolders` rather than symlinking all of `node_modules`. Individual linked unit packages are supported (declare them as package-name roots; outside dirs are added to `watchFolders`). |
| Metro prints many ENOENT warnings, or crawls `ios/Pods` / `android/build` | native build dirs are in the project root and contain dangling symlinks (`ios/Pods`) | add to `resolver.blockList`: `/\/ios\/(Pods|build)\/.*/`, `/\/android\/(app\/build|build|\.gradle|\.cxx)\/.*/` (see `examples/spike-app/metro.config.js`). Doctor `metro-crawl` WARN lists dangling links. If `pod install` left Pods half-populated, re-run it (section 5). |
| `... did not call withOtaUnits (or it is disabled): no id factory` | `metro.config.js` exists but does not wrap its config | `module.exports = withOtaUnits(mergeConfig(getDefaultConfig(__dirname), {...}), {units: require('./units.config.json').units, projectRoot: __dirname})`; or `"metroConfig": false` in `units.config.json` if that config is not for the splitter. Doctor `metro-config-wired` checks this by loading the config in a child process. |
| Second build in one process ignores `withOtaUnits` | Metro `loadConfig` result cached | fixed in the splitter (JS_FINDINGS.md); run each build in a fresh process if you embed it |
| `module id collision (48-bit)` | two path keys hash to the same id | practically never at 48 bits (0 collisions on 14,570 files); rename one module or file a bug. Do not lower `--bits` (32-bit collides on real apps). |
| `dynamic-require` error: `Invalid call at line N: require(x)` | non-literal `require`/`import` in first-party code (Metro rejects it; translated to our rule) | use a string literal; see [rules catalog](../reference/rules-catalog.md) |
| Build output differs between machines / `NOT REPRODUCIBLE` | absolute path leaking, env-dependent babel/Metro config, different Metro cache | `ota-build verify-repro` names the files; `node packages/unit-splitter/src/determinism.js` also reports path leaks. Check custom babel plugins and `metro.config.js` for `process.env`/`Date`/absolute paths. |
| Different platform gives different unit set / patch only for one platform | by design: `.android.js`/`.ios.js` differ per platform | `deploy-args` warns "unchanged on <platform>; deploying to the other platform only" |
| `bundle` fails `OUT_NOT_EMPTY` | `--out` exists, is non-empty and has no `build.json` | choose a new dir or delete it (the tool refuses to delete unknown dirs) |
| `patch` fails `TOOLCHAIN_MISMATCH`, `UNIT_SET_MISMATCH`, `APPVERSION_MISMATCH`, `IDS_CONFLICT` | base and new builds came from different toolchains/unit sets/app versions, or module ids moved | rebuild both with the same tools and `--app-version`; adding or removing a unit is not patchable (ride the train) |
| `patch` fails `ROUNDTRIP_FAILED` | the produced patch does not reproduce the new hash through `ota_apply` | do not bypass; rebuild native tools (`--clean`), confirm both build dirs unmodified (`BAD_BUILD` means a file changed after bundling) |
| `deploy-args` fails `RULE_ONE_UNIT` | the change touches the host or more than one unit | split into one PR per unit (host changes are the host lane / train) |
| `NOTHING_TO_DEPLOY` | unit bytes unchanged on both platforms | the edit did not change the unit's bytecode (e.g. comment); verify you built the right sha |

## 4. ota-cli / state

| Symptom | Cause | Fix |
|---------|-------|-----|
| `missing --key` etc. on `show`/`verify` | the CLI builds its full context for every command | pass all common flags (see [CLI reference](../reference/cli-reference.md)); `--teams` is optional |
| `no state for <v>; run init first` | version not initialized | `init --base base.json` (output of `ota-build base-info`) |
| `not authorized: ...` | requester/approver rules from governance `units.json` + teams | see [04 release workflow](../architecture/04-release-workflow.md); approver must be in the unit's owner team and not the requester; `halt` needs no approver |
| `signature check failed ... refusing to build on tampered state` | a stored state or key differs from what signed it | restore the store from backup; use the same key pair; `verify` lists problems |
| `<v> is retired: only halt is accepted` | base marked retired | halt only, or break-glass (see [incident runbook](incident-runbook.md)) |
| lock `timed out` | another process holds the per-version lease | wait; a crashed same-host holder is taken over automatically, otherwise after `leaseMs` (default 10 min) |
| `CDN serves vN > latest state` | CDN ahead of the store | manual investigation, do not reconcile blindly |

## 5. Android and iOS spike builds

| Symptom | Cause | Fix |
|---------|-------|-----|
| First RN surface never renders (10 s) on Android | `ReactHost.onHostResume(activity)` not called | call it for each activity hosting a surface (DESIGN 5.9 item 3) |
| Gradle: wrong JDK | spike expects JDK 17 | `export JAVA_HOME=~/.sdkman/candidates/java/current` (JDK 17) |
| `./gradlew` needs assets | spike assets not generated | `node examples/spike-app/scripts/prepare-spike-assets.mjs` first |
| `pod install` fails on first run (SocketRocket 0.7.1 not found) | local CocoaPods spec repo is stale | `cd examples/spike-app/ios && pod install --repo-update` (~15 s once the Hermes tarball is cached) |
| iOS build fails in `fmt` with `consteval` errors | Xcode 26 clang rejects fmt's consteval format strings shipped with RN 0.78.3 | the spike Podfile `post_install` patches `Pods/fmt/include/fmt/base.h` to `FMT_USE_CONSTEVAL 0`; copy that hook into any app built with Xcode 26 and RN 0.78 |
| `xcodebuild -workspace ... -destination 'generic/platform=iOS Simulator'` -> "Found no destinations / iOS 26.5 is not installed" | the simulator platform component/runtime is missing in Xcode | install the iOS platform in Xcode settings; without it, build with `-project`/`-target` as in `ios/SPIKE_IOS.md` (commands there). No iOS test has **run** yet: see [spike summary](../spikes/summary.md). |
| `ibtool` fails on `LaunchScreen.storyboard` | iOS platform component absent | the spike uses a `UILaunchScreen` dictionary instead |
| `Pods/` contains dangling symlinks; Metro warns | partial/failed pod install, development pods | re-run `pod install`; keep `ios/Pods` in the Metro `blockList` |
| iOS bundle phase slow in Release | "Bundle React Native code and images" builds `main.jsbundle` (unused by the spike) | harmless but slow; the spike boots `ota/embedded/host.hbc` |
| Android emulator tests fail for graphics reasons | swiftshader emulator | results in this repo were recorded on API 33 arm64 swiftshader; physical devices are untested |

Android/iOS integration details: [android-ios-integration](android-ios-integration.md).

## 6. Test suites

| Symptom | Fix |
|---------|-----|
| `npm test` at root does nothing useful / SKIPs | suites need `npm install` in each package (`bash scripts/doctor.sh` lists missing deps) |
| `unit-splitter` tests take ~2 min | expected; use `npm run test:fast` for ota-core + ota-cli only |
| A suite hangs | `test-all.sh` kills the process group after `OTA_SUITE_TIMEOUT` s (default 1800) and reports `FAIL(timeout)`; logs in `.work/test-all/<suite>.log` |
| `ota-build` tests need tools | run `scripts/fetch-tools.sh` and `scripts/native-build.sh --tools` first |
| Schema fixture drift | `npm run schemas:fixtures` regenerates `schemas/fixtures` (needs tools), `npm run schemas:test` checks them |
