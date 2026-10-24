# JS / bundler findings: the splitter on a real RN 0.78.3 app

Stack actually used: react-native 0.78.3, Metro 0.81.5 (app and splitter resolve the same version), `@react-native/metro-config` 0.78.3, `@react-native/babel-preset` 0.78.3, hermesc from RN 0.78.3 (HBC 96), Node v24.22. Fabric/bridgeless is a native matter; nothing in the JS differs.
Nothing here was run on a device or simulator by the JS agent: bundles were built, compiled and diffed, `require.js` semantics were exercised in a Node `vm`. Device behaviour is for the native agents.

## How to run
```
N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH
cd examples/spike-app
node scripts/prepare-spike-assets.mjs [android] [ios]   # -> .spike-assets/<platform>/ per SPIKE.md (~20 s per platform)
node scripts/measure.mjs                                 # sizes + patch sizes (a, b, c, d) on spike (android+ios) and demo; ~2 min
node ../../packages/ota-build/src/cli.ts verify-repro --project . --platform android --work ../../.work/repro
cd ../../packages/unit-splitter && npm test              # 24 tests (23 + test/spike-app.test.js)
cd ../ota-build && npm test                              # 17 tests
```
Layout: `index.js` (host entry), `src/host/*` (probe, loader, SpikeHost, lazyUnit, format), `src/units/{cabs,bus,travelplex}/*`, `units.config.json` (units + `entry` + `metroConfig`), `metro.config.js` (RN defaults + `withOtaUnits`), `scripts/`.
Units are reached ONLY via `lazyUnit('cabs', () => import('../units/cabs/entry'))` in `src/host/SpikeHost.js`. cabs = FlatList + Animated (JS driver), bus = Image with a png asset + `seat-label.android.js/.ios.js`, travelplex = plain View/Text + a host import (`formatMoney`).

## What worked first time
* One Metro run over the real RN graph, `customSerializer` splitting, path-hash 48-bit ids, `paths` for `import()`: all worked unchanged. Host 486-490 modules (all of RN's `index` is in the graph because RN's lazy getters are static `require`s), units 2-4 modules each.
* `import()` compiles to `asyncRequire(id, _dependencyMap.paths)` with `paths = {"<cabsEntryId>":"cabs", ...}` on the host module of `SpikeHost.js` (checked in the output). RN 0.78's `asyncRequireModulePath` is Metro's own `asyncRequire`, which is in the host. A STOCK `react-native bundle` of the same project (config inert) also works (496 modules, import() falls back to a synchronous `require.importAll`), so the app keeps building normally with this metro.config.js.
* Direction rules on the real graph (negative fixtures, all rejected): host static import of a unit, unit -> unit, host `import()` of a non-entry unit module, `lazyUnit` name mismatch; patch mode: a unit importing an RN module absent from the base host (`NewAppScreen`) is rejected, an unchanged tree passes. Unit -> RN internals (View, FlatList, Animated, VirtualizedList...) resolve to the host, closure check: every dependency id of every unit module exists in host or unit.
* Platform files: android build owns `seat-label.android.js`, ios build `seat-label.ios.js`; units' bytecode differs per platform only for `bus`.

## Changes made to the splitter / ota-build (all existing tests still pass: unit-splitter 23 + 1 new, ota-build 17)
1. `src/with-ota-units.js`: `withOtaUnits(metroConfig, {units, projectRoot, bits})` for the APP's metro.config.js. Inert unless build() enables it (`ctx.enabled`) or `OTA_UNITS_BUILD=1`, so `react-native start`/Gradle/Xcode ignore it. Module-level `ctx` shares sink/base/approach/ids with build() (the config file `require()`s the ESM module; Node >= 22.12 require(esm), works on 24).
2. `units.config.json` gained `entry` (default `src/host/index.js`) and `metroConfig` (path of the app config). With `metroConfig` the splitter loads the app's config as-is instead of assembling its own (demo-app path unchanged, still the default).
3. `metro-compat.js` (the only Metro-internals file): `loadProjectConfig` (requires the config fresh on each build; metro-config's `loadConfig` cannot be used: its cosmiconfig explorer is module-level and cached, so a 2nd build in one process silently skipped `withOtaUnits`: this broke `verify-repro` until fixed) and `buildOnServer` (Metro.runBuild has no `unstable_transformProfile`; this mirrors what the RN CLI does: `runMetro` + `server.build`).
4. `metro-run.js`: in project-config mode the watch folders must include `projectRoot` and the splitter's own metro-runtime dir (default config resolves the `require.js` polyfill from the splitter's node_modules copy, "Failed to get the SHA-1" otherwise; ids still key it as `node_modules/metro-runtime/...`).
5. `build.js`: `units.json` now lists `assets` per owner (asset modules in the graph, path + sha256 of the source file).
6. `test/spike-app.test.js`.

## Real-RN specifics: each item
| Topic | Finding |
|---|---|
| `getModulesRunBeforeMainModule` (InitializeCore) | Works unmodified (the demo had to stub it). Metro's `getAppendScripts` emits `__r(InitializeCore)` then `__r(entry)` at the END of host.js; both modules and every RN polyfill are host-owned. Units contain only `__d(...)`. |
| Polyfills | RN's `js-polyfills` (console, error-guard, ...) are `preModules`, always host. |
| `inlineRequires` | `@react-native/metro-config` sets `inlineRequires: true` via `getTransformOptions`; works in the split build. `import` of a module that is only imported but unused is dropped (so such an import creates no graph edge/rule hit: relevant when writing negative tests). |
| Transform profile | RN CLI 0.78 does NOT pass `--unstable-transform-profile` (no hit in the CLI), so `default` is what real builds use; hermes-stable is not used and not measured. The hook exists now (`build({transformProfile})`, project-config mode). |
| Minify | Xcode script passes `--minify false` with Hermes, Gradle plugin has `minifyEnabled`; we use `minify:false` (a stock `bundle` is minified: 923 KB vs our 2.2 MB unminified host.js; hermesc output is what ships). Decide and pin this together with the app's real build flags; differing flags = different ids/bytes only in function names/debug, not in module ids. |
| Assets | See "Assets" below. |
| `import()` / `asyncRequire` | See above; nothing RN-specific. `__loadBundleAsync` is defined by RN only under `__DEV__` (`setUpDeveloperTools`), the host defines it after InitializeCore only if `NativeOtaUnits` exists (`src/host/loader.js`; `TurboModuleRegistry.get` first, then `NativeModules`). In a dev build the host would overwrite RN's dev loader: do not split in dev. |
| Id collisions | Real graph has ~500 modules, not 1000+: 0 collisions at 24/32/40/48 bits. Synthetic worst case, all 14,570 .js/.json files of node_modules: 3 collisions at 24 bits, 0 at 32/40/48. 48 bit remains the right choice for 5-15k-module apps. Ids are > 2^32 (e.g. `11960423920495`): native must carry them as `double`/int64 (shared/ota_unit_jsi.h does: `double entryModuleId`). |
| Determinism | `ota-build verify-repro` (two builds, different output dirs) android and ios: REPRODUCIBLE, 13 files byte-identical each. Also a build of a COPY of the project in a different absolute directory (`.work/cp/some/deeper/dir/proj`, copied node_modules, `TZ=Asia/Kolkata LANG=en_US.UTF-8`) was byte-identical to the original including js/, ids.json, build.json. Symlinked node_modules does NOT work with Metro (react-native unresolved): copy it (`cp -Rc` on APFS is instant). Source maps / debug ids / minified builds not covered. |
| Build time | Metro + 4x hermesc via ota-build `bundle`: 5.2-6.9 s per platform (cold cache, cache disabled). `verify-repro` ~11 s. `prepare-spike-assets` ~20 s/platform (two bundles + fixtures). Demo app: 1.2-1.5 s. |
| Metro crawler noise | The project root contains `android/` and `ios/Pods` (dangling symlinks): Metro printed ENOENT warnings. metro.config.js adds a `blockList` for native build dirs and `.spike-assets`. |
| Entry exceptions (IMPORTANT, native agents) | Metro's `__r`/`guardedLoadModule` catches an exception from a module factory and calls `global.ErrorUtils.reportFatalError(e)`, and does NOT rethrow (verified against the real `require.js` in a vm). In RN release, `reportFatalError` = fatal JS error = app crash, and the native `__r(entryId).call` sees no exception. So S5 ("RequireError returned, no crash") cannot pass by calling `__r` directly. The host therefore defines `globalThis.__otaRequire(id)`: hides `ErrorUtils` for the call, calls `__r(id)`, restores it in `finally`; tested in the vm: `__r(bad)` -> FATAL logged, returns undefined; `__otaRequire(bad)` -> throws, ErrorUtils restored. Native should call `__otaRequire` when it exists (named in spike.json `js.requireFn`), else `__r`. Not yet verified on a device. A module that is in `hasError` state rethrows its stored error on the next `__r`. |

## Assets (unresolved, honest)
* An asset (png) is an ordinary module in the graph: `module.exports = require('@react-native/assets-registry/registry').registerAsset({httpServerLocation: "/assets/src/units/bus/assets", width, height, scales, hash (md5 of the file), name, type})`. It is owned by path, so an asset under a unit root lives in the unit's bundle (ids stable, `bus-icon.png` -> `src/units/bus/assets/bus-icon.png`); an asset outside unit roots (my first attempt, `src/assets/`) silently became HOST-owned. `units.json` lists asset files per owner.
* The bytes of the image are NOT in any bundle. In a release build Android resolves the registered asset to a drawable resource name derived from `httpServerLocation` + name (`src_units_bus_assets_bus_icon`) and iOS to a file in the app bundle (`assets/src/units/bus/assets/bus-icon.png`), both put there by `react-native bundle --assets-dest` / the Gradle/Xcode bundling step, which this pipeline does not run. Consequences: (1) an OTA unit can only reference assets that are already in the binary; a patch that adds or changes an image breaks (blank image) or needs a side channel; (2) hence `ota-build` must at least fail/warn when a patch's unit has an asset whose sha256 differs from or is absent in the base (data for that is now in `units.json`, the check is not written); (3) remote/URI images or inlining small assets as data URIs are the OTA-friendly options, not designed here. The spike app does not yet put the png into android `res/` or ios resources, so on the device `BUS` renders without the image unless the native agents add it (name above). That is acceptable for the spike (text markers are the pass criteria).
* Android resource name collision/ scales and iOS `@2x` handling were not examined.

## Measurements (hermesc `-O -emit-binary -g0`, zstd-19, HDiffPatch zstd-19 minMatchScore 4; all patches round-tripped by `ota_apply`)
| | spike android | spike ios | demo app (android) |
|---|---|---|---|
| modules host / cabs / bus / travelplex | 490 / 4 / 4 / 2 | 486 / 4 / 4 / 2 | 22 / 2 / 3 / 2 |
| JS size host (unminified) | 2,221,900 | 2,208,494 | 68,325 |
| JS size cabs / bus / travelplex | 4,186 / 2,792 / 1,767 | 4,186 / 2,788 / 1,767 | 1,256 / 1,615 / 939 |
| hbc host | 860,712 | 854,756 | 28,800 |
| hbc cabs / bus / travelplex | 3,328 / 2,172 / 1,524 | 3,328 / 2,168 / 1,524 | 1,092 / 1,244 / 936 |
| zstd-19 host | 348,781 | 346,568 | 16,046 |
| zstd-19 cabs / bus / travelplex | 2,378 / 1,587 / 1,152 | 2,378 / 1,581 / 1,152 | 784 / 857 / 684 |

Patch sizes (bytes; % = of zstd-19 of the new full file):
| change | unit/host | spike android | spike ios | demo |
|---|---|---|---|---|
| a) one-line change in unit (cabs `fare: 120` -> `125`) | cabs | 80 (3.4%) | 80 (3.4%) | 109 (13.8%) |
| b) new function in a unit (cabs `surge()`, used in label) | cabs | 825 (33.4%) | 825 (33.4%) | n/a |
| c1) host app code: string literal, new length (`'embedded'`->`'patched'`) | host | 32,646 (9.4%) | 29,570 (8.5%) | n/a |
| c2) host app code: string literal, same length | host | 22,475 (6.4%) | 35,254 (10.2%) | n/a |
| c3) host app code: numeric literal (`padding: 24`->`28`) | host | 85 (0.02%) | 85 | 84 (0.5%, a numeric literal in config.js) |
| d1) node_modules numeric (RN TimingAnimation default `500`->`501`) | host | 85 | 86 | n/a |
| d2) node_modules numeric (virtualized-lists `windowSize ?? 21`->`22`) | host | 85 | 85 | n/a |
| d3) node_modules string (RN Dimensions invariant message) | host | 2,657 (0.8%) | 652 (0.2%) | n/a |

Reading: (1) units behave as in the demo (tiny); on a tiny unit the 128 B header dominates, so ratios are meaningless. (2) The host is ~860 KB hbc / ~348 KB zstd; any edit that only changes numbers costs ~85 bytes, but an edit that adds/changes a STRING literal in host code cost 22-35 KB (6-10%) in `src/host/marker.js` yet only 0.7-2.7 KB for an RN message string. This is the Hermes string-table renumbering effect already seen in DESIGN 5.7 (~14 KB for 5 literal tweaks); the large spread suggests it depends on where the string sits in the table (hypothesis, not verified). Plan host patches at ~30 KB worst case for "one string changed"; far smaller if units hold the changing strings. (3) A change inside a node_modules file used by the host is just a host change; nothing special.
Embedded vs patched fixtures (what the native tests use) are in `.spike-assets/<p>/spike.json`: patched host 860,704 B (android), cabs v2 3,328 B.

## Fixtures (exact)
`unit-wrong-version.hbc` = real cabs unit with bytes 8..11 = 98 (real 96); `unit-text.js` = `globalThis.__otaProbe.pwned = true;`; `unit-truncated.hbc` = first 6 bytes of cabs; `unit-bad-entry.hbc` = hermesc-compiled `__d(function(){throw new Error('OTA_SPIKE bad entry module')}, <entryId>, [])` with entryId `hashId('src/units/badentry/entry.js')`, recorded in spike.json `fixtures`. `spike.json` extras: `toolchain`, `platform`, `patched.{host,cabs}`, `fixtures`, `js.requireFn`, sizes.

## Open problems
1. Assets (above): files outside the bundle, no check yet.
2. Hermes string-table churn makes host patches 20-35 KB for single string edits; unmeasured on a realistically large unit (units here are 1.5-3 KB).
3. `__r` swallowing entry exceptions (workaround `__otaRequire`, needs device proof). Same swallowing applies to errors thrown while a lazily `import()`ed unit's modules initialise: they go to ErrorUtils (fatal) instead of rejecting the promise; the production design should wrap unit entry evaluation in the loader's own try/catch path, not rely on `import()`.
4. Not exercised: minified builds, source maps / Sentry debug ids, hermes-stable profile, dev mode, `require.context`, package `exports` edge cases, a graph in the 5-15k module range (build time, memory), Tier-1 rules 5 and 6.
5. The splitter's Metro is its own copy in packages/unit-splitter/node_modules; the app's copy is only used by the app's config file. They match (0.81.5) here; with a mismatch the second would be silently mixed. A check that both resolve to the same version is not written.
6. Metro cache is disabled for reproducibility, so every build is cold (5-7 s here; will grow with the app).
7. `index.js` registers SpikeHost; hybrid-app surfaces opened from native by name (`cabs`) rely on the unit's entry having run (`__otaRequire(entryId)`) before the surface is started; for `bus`/`travelplex` the same.
