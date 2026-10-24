# Writing a unit

**Purpose:** the conventions a unit's code must follow so it builds, loads and can be patched safely, and how to test it locally.
**Audience:** LoB engineers working inside a declared unit.
**Source of truth:** `packages/unit-splitter/src/{analyze,checks,public-api}.js`, tests `unit-splitter/test/{rules,checks,initializer,two-package}.test.js`, `examples/{demo-app,spike-app}/src/units/*`, [DESIGN.md 4, 5.6, 5.8, 5.9](../../DESIGN.md).

Prerequisite: your code is already under a unit root ([splitting-a-lob-into-a-unit](splitting-a-lob-into-a-unit.md)). Rule details: [rules-catalog](../reference/rules-catalog.md). Ownership model: [01-units-and-ownership](../architecture/01-units-and-ownership.md).

## 1. Conventions

| # | Convention | Why | Enforced by |
|---|---|---|---|
| 1 | The unit has exactly one **entry** module (declared in `units.config.json`). The host reaches the unit only through it. | encapsulation | `host-imports-non-entry` |
| 2 | The entry **registers the RN component named after the unit**: `AppRegistry.registerComponent('cabs', () => CabsRoot)` with a literal name. Native entry points mount that name. | `openUnit("cabs")` mounts surface `cabs` | `register-component` (opt-in via `checks.requireRegisterComponent`; on in `examples/spike-app`) |
| 3 | The entry exports what the host's `lazyUnit` needs (`Root` in spike-app, `default` in demo-app). The host helper and the export shape are per app; there is no shared `lazyUnit` package yet (**planned**). | `lazyUnit` resolves `m.Root`/`m.default` | by convention |
| 4 | **No import-time side effects that can throw or block**; keep module top levels declarative. Import-time code runs when the loader requires the entry, once per VM. A throw makes the load fail (the loader falls back or reports a require error), it does not crash, but the unit is then unusable in that VM. | VM pin, single evaluation | `initializer.test.js` documents the behavior; not a lint rule |
| 5 | No dynamic `require(x)`, `import(x)` or `require.context(...)`. Use string literals. | defeats every static rule | `dynamic-require` |
| 6 | Import host code only for names that already exist in the shipped binary's host modules. | a patch is built against the base host | `host-export-missing`, patch-mode `missing-in-base-host` |
| 7 | Do not import another unit. Share code by moving it to the host (outside every unit root) via the train. | no unit -> unit edges | `unit-to-unit` |
| 8 | No cycles inside the unit. | tier 2/1 | `cycle` (ratchet with `checks.cycleBaseline`) |
| 9 | Use packages that the host already ships at the **same version**. A new pure-JS package is bundled into your unit; a new native-backed package or `NativeModules` use that the binary does not register cannot ship OTA. | binary cannot gain native code | `package-version-mismatch`, `native-package` |
| 10 | Keep global state out. Assignments to `global`/`globalThis` hide cross-LoB coupling (Tier 3 lint, **not implemented**). | | none |
| 11 | Reach a host-owned public package only through its entry (two-package pattern). | | `public-deep-import` |

## 2. Assets (images)

An image is an ordinary module (`registerAsset(...)`) owned by the unit, but the **bytes are in no bundle**: they exist only in the binary (Android drawable name derived from the path, iOS bundle path). Therefore a patch may only reference assets that already exist in the base build. The verify rule for this (same path and hash as base) is **planned** ([DESIGN.md 5.9](../../DESIGN.md)); today nothing blocks you, and `units.json` merely lists `assets` per owner with sha256. Shipping new assets OTA is out of scope for v1. Practical rule: do not add or change images in a patch.

## 3. What a patch can and cannot change

| Change | OTA? |
|---|---|
| Logic, UI, copy, validations in the unit | yes |
| A new pure-JS dependency | yes (bundled into the unit; listed for review) |
| A different version of a library the host ships | no (train or host lane) |
| New or changed image assets | no (planned rule; see section 2) |
| Native code, new native modules | no |
| Data shape written into a host store read by other LoBs | no tool detects this; rely on tests and staged rollout |

Patch size note: bytecode diffs are 30-180x larger than source diffs, and a string-literal edit in host code cost 22-35 KB in the spike; units are cheaper ([spikes/summary](../spikes/summary.md)).

## 4. Test locally

All commands from the repo root, with the project installed (`npm install` in the project and in `packages/unit-splitter`):

```
# 0. readiness (no builds)
node packages/ota-build/src/cli.ts doctor --project examples/spike-app --platform android
# 1. split + rules (base mode): errors print as "[rule-id] message", exit 1
node packages/unit-splitter/src/cli.js build --project <your-app> --out .work/dist-base --platform android
# 2. make your change, then build in patch mode against the base build
node packages/unit-splitter/src/cli.js build --project <your-app> --out .work/dist-new --platform android --base .work/dist-base
```
Read the printed `check <rule>: severity=... findings=N` summary and `warning [...]` lines. For the full artifact path (Hermes, patch, round trip) use `ota-build` ([02-build-and-patch-pipeline](../architecture/02-build-and-patch-pipeline.md), [shipping-a-patch](shipping-a-patch.md)).

Run the real-RN example: `examples/spike-app` builds on both platforms in ~5-7 s each (JS_FINDINGS). For logic-level tests of the load path, `packages/unit-splitter/harness/harness.js` (`createRuntime({distDir, patchDir})`) is a Node `vm` stand-in for the app runtime with a simulated `__loadBundleAsync`; see `test/runtime.test.js` for usage. It is not Hermes: real bytecode behavior was only exercised on the Android spike ([spikes/summary](../spikes/summary.md)).

## 5. A minimal unit

```js
// src/units/cabs/entry.js
import { AppRegistry } from 'react-native';
import { CabsRoot } from './CabsRoot';
AppRegistry.registerComponent('cabs', () => CabsRoot);
export const Root = CabsRoot;            // what the host's lazyUnit('cabs', ...) reads
```
```js
// host side (src/host/SpikeHost.js style): the single sanctioned reach into the unit
const Cabs = lazyUnit('cabs', () => import('../units/cabs/entry'));
```
(from `examples/spike-app/src/units/cabs/entry.js` and `src/host/lazyUnit.js`.) The first argument of `lazyUnit` must equal the unit name that owns the imported entry (`lazyUnit-name-mismatch`).
