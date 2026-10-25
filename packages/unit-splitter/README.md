# unit-splitter (Phase-0 spike)

Proves, on **Metro only** (no Re.Pack/webpack), that ONE Metro dependency graph can be split into a host bundle plus
per-unit bundles with deterministic path-hash module ids, and that units load lazily through plain `import()`
-> `asyncRequire` -> `global.__loadBundleAsync(unitName)` (DESIGN.md 4 and 5.6). Runtime is simulated in a Node `vm`.

## Run

```
cd packages/unit-splitter && npm install          # and: cd ../../examples/demo-app && npm install
npm run build                                     # builds examples/demo-app -> examples/demo-app/dist
node src/cli.js build --project <dir> --out <dir> [--approach serializer|postprocess] [--base <base dist>] [--bits 32]
npm test                                          # node --test (83 tests incl. two-package.test.js and metro-project.test.js), ~110 s
node src/cli.js cycle-baseline --project <dir> [--platform ios|android] [--file baseline.json]   # print/write current cycles for checks.cycleBaseline
node src/cli.js api-snapshot --project <dir> [--platform ios|android] [--write]   # print / write the public API snapshot(s) of checks.publicPackages
scripts/metro-matrix.sh 0.87.1                    # same tests on another Metro line, in a temp tree (see Matrix)
npm run determinism                               # two builds, different abs paths/TZ/LANG, both approaches
```
Output (`dist/`): `host.js` (Metro runtime + polyfills + host modules + `__r(entry)`), `units/<name>.js` (only `__d(...)`),
`ids.json` (id -> project-relative path), `units.json` (host/unit module ids, packages, `paths` = entryId -> unit name).
`--base <dist>` = patch mode: enforces rules 3/4 against the base host (package@version, module presence, new pure-JS
packages bundled into the unit, native-looking packages rejected).
`diffAgainstBase(baseDir, newDir)` in `src/diff.js` -> `{changedUnits, hostChanged, addedUnits, removedUnits}`.
Harness: `harness/harness.js` (`createRuntime({distDir, patchDir, dedupe})`).
Reproducibility with the repo tool (needs a git repo; use the absolute node path, `sh` has no nvm):
`python3 tools/repro_check.py --repo <git repo of demo-app incl. node_modules> --build-cmd "<node> .../src/cli.js build --project . --out build/bundles" --out-dir build/bundles --runs 2 --env-b TZ=Asia/Kolkata --env-b LANG=C` -> REPRODUCIBLE (run once during this spike).

## Checks (units.config.json `checks`)

Rule violations are errors (`VerificationError`, `.violations`; non-fatal findings are in `.warnings`). `build()` returns `{cycles, warnings, checks}` and
writes the same into `units.json` (`cycles: {owner: [{signature, modules, async?}]}`, `warnings: [{rule, message}]`, `checks: {rule: {severity, count, ...}}`);
the CLI prints warnings and a one-line summary per check. All keys are optional:

```json
"checks": { "cycles": "error", "cycleBaseline": "cycles.baseline.json", "singleImportSite": "warn", "dynamicRequire": "error", "requireRegisterComponent": false }
```

| key | values (default) | rule ids | meaning |
|---|---|---|---|
| `cycles` | `error`\|`warn`\|`off` (`error`) | `cycle`, warn-only `cycle-async`, `cycles-base-missing` | Cycles (Tarjan SCC, iterative) over static edges, per owner: each unit (all its modules, incl. packages bundled into it) and first-party host code (not under node_modules). Message shows the shortest cycle `a -> b -> a` with project-relative keys and a signature (sha256 of the sorted module keys). Cycles that need an `import()` edge are warnings only. Third-party host cycles (RN internals) are only counted (`checks.cycles.thirdPartyHostCycles`). |
| `cycleBaseline` | path, relative to the project (none) | | Ratchet. Base build (no `--base`): a cycle is an error unless its signature or `{modules}` set is in this file (`{"cycles": {"<owner>": [{"signature", "modules"}]}}`; generate with `cli.js cycle-baseline` / `generateCycleBaseline()`). Patch build (`--base`): an error only if the cycle is NEW compared to `cycles` in the base `units.json`; the baseline file is also honoured; a base without `cycles` falls back to the baseline file and emits `cycles-base-missing`. Note: the signature covers the whole SCC, so adding a module to an accepted cycle makes it a new cycle. |
| `singleImportSite` | `off`\|`warn`\|`error` (`warn`) | `multiple-import-sites` | Each unit entry may be `import()`ed from exactly one site (module + specifier); all sites are listed when there are several. |
| `dynamicRequire` | `error`\|`warn`\|`off` (`error`) | `dynamic-require` | Non-literal `require(x)` / `import(x)` and `require.context(...)` in first-party host code, unit code and packages bundled into a unit. Third-party host packages are only counted (`checks['dynamic-require'].thirdPartyModules`). See "Dynamic references" below. |
| `requireRegisterComponent` | boolean (`false`) | `register-component` | Each unit entry file must call `AppRegistry.registerComponent('<unitName>', ...)` with a literal name equal to the unit name. On in `examples/spike-app`. |

| `assets` | `error`\|`warn`\|`off` (`error`) | `asset-not-in-base`, `asset-path-changed` | Patch builds only. See "Asset rule" below. |
| `nativeModules` | `error`\|`warn`\|`off` (`error`) | `native-module-new`; warn-only `native-method-new`, `native-module-dynamic`, `native-refs-base-missing` | Patch builds only. See "Native-module scan" below. |

### Asset rule (Tier 1, patch builds; `src/assets.js`)

The bytes of an image (or a font that goes through Metro's asset pipeline) are in no JS bundle: they are in the binary (Android `res/drawable-*`, iOS bundle). A patch can only reference assets whose bytes already shipped. Every build records, per owner, in `units.json` `assets[]`: `path`, `sha256` of the file, the registered `name`/`type`/`httpServerLocation`/`scales`, the derived `androidResource` (e.g. `src_units_bus_assets_busicon`: lower-cased, `/` -> `_`, everything else but `[a-z0-9_]` dropped, same as RN's bundling step) and `iosPath`, and `variants[]` (`{scale, path, sha256}` for every `@2x`/`@3x`/platform file found next to it). With `--base`, each asset owned by a unit (or by a new package claimed into it) is looked up in the base's assets (host and units):

* same path, other sha256 or other variant set -> `asset-not-in-base` ("changed"); path absent in the base and bytes unknown -> `asset-not-in-base` ("new");
* same bytes at another path (moved/renamed), or same path but another registered location/name -> `asset-path-changed` (the native resource name derives from the path, so the patch would point at a resource that does not exist);
* an asset that disappeared is fine. Host assets are not compared (host changes are not shipped in a patch). A base build is never checked, only recorded.

Fix: keep the asset unchanged, ship it in a binary release, or use a remote / data-URI image. Tests: `test/assets-native.test.js` (new, edited, `@2x` added, moved, warn/off) and `test/spike-app.test.js` (real RN graph, unchanged patch passes).

### Native-module scan (Tier 1 rule 5, v1; `src/native-refs.js`)

A patch must not call a native module the binary lacks. v1 needs no native-side introspection: the inventory is derived from the BASE build's JS (everything the base JS references must exist in the binary, because the base works). In EVERY build, all script modules of the graph (units, first-party host, node_modules) that mention a native-lookup identifier are parsed with Babel (cached per content hash within the run) and the references are recorded in `units.json` `nativeRefs: {<Name>: {owners, methods, kinds}}`:

* `NativeModules.X`, `NativeModules['X']`, `const {X} = NativeModules` (kind `module`); `TurboModuleRegistry.get('X')` / `getEnforcing('X')` (`turbo`); `requireNativeComponent('X')`, `codegenNativeComponent('X')`, `NativeComponentRegistry.get('X')`, `UIManager.getViewManagerConfig('X')` (`view`). `new NativeEventEmitter(NativeModules.X)` is covered by the first form.
* `methods` = members accessed directly: `NativeModules.X.m`, `getEnforcing('X').m`, or through a same-file alias (`const X = NativeModules.X; X.m`, destructured names).

With `--base`, for the modules owned by units (incl. claimed new packages): a literal name absent from the base's `nativeRefs` -> `native-module-new` (error, or warning with `checks.nativeModules: "warn"`); a direct method the base never accessed on that module -> warning `native-method-new`; a non-literal name -> warning `native-module-dynamic`. A base without `nativeRefs` -> one warning `native-refs-base-missing`, no checks. Host modules are never checked in a patch (not shipped).

Limits (deliberate): (1) conservative in one direction only: it can reject modules the base JS never referenced, it cannot know the binary's real module list, so a native module that exists in the binary but is unused by the base JS cannot be adopted OTA (relax: add a reference to it in the base/train build, e.g. a host-side `TurboModuleRegistry.get('X')`); (2) indirect uses are invisible (a module obtained in one file and used in another, codegen wrapper specs, `NativeModules[name]`), so `native-method-new` is only a warning and a name found through a non-literal lookup cannot be verified; (3) the match is by identifier name, not by import binding (`NativeModules` re-exported under another name is missed); (4) module and view names share one namespace; (5) per platform: compare android builds with an android base. Cost: ~0.3 s on examples/spike-app (~4.2 s -> ~4.5 s per build, 500 modules).

### Two-package LoB layout: host API checks (examples/two-package-app, tests: `test/two-package.test.js`)

A LoB ships a PUBLIC package (HOST-owned: in the binary, patched only by host lane/train, must stay very stable; e.g. `@travelplex/core`: init, fetch-config
API, a thin shell that embeds the unit through `lazyUnit('travelplex', () => import('@travelplex/ui'))`, shared modules, the singleton state) and a PRIVATE
package that IS the unit (`@travelplex/ui`, patchable OTA, imports the public package). A unit patch is built against the BASE host, so it may only use public
API that already shipped. These checks enforce that. All run in BASE and PATCH mode (host sources equal the base's in patch mode).

| key | values (default) | rule ids | meaning |
|---|---|---|---|
| `hostExports` | `error`\|`warn`\|`off` (`error`) | `host-export-missing`, warn-only `host-export-unknown` | Every static import a UNIT module makes from a HOST module must exist in the host target's runtime exports: ES `import {a, b as c}`, `import d` (needs a default export), `import * as ns` + `ns.member` accesses, `export {a} from`, plus `require('x').a` / `const {a} = require('x')`. Type-only imports are ignored. If the target's exports cannot be determined the build does NOT fail: one `host-export-unknown` warning per target module lists the importing sites (`checks['host-exports'].unknown` counts them). |
| `publicPackages` | `["@scope/core"]` (`[]`) | `public-deep-import`, `public-package-not-host`, `public-package-missing` | A unit may import a public package only through its entry (`import '@scope/core'`) or a file exposed by its package.json `exports` / `main` / `react-native` / `browser` / `module`; any other file (`@scope/core/internal/secret`, or a relative path into the package) is `public-deep-import`. The package must be HOST-owned: it may not overlap a unit root (`public-package-not-host`), must be installed and reachable from the host entry (`public-package-missing`). |
| `publicApiSnapshot` | `{ "@scope/core": "api/core.api.json" }` (`{}`) | `public-api-breaking`, `public-api-changed`, `public-api-opaque`, `public-api-snapshot-missing` | The snapshot is `{package, entry, default, exports: [sorted runtime export names]}` of the package ENTRY, produced by the same analyzer (`cli.js api-snapshot --project <dir> [--write]`). A name REMOVED or renamed (or default dropped) is an error `public-api-breaking`; a name ADDED is a warning `public-api-changed` asking to update the snapshot; an analyzer-opaque entry is an error `public-api-opaque` that explains how to make it analyzable. Keys must be listed in `publicPackages`. |
| `publicApiStrict` | boolean (`false`) | `public-api-changed` | Make an added public name an error. |

`units.json` gets `publicApi: {pkg: {version, package, entry, default, exports}}` at every build (also without a snapshot), and `checks['host-exports']`,
`checks['public-api']`, `checks['public-deep-import']` summaries.

**Export analyzer (`src/exports.js`, Babel AST).** Supported: ESM `export const/let/var/function/class/enum`, destructuring exports, `export {a as b}`,
`export {a} from`, `export * from` (followed through the Metro graph's resolved dependencies, cycle-safe; default is not re-exported), `export * as ns`, `export default`;
type-only exports (TS `interface`/`type`, Flow `type`, `export type`) are not runtime exports. Babel/tsc CJS: `exports.x =`, chained `exports.a = exports.b = void 0`,
`module.exports.x =`, `exports['x']`, `Object.defineProperty(exports, 'x', ...)` (getters), `Object.defineProperties/assign(exports, ...)`, `module.exports = {...}` (incl. getters,
literal spreads of `require()`), `module.exports = require('./x')` and `= ident` aliases (an object-literal var or a require var), JSON modules, `__esModule`, `exports.default`, the Babel wildcard
`Object.keys(_x).forEach(... Object.defineProperty(exports, key ...))` after `var _x = require('./x')`, tsc `__exportStar(require('./x'), exports)`; exports nested in IIFEs / `if (NODE_ENV)` blocks
count (so React's `exports.useState =` inside a dev IIFE works). A `require()` that Metro dropped from the graph (dead `NODE_ENV` branch) is ignored while another alias resolves.
OPAQUE (names we know are kept, the rest unknown => `host-export-unknown`, and `public-api-opaque` for a snapshot entry): `module.exports = fn()/function/class/unknown identifier`,
non-literal spreads, computed export names (`exports[expr] =`), TS `export =`, unparsable files, `export *` of something not in the graph, assets.
Limitations: namespace imports are checked only for `ns.member` accesses (not `ns[x]`, destructuring, or passing `ns` around); no shadowing analysis; `require` forms never check `default`;
re-exported names (`export {x} from './y'`) are not verified to exist in `./y`; dynamic export mutation after load is invisible.

**Cycles and the lazyUnit boundary.** A cycle that crosses owners (core shell `import()`s the unit entry, the unit imports core) is by design: it is not a `cycle-async` warning and only counted
(`checks.cycles.lazyUnitBoundaryCycles`). Every other cross-owner edge is already a direction-rule error. Async cycles inside one owner (a unit, first-party host code) still warn.

Encapsulation rules (always on, no key): `unit-to-unit` (any edge, static or `import()`), `host-to-unit-static` (import, `require()`, `export ... from`,
barrel re-export of a unit module from host code), `host-imports-non-entry`, `lazyUnit-name-mismatch` (compared by import specifier, so it also works for
package specifiers), plus the patch-mode rules. A unit module may therefore be reached from outside only by the host, through an async `import()` of the
declared entry.

**Ownership by package name.** A unit root is a directory OR an installed npm package (`"roots": ["@lob/cabs"]`, optional `package:` prefix; `entry` may be
`"@lob/cabs/entry.js"` or `node_modules/@lob/cabs/entry.js`). Roots are realpath'd (Metro reports symlink-resolved paths), so a real copy in node_modules, a
workspace symlink to a directory inside the project, and a symlink to a directory outside the project are all owned by the unit (outside dirs are added to
Metro's `watchFolders` by the splitter, and keyed `node_modules/<pkg>/...` so ids stay machine independent). The package's own nested `node_modules` stay host.

**Dynamic references: what Metro 0.81.5 does.** The transform worker's `dynamicDepsInPackages` default is `throwAtRuntime`, which still *rejects* (build error
`Invalid call at line N`) a non-literal `require()` in files outside node_modules; a non-literal `import()` is rejected everywhere. We translate that error into
`[dynamic-require]` (file:line). Inside node_modules a non-literal `require()` silently becomes a runtime-throwing placeholder; we find those placeholders in the
transformed output for packages bundled into a unit (error) and count them for host packages. `require.context` is NOT rejected without
`unstable_allowRequireContext` (it is a runtime TypeError), so we detect it with a Babel AST pass over first-party/unit sources that mention it (and with the flag on, the expanded context
edges would be invisible to the rules). Limitation: Metro's own first-party rejection cannot be downgraded by `dynamicRequire: warn|off` (the transform fails
first); those values only affect the placeholder and `require.context` findings.

## Which Metro runs: the PROJECT's (peerDependencies)
`metro`, `metro-config` and `metro-runtime` are **peerDependencies** (`0.81.x || 0.87.x`); they stay devDependencies pinned to `0.81.5` only so this repo's own tests run. `src/metro-compat.js` resolves them **from the project root first** (Node resolution upwards from `<project>/package.json`, so a hoisted monorepo root works; then from where the project's `react-native` / `@react-native/metro-config` live, for strict layouts such as pnpm). Only if the project has no `metro` at all (this repo's demo apps) does it fall back to the splitter's own copy. `metro-config` / `metro-runtime`: project first, then next to the chosen `metro`, then the splitter.
* Nothing is loaded at import time: `initMetro(projectRoot)` (called by `build()`, `runMetro()`) loads it; `locateMetro(projectRoot)` / `describeMetro(projectRoot)` only LOCATE (pure, used by `ota-build doctor` check `metro-runs`, which says "the project's" or "FALLBACK"). One process drives one Metro install: a second project resolving a different Metro in the same process throws.
* The version gate (`checkMetroVersions`) applies to the Metro that was located: supported lines `0.81.x` / `0.87.x`, and metro = metro-config = metro-runtime exactly; otherwise `MetroCompatError` names the version and the path ("unsupported Metro 0.99.0 (the project's Metro (<path>)) ... Fix: align the app to React Native 0.78"). `withOtaUnits` applies the same gate (without loading Metro) when it is active.
* `build.json` (ota-build) records the version of the Metro that actually ran. Tests: `test/metro-project.test.js` (package.json-only stub projects for location/gate; a fresh process for `initMetro`).

## Real React Native projects: `withOtaUnits` (see examples/spike-app/JS_FINDINGS.md)
`src/with-ota-units.js` exports `withOtaUnits(metroConfig, { units, projectRoot, bits = 48 })`, meant for the APP's `metro.config.js`
(`withOtaUnits(mergeConfig(getDefaultConfig(__dirname), {...}), { units: require('./units.config.json').units, projectRoot: __dirname })`).
It is inert unless the splitter drives the build (or `OTA_UNITS_BUILD=1`), so `react-native start` / Gradle / Xcode keep working. When enabled it installs the path-hash id factory and the splitting customSerializer.
`withOtaUnits` accepts any config shape: an object (even partial: `{}`, `{resolver: {}}`; it never calls Metro's `mergeConfig`, which crashed on `transformer.babelTransformerPath` / `resolver.dependencyExtractor` of a partial base, and it only sets `serializer.createModuleIdFactory` / `customSerializer`), a Promise, or a `(defaults) => config` function. Bad arguments throw an error naming the key and the fix (`units` missing, `projectRoot` missing, first argument not a config).
`units.config.json` gets two optional keys: `"entry"` (host entry, default `src/host/index.js`) and `"metroConfig"` (the app's config file; **absent = auto-detect `<project>/metro.config.js` (then `.cjs`)**, a string names the file, `false` opts out and uses the splitter's own config; a detected config that does not call `withOtaUnits` fails with an error that says so and shows the opt-out. When used, the splitter loads that config instead of assembling its own, so the app's resolver, transformer and `getModulesRunBeforeMainModule` (InitializeCore) are used as-is).
`build({..., transformProfile})` is honoured in project-config mode only. `units.json` now also lists `assets` (asset modules per owner). Tests: `test/spike-app.test.js` (needs examples/spike-app/node_modules).

## Pinned versions (exact, see package.json; target = React Native 0.78.3)
This repo's tests run on metro 0.81.5, metro-config 0.81.5, metro-runtime 0.81.5 (devDependencies; peerDependencies `0.81.x || 0.87.x` for real apps; metro-runtime also a devDependency of the demo app, as in an RN app), @react-native/babel-preset 0.78.3,
@react-native/metro-config 0.78.3 (pulls @react-native/metro-babel-transformer 0.78.3 and @react-native/js-polyfills 0.78.3), @babel/core 7.28.4,
@babel/parser 7.28.4; demo app: @babel/runtime 7.28.4 (needed by the preset's transform-runtime, incl. for metro-runtime's own asyncRequire).
0.81.5 is the latest 0.81 patch; RN 0.78.3 declares `metro* ^0.81.3`. Node v24.22.0. A real app should pin to whatever its lockfile resolves.

## What changed for Metro 0.81 (previously 0.87.1)
* **All Metro internals live in `src/metro-compat.js`** (the only file that deep-imports). It locates the project's Metro (see above), reads its `package.json`, accepts only `0.81.x` / `0.87.x`
  (anything else throws `MetroCompatError` naming the version; metro, metro-config and metro-runtime must be the same exact version), and picks the deep path prefix:
  `metro/src/<x>` on 0.81, `metro/private/<x>` on 0.87. Used internals: `DeltaBundler/Serializers/baseJSBundle`, `lib/bundleToString`, `lib/getAppendScripts` (+ `helpers/processModules` on 0.87 only).
* **`wrapModule` cannot emit our `paths` on 0.81**: it has no `unstable_getAsyncDependencyPath` (see Findings b). On 0.81 the adapter builds the `__d` params itself
  (`createModuleId`, dependency array, `{...deps, paths}`) and calls `addParamsToDefineCall` from the public `metro-transform-plugins`. Output is the same shape as 0.87's.
* **Transform = RN's**: `transformer.babelTransformerPath` is `@react-native/metro-babel-transformer`; the demo app has no babel.config.js so it applies `@react-native/babel-preset`
  (replaces the old hand-rolled commonjs-only transformer, now deleted). Base config = `@react-native/metro-config` `getDefaultConfig()` merged with our overrides (0.81 only).
* Resolution: `resolver.nodeModulesPaths = [<app>/node_modules]` (metro-runtime lives in the splitter's node_modules but is transformed like app code, so its `@babel/runtime` imports must resolve from the app);
  `watchFolders` also include js-polyfills.
* Host now contains RN's polyfills (`console.js`, `error-guard.js`, ...) and modules compiled by the real preset (inline requires: `_$$_REQUIRE(...)` at use sites).

## Using RN 0.78's own config (`@react-native/metro-config` 0.78.3, read from source)
`getDefaultConfig` sets: `transformer.babelTransformerPath` = `@react-native/metro-babel-transformer`; `transformer.asyncRequireModulePath` = `require.resolve('metro-runtime/src/modules/asyncRequire')`
(same module as Metro's default, only an absolute path: **import() compiles identically**, no RN-specific async loader); `transformer.getTransformOptions` -> `{inlineRequires: true, experimentalImportSupport: false}`;
`transformer.allowOptionalDependencies`, `assetRegistryPath`; `serializer.getModulesRunBeforeMainModule` = `[require.resolve('react-native/Libraries/Core/InitializeCore')]` (**throws without react-native installed**;
we override with `() => []` in `baseConfig()`; a real app keeps it and `__r(InitializeCore)` runs before the entry in host.js); `serializer.getPolyfills` = `@react-native/js-polyfills` (works standalone; used);
`serializer.isThirdPartyModule`, `symbolicator.customizeFrame`, `server.port` (irrelevant to a build); `resolver.resolverMainFields ['react-native','browser','main']`, `platforms ['android','ios']`, `unstable_conditionNames ['react-native']`.
None of these touch `createModuleIdFactory`/`customSerializer`, so they do not conflict with our serializer. `getModulesRunBeforeMainModule` and `getPolyfills` reach our serializer only as `options.runBeforeMainModule` / `preModules`, which we pass to `getAppendScripts` / emit in host.js.
Implication for the real app: **InitializeCore and every RN polyfill must be owned by the host**, which holds as long as no unit root contains react-native.
RN installs its own `global.__loadBundleAsync` only under `__DEV__` (`Libraries/Core/setUpDeveloperTools.js` -> `loadBundleFromServer`, read in react-native 0.78.3); release builds leave it undefined, so `NativeOtaUnits`' definition is free in release (in dev builds define ours after InitializeCore or don't split in dev).
Delta from the real RN transform: (1) `react-native` is not installed, so react-native's own modules and `InitializeCore` are absent (the demo is plain JS); (2) `unstable_transformProfile` is `default`: `Metro.runBuild` 0.81 does not accept it, and the RN CLI default is also `default`;
Hermes-stable/canary profiles (which skip some down-leveling) are NOT verified; (3) `dev:false, minify:false`; (4) no `.ios/.android` platform files, assets or `@react-native/babel-plugin-codegen` cases are exercised.
Verified: ESM -> CJS done by the preset (`@babel/plugin-transform-modules-commonjs`, `lazy` only for RN specifiers), `import()` untouched by the preset and turned into `asyncRequire(id, _dependencyMap.paths)` by Metro.

## Matrix (other Metro versions without a second node_modules in the repo)
`packages/unit-splitter/scripts/metro-matrix.sh <metro-version> [tmpdir]` copies the splitter (sources/tests) and demo app to a temp tree, installs exactly that `metro`, `metro-config` and `metro-runtime`
there, and runs `npm test`. Result for **0.87.1: 23/23 pass** (and **0.81.5: 23/23** in the repo). For 0.87 the RN config is not loaded (it depends on metro-config 0.81); the RN transformer is still used.
Needs `npm` on PATH (nvm shells: export PATH to the node bin first). Any other Metro line fails fast with `MetroCompatError`; to add one, extend `SUPPORTED`/`deepPrefix` in metro-compat.js and run the matrix.

## Splitting approaches (in the requested order)
* **(a) single run + `serializer.customSerializer`: WORKS, default.** The serializer gets `(entryPoint, preModules, graph, options)`
  = the whole graph, runs the ownership/direction checks, and builds host.js and every unit file itself (files are returned via
  a side-channel object; Metro itself only sees the host code). `createModuleIdFactory` gives path-hash ids.
* **(c) post-process split of the stock single bundle: WORKS** (`--approach postprocess`). Stock `baseJSBundle` string is parsed with
  @babel/parser and cut at top-level `__d(...)` statements by id->owner; host modules that reference a unit-entry id get `paths` added.
  Output is **byte-identical** to (a) (tested). Caveat: stock Metro emits no `paths`, so (c) has to rewrite the host dep arrays
  itself, and it only knows unit-entry ids (a non-unit async host->host import would get no `paths` entry in (c) but `paths:{}` in (a); no functional difference).
* **(b) multiple Metro runs with `processModuleFilter`: not implemented** (it cannot give `paths` either without a custom serializer, so it
  needs (a) anyway; no benefit over (a) on this Metro).
`processModuleFilter` alone is insufficient: it filters one bundle, but does not add `paths` and cannot write several files.

## Findings (re-verified on Metro 0.81.5; 0.87.1 results in brackets where they differ)
* (a) Custom serializer receives the whole graph `(entryPoint, preModules, graph, options)` and can emit any number of files (returns a primary `{code,map}`; extras via side channel). VERIFIED on 0.81.5.
* (b) **`paths` is NOT emitted by default in a non-dev build** (VERIFIED: stock build of the demo app has 0 `paths` objects; `import()` compiles to `asyncRequire(id, _dependencyMap.paths)` where `paths` is undefined).
  0.81 source: `Server.js` sets `includeAsyncPaths: graphOptions.lazy` (false unless the graph is lazy, which would drop async deps from the graph); `helpers/js.js getModuleParams` with `includeAsyncPaths` **requires `sourceUrl`** and writes
  `"/<relative path>.bundle?<query of sourceUrl>&modulesOnly=true&runModule=false"` URLs (dev-server style) - not unit names. **There is no `unstable_getAsyncDependencyPath` hook in 0.81** (grep: zero hits in metro 0.81.5);
  [0.87 has it, which the old prototype used]. Mechanism that works on both: the customSerializer writes the `{...depMap, paths:{<entryId>:"<unit>"}}` params itself (`wrapOwn` in metro-compat.js, built on public `metro-transform-plugins`). `includeAsyncPaths:true` + a fake `sourceUrl` would also "work" but yields URL strings, so we do not use it.
  Fallback (c) post-process rewrites the host dep arrays and is byte-identical to (a) on 0.81 as well (tested).
* (c) `define()` ignores duplicates in 0.81.5 `metro-runtime/src/polyfills/require.js`: `if (modules.has(moduleId)) return;` VERIFIED by test (3): second definition is a silent no-op, before and after initialization, first wins.
  (require.js differs from 0.87 only in dev/HMR code: `ensureModuleRegistered` for RAM segments, `forceFullRefreshPatterns`, named `Cannot find module 'x'` in dev; none affect `define`/`metroRequire` in production.)
* (d) Determinism: byte-identical host.js/units/ids.json/units.json across absolute paths, TZ, LANG, cwd and time for both approaches (`npm run determinism`, tests), and `tools/repro_check.py` on a temp git copy of the demo app (node_modules committed, 2 fresh clones, TZ=Asia/Kolkata, LANG=C): **REPRODUCIBLE**, 6 files.
  Same caveats as before: Metro cache disabled (`cacheStores: []`), ids from project-relative / after-last-`node_modules/` paths, modules sorted by id. NEW with the RN preset: babel output was still stable (no timestamps/paths); not covered: source maps, debug ids, minify, hermesc, `react-native` itself.
* (e) `metro-runtime` 0.81.5 `modules/asyncRequire.js` vs 0.87.1: **functionally identical** (only trailing-comma formatting differs). Semantics: `maybeLoadBundle(moduleID, paths)` reads `global[__METRO_GLOBAL_PREFIX__ + '__loadBundleAsync']`;
  if defined and `paths[String(moduleID)]` is non-null it returns `loadBundle(bundlePath)` (one string argument: our unit name) and then `.then(() => require.importAll(moduleID))`; otherwise `require.importAll(moduleID)` synchronously-in-a-promise.
  A custom `__loadBundleAsync` is supported (no `transformer.asyncRequireModulePath` needed). `asyncRequire(moduleID, paths, moduleName)` is `async`; `asyncRequire.unstable_importMaybeSync(moduleID, paths)` is the sync-or-promise variant used for `import()` under `require.unstable_importMaybeSync` / `experimentalImportSupport`-style output
  (same lookup, returns the module synchronously when no loader applies); `asyncRequire.prefetch(moduleID, paths)` calls the loader and swallows rejections (fire-and-forget). Note `__loadBundleAsync` must return a thenable. `global[...]` is prefixed by `__METRO_GLOBAL_PREFIX__` (empty in this build; set it consistently in the loader if the app uses a prefix).
  The runtime test drives this exact 0.81.5 file end to end (test 181 in runtime.test.js looks it up in the bundle).
* Direction rules, ids, id collision, `--bits`, ownership: unchanged from the 0.87 prototype (all failing fixtures pass on 0.81). 32-bit ids are too small for a real app; default is 48 bits.
* Metro setup gotchas still apply: the preset converts ESM; `import()` must be left to Metro; metro-runtime `require.js` and js-polyfills dirs must be in `watchFolders`; plus `@babel/runtime` must be resolvable from the app.

## NOT verified (needs real React Native / Hermes)
* hermesc compile of host/unit files, bytecode validation behaviour ("corrupt .hbc fails before registering" is simulated with a parse + only-`__d` check; real Hermes behaviour on truncated/mismatched HBC is untested; whether an HBC "script" evaluate is atomic is untested).
* `NativeOtaUnits` / `ReactInstance.loadJSBundle` / JSI `evaluateJavaScript` for a second bundle in a running Hermes runtime, on either platform.
* `react-native` itself (`InitializeCore` is stubbed out; the preset and the polyfills are the real 0.78.3 ones), Hermes transform profiles, assets, platform extensions (`.ios/.android`), `inlineRequires`, minification, source maps and Sentry debug ids, `lazy` Suspense rendering with real React.
* HMR/dev mode (only `dev:false` tested), Metro `require.context`, `experimentalImportSupport`, package `exports` edge cases.
* Scale: 17 modules here. Build time, id collision rate, and module-order effects on a real graph are unmeasured.
* "Pure JS" and `NativeModules` checks are heuristics (folder/podspec/codegen evidence); rule 5's `NativeModules` reference scan and rule 6 (baseHash) are not implemented.
