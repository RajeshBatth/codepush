# 02 - Build and patch pipeline

**Purpose:** How source code becomes host/unit Hermes bytecode, how patches are produced and proven, and why the output is reproducible.
**Audience:** Engineers wiring the pipeline into CI; anyone debugging "why did this unit change" or "why is the patch big".
**Source of truth:** `packages/unit-splitter/src/{build,split,ids,metro-run,metro-compat,with-ota-units,diff,determinism}.js`, `packages/ota-build/src/{bundle,patch,tools,pins,handoff,hbc,util}.ts`, `tools/repro_check.py`, `native/measure-rn078/RESULTS.md`, DESIGN.md sections 5.6, 5.7, 7.8.

Status: everything on this page is **implemented** unless marked *planned*. Real Jenkins wiring is *planned* (see [adopting guide](../guides/adopting-in-your-monorepo.md)).

## 1. The pipeline at a glance

```
 source @ sha, per platform (android | ios)
      |
      |  [1] ota-build bundle        packages/ota-build/src/bundle.ts
      |        unit-splitter build   ONE Metro run -> ONE graph -> owner by path
      |        -> js/host.js  js/units/<u>.js  ids.json  units.json
      |        hermesc -O -emit-binary -g0 on each file (fixed relative name)
      v
 <build dir>: build.json  host.hbc  units/<u>.hbc  ids.json  units.json  (js/ is kept for inspection)
      |
      |  [2] ota-build patch --base <base build> --new <new build>   packages/ota-build/src/patch.ts
      |        per changed file: hdiffz_tool (zstd-19) -> ota_apply round trip -> `full` fallback if > 0.6 x zstd(new)
      v
 <patch dir>: patch-report.json  <unit>.<platform>.<base12>-<new12>.(delta|full).hdiff
      |
      |  [3] ota-build deploy-args --report android --report ios   packages/ota-build/src/handoff.ts
      v
 flags for `ota-cli deploy` (see 03 and 04)
```

Command syntax for all steps: [CLI reference](../reference/cli-reference.md). File layouts: [file formats](../reference/file-formats.md).

## 2. Step 1: splitter (one Metro graph, partitioned)

Entry point: `build()` in `packages/unit-splitter/src/build.js`. Order of operations:

1. `initMetro(projectRoot)` fails fast on an unsupported Metro. The adapter `metro-compat.js` is the only place that touches Metro internals and accepts only the 0.81.x and 0.87.x lines (DESIGN 5.6 A).
2. Load `units.config.json` (units, `entry`, `metroConfig`, `checks`; see [config reference](../reference/config-reference.md)).
3. One Metro run (`metro-run.js`). Two modes:
   - **Project-config mode** (real apps): the app's own `metro.config.js` is loaded; it must wrap its config with `withOtaUnits(config, {units, projectRoot})` (`with-ota-units.js`). The wrapper is inert unless the splitter (or `OTA_UNITS_BUILD=1`) enables it, so `react-native start` and normal Gradle/Xcode bundling are unaffected. When active it installs only `serializer.createModuleIdFactory` and `serializer.customSerializer`. Auto-detected if `<project>/metro.config.js` exists; `"metroConfig": false` opts out.
   - **Demo mode** (`examples/demo-app`): the splitter assembles its own Metro config.
   - Both modes disable the Metro cache and watchman, so output does not depend on prior state.
4. **Module ids** (`ids.js`): `id = first 48 bits (12 hex chars) of sha256(path key)`, as a plain JS number (exact up to 52 bits). The path key is project-relative; for files outside the project (hoisted or linked packages) it is the part after the last `node_modules/`, so ids are machine independent. Collisions throw at build time.
5. **Analysis and rules**: `customSerializer` receives the whole graph; `analyze()` assigns an owner (`host` or a unit) to every module and runs all rules; any error aborts with `VerificationError`. Rule catalog: [rules catalog](../reference/rules-catalog.md). Ownership model: [01 units and ownership](01-units-and-ownership.md).
6. **Split** (`split.js`), two interchangeable approaches (`--approach`):
   - `serializer` (default, "a"): the serializer renders `__d(...)` definitions per owner itself. Unit files contain only `__d` statements; the host file holds Metro's runtime/polyfills, `InitializeCore`, the entry, and `paths`.
   - `postprocess` ("c"): take Metro's stock single bundle and cut it at `__d` statements using `ids.json`. Produces byte-identical output to (a); kept as a fallback if serializer hooks break on a Metro upgrade.
7. **`paths` for `import()`**: Metro does not emit `paths` in a normal build, so the splitter sets `paths[<unit entry id>] = "<unitName>"` in the host's dependency map; `import()` then compiles to `asyncRequire(id, paths)` which calls the host's `__loadBundleAsync(unitName)` (see [05 client runtime](05-client-runtime.md)).
8. Write `host.js`, `units/<name>.js`, `ids.json` (id -> path key), `units.json` (per-owner module ids, packages, assets, `paths`, cycles, warnings, check summary, `publicApi`).

**Patch mode:** pass `--base <base dist>` (CLI) / `--base-build` (`ota-build bundle`). The splitter loads the base `units.json` + `ids.json` and additionally enforces Tier 1 rules 3 and 4 (every import resolves to the base host; same `package@version`). `diffAgainstBase` (`diff.js`) compares two dist dirs byte for byte and returns `{changedUnits, hostChanged, addedUnits, removedUnits}`.

**Per-platform builds.** Metro is run once per platform (`.android.js`/`.ios.js` files and `Platform.OS` make bundles differ). Everything downstream (`build.json`, patches, `patch-report.json`) is per platform. A change in only an `.android.js` file leaves iOS bytes identical, so that unit has a patch for Android only; `deploy-args` then emits flags for the affected platform only and warns (`handoff.ts`).

**Assets.** Image assets are ordinary modules owned by path; their *bytes* are in no bundle. `units.json` lists `assets` with sha256. The rule "a patched unit may only reference assets present in the base build" is **planned**, not enforced (DESIGN 5.9; see the [ADR index](decisions/README.md)).

## 3. Step 1b: hermesc (the reproducible recipe)

Implemented in `compileHbc()` (`bundle.ts`):

1. `hermesc` is **pinned by sha256 per host OS** in `packages/ota-build/src/pins.ts` (RN 0.78.3, Hermes commit `a942ef37...`, HBC bytecode version 96; osx/linux64/win64). `resolveHermesc` refuses any other binary unless `--allow-unpinned-hermesc` (experiments only).
2. Each JS file is copied to `<work>/hermes-<label>/bundle.js` (fixed relative name), cwd is that directory, and the command is `hermesc -O -emit-binary -g0 -out out.hbc bundle.js`. `-g0` removes the embedded name/debug tables, so absolute paths cannot leak and different names give identical bytes. Cost: stack traces need the Metro/Hermes source map.
3. Child processes run with a fixed environment (`childEnv()`: minimal PATH, `LANG=C`, `TZ=UTC`), no shell, SIGKILL on timeout.
4. Each `.hbc` is validated: Hermes magic `c6 1f bc 03 c1 03 19 1f` and the u32 bytecode version at offset 8 equals the toolchain's (`hbc.ts`).
5. `build.json` records toolchain `{rn, metro, hermescSha256, hbcVersion, hermescFlags}`, per-file `{file, hash, size, zstdSize}`, each unit's `entryModuleId` and a `delta` record (below). It contains no timestamps or paths. `zstdSize` is zstd level 19 of the file (Node built-in zstd) and is the denominator of the size ratios.
6. The output dir is built in a sibling staging dir and renamed into place; `bundle` refuses to overwrite a non-empty directory that has no `build.json`.

**Delta mode (patch builds).** When `bundle` gets `--base-build <embedded base build>` (and `--delta` is not `off`), every file is compiled as `hermesc -O -emit-binary -g0 -base-bytecode=base.hbc -out out.hbc bundle.js`, where `base.hbc` is a copy of the base build's `.hbc` for that file under a fixed relative name (the base path cannot reach the output; verified by compiling against the same base in two directories). Why: Hermes re-sorts the whole string table and renumbers string/function IDs on every compile, so one string edit changes 40-90% of string IDs and 27-76% of function bodies; as a plain patch that costs 17-48 KB on the 860 KB RN host (median about 33 KB). With `-base-bytecode` the string table is seeded from the base and existing IDs cannot move: 0.7-1.7 KB (median about 0.9 KB) (`native/measure-rn078/STRING_TABLE.md`). The output is ordinary HBC v96 (+12 B on the host: it keeps base strings), so nothing changes on the device, and the patch format, round trip and `builtHash` rules are unchanged.

Safety rules: (a) a file whose JS sha256 equals the base's (recorded in the base `build.json`) is NOT recompiled; the base `.hbc` is copied, so the one-unit rule (built-hash comparison) holds by construction (delta-compiling an unchanged file against its own base is also byte-identical, measured on demo-app and two-package-app); (b) the base is always the EMBEDDED base build: a base whose `build.json` has `delta.enabled` is refused, and `patch` refuses a delta build against any base but its `delta.baseBuild`; (c) the base `.hbc` must be valid HBC of the toolchain's version and come from the same hermesc, else a clear error before hermesc runs; (d) `verify-repro --base-build` covers delta builds; (e) `--delta on` never silently falls back to plain. `--delta off` is exactly the previous recipe.

`build.json.delta = { enabled, baseBuild (sha256 of the base build.json | null), files: { "<hbc path>": { baseHbc (sha256 of the base .hbc, only when enabled), js (sha256 of the JS compiled) } } }`; base builds and `--delta off` builds have `enabled: false` and only `js`.

**Base artifact requirement.** Delta compile needs the base `.hbc` bytes at patch-build time, but the artifact store keeps only hashes in `base.json`. The base release job must archive `ota-build archive-base --build <base build dir> --out <dir>` (host.hbc, units/*.hbc, build.json with the js hashes, ids.json, units.json, `archive-manifest.json`) next to `base.json` and restore it as `--base-build` for patch builds; `archive-base --verify <dir> --base-json base.json` checks it against `base.json`. This is a planned extension of the `ota-cli` ports (not implemented there); until then `bundle` fails with `DELTA_BASE_MISSING` when the files are absent.

Obtaining the compiler: `node packages/ota-build/src/cli.ts fetch-tools` runs `npm pack react-native@0.78.3`, extracts only the hermesc binary and `.hermesversion` (the tarball is treated as untrusted), verifies every sha256 **before executing anything**, then checks `hermesc -version` reports HBC 96. A cross-OS fetch (`--platform linux64`) is hash-checked, never executed.

## 4. Step 2: patches

`createPatches()` in `patch.ts`. Preconditions checked first (each a hard `BuildError`): both build dirs re-hash clean (`verifyBuildDir`), same platform, **identical toolchain**, same `appVersion`, identical unit set (added/removed units are not patchable), and no module id maps to a different path between base and new (`IDS_CONFLICT`).

For the host and each unit whose `hash` differs:

| Step | Detail |
|------|--------|
| Diff | `hdiffz_tool -c zstd -l 19 -m 4 old new out` = HDiffPatch `create_single_compressed_diff`. These parameters are `patchAlgoVer` `v1` (`PATCH_ALGO`); changing one needs a new version. |
| `full` fallback | if `deltaSize > 0.6 x newZstdSize` (`FULL_THRESHOLD`) or `--force-full`: redo the diff against an **empty** old file, `updateType: "full"`. Same format, so the device uses the same apply code. |
| Round trip (mandatory) | `ota_apply <old|-> <patch> <out> <expected-hash>` (this is `otacore::applyPatch`, the code the app ships) must exit 0, and the output is re-hashed independently; mismatch aborts the whole command (`ROUNDTRIP_FAILED`). A patch that does not reproduce the new hash is never emitted. |
| Publish | patches first, `patch-report.json` last, so a report never references a missing file. Existing outputs need `--overwrite`. |

`patch-report.json` carries `deltaMode` (the new build was delta-compiled), `hostChanged`, `changedUnits`, `idsChanged`, per-item `{unit, patchFile, patchSize, updateType, builtHash, baseHash, ratioOfZstdFull, deltaPatchSize, newZstdSize}` (with `patch --report-plain` also `plainEquivalentSize` and `deltaOverPlain`: the size the same edit would cost compiled plainly, for production monitoring), the toolchain, algo parameters and sha256 of the two native tools. `deploy-args` enforces the one-unit rule on it (Tier 1 rule 2): a unit PR may not change the host or another unit (`RULE_ONE_UNIT`).

Patch **bytes** need not be reproducible; the **built hash** must be (verify records it, deploy rebuilds and compares; the Jenkins side is *planned*).

**Native tools** (`native/tools/hdiffz_tool.cpp`, `native/tools/ota_apply/ota_apply.cpp`) are built with `scripts/native-build.sh --tools` into `native/build-ota-tools/`. Locations resolve flag > env > default (`OTA_HDIFFZ`, `OTA_APPLY`).

### Measured sizes (for sanity checks, not guarantees)

From `native/measure-rn078/RESULTS.md` and DESIGN 5.7/5.9: Hermes bytecode diffs are 30-180x larger than JS-source diffs; ~14 KB for 5 literal tweaks on a 331 KB zstd corpus, ~20-29% of zstd'd full for 5% module churn. On the real RN 0.78.3 spike host: a one-line unit change 80 B, new function in a unit 825 B, a *string-literal* edit in host code 22-35 KB as a plain patch, 0.7-1.7 KB with hermesc delta mode (see section 3). Details: [spike summary](../spikes/summary.md).

## 5. Reproducibility

The one-unit rule only works if the same source produces byte-identical bundles. Controls, and where each is enforced:

| Source of nondeterminism | Control |
|--------------------------|---------|
| Absolute paths in module keys | `pathKey()` project-relative / after `node_modules/` (`ids.js`) |
| Metro cache | disabled in the split build (`cacheStores: []`, `resetCache`) |
| hermesc name/debug info | fixed relative name + `-g0` |
| hermesc version | sha256 pin per OS (`pins.ts`) |
| Locale/TZ/env | fixed child env (`childEnv`) |
| Sort order | ids, module lists, JSON keys sorted; locale-independent `listFiles` |

Gates (run these in CI before trusting a base):

- `ota-build verify-repro` builds twice into different absolute directories and requires every file and `build.json` to be byte-identical.
- `unit-splitter` `src/determinism.js` (`npm run determinism`): two copies of a project at different paths, TZ and LANG, both approaches, plus a check that no output contains the build root.
- `tools/repro_check.py`: fresh git checkouts at different paths with perturbed env, optional comparison to a reference hash file (for a real monorepo and release tag).
- `ota-build doctor --deep` runs `verify-repro` as its last check.

Known caveat: the pinned `hermesc` hash proves the *compiler*; the pin that the **CI toolchain image** is itself pinned is a manual item (`base-info` defaults `toolchainImage` to `local-unpinned`; `doctor` reports it as MANUAL).

## 6. Where to change things

| You want to | Edit |
|-------------|------|
| Support another RN/Hermes | `pins.ts` (`RN_VERSION`, hashes, `EXPECTED_HBC_VERSION`), re-verify the splitter on that Metro (`packages/unit-splitter/scripts/metro-matrix.sh`) |
| Change patch algorithm | `PATCH_ALGO` in `patch.ts` + new `patchAlgoVer` + native apply support |
| Add a Metro version | `metro-compat.js` (single adapter) and its test matrix |
| Add a rule | `analyze.js`/`checks.js`; document in [rules catalog](../reference/rules-catalog.md) |
