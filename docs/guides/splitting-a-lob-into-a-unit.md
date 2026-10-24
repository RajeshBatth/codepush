# Splitting a LoB into a unit

**Purpose:** step-by-step procedure to declare one LoB as a unit in an existing app and get the first passing base build.
**Audience:** a LoB or Common engineer doing the first split; for the whole-program plan see [adopting-in-your-monorepo](adopting-in-your-monorepo.md).
**Source of truth:** `packages/unit-splitter/{README.md,src/*}`, `packages/ota-build/src/doctor.ts`, `examples/{demo-app,spike-app,two-package-app}`, [DESIGN.md 4](../../DESIGN.md) (Tier 2 eligibility).

A LoB that cannot pass the base-build rules stays undeclared (inside the host, not patchable); declaring it is the opt-in. Rules: [rules-catalog](../reference/rules-catalog.md). Config: [config-reference](../reference/config-reference.md).

## Step 0. Preconditions

- RN 0.78 / Metro 0.81.x (0.87.x also accepted; the version gate in `metro-compat.js` refuses others). Hermes enabled.
- Node >= 24 for the repo tooling (`require()` of the ESM splitter in `metro.config.js` needs >= 22.12).
- `node_modules` must be a real directory, not a symlink (Metro's crawler does not follow it).
- Run the readiness check: `node packages/ota-build/src/cli.ts doctor --project <app> --platform android` (checks and fixes listed in `packages/ota-build/README.md`).

## Step 1. Choose roots and the entry

Pick the directory (or npm package name) that holds only this LoB's source. The entry is the single module the host will `import()`. If the LoB is an npm package linked into the monorepo, use its package name for `roots` and `entry` (a bare package name resolves to its `main`).

Checklist (Tier 2): roots disjoint from every other unit; nothing outside the roots is imported statically by host code from inside them except through the entry; LoB code does not import another LoB.

## Step 2. Write `units.config.json` at the app root

```json
{
  "entry": "index.js",
  "units": [
    { "name": "cabs", "roots": ["src/units/cabs"], "entry": "src/units/cabs/entry.js" }
  ],
  "checks": { "requireRegisterComponent": true }
}
```
Unit names: lowercase, digits, hyphen; not `host`. Start with every check at its default; relax only with a reason (section 5).

## Step 3. Wire Metro

```js
// metro.config.js
const {withOtaUnits} = require('<path>/packages/unit-splitter/src/with-ota-units.js');
module.exports = withOtaUnits(mergeConfig(getDefaultConfig(__dirname), {/* yours */}),
  { units: require('./units.config.json').units, projectRoot: __dirname });
```
It is inert in normal `react-native start`/Gradle/Xcode runs (activates only for the splitter or `OTA_UNITS_BUILD=1`). Add the `blockList` for `ios/Pods`, `ios/build`, `android/*/build`, `.gradle`, `.cxx` as in `examples/spike-app/metro.config.js`. `doctor` check `metro-config-wired` verifies this by loading the config in a child process.

## Step 4. Make the host reach the unit only through `lazyUnit`

Replace every static import of the LoB from host code with a single site:
```js
const Cabs = lazyUnit('cabs', () => import('../units/cabs/entry'));
```
`lazyUnit` is a small per-app helper (see `examples/demo-app/src/host/lazyUnit.js`, `examples/spike-app/src/host/lazyUnit.js`). Native entry points will `openUnit("cabs")` instead ([05-client-runtime](../architecture/05-client-runtime.md)); the JS site is the fallback and the way one unit opens another via the host.

## Step 5. First build and triage

```
node packages/unit-splitter/src/cli.js build --project <app> --out .work/dist --platform android
```
Typical first-run findings and what to do:

| Finding | Meaning | Action |
|---|---|---|
| `host-to-unit-static` | host (or a barrel) imports LoB code | route through the entry + `lazyUnit`; delete re-exports of LoB modules from host barrels |
| `unit-to-unit` | LoB imports another LoB | move the shared piece to the host, or leave the LoB undeclared |
| `cycle` | existing cycles | break them, or adopt incrementally: `cli.js cycle-baseline --project <app> --file cycles.baseline.json`, set `checks.cycleBaseline`, and ratchet |
| `dynamic-require` | `require(x)` etc. | literal specifiers |
| `host-imports-non-entry`, `lazyUnit-name-mismatch` | wrong import target or name | fix the `import()` or the first argument |
| `multiple-import-sites` (warn) | several `lazyUnit` sites | collapse to one |
| `host-export-missing` | LoB imports a name a host module does not export | use an existing export; or add the export to the host in the next train |

Common team's tuning: `error` -> `warn` per check in `units.config.json` for a transitional period; Metro's first-party `dynamic-require` rejection cannot be downgraded. Unit-level scope: package-owned units add `node_modules/<pkg>/...` keys; cycles inside bundled third-party packages count for the unit.

## Step 6. Confirm the output

`dist/` contains `host.js`, `units/cabs.js`, `ids.json`, `units.json`. Check `units.json`: `units.cabs.moduleIds` should list only LoB modules; `packages` lists npm packages seen; `paths` maps the entry module id to `"cabs"`. Schema and field meanings: [file-formats.md](../reference/file-formats.md).

## Step 7. Make it reproducible, then baseline

Run the determinism check twice (different path/TZ/LANG) before trusting patches:
```
node packages/ota-build/src/cli.ts verify-repro --project <app> --platform android
```
(requires `hermesc` from `fetch-tools`; see [02-build-and-patch-pipeline](../architecture/02-build-and-patch-pipeline.md)). Then the governance side: add the unit to the `ota-deployments` `units.json` (owner team, Jira keys) - [config-reference 2](../reference/config-reference.md); the automatic check that the two lists agree is **planned**.

## Step 8. Optional: two-package layout

If the LoB has code that must run before/outside the unit (init, shared state), do [two-package-pattern](two-package-pattern.md) instead of putting everything under the unit root.

## Done criteria

- `build` passes in base mode with the intended severities, on both platforms.
- Host contains no LoB module; unit contains no host module.
- `doctor` shows no FAIL.
- A one-line change in the unit, built with `--base`, differs only in `units/<name>.js` (`diffAgainstBase` in `src/diff.js`; the full flow is in [shipping-a-patch](shipping-a-patch.md)).
