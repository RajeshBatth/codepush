# Rules catalog

**Purpose:** every rule id that the unit splitter (build time) and `verifyPinPr` (pin-PR verify) can emit: tier, default severity, how to change it, trigger, message, fix.
**Audience:** unit authors reading a failed build; engineers adding or tuning checks; AI assistants mapping a message to a fix.
**Source of truth:** `packages/unit-splitter/src/{analyze,checks,public-api,build,config,ids,metro-compat}.js`, `packages/ota-core/src/verify.ts`, tests `packages/unit-splitter/test/*.test.js`, `packages/ota-core/test/governance.test.ts`; design in [DESIGN.md section 4](../../DESIGN.md) and [7.3](../../DESIGN.md).

Related: [config-reference.md](config-reference.md) (config keys), [01-units-and-ownership](../architecture/01-units-and-ownership.md), [writing-a-unit](../guides/writing-a-unit.md), [troubleshooting](../guides/troubleshooting.md).

## How to read this

- **Tier** follows DESIGN.md: Tier 1 = patch safety, Tier 2 = unit eligibility, Tier 3 = hygiene. Rules that run in both base and patch builds are marked `1/2`.
- **Severity**: `error` fails the build (`VerificationError`, CLI exit 1); `warn` is printed and recorded in `units.json` `warnings`. `off` skips.
- **Modes**: *base* = build without `--base`; *patch* = build with `--base <base dist>`. "both" = runs in either.
- Messages are quoted from the source; `<...>` are placeholders. Paths are project-relative module keys (`src/units/cabs/fare.js`, `node_modules/pkg/...`).
- Each build writes a per-check summary (`{severity, count}`) to `units.json` `checks` (see [file-formats.md](file-formats.md)).

## A. Splitter rules (emitted by `unit-splitter`)

### A1. Direction and encapsulation (always on, no config key)

| Rule id | Tier | Sev | Mode | Trigger | Example message | Fix |
|---|---|---|---|---|---|---|
| `unit-to-unit` | 1/2 | error | both | Any edge (static or `import()`) from a module of unit A to a module of unit B | `unit cabs imports unit bus (src/units/cabs/a.js -> src/units/bus/entry.js, via import()); units may only import their own modules or the host, and only the host may import a unit (through lazyUnit)` | Move the shared code to the host (outside every unit root), or go through the host. Test: `rules.test.js` "(i)". |
| `host-to-unit-static` | 1/2 | error | both | Host module imports a unit module with static `import`, `require()`, `export ... from`, or re-exports it through a barrel | `host statically imports unit cabs (import, require() or re-export) (<from> -> <to>); reach units only via lazyUnit(name, () => import(...))` (variant: `host loads unit X through <asyncType> require` for non-`async` dependency types, e.g. `prefetch`) | Replace with `lazyUnit('cabs', () => import('<entry>'))`. Tests: `rules.test.js` "(ii)", `checks.test.js` C2 re-export / barrel / `require()` cases, `two-package.test.js` "core statically importing the unit". |
| `host-imports-non-entry` | 1/2 | error | both | Host `import()` of a unit module that is not the unit's declared `entry` | `host import() targets <key> which is not the entry of unit cabs (<from> -> <to>)` | Import the entry only; export what the host needs from the entry or keep it inside the unit. |
| `lazyUnit-name-mismatch` | 1/2 | error | both | `lazyUnit('<name>', () => import('<spec>'))` in a host file where `<spec>` resolves to the entry of a different unit. Matched by regex on the source and by the specifier as written (relative or bare package) | `<file>: lazyUnit('bus') imports '../units/cabs/entry' which belongs to unit cabs` | Make the first argument equal the unit that owns the imported entry. |

Config errors that fail the build before analysis (plain `Error`, not rules): `duplicate unit name <n>`, `unit <n>: entry <path> does not exist`, `unit <n>: entry is not under its roots`, `unit roots not disjoint: <a> and <b>` (Tier 2 rule 8), `unit <n>: root "<r>" is neither a directory of the project nor an installed package`, `module id collision (48-bit): <id> for "<k1>" and "<k2>"` (from `ids.js`; build with fewer bits only in tests).

### A2. Patch-mode dependency rules (only with `--base`)

| Rule id | Tier | Sev | Trigger | Example message | Fix |
|---|---|---|---|---|---|
| `package-version-mismatch` | 1 | error | A unit imports a host package whose installed version differs from the base host's | `unit cabs imports lodash@4.17.22 but the base host has lodash@4.17.21 (<from> -> <to>); upgrading shared libs goes through the train/host lane` | Keep the version equal to the base, or ship the upgrade through the train/host lane. Test: `rules.test.js` "(iii) ... DIFFERENT version". |
| `missing-in-base-host` | 1 | error | A unit imports a host module whose key is not in the base host's module list | `unit cabs imports <key> which does not exist in the base host (<from> -> <to>)` | The module is new to the host: it cannot ship OTA. Move it into the unit or ride the train. |
| `native-package` | 1 | error | A unit reaches a package absent from the base host that looks native (`ios/` or `android/` dir, `*.podspec`, `codegenConfig`, `react-native.android/ios` in package.json) | `unit cabs imports new package <name>@<ver> which looks native (ios/ directory, podspec); not allowed OTA` | Remove the dependency or ship it in a binary release. The `NativeModules` reference scan (DESIGN Tier 1 rule 5) is **planned**, not implemented. |
| `new-package-in-multiple-units` | 3 (enforced as error) | error | The same new pure-JS package is needed by two units (it would exist in two files under one id) | `new package <name>@<ver> is imported by units a and b; add it to the host` | Add the package to the host (train). |

A new **pure-JS** package that is not in the base host is allowed: it is claimed by the unit and bundled into it (listed in `units.json` `units.<n>.packages`). Test: `rules.test.js` "(iii) ... NEW pure-JS package".

### A3. Configurable checks (`checks` in `units.config.json`)

| Rule id | Tier | Default | Config key | Trigger | Example message | Fix |
|---|---|---|---|---|---|---|
| `cycle` | 2 (base) / 1 (patch) | error | `checks.cycles` = `error`/`warn`/`off`; `checks.cycleBaseline` | A static-edge cycle inside one unit (incl. packages bundled into it) or in first-party host code (not `node_modules`). Base: error unless in the baseline file. Patch: error only if absent from the base build's recorded `cycles` (or the baseline file). Signature covers the whole SCC, so growing an accepted cycle makes it new | `dependency cycle in unit cabs: src/units/cabs/fare.js -> src/units/cabs/util.js -> src/units/cabs/fare.js (2 module(s), signature 3fa1c2d0e4b1; not in the baseline (checks.cycleBaseline)). Break the cycle, or accept it with \`cli.js cycle-baseline\` + checks.cycleBaseline` (policy text varies: `new compared to the base build`, `not in the baseline file`) | Break the cycle, or adopt incrementally: `node packages/unit-splitter/src/cli.js cycle-baseline --project <dir> --file cycles.baseline.json` and set `checks.cycleBaseline`. Tests: `checks.test.js` C1. |
| `cycle-async` | 3 | warn (only when `checks.cycles` is not `off`) | `checks.cycles` | Cycle that exists only with an `import()` edge, inside one owner | `cycle in unit cabs through an import() edge (informational): a -> b -> a [3fa1c2d0e4b1]` | Informational. Cycles closed only by the intended `lazyUnit` boundary (host shell `import()`s the unit, unit imports host) are counted as `lazyUnitBoundaryCycles` and produce no warning. |
| `cycles-base-missing` | 3 | warn | `checks.cycles` | Patch build whose base `units.json` has no `cycles` record | `base build has no \`cycles\` record in units.json; comparing against the baseline file (checks.cycleBaseline) only (none configured: every cycle counts as new)` | Rebuild the base with the current splitter. |
| `multiple-import-sites` | 3 | warn | `checks.singleImportSite` = `off`/`warn`/`error` | A unit entry is `import()`ed (by the host) from more than one distinct site (module + specifier) | `unit cabs entry is imported from 2 sites: a.js import('x'); b.js import('x'); keep exactly one lazyUnit site per unit` | Keep one `lazyUnit` site per unit and share the resulting component. Test: `checks.test.js` C2 "second import site". Summary key in `units.json`: `single-import-site`. |
| `dynamic-require` | 1/2 | error | `checks.dynamicRequire` = `error`/`warn`/`off` | Non-literal `require(x)`, non-literal `import(x)`, `require.context(...)` in first-party host code, unit code, or packages bundled into a unit. Third-party host packages are counted only (`thirdPartyModules`) | Metro-rejected form: `<file>:<line>: <detail> is not statically analyzable (Metro rejects a non-literal require()/import() in first-party code at transform time); use a string-literal specifier`. AST/placeholder forms: `unit cabs: <key>:<line> uses require.context(), whose module set is not statically declared` / `<owner>: <key>:<line> has a non-literal require(); Metro turns it into a runtime error` | Use string-literal specifiers and explicit imports. **Caveat:** Metro's own first-party rejection happens at transform time and cannot be downgraded by `warn`/`off`; those values only affect the placeholder and `require.context` findings. |
| `register-component` | 2 | off | `checks.requireRegisterComponent` = `true` (boolean) | Unit entry never calls `AppRegistry.registerComponent`, registers a different literal, or uses a non-literal name | `unit cabs (src/units/cabs/entry.js): entry never calls AppRegistry.registerComponent('cabs', ...)` / `entry registers 'x' but the unit is named 'cabs'; the registered component name must equal the unit name` / `... has a non-literal name; it must be the literal 'cabs'` / `cannot parse entry for the registerComponent check: ...` | Register `AppRegistry.registerComponent('<unitName>', () => Root)` in the entry. On in `examples/spike-app`. |
| `host-export-missing` | 1/2 | error | `checks.hostExports` = `error`/`warn`/`off` | A unit module imports a name (named, default, `ns.member`, `export {a} from`, `require('x').a`, destructured `require`) that the host target module does not export at runtime. Type-only imports ignored | `unit cabs: src/units/cabs/a.js:3 imports { foo } from './h' (src/host/h.js), which does not export it. Exports of that module: a, b, ... A unit can only use host API that already shipped in the binary` | Use an existing export, or add the export to the host through the train/host lane. Test: `two-package.test.js` negative cases. |
| `host-export-unknown` | 3 | warn (never an error) | `checks.hostExports` (off disables) | Target's exports cannot be determined (opaque: `module.exports = fn()`, computed names, TS `export =`, unparsable, `export *` of something outside the graph); one warning per target module | `exports of <key> cannot be determined statically (<reason>); N imported name(s) from units were not verified, e.g. <sites>` | Make the host module analyzable (plain ESM `export`, Babel/tsc CJS forms). |
| `public-deep-import` | 1/2 | error | `checks.publicPackages` (list; default `[]`) | A unit imports an internal file of a public package that is not its entry or exposed via `exports`/`main`/`react-native`/`browser`/`module` | `unit travelplex: <key> imports '@travelplex/core/internal/secret' (<key>), an internal file of public package @travelplex/core; import only '@travelplex/core' or a path listed in its package.json "exports"` | Import the package entry; or expose the file in the public package's `exports` (a public API promise). |
| `public-package-not-host` | 2 | error | `checks.publicPackages` | A listed public package overlaps a unit root, or its entry is owned by a unit | `public package <name> overlaps the root of unit <u> (<key>): a public package is HOST-owned (ships in the binary, patched only via the host lane) and must not be inside a unit root` / `public package <name> entry <key> is owned by unit <u>` | Remove it from the unit's roots or from `publicPackages`. Test: `two-package.test.js` "must be host-owned". |
| `public-package-missing` | 2 | error | `checks.publicPackages` | Listed package not installed, or has no entry in the bundle graph (the host does not import it) | `checks.publicPackages lists <name>, but node_modules/<name> is not installed` / `public package <name> has no entry in the bundle graph: the host must import it (host entry calls its init())` | Install it and import it from the host entry. |
| `public-api-breaking` | 2 | error | `checks.publicApiSnapshot` (`{pkg: file}`) | A name in the snapshot's `exports` (or the default) is gone from the current runtime exports of the package entry; a rename counts as removal | `public API of <pkg> lost 'x' compared to <snapshot>. Units patched OTA call these names in the already shipped binary: restore them (a rename is a removal; keep the old name), or ship the change through the train with a new snapshot` | Restore the name (keep the old one as an alias), or train release plus new snapshot. |
| `public-api-changed` | 2 | warn; error with `checks.publicApiStrict: true` | `checks.publicApiSnapshot`, `checks.publicApiStrict` | A name was added versus the snapshot | `public API of <pkg> gained 'y' compared to <snapshot>; review it (public API is a long-lived promise) and update the snapshot: cli.js api-snapshot --project <dir> --write` | Review, then `node packages/unit-splitter/src/cli.js api-snapshot --project <dir> --write`. |
| `public-api-opaque` | 2 | error | `checks.publicApiSnapshot` | The public entry cannot be analyzed statically, so the snapshot cannot be verified | `entry of public package <pkg> (<entry>) is not statically analyzable (<reason>), so its API snapshot cannot be verified. Make it analyzable: plain ES \`export\` / ...` | Use ESM `export`/`export *` or Babel-compiled CJS forms. |
| `public-api-snapshot-missing` | 2 | error | `checks.publicApiSnapshot` | Snapshot file missing or unreadable | `API snapshot <path> for <pkg> is missing or unreadable (ENOENT); create it with: cli.js api-snapshot --project <dir> --write` | Run the `api-snapshot --write` command and commit the file. |
| `unparsed-source` | 3 | warn (not configurable) | none | A file could not be parsed for the dynamic-require or host-export scan | `<key>: cannot parse for the dynamic-require scan (<first error line>)` / `... for the host-export check (...)` | Fix the syntax or accept that the file is skipped. |

Notes on severity: `cycles`, `dynamicRequire`, `hostExports`, `singleImportSite` accept `error|warn|off`; invalid values or unknown keys under `checks` throw `units.config.json checks.<k> must be one of error|warn|off` (see `parseChecks`, test `checks.test.js` "bad checks values").

### A4. Not implemented (do not rely on)

| DESIGN item | Status |
|---|---|
| Asset rule: every asset module of a patched unit must exist in base with same path and hash (DESIGN 5.9) | **planned**. `units.json` already lists `assets` with sha256, no rule consumes them. |
| `NativeModules`/TurboModule reference scan (Tier 1 rule 5, second half) | **planned**. `native-package` is a folder/podspec/codegen heuristic only. |
| `baseHash` check (Tier 1 rule 6) | **planned** in the splitter. The hash-vs-`base.json` comparison belongs to the deploy flow ([04-release-workflow](../architecture/04-release-workflow.md)). |
| Tier 2 rule 9 (unit declared in both build config and governance `units.json`) | no code found that cross-checks the two lists (`grep` of `ota-core`/`ota-cli`). **planned**. |
| Tier 3: unit base size budget (10), `global` assignment lint (12) | not implemented. |

## B. Environment/tool and compatibility errors (not rule ids)

| Source | Message start | Meaning |
|---|---|---|
| `metro-compat.js` `MetroCompatError` | `unsupported Metro <v> ...` | Located Metro is not 0.81.x/0.87.x, or metro/metro-config/metro-runtime versions differ. Align the app to RN 0.78. |
| `metro-run.js` | `<config> did not call withOtaUnits (or it is disabled): no id factory` | `metro.config.js` was auto-detected but not wrapped. Wrap it or set `"metroConfig": false`. |
| `build.js` | `unknown approach <x>` | `--approach` must be `serializer` or `postprocess`. |

## C. Verify checks (`verifyPinPr`, pin PR on `ota-deployments`)

`verifyPinPr(input)` in `packages/ota-core/src/verify.ts` returns `Finding[]` with `{severity: 'error'|'warning', check, message}`. Any `error` fails the required status (`hasErrors`). All checks are pure functions of the input; Jenkins supplies git facts and the build result. **The function is exercised by tests only: no code under `packages/*/src` calls it yet** (real Jenkins verify job: planned, see [04-release-workflow](../architecture/04-release-workflow.md)). Nothing in `ota-cli` or `ota-build` fills `build.tier1Errors` either; the splitter's errors are the natural source.

| Check id | Sev | Config | Trigger | Message | Fix |
|---|---|---|---|---|---|
| `single-commit` | error | none | PR commit count != 1 | `PR must have exactly one commit (has N)` | Squash. |
| `single-file` | error | none | Changed files != 1 | `PR must change exactly one file (changes N)` | One pin file per PR. |
| `pin-path` | error | none | The one file is not `<x.y.z>/<unit>.json` (regex `^([0-9]+\.[0-9]+\.[0-9]+)/([a-z][a-z0-9-]*)\.json$`) | `<file> is not a pin file (<version>/<unit>.json)` | Fix path. Evaluation stops here. |
| `known-unit` | error | governance `units` | Unit not in governance `units.json` | `unit "<u>" is not declared in units.json` | Declare the unit (PR to `ota-deployments`). |
| `live-version` | error | `liveVersions` input | Version not live | `app version <v> is not live (live: ...)` | Pin a live version (latest 3 lines with a base). |
| `pin` | error | none | `validatePin`: branch not `ota/<unit>/<version>`, or sha not 40 lowercase hex | `branch must be ota/<unit>/<version>, got <b>` / `sha must be a full 40-char lowercase hex commit id` / `branch missing` | Correct the pin file. |
| `jira-title` | error | `enforceJira: true` (default off) | Title does not start with `KEY-123` | `PR title must start with a Jira key, e.g. "TLX-1244: ..."` | Prefix the title. |
| `jira-unit` | error | `enforceJira` | Project of the key not mapped to the unit | `ticket <k> belongs to <unit or no unit>, not <unit>` | Use a ticket of the unit's project. |
| `jira-exists` | error | `enforceJira` | Ticket lookup is empty | `ticket <k> does not exist` | Check key. |
| `jira-status` | error | `enforceJira`, `acceptableTicketStatuses` | Status not acceptable | `ticket <k> is "<s>"; acceptable: ...` | Move ticket to an acceptable status. |
| `sha-on-branch` | error | none | `git.shaOnBranch` false | `pinned sha is not reachable from the pinned branch` | Pin a commit of the branch. |
| `descends-from-tag` | error | none | `git.descendsFromReleaseTag` false | `pinned sha does not descend from the release tag of this version` | Branch from the release tag. |
| `branch-protected` | error | none | `git.branchProtected` false | `pinned branch is not protected` | Protect `ota/**` branches. |
| `tier1` | error | none | Each entry of `build.tier1Errors` | the entry text | See sections A1-A2. |
| `only-one-unit` | error | none | Host differs but unit is not `host`; or other units differ | `host artifact differs from base but this PR claims unit "<u>"` / `other units differ from base: a, b` | Split into one branch per unit. |
| `has-change` | error | none | Non-host unit byte-identical to base | `unit "<u>" is byte-identical to the base: nothing to patch` | Nothing to ship. |
| `size-hard` | error | `hardLimit` / `defaultHardLimit` (`bytes`, `ratio`; either triggers) | Per platform: patch size over limit | `<platform>: hard limit: 90000 B > 80000 B` or `hard limit: 31.0% of base > 30.0%` | Shrink/split, or change limits by PR to governance `units.json`. |
| `size-soft` | warning | `softLimit` / `defaultSoftLimit` | Per platform over soft limit (only if hard not exceeded) | `<platform>: soft limit: ...` | Reviewer warning only. |

Size ratio is `patchSize / unitBaseSize` as supplied by the caller (`evaluateSize` in `units.ts`); the governance schema documents ratio as "of the unit's embedded base bundle zstd size". Which number the caller passes is up to the (not yet written) verify job.

## D. Related non-rule checks

`ota-build doctor` check ids (`node`, `project`, `react-native`, `metro`, `metro-runs`, `units-config`, `units-resolve`, `host-entry`, `metro-config-wired`, `metro-config-used`, `metro-crawl`, `node-modules`, `hermes-engine`, `native-modules`, `hermesc`, `hdiffz`, `ota-apply`, `tools-dir`, `work-dir`, `toolchain-image`, `deep-repro`) are readiness probes with PASS/WARN/FAIL/MANUAL status, documented in [cli-reference.md](cli-reference.md) and `packages/ota-build/README.md`.
