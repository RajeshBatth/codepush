# Glossary

**Purpose:** One-line definitions of every term used in the code and docs, with where it lives. Use these exact words in new docs, code comments and prompts.
**Audience:** Everyone; AI assistants should treat this as the canonical vocabulary.
**Source of truth:** [DESIGN.md](../DESIGN.md) (terminology in sections 4, 5, 6, 7), `packages/ota-core/src/types.ts`, `packages/unit-splitter/src/*`, `native/otacore/**`, `examples/spike-app/**`. Sorted by theme, then alphabetically inside each table.

Two files are both called `units.json` and are unrelated: the **governance** file in the `ota-deployments` repo (owners, Jira keys, limits) and the **splitter output** `units.json` next to `host.js` (module ownership and hashes). Always say which.

## Units and ownership

| Term | Definition | Where |
|---|---|---|
| **unit** | Independently patchable piece of the app: one per declared LoB, plus the special unit `host`. Hermes bytecode, one artifact per platform | [DESIGN.md 4](../DESIGN.md); `units.config.json`; [01-units-and-ownership](architecture/01-units-and-ownership.md) |
| **host** | Everything that is not a unit: React, RN, navigation, design system, shared stores, all third-party packages, the bridge. Also a unit name (`host`, constant `HOST_UNIT`) with its own pin file and stricter ownership | `packages/ota-core/src/state.ts` (`HOST_UNIT`) |
| **mainBundle** | The manifest's name for the host bundle (loaded before JS runs, so cannot be lazy). Manifest field `mainBundle {baseHash, entries[]}` | `packages/ota-core/src/types.ts` (`MainBundle`) |
| **ownership root** (`roots`) | A directory or package name listed under a unit in `units.config.json`. A module belongs to a unit iff its (realpath'd) path is under one of the roots; otherwise to the host. Ownership is by path/package, not reachability | `packages/unit-splitter/src/config.js` |
| **entry** (unit entry) | The single module of a unit that the host may import (via `import()`); `units[].entry` in `units.config.json`. Must register the RN component named after the unit. Not to be confused with the project-level `entry` (host entry, default `src/host/index.js`) | `config.js`, `analyze.js` |
| **entry point** | A native screen/button that opens an RN surface for a unit (`openUnit("cabs")`). The static table of entry points for prefetch is planned (`setEntryPointPriority` exists) | `native/otacore/runtime/include/otaruntime/runtime.h` |
| **direction rule** | Allowed edges: unit to own modules, unit to host, host to unit only through an async `import()` of the entry. Never unit to unit, never static host to unit | [DESIGN.md 4](../DESIGN.md); `analyze.js`, `checks.js` |
| **encapsulation** | The part of the direction rule that says a unit module may be imported from outside only by the host, via plain `import()`, only the entry | rules `host-imports-non-entry`, `host-to-unit-static`; [rules-catalog](reference/rules-catalog.md) |
| **lazyUnit** | Host-side `React.lazy`-style wrapper `lazyUnit('cabs', () => import('@acme/cabs/entry'))` with loader/error UI; name must match the unit owning the imported entry (rule `lazyUnit-name-mismatch`). Exists as example code only; a reusable runtime package is **planned** | `examples/demo-app/src/host/lazyUnit.js`, `examples/spike-app/src/host/lazyUnit.js` |
| **public package / private package** | Two-package pattern: the public package is host-owned (in the binary, additive-only API); the private package is the unit (patchable). The only static dependency from public to private is the shell's `lazyUnit` `import()` | [DESIGN.md 4.1](../DESIGN.md); [two-package-pattern](guides/two-package-pattern.md) |
| **shell** | The thin UI in the public package that `import()`s the unit and shows loading/error/retry; no business logic | [two-package-pattern](guides/two-package-pattern.md) |
| **initializer (`init()`)** | Idempotent, never-throwing, non-blocking function in the public package, called once per VM at host boot (ws-init, fetch-config) | `packages/unit-splitter/test/initializer.test.js`, `two-package.test.js` |
| **public API snapshot** | `checks.publicApiSnapshot`: sorted runtime export names of a public package entry; removal fails, addition warns | `packages/unit-splitter/src/public-api.js`; `cli.js api-snapshot` |
| **Tier 1 / 2 / 3** | Rule tiers. Tier 1 patch safety (every verify and deploy build, hard fail, no waiver); Tier 2 unit eligibility (base build, hard fail); Tier 3 hygiene (warn, may ratchet) | [DESIGN.md 4](../DESIGN.md); [rules-catalog](reference/rules-catalog.md) |
| **ratchet** | Policy for cycles: base build fails on any cycle not in `checks.cycleBaseline`; patch build fails only on cycles new vs the base build's recorded `cycles` | `checks.js`; `cli.js cycle-baseline` |
| **quarantine** | Not a term in this system. An earlier idea of quarantining LoBs was dropped: a LoB that fails Tier 2 simply stays undeclared (in the host). No code or doc defines it | (searched: no occurrence in code) |

## Build and artifacts

| Term | Definition | Where |
|---|---|---|
| **base** (embedded base) | The bundles shipped inside a given app version's binary; the "old" input of every patch. Identified by release tag and the hashes in `base.json` | `BaseInfo` in `types.ts`; `ota-base/<version>/base.json` |
| **`base.json`** | Written by the base release job: per platform hashes of host and each unit, `hbc {bytecodeVersion, hermescSha256}`, zstd sizes, `retired` flag | [file-formats](reference/file-formats.md) |
| **baseHash** | sha256 of the embedded unit (or host) a patch applies to; the client ignores a patch whose `baseHash` differs from the embedded bytes | manifest `units[].baseHash`, `mainBundle.baseHash` |
| **built hash** | sha256 of the result of applying the patch to the embedded unit (manifest entry field `hash`). Verified on device; must be reproducible, patch bytes need not be | `Entry.hash` in `types.ts` |
| **patch** | One update for a unit or the host: listed in the manifest, rolled out by percentage, can be halted. It consists of a **diff file** (HDiffPatch "single compressed diff", zstd, `patchAlgoVer` `v1`, from the embedded bundle to the new one) that the device turns into a **built bundle** | `packages/ota-build/src/patch.ts`, manifest `entries[]` |
| **diff file** | The small downloaded file of a patch; applying it to the embedded bundle yields the built bundle | `native/otacore/src/patch.cpp` |
| **built bundle** / built file | The bytecode a device actually runs for a patch: the diff applied to the embedded bundle, sha256-verified against the manifest `hash` | `Cache::builtPath` |
| **`PatchState`** | The on-device progress record of one patch (queued, downloading, building, ready, failed, bad). Not a build or CI artifact | `runtime_impl.h` |
| **manifest entry** | One patch as listed in the signed manifest (`otacore::Entry`). Not the same as a unit's "entry module" | `otacore.h` |
| **`full` update** (`updateType: "full"`) | Same diff format computed against an EMPTY old file (whole replacement), emitted when `patchSize > 0.6 x zstdSize(new)`; same apply code on device | `patch.ts` (`fullThreshold`), `types.ts` (`UpdateType`) |
| **`patchAlgoVer`** | Manifest string naming the diff algorithm and parameters (`v1`); changing any parameter needs a new value and a new binary | `patch.ts` |
| **`build.json`** | Output of `ota-build bundle` per platform: toolchain, hashes and sizes of `host.hbc` and `units/*.hbc`, `entryModuleId` | [file-formats](reference/file-formats.md) |
| **`patch-report.json`** | Output of `ota-build patch`: `hostChanged`, `changedUnits`, items with sizes, built hashes, `ratioOfZstdFull` | `packages/ota-build/src/patch.ts` |
| **`units.json` (splitter output)** | Per build: module ownership, hashes, assets, `cycles`, `publicApi`. Not the governance file | `packages/unit-splitter/src/build.js` |
| **`ids.json`** | Module id map (path key to id) of a build; the "base module-ID map" patches are built against | `packages/unit-splitter/src/ids.js` |
| **module id** | 48-bit hash (12 hex chars, still an exact JS number) of the project-relative path, with collision check; makes ids identical between base and patch | `ids.js` (`hashId`, `createIdFactory`) |
| **`entryModuleId`** | Module id of a unit's entry, recorded in `build.json`; passed as a `double` to the native loader | `build.json`; DESIGN 5.9 |
| **`paths` / `__loadBundleAsync`** | Metro's `import()` compiles to `asyncRequire(id, paths)`; the splitter emits `paths[entryId] = "<unit>"` and the host defines `global.__loadBundleAsync = (unit) => NativeOtaUnits.load(unit)` | `split.js`, `metro-compat.js`; `examples/spike-app/src/host/loader.js` |
| **`__otaRequire`** | Host-provided function (SDK pre-module) that runs a unit entry by id with `ErrorUtils` hidden, so a throwing module factory surfaces as a load error instead of a fatal crash. Metro's `__r` must NOT be used | `examples/spike-app/src/host/loader.js:21`; [ADR-0009](architecture/decisions/README.md) |
| **hermesc recipe** | `hermesc -O -emit-binary -g0 -out out.hbc bundle.js` with a fixed relative file name, compiler pinned by sha256 | `packages/ota-build/src/bundle.ts`, `pins.ts` |
| **HBC** | Hermes bytecode; version 96 for RN 0.78.3. Magic `c6 1f bc 03 c1 03 19 1f` | `packages/ota-build/src/hbc.ts` |
| **round trip** | Mandatory check in `patch`: apply the new patch with the app's own C++ (`ota_apply` = `otacore::applyPatch`) and require the built hash | `packages/ota-build/src/patch.ts` |
| **approach (a) / (c)** | Splitter strategies: (a) custom Metro serializer emitting several files (default); (c) post-process the stock bundle at `__d` statements (validated fallback, byte-identical) | `split.js`; `test/determinism.test.js` |
| **reproducibility** | Same source plus pinned toolchain gives byte-identical built hashes; gate is `verify-repro` / `tools/repro_check.py` | [02-build-and-patch-pipeline](architecture/02-build-and-patch-pipeline.md) |

## Manifest, rollout and state

| Term | Definition | Where |
|---|---|---|
| **manifest** | The one served file per `(platform, appVersion)`: `{schema, platform, appVersion, patchAlgoVer, version, ttlSec, mainBundle, units[]}` in canonical JSON | `types.ts` (`Manifest`), `manifest.ts` |
| **entry (manifest entry)** | One patch offer: `{id, patchUrl, hash, size, updateType, range?, requiresHost?}`. Different from "unit entry" above | `types.ts` (`Entry`) |
| **patch id** | `<unit>-pr<N>`, N = the `ota-deployments` PR number; same for both platforms. A label; the hash guarantees integrity | `Entry.id` |
| **bucket** | Stable per-device, per-unit value in [0,1): `uint32_be(sha256(deviceId \n unitName)[0..4]) / 2^32`. Computed on device | `packages/ota-core/src/bucket.ts`; `native/otacore/src/` ; `vectors/bucket.json` |
| **range** | Half-open `[start,end)` over the bucket; absent means 100%. Ranges of one unit's entries are disjoint; unassigned range means embedded | `ranges.ts`, `manifest.ts` (`validateManifest`) |
| **ladder** | Ordering of a unit's entries newest-first: `[0,x) newest | [x,y) previous | [y,1) embedded`. Ramping the newest takes buckets from the previous; users only move forward | `packages/ota-core/src/ladder.ts` |
| **ramp / rollout** | Setting the newest patch's range to `[0, percent/100)`; only the latest patch of a unit can be ramped | `ladder.ts` (`setPercent`), `state.ts` (`applyRollout`) |
| **halt** | `ota-rollout 0`: removes the entry (users return to what they had). No approval needed. Takes effect after `ttlSec` and the next sync; does not fix a VM that already loaded the patch | `ladder.ts` (`halt`), `state.ts` (`applyHalt`); [incident-runbook](guides/incident-runbook.md) |
| **restore** | Publishes the content of an earlier state version K as a NEW version N+1 (`version` stays monotonic) | `state.ts` (`applyRestore`) |
| **break-glass** | Super-admin runs the deploy job manually, bypassing Jira/GitHub; flagged `breakGlass: true` in `audit.json` | `authz.ts`, `AuditRecord` |
| **state / state version** | The deployable state: immutable `ota-state/<version>/vN/{android,ios}/manifest.json(+.sig), audit.json`. Never overwritten | `packages/ota-core/src/state.ts`; `ota-cli` store adapter |
| **pin** | Human-authored, reviewed file `<version>/<unit>.json` in `ota-deployments`: `{branch, sha}` = which commit we intend to ship | `packages/ota-core/src/pin.ts` |
| **pin vs state** | Pin = intent (git, human). State = what is published and at what percentage (artifact store, machine-written). `ota-rollout 10` changes no git file | [DESIGN.md 7.1](../DESIGN.md) |
| **audit chain** | `audit.json` per state version holds requester, approver, ticket, PR, source SHA, job URL and `prevAuditHash` (hash of the previous record) | `audit.ts` |
| **detached signature** | `manifest.json.sig` = base64 Ed25519 over the exact served bytes; devices verify bytes then parse | `manifest.ts` (`signManifest`, `verifyManifestBytes`) |
| **anti-replay** | Device rejects a manifest whose `version` is lower than the highest ever seen (persisted before adoption); `platform`/`appVersion` are inside the signed bytes | `native/otacore/runtime` (`highestManifestVersion`) |
| **`ttlSec`** | How long clients may cache the manifest before a conditional GET; bounds halt latency | manifest |
| **`requiresHost`** | Optional entry field for coupled releases: usable only if the VM booted with that host entry id | `select.ts` |
| **live version** | App version whose `base.json` exists and whose release line is among the latest 3 (`major.minor`); `retired` versions accept only halt | [04-release-workflow](architecture/04-release-workflow.md) |
| **dot release** | e.g. 11.9.1: treated as its own app version with its own directory, manifest and embedded bundle | [DESIGN.md 7.5](../DESIGN.md) |
| **owner team / super-admin team** | GitHub team that approves a unit's commands; the `host` unit and break-glass need the super-admin team | `authz.ts`, governance `units.json` |
| **one-unit rule** | A unit PR may change exactly its own unit's artifact; host and other units must be byte-identical to base (verify check `only-one-unit`) | `verify.ts` |
| **soft / hard limit** | Patch size limits: soft warns on the PR, hard fails verify; bytes and/or ratio of zstd base size; global defaults plus per-unit overrides | `units.ts` (`evaluateSize`) |

## Client runtime

| Term | Definition | Where |
|---|---|---|
| **otacore** | Portable C++17 library (+ C API): sha256, bucket, selection, manifest parse/validate, atomic hash-verified patch apply, cache GC | `native/otacore/` |
| **orchestrator / `otaruntime`** | The C++ runtime that implements the loader state machine against injected interfaces (Clock, Scheduler, Worker, Http, FileSystem, Store, SignatureVerifier, EmbeddedAssets, PatchBuilder, VmController, Observer) | `native/otacore/runtime/`; [native-api](reference/native-api.md) |
| **ota queue** | The single serial queue on which all OTA decisions run | DESIGN 5.8 |
| **VM** | One Hermes runtime instance (bridgeless `ReactHost` / `RCTHost`). Units evaluate once per VM | [05-client-runtime](architecture/05-client-runtime.md) |
| **per-VM pin** | A unit's choice (embedded or patch id) is fixed for the VM's lifetime because Metro's `define()` ignores a second definition of a loaded module id | DESIGN 5.2; runtime test `mixed_snapshots_per_unit_pin` |
| **embedded fallback** | The bundle shipped in the binary; used on any failure | everywhere |
| **pre-evaluate checks** | Before evaluating bytes: path under cache root, size, sha256, 4-byte alignment, Hermes magic, bytecode version; evaluate inside try/catch | `native/otacore/runtime/include/otaruntime/hermes.h` |
| **`markReady`** | JS-to-native call after first healthy render; confirms a patch (and the booted host patch) and clears attempt counters | `runtime.h` |
| **crash-loop guard** | Persisted per-patch attempt counter bumped once per process; K unconfirmed processes blacklist the patch | `runtime.h`; scenario `crash_loop_unit_blacklists_after_k_attempts` |
| **host swap / recreate** | Destroying the VM and creating one from a newly built host patch, only when no JS views are mounted and no unit load is in flight | scenarios `host_patch_*` |
| **`unitBudgetMs` / `hostSettleMs`** | Max wait for an in-flight patch at tap time (default 1000 ms) / max wait before VM prewarm for a host patch (default 800 ms) | `runtime.h` `Config` |
| **`hostBucketKey`** | String hashed with `deviceId` to bucket the host (default `"mainBundle"`) | `runtime.h` |
| **deviceId** | Random install-scoped UUID in app-private storage; never leaves the device | DESIGN 5.8 |
| **NativeOtaUnits** | The JS-visible native module whose `load(name)` backs `__loadBundleAsync` (spike: legacy `ReactContextBaseJavaModule`) | `examples/spike-app/android/`, `ios/` |
| **eager unit / `preloadUnit`** | Unit evaluated at VM boot and consumed through a registry; **planned**, deliberately not in v1 | DESIGN 4.1 |
| **asset rule** | Every asset module of a patched unit must exist in the base build with the same path and hash; **planned** (not implemented) | DESIGN 5.9, 4 |

## Process and tooling

| Term | Definition | Where |
|---|---|---|
| **`ota-deployments`** | Separate repo holding pin files, governance `units.json`, CODEOWNERS | DESIGN 7.1 |
| **`ota/<unit>/<version>`** | Monorepo branch for patches of one unit and one app version, cut from the release tag | `pin.ts` (`branchFor`) |
| **`ota-deploy` / `ota-rollout`** | PR-comment commands: deploy a merged pin at 0%; set a percentage (0 = halt). Today emulated by `ota-cli deploy` / `rollout` / `halt` | [04-release-workflow](architecture/04-release-workflow.md) |
| **deploy job** | The single job that applies every state change under a per-version lock; only holder of signing key and CDN write | `packages/ota-cli/src/job.ts` |
| **reconcile** | Redeploys the latest state to the CDN if it lags; detects CDN ahead of state | `job.ts`; [incident-runbook](guides/incident-runbook.md) |
| **port / adapter** | `ArtifactStorePort`, `CdnPort`, `SignerPort`, `TeamDirectoryPort` and their implementations; certified by conformance suites | [ports-and-adapters](reference/ports-and-adapters.md) |
| **spike (S1-S10)** | The Android device test runner in `examples/spike-app`; ten scenarios, all pass on an emulator | [spikes/summary.md](spikes/summary.md) |
| **doctor** | Readiness checks: `ota-build doctor` (project) and `scripts/doctor.sh` (machine) | [cli-reference](reference/cli-reference.md) |
| **LoB** | Line of business (Bus, Rails, Cabs, Holidays, Travelplex/Chatbot) | DESIGN 1 |
| **train** | The monthly release cycle; patches never land on the `release` branch | DESIGN 1, 7.0 |
