# Configuration reference

**Purpose:** every configuration surface of the system: `units.config.json` (splitter input), governance `units.json`, pin files, environment variables, and the unit-splitter CLI flags.
**Audience:** engineers wiring the build into an app or monorepo; AI assistants editing config.
**Source of truth:** `packages/unit-splitter/src/{config,checks,cli,with-ota-units,build}.js`, `packages/ota-core/src/{types,units,pin}.ts`, `schemas/{units.config,ota-units-governance,pin}.schema.json` and `schemas/fixtures/`, `packages/ota-build/src/{util,tools}.ts`, `scripts/*.sh`.

Three different files are called "units": do not mix them up.

| File | Where | Who writes it | Schema |
|---|---|---|---|
| `units.config.json` | root of the **app project** | LoB/Common team, reviewed in the monorepo | `schemas/units.config.schema.json` |
| `units.json` (governance) | root of the **`ota-deployments`** repo | Common team (PR) | `schemas/ota-units-governance.schema.json` |
| `units.json` (build output) | `dist/units.json` next to `host.js` | the splitter | `schemas/units.output.schema.json`, see [file-formats.md](file-formats.md) |

CLI flags of `ota-cli` and `ota-build` are in [cli-reference.md](cli-reference.md).

## 1. `units.config.json` (splitter input)

Read by `readUnitsConfig` / `loadUnitsConfig` in `packages/unit-splitter/src/config.js`. Top-level keys: `units` (required), `entry`, `metroConfig`, `checks`, `$schema` (ignored).

```json
{
  "entry": "index.js",
  "metroConfig": "metro.config.js",
  "checks": { "requireRegisterComponent": true },
  "units": [
    { "name": "cabs", "roots": ["src/units/cabs"], "entry": "src/units/cabs/entry.js" }
  ]
}
```
(from `examples/spike-app/units.config.json`, abbreviated)

### 1.1 `units[]`

| Key | Type | Rule |
|---|---|---|
| `name` | string | Schema: `^[a-z][a-z0-9-]*$`, not `host`. Becomes `units/<name>.js` and the `lazyUnit` name. Duplicates throw `duplicate unit name`. (The code does not itself reject `host`; the schema does.) |
| `roots` | string[] (>=1) | Each is a project-relative **directory**, or an npm **package name** (`"@lob/cabs"`, optionally `"package:@lob/cabs"`). A string that is an existing directory wins unless prefixed `package:`. Roots are `realpath`ed. Roots of different units must be disjoint (`unit roots not disjoint`). A package root does not own that package's nested `node_modules`. |
| `entry` | string | Project-relative file, `"<package>/<file>"`, or a bare package name (its main file: `react-native`, `browser`, `main` fields in that order, then `index`). Must exist and lie under one root. |

Outside-project package roots are added to Metro `watchFolders` and keyed `node_modules/<pkg>/...` so ids stay machine independent (`registerAliasRoot` in `ids.js`).

### 1.2 `entry` (host entry)

Project-relative path of the host entry Metro bundles as `host.js`. Default `src/host/index.js`. CLI `--entry` overrides it. Verified by `ota-build doctor` check `host-entry`.

### 1.3 `metroConfig`

Resolved by `resolveMetroConfigFile` (`config.js`):

| Value | Behavior | `source` |
|---|---|---|
| string | That file is loaded as the app's Metro config. | `units.config.json` |
| absent | Auto-detect `metro.config.js`, then `metro.config.cjs` in the project root. | `auto-detected` (or `none` if absent) |
| `false` or `null` | Never use the app's config; splitter assembles its own ("demo mode"). | `disabled` |

With no config file the splitter builds its own Metro config (this is how `examples/demo-app` and `examples/two-package-app` run). A detected config that does not call `withOtaUnits` fails with `<file> did not call withOtaUnits ...`. **Disagreement:** `schemas/units.config.schema.json` types `metroConfig` as a non-empty string only, while the code (and splitter README) also accept `false`/`null`; the code wins.

### 1.4 `checks`

All keys optional; unknown keys throw (`parseChecks`). Defaults (`DEFAULT_CHECKS` in `checks.js`):

| Key | Type | Default | Controls rule ids |
|---|---|---|---|
| `cycles` | `error`/`warn`/`off` | `error` | `cycle`, `cycle-async`, `cycles-base-missing` |
| `cycleBaseline` | string path (project-relative) or null | `null` | ratchet file for `cycle` |
| `singleImportSite` | `error`/`warn`/`off` | `warn` | `multiple-import-sites` |
| `dynamicRequire` | `error`/`warn`/`off` | `error` | `dynamic-require` (Metro's own first-party rejection cannot be downgraded) |
| `requireRegisterComponent` | boolean | `false` | `register-component` |
| `hostExports` | `error`/`warn`/`off` | `error` | `host-export-missing`, `host-export-unknown` |
| `publicPackages` | string[] | `[]` | `public-deep-import`, `public-package-not-host`, `public-package-missing`, and the snapshot rules |
| `publicApiSnapshot` | `{ "<pkg>": "<path>" }` | `{}` | `public-api-*`. Every key must also be in `publicPackages`. |
| `publicApiStrict` | boolean | `false` | makes `public-api-changed` an error |

Full per-rule detail: [rules-catalog.md](rules-catalog.md). Validation errors, e.g. `units.config.json checks.cycles must be one of error|warn|off, got "fatal"` (test: `ota-core/test/schemas.test.ts`, `unit-splitter/test/checks.test.js`).

### 1.5 `cycleBaseline` file

```json
{ "cycles": { "cabs": [ { "signature": "<sha256 of sorted module keys>", "modules": ["src/units/cabs/a.js", "src/units/cabs/b.js"] } ] } }
```
Generate with `cli.js cycle-baseline`. An entry matches by `signature` or by sorted `modules` set; bare signature strings are also accepted.

### 1.6 Public API snapshot file

`{ "package": "@travelplex/core", "entry": "index.js", "default": false, "exports": ["TravelplexEntry", "getConfig", ...] }` (`examples/two-package-app/api/travelplex-core.api.json`). Generate with `cli.js api-snapshot --write`. See [two-package-pattern](../guides/two-package-pattern.md).

### 1.7 App `metro.config.js`

```js
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const {withOtaUnits} = require('../../packages/unit-splitter/src/with-ota-units.js');   // path in this repo
const unitsConfig = require('./units.config.json');
module.exports = withOtaUnits(mergeConfig(getDefaultConfig(__dirname), { /* app config */ }),
  { units: unitsConfig.units, projectRoot: __dirname });
```
`withOtaUnits(metroConfig, { units, projectRoot, bits = 48, enabled, checks })` accepts an object, Promise or function. It is **inert** unless the splitter drives the build or `OTA_UNITS_BUILD=1`; when active it sets only `serializer.createModuleIdFactory` and `serializer.customSerializer`. Errors name the missing argument. `require()` of the ESM file needs Node >= 22.12 (README says Node >= 24 for the repo). Template: `examples/spike-app/metro.config.js` (also has the `blockList` for `ios/Pods`, `android/*/build`).

## 2. Governance `units.json` (`ota-deployments` repo)

Type `UnitsConfig` (`packages/ota-core/src/types.ts`), validated by `validateUnitsConfig` (`units.ts`), passed to `ota-cli` as `--units`. Example: `schemas/fixtures/ota-units-governance.json`.

```json
{
  "superAdminTeam": "ota-super-admin",
  "enforceJira": false,
  "acceptableTicketStatuses": ["In Progress"],
  "defaultSoftLimit": { "bytes": 100000 },
  "defaultHardLimit": { "bytes": 500000, "ratio": 0.5 },
  "units": {
    "host": { "ownerTeam": "ota-super-admin", "jiraProjects": ["COM"] },
    "cabs": { "ownerTeam": "ota-cabs", "jiraProjects": ["CAB"], "softLimit": { "ratio": 0.2 } }
  }
}
```

| Key | Meaning | Validation (`validateUnitsConfig`) |
|---|---|---|
| `superAdminTeam` | approves host-lane and break-glass | required: `superAdminTeam missing` |
| `enforceJira` | verify-time Jira checks (`jira-*`) run only if `true`; default off (deferred) | optional |
| `acceptableTicketStatuses` | statuses accepted by `jira-status` | non-empty |
| `defaultSoftLimit` / `defaultHardLimit` | `{bytes?, ratio?}`; **either** bound triggers (`exceeds` in `units.ts`) | schema-required |
| `units.<name>.ownerTeam` | approvers for that unit | required |
| `units.<name>.jiraProjects` | keys like `TLX`, regex `^[A-Z][A-Z0-9]+$`, a key maps to one unit only | non-empty |
| `units.<name>.softLimit/hardLimit` | per-unit override (replaces the default whole, not per field) | optional |
| `units.host` | the special unit | required: `the special unit "host" must be declared` |

Size semantics: soft exceeded -> warning `size-soft`; hard exceeded -> error `size-hard` ([rules-catalog C](rules-catalog.md)). Default values are `[DECIDE]` in [DESIGN.md 4](../../DESIGN.md) and 13.

A CODEOWNERS file generated from this file, and a sync check against the splitter's `units.config.json`, are **planned** ([DESIGN.md 7.1](../../DESIGN.md), Tier 2 rule 9).

## 3. Pin file `<appVersion>/<unit>.json`

```json
{ "branch": "ota/cabs/11.9.0", "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
```
- Path regex (`parsePinPath`): `^([0-9]+\.[0-9]+\.[0-9]+)/([a-z][a-z0-9-]*)\.json$`.
- `branch` must equal `ota/<unit>/<version>` (`branchFor`); `sha` is a full 40-char lowercase hex id (`validatePin`).
- `tools/ota-propose.mjs <unit> <version>` writes this file from the branch head and prints the `gh pr create` command (script only, not wired).
- A pin changes no user-visible state by itself: see [04-release-workflow](../architecture/04-release-workflow.md).

## 4. Environment variables

Found by grepping `packages/ scripts/ tools/ native/CMakeLists.txt examples/spike-app/scripts`.

| Variable | Read by | Meaning | Default |
|---|---|---|---|
| `OTA_UNITS_BUILD` | `with-ota-units.js`, set by `ota-build doctor` probe | `1` activates `withOtaUnits` without the splitter driving (used by the doctor probe; `build()` enables it itself). Unset: `react-native start`, Gradle and Xcode bundles are unaffected. | unset |
| `OTA_TOOLS_DIR` | `ota-build` `util.ts` | Cache dir for `hermesc-rn<RN>/` | `<repo>/.tools` |
| `OTA_WORK_DIR` | `ota-build` | Scratch dir (fetch, verify-repro, doctor --deep) | `<repo>/.work` |
| `OTA_HERMESC` | `ota-build` `tools.ts`, doctor | Path of the `hermesc` binary | `<tools dir>/hermesc-rn0.78.3/hermesc` |
| `OTA_HDIFFZ` (alias `OTA_HDIFFZ_TOOL`) | `ota-build` | `hdiffz_tool` binary | `<repo>/native/build-ota-tools/hdiffz_tool` |
| `OTA_APPLY` | `ota-build` | `ota_apply` binary | `<repo>/native/build-ota-tools/ota_apply` |
| `OTA_ROOT` | `scripts/env.sh` (exports) | Absolute repo root; used by all `scripts/*.sh` | derived |
| `OTA_ENV_QUIET` | `scripts/env.sh`, `lib/common.sh` | `1` suppresses the version printout | unset |
| `OTA_SUITE_TIMEOUT` | `scripts/test-all.sh` | Per-suite timeout, seconds | `1800` |

Precedence for the tool/work locations is **flag > env > default** (`pickPath` in `ota-build/src/util.ts`; test `ota-build/test/pins.test.ts`). `ota-build doctor` prints where each value came from.

Discrepancy: `scripts/test-all.sh:90` checks only `OTA_HDIFFZ_TOOL` for the hdiffz tool, while `ota-build` prefers `OTA_HDIFFZ`; set both (or the legacy one) when running `test-all.sh`.

`OTA_SPIKE` is a log tag in the spike app, not a variable. Other non-`OTA_` variables: `ANDROID_HOME`, `CC`, `CXX` (set in `scripts/env.sh`).

## 5. unit-splitter CLI flags

Entry point `node packages/unit-splitter/src/cli.js <build|cycle-baseline|api-snapshot> --project <dir> [flags]` (`cli.js`). Exit codes: 0 ok, 1 `VerificationError`, 2 usage.

| Flag | Commands | Default | Meaning |
|---|---|---|---|
| `--project <dir>` | all (required) | none | App project root (holds `units.config.json`) |
| `--out <dir>` | build | `<project>/dist` | Output dir (removed and recreated) |
| `--approach serializer\|postprocess` | build | `serializer` | (a) custom serializer, or (c) post-process split; byte-identical outputs |
| `--base <dist>` | build | none | **Patch mode**: compare against a base build (dist dir with `units.json`+`ids.json`) |
| `--bits <n>` | all | `48` | Module-id width; lower only to test collisions |
| `--platform ios\|android` | all | `ios` | Metro platform |
| `--entry <file>` | all | `units.config.json` `entry`, else `src/host/index.js` | Host entry |
| `--file <path>` | cycle-baseline | stdout | Write the baseline JSON here |
| `--write` | api-snapshot | false | Write snapshots to `checks.publicApiSnapshot[pkg]` paths (refuses opaque entries) |

Examples:
```
node packages/unit-splitter/src/cli.js build --project examples/demo-app --out examples/demo-app/dist
node packages/unit-splitter/src/cli.js build --project examples/demo-app --out /tmp/x --base examples/demo-app/dist
node packages/unit-splitter/src/cli.js cycle-baseline --project examples/spike-app --platform android --file cycles.baseline.json
node packages/unit-splitter/src/cli.js api-snapshot --project examples/two-package-app --write
```
(use `.work/` instead of `/tmp` in this repo's shared environment). In practice `ota-build bundle` wraps `build()` and adds the Hermes step ([02-build-and-patch-pipeline](../architecture/02-build-and-patch-pipeline.md)).

Output files: `host.js`, `units/<name>.js`, `ids.json`, `units.json` ([file-formats.md](file-formats.md)).
