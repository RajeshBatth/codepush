# Adopting this system in your monorepo

**Purpose:** A phased, numbered plan to take this code into a larger work project: what to run, what to wire, what to customise, what can go wrong, and what is explicitly NOT DONE YET.
**Audience:** The engineer/lead doing the adoption, and the AI assistant (Cursor) helping them.
**Source of truth:** [DESIGN.md](../../DESIGN.md) section 12 (roadmap) and 13 (open questions); `scripts/doctor.sh`, `packages/ota-build/src/doctor.ts`, `packages/unit-splitter/src/with-ota-units.js`, `packages/ota-cli/src/ports.ts`, `native/README.md`, `native/otacore/runtime/README.md`. Every command below is run from the repository root of THIS repo unless stated; paths to your app are written `<app>`.

Phases here are adoption phases (0-3). They correspond loosely to DESIGN.md's roadmap phases 0-2 but are ordered by what you can do with the code in this repo today. Each step names what you get at its end ("exit"). Do not skip a phase's exit: later phases assume it.

## What you are importing

| Piece | Copy as | Notes |
|---|---|---|
| `packages/ota-core`, `ota-cli`, `ota-build`, `unit-splitter`, `schemas/`, `tools/`, `scripts/` | a tooling directory/workspace in your repo (or a separate "ota-tooling" repo) | TypeScript run directly by Node >= 24 (type stripping); no build step. `ota-build` imports `unit-splitter` and `ota-core` by RELATIVE path, so keep the `packages/` layout |
| `native/otacore` + `native/otacore/runtime` + `native/third_party` | into your native build as a C++17 library (CMake) | `third_party` holds HDiffPatch and zstd sources |
| `examples/spike-app/{shared,android,ios}` | as a TEMPLATE only | spike quality; see [android-ios-integration](android-ios-integration.md) |
| `DESIGN.md`, `docs/` | keep next to the code | [docs/README.md](../README.md) |

## Phase 0: readiness (days)

Goal: prove the toolchain runs on your machines/CI and your app is a plausible candidate. No app changes.

1. Machine check (no network): `bash scripts/doctor.sh`. Fix every FAIL (Node >= 22.12, 24 preferred; cmake; `/usr/bin/clang++`). WARNs are for parts you may not need yet (Android SDK, Xcode). Known machine quirks: [troubleshooting](troubleshooting.md).
2. Install deps: `(cd packages/ota-core && npm install)`, same for `ota-cli` and `unit-splitter`.
3. Fetch/build external tools once: `bash scripts/fetch-tools.sh` (hermesc for RN 0.78.3, sha256-pinned, needs network) and `bash scripts/native-build.sh --tools` (`hdiffz_tool`, `ota_apply`).
4. Run this repo's own tests as a smoke test: `bash scripts/test-all.sh --fast` (suites SKIP with a reason when tools are missing).
5. Check your app: `node packages/ota-build/src/cli.ts doctor --project <app> --platform android` (and `ios`). Each FAIL prints a `fix:` line. Key requirements: RN 0.78.x (the hermesc pin is for 0.78.3; other versions need an entry in `packages/ota-build/src/pins.ts`), Metro 0.81.x or 0.87.x resolved from the project, Hermes enabled, `node_modules` a real directory, a `metro.config.js` you can wrap.
6. Decide the pilot LoB (DESIGN suggests Travelplex) and list its static imports from the rest of the app and any native modules it needs.

Exit: `doctor` shows no FAIL for the app; tools present. If your RN or Metro differs from 0.78/0.81, stop and run the Metro matrix (`sh packages/unit-splitter/scripts/metro-matrix.sh <version>`) and the spike ([spikes/summary.md](../spikes/summary.md)) first: the loader relies on RN-internal surface ([ADR-0008](../architecture/decisions/README.md)).

## Phase 1: split, build, reproduce (weeks)

Goal: the app builds `host` + one pilot unit deterministically, and a one-line change produces a tiny verified patch. Still no servers, no native SDK.

1. Wire Metro: wrap the app's `metro.config.js` with `withOtaUnits` (`packages/unit-splitter/src/with-ota-units.js`), pattern in `examples/spike-app/metro.config.js`. It is inert in normal `react-native start` and Gradle/Xcode bundling (active only when the splitter/`ota-build` runs, `OTA_UNITS_BUILD=1`). Add the `blockList` for `ios/Pods`, `ios/build`, `android/*/build`, `.gradle`, `.cxx`.
2. Write `<app>/units.config.json` for the pilot LoB: [splitting-a-lob-into-a-unit](splitting-a-lob-into-a-unit.md), keys in [config-reference](../reference/config-reference.md). If the LoB needs always-on code, use [two-package-pattern](two-package-pattern.md).
3. First split and triage: `node packages/unit-splitter/src/cli.js build --project <app> --out .work/dist --platform android`. Fix findings using [rules-catalog](../reference/rules-catalog.md). Adopt cycles incrementally with `cli.js cycle-baseline`. Replace static host imports of the LoB with one `lazyUnit` site.
4. Public package snapshot (two-package only): `node packages/unit-splitter/src/cli.js api-snapshot --project <app> --write`, commit the file, set `checks.publicApiSnapshot`.
5. Real bundles: `node packages/ota-build/src/cli.ts bundle --project <app> --platform android --out .work/base-android --app-version <v> --source-sha <sha>` (and `ios`). Inspect `build.json`.
6. Reproducibility (gates everything after): `node packages/ota-build/src/cli.ts verify-repro --project <app> --platform android`; then on a real release tag across fresh clones: `python3 tools/repro_check.py --repo <monorepo> --rev <release tag> --build-cmd "..." --out-dir <rel dir>` (flags in [cli-reference](../reference/cli-reference.md)). If bytes differ, find the nondeterminism (absolute paths, timestamps, env) before going further ([02-build-and-patch-pipeline](../architecture/02-build-and-patch-pipeline.md)).
7. Baseline cycles: build the base for every live app version (latest 3 release lines) from its release tag; keep the output dirs, they are the `--base-build` inputs of patch builds. Compare with the hashes of the bundles extracted from the SHIPPED APK/IPA (this extraction is manual; the base release job is not written).
8. First patch locally: edit one unit file in a copy, `bundle ... --base-build <base dir>`, then `patch --base <base> --new <new> --out <dir>`. Read `patch-report.json`: expect `changedUnits: ["<unit>"]`, `hostChanged: false`, sizes in tens of KB at most ([spikes/summary.md](../spikes/summary.md) for reference numbers).
9. Measure and decide size limits (DESIGN open question 2): patch sizes on real branch divergence for your units, ratio against `zstdSize`.

Exit: deterministic builds on 3 live versions; a unit patch that changes only the unit artifact; Tier 1/2 findings for the pilot LoB at zero; size numbers for your code.

## Phase 2: pipeline and native SDK (months)

Goal: one pilot unit ships to production behind a ramp with a halt drill.

### 2a. Release pipeline (replace the local adapters)

1. Create the `ota-deployments` repo: governance `units.json` (schema `schemas/ota-units-governance.schema.json`, example `schemas/fixtures/`), CODEOWNERS generated from it, `<version>/<unit>.json` pin files ([file-formats](../reference/file-formats.md)). Wire `tools/ota-propose.mjs` for developers ([shipping-a-patch](shipping-a-patch.md)).
2. Implement the four ports for your infrastructure ([ports-and-adapters](../reference/ports-and-adapters.md)): artifact store (immutable, create-if-absent, lease lock), CDN (patches, then signature, then manifest last, plus cache purge), signer (KMS Ed25519, detached, no framing), team directory (GitHub teams from SSO). Certify each with the conformance suites in `packages/ota-cli/test/conformance/`.
3. Write the Jenkins jobs around the existing entry points `initVersion`, `runCommand`, `reconcile`, `verifyStore` in `packages/ota-cli/src/job.ts`:
   - verify job: gather facts (commit count, changed files, git ancestry, branch protection, `ota-build bundle` + `patch` output) and call `verifyPinPr` (`packages/ota-core/src/verify.ts`); post a commit status and the report.
   - deploy job: on an approved Jira ticket, rebuild, require hashes equal to the verify report (**not in the code**), then `runCommand`; token-callable halt.
   - reconcile job on a schedule; base release job (writes `base.json` from the SHIPPED APK/IPA, runs the reproducibility gate, sets `retired` when a line leaves the window).
4. Webhook for PR comments (`ota-deploy`, `ota-rollout <p> [android|ios]`) and Jira ticket creation/approval. Re-check approver in the owner team and not the requester (the rule is `authorize` in `packages/ota-core/src/authz.ts`; the API calls are yours).
5. Set artifact-store retention exemption for `ota-state`, `ota-base` and referenced `ota-patches` (DESIGN 7.1).
6. Dry run end to end with a throwaway unit and a halt drill.

### 2b. Native SDK

1. Build `native/otacore` and `native/otacore/runtime` into your app (CMake; options `OTACORE_ZSTD`, `OTACORE_LZMA`, `OTACORE_ZSTD_SMALL` in [native/README.md](../../native/README.md)). Measure size ([DESIGN.md 5.7](../../DESIGN.md): about 57-67 KB arm64 for the patch side; the nlohmann/json parser adds about 91 KB, a purpose-built parser is advised).
2. Implement the platform interfaces ([native-api](../reference/native-api.md)): Clock, Scheduler, Worker, Http, FileSystem (with mmap), Store (durable writes), SignatureVerifier (Ed25519: CryptoKit / `java.security`), EmbeddedAssets, PatchBuilder (wrap `otacore::applyPatch`), VmController, Observer. None exists in this repo beyond the in-memory simulation.
3. Use `examples/spike-app/{shared,android,ios}` as the template for the JSI evaluate step, `NativeOtaUnits`, mmap and pre-checks. Note the spike glue does not drive `otaruntime::Runtime`; you must integrate the two ([android-ios-integration](android-ios-integration.md)).
4. Host bundle: add the SDK pre-module that defines `__loadBundleAsync` and `__otaRequire`; ship a `lazyUnit` runtime package; declare the entry-point table (unit to surface name) and feed `setEntryPointPriority`.
5. Boot from a patched host: Android needs a dynamic `JSBundleLoader` (not `DefaultReactHost.getDefaultReactHost`); iOS `bundleURL`. Cold-process patched-host boot is unproven.
6. Embed the public key(s); ship embedded `.hbc` as uncompressed assets (Android `noCompress`).
7. Re-run the spike scenarios (S1-S10) on your RN version, release build and a physical low-end device; run iOS for the first time.

Exit: a pilot unit patch reaches a real device through your CDN, is confirmed with `markReady`, halted with `ota-rollout 0`, and a restore is rehearsed ([incident-runbook](incident-runbook.md)).

## Phase 3: scale-out (ongoing)

1. Onboard compliant LoBs one by one with [splitting-a-lob-into-a-unit](splitting-a-lob-into-a-unit.md); non-compliant LoBs stay in the host.
2. Expose attribution for LoB analytics (`getActivePatch(unit)`, lifecycle callbacks): **planned**; today `Runtime::pinOf` and `Observer` events are the raw data.
3. Host lane (Common-owned, super-admin approval, export-surface rule): designed, **not implemented** ([DESIGN.md 7.4](../../DESIGN.md)).
4. Backport helper, dot-release patch reuse, Jira polish, `enforceJira` on.
5. Tighten checks per LoB over time (cycle ratchet, `publicApiStrict`).

## What to customise

| Area | Customise | Where |
|---|---|---|
| Infrastructure | store, CDN, signer, team directory adapters; Jenkins wrappers | `packages/ota-cli/src/ports.ts`, `adapters/` |
| Governance | `units.json` (owner team, Jira keys, limits), super-admin team, `enforceJira`, acceptable statuses | [config-reference](../reference/config-reference.md) |
| Toolchain | RN/hermesc pin table, tool/work dirs (`OTA_TOOLS_DIR`, `OTA_WORK_DIR`, `OTA_HERMESC`, `OTA_HDIFFZ`, `OTA_APPLY`) | `packages/ota-build/src/pins.ts` |
| Build config | `units.config.json`, `checks`, `metroConfig`, `entry` | splitter |
| Runtime tuning | `unitBudgetMs`, `hostSettleMs`, `crashLimitK`, cellular cap, bucket key | `native/otacore/runtime/include/otaruntime/runtime.h` `Config` |
| Naming | the branch pattern `ota/<unit>/<version>` is hardcoded in `ota-core` (`pin.ts` `branchFor`); the patch id `<unit>-pr<N>` is built from `--unit` and `--pr` by `ota-cli` | `pin.ts`, `ota-cli/src/cli.ts` |

## Risk register

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | Builds are not byte-reproducible in your CI image | medium / blocks "one unit differs" | Phase 1 step 6 before anything else; pin the image digest |
| R2 | Your RN, Metro or architecture mode differs from the spike | medium / loader rework | Phase 0 stop rule; re-run S1-S10; `docs/research/rn-0.78-loader.md` |
| R3 | Loader depends on RN internals (JSI `invokeAsync`, undeclared iOS selectors, `@FrameworkAPI`) | high on every RN upgrade | Keep an RN-upgrade checklist: re-run the spike scenarios, `metro-matrix.sh` |
| R4 | LoB code fails Tier 2 (cycles, cross-LoB imports) | high / slows onboarding | Cycle baseline ratchet; undeclared LoBs stay in host |
| R5 | Host string edits make large patches (22-35 KB on the spike host) | medium | Size limits sized for host; keep host lane for later |
| R6 | Asset and native-module checks are conservative v1 rules: assets must already be in the binary; native modules must already be referenced by the base JS (indirect uses are invisible) | low-medium / broken screens | Rules implemented (`asset-not-in-base`, `asset-path-changed`, `native-module-new`); keep reviewing PRs that touch native bridge usage; a native-side inventory (`contractHash`) is planned ([ADR-0012](../architecture/decisions/README.md)) |
| R7 | Artifact store lacks create-if-absent or retention exemption | medium / state loss | Conformance suite; DESIGN open question 9 |
| R8 | Halt does not fix VMs that already loaded the patch | certain / user-visible | crash-loop guard, small first ramp, expectations in [incident-runbook](incident-runbook.md) |
| R9 | `ota-cli` trusts `--requester/--approver` flags | certain in emulator | the real job must call GitHub/Jira APIs |
| R10 | Linux/Windows hermesc pins were hashed but never executed | medium on CI | first `fetch-tools` on the CI OS runs `-version`; see `packages/ota-build/README.md` |
| R11 | Native signature verification is unwritten | certain / security gate | implement and test against `vectors` and `signManifest` output before any production manifest |
| R12 | iOS has never run | certain | Phase 2b step 7 |

## NOT DONE YET

| Item | Status | Reference |
|---|---|---|
| Native SDK extraction into a reusable Android library and iOS pod | not started; only spike glue exists, and it does not call `otaruntime::Runtime` | [05-client-runtime](../architecture/05-client-runtime.md), [native README](../../native/README.md) |
| Real Jenkins jobs (verify, deploy, reconcile, base release) | not started | [04-release-workflow](../architecture/04-release-workflow.md) |
| Jira integration (tickets, approval, `enforceJira` is off by default) | not started | `verify.ts` |
| Rebuild-and-compare at deploy; stale-pin refusal; toolchain-image build in verify | not in code | [06](../architecture/06-safety-and-failure-modes.md) |
| Asset rule | implemented (patch mode) | [ADR-0012](../architecture/decisions/README.md) |
| `NativeModules`/TurboModule scan, `baseHash` rule in splitter, Tier 3 size budget and `global` lint, Tier 2 rule 9 cross-check of config vs governance | planned | [rules-catalog A4](../reference/rules-catalog.md) |
| iOS device/simulator run | compiled only | [spikes/summary.md](../spikes/summary.md) |
| Eager units / `preloadUnit` | planned, deliberately not v1 | DESIGN 4.1 |
| Real S3/CDN/KMS/GitHub adapters | ports and local adapters only | [ports-and-adapters](../reference/ports-and-adapters.md) |
| Native Ed25519 verification, key rotation, KMS signature on `audit.json` | not done | [ADR-0004](../architecture/decisions/README.md) |
| `lazyUnit` runtime package, attribution API (`getActivePatch`, callbacks), entry-point table | not done | glossary |
| Host lane (host patches in production) | designed | DESIGN 7.4 |
| Release builds and physical devices for the loader | unproven | [spikes/summary.md](../spikes/summary.md) |

## Using Cursor/AI assistants on the adopted code

Point the assistant at [docs/README.md](../README.md) (reading path "AI assistant"), [glossary](../glossary.md) and the rule that code wins over docs. Safety-relevant files (`select.ts`, `ladder.ts`, `authz.ts`, `job.ts`, `runtime.cpp`, `checks.js`) have conformance vectors or scenario tests: require the matching test to pass and update [06](../architecture/06-safety-and-failure-modes.md) when behaviour changes.
