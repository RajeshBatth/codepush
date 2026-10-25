# File formats

**Purpose:** One section per JSON file the OTA tooling reads or writes: who produces it, who consumes it, a minimal example, and the matching JSON Schema.
**Audience:** Engineers writing adapters, CI jobs or native parsers; AI assistants checking a field name before using it.
**Source of truth:** [`schemas/*.json`](../../schemas/) and [`schemas/README.md`](../../schemas/README.md); types in [`packages/ota-core/src/types.ts`](../../packages/ota-core/src/types.ts); validators in [`manifest.ts`](../../packages/ota-core/src/manifest.ts), [`state.ts`](../../packages/ota-core/src/state.ts), [`audit.ts`](../../packages/ota-core/src/audit.ts), [`pin.ts`](../../packages/ota-core/src/pin.ts), [`units.ts`](../../packages/ota-core/src/units.ts); real examples in [`schemas/fixtures/`](../../schemas/fixtures/) (generated from the demo app by `scripts/gen-schema-fixtures.mjs`). Rationale: [DESIGN.md](../../DESIGN.md) sections 6, 7.1, 7.8.

All hashes are the string `sha256:` followed by 64 lowercase hex characters. A schema cannot express cross-field invariants; those are enforced in code and listed per section ("Enforced in code"). Schemas are checked against the fixtures and the TypeScript types by `packages/ota-core/test/schemas.test.ts`.

## Map

| Format | File | Written by | Read by | Schema |
|---|---|---|---|---|
| [manifest](#manifest) | `<cdn>/<platform>/<appVersion>/manifest.json` (+ `.sig`) | ota-cli job | native SDK, `ota-cli verify` | `manifest.schema.json` |
| [base](#base-basejson) | `ota-base/<appVersion>/base.json` | `ota-build base-info` -> `ota-cli init` | ota-cli, verify (size limits) | `base.schema.json` |
| [build](#build-buildjson) | `<build dir>/build.json` | `ota-build bundle` | `ota-build patch/base-info` | `build.schema.json` |
| [patch-report](#patch-report-patch-reportjson) | `<patch dir>/patch-report.json` | `ota-build patch` | `ota-build deploy-args`, verify | `patch-report.schema.json` |
| [units.output](#splitter-output-unitsjson-in-the-build-dir) | `<out>/units.json` | unit-splitter | ota-build, next patch build | `units.output.schema.json` |
| [audit](#audit-auditjson) | `ota-state/<v>/v<N>/audit.json` | ota-cli job | `ota-cli verify` | `audit.schema.json` |
| [state layout](#state-layout) | `ota-state/<v>/v<N>/...` | ota-cli job | ota-cli | (directory) |
| [pin](#pin-file) | `ota-deployments/<v>/<unit>.json` | humans / `tools/ota-propose.mjs` | verify (`validatePin`) | `pin.schema.json` |
| units.config.json | app root | humans | unit-splitter | `units.config.schema.json`; see [config-reference.md](config-reference.md) |
| governance `units.json` | `ota-deployments/units.json` | humans | ota-cli (`--units`), authz, verify | `ota-units-governance.schema.json`; see [config-reference.md](config-reference.md) |

Three different files are named `units.json` / `units.config.json` (splitter input, splitter output, governance). See [schemas/README.md](../../schemas/README.md) and the [glossary](../glossary.md).

## Manifest

The served, signed file; this is also the deployable state (DESIGN.md 6). Bytes are canonical JSON (keys sorted recursively, no whitespace, `undefined` dropped; `canonicalize` in `manifest.ts`). The detached signature `manifest.json.sig` is base64 Ed25519 over exactly those bytes (see [03-manifest-state-and-signing.md](../architecture/03-manifest-state-and-signing.md)). Do not add `$schema` to it: the signature covers the bytes.

```json
{"appVersion":"11.9.0","mainBundle":{"baseHash":"sha256:c4ff...d9ba","entries":[]},"patchAlgoVer":"v1","platform":"android","schema":1,"ttlSec":120,
 "units":[{"baseHash":"sha256:0ef8...20fd","entries":[{"hash":"sha256:fd0e...7726","id":"cabs-pr42","patchUrl":"https://cdn.example.com/ota/android/11.9.0/cabs-pr42.ae745c96114d.android.patch","range":[0,0.1],"requiresHost":null,"size":333,"updateType":"patch"}],"unitName":"cabs"}],
 "version":3}
```
(Shown on two lines for readability; real bytes have no whitespace. Full pretty-printed example: [`schemas/fixtures/manifest.json`](../../schemas/fixtures/manifest.json).)

| Field | Meaning |
|---|---|
| `schema` | always `1` |
| `platform`, `appVersion` | inside the signed bytes so a signature cannot be replayed across platforms/versions; the device rejects a mismatch |
| `patchAlgoVer` | `v1` = HDiffPatch single compressed diff + zstd |
| `version` | integer >= 1, monotonic per (platform, appVersion); equals the `ota-state` version `N` |
| `ttlSec` | 1..86400 (job default 120, `initState`) |
| `mainBundle` | host: `baseHash` + `entries` |
| `units[]` | `unitName`, `baseHash` (embedded unit hash), `entries` newest first |
| entry `id` | `<unit>-pr<N>` (host entries: `host-pr<N>`) |
| entry `patchUrl`, `size` | download URL and size of the patch file (not of the built result) |
| entry `hash` | sha256 of the BUILT result (patch applied to the embedded bytes); verified on device |
| entry `updateType` | `patch` or `full` (`full` = diff against an empty file, same apply code) |
| entry `range` | `[start,end)` over the device bucket; absent = `[0,1)` (100%) |
| entry `requiresHost` | host entry id the running VM must have booted with, or `null` |

Enforced in code (`validateManifest`): unique entry ids across the whole manifest, `0 <= start <= end <= 1`, non-empty ranges of one ladder do not overlap, `requiresHost` names an existing `mainBundle` entry, unique `unitName`, valid hashes, positive integer `size`.

Patch file name written by the job: `<patchId>.<fileHash12>.<platform>.patch` (`patchName` in [`job.ts`](../../packages/ota-cli/src/job.ts)); `fileHash12` = first 12 hex of the sha256 of the patch file. Note DESIGN.md 6 shows `<unit>-pr<N>.<hash12>.patch` without the platform part; the code wins.

Schema: [`manifest.schema.json`](../../schemas/manifest.schema.json). Tests: `packages/ota-core/test/core.test.ts` ("validateManifest rejects ...").

## Base (`base.json`)

Written once per app version by the base release job (here: `ota-build base-info`, then `ota-cli init`). Records what is embedded in the binary. Type `BaseInfo`.

```json
{ "appVersion": "11.9.0", "releaseTag": "release/11.9.0", "toolchainImage": "img@sha256:1111...",
  "patchAlgoVer": "v1",
  "hbc": { "bytecodeVersion": 96, "hermescSha256": "sha256:a82e519e...02ab" },
  "host":  { "android": "sha256:c4ff...", "ios": "sha256:37e9..." },
  "units": { "cabs": { "android": "sha256:0ef8...", "ios": "sha256:0ef8..." } },
  "sizes": { "host": { "android": 16046, "ios": 16061 }, "units": { "cabs": { "android": 784, "ios": 784 } } } }
```
`sizes` are zstd-compressed sizes of the embedded bundles (the denominator of the size-ratio limits). Optional `retired: true` is set when the release line leaves the live window. Defaults when `ota-build base-info` is run without flags: `releaseTag` = `v<appVersion>`, `toolchainImage` = `local-unpinned`. Enforced in code: `units` and `sizes.units` have the same keys. Schema: [`base.schema.json`](../../schemas/base.schema.json); example: [`fixtures/base.json`](../../schemas/fixtures/base.json).

## Build (`build.json`)

Output of `ota-build bundle` for one platform (DESIGN.md 7.8 step 1). Lists the Hermes bytecode files, their hashes and the toolchain used.

```json
{ "schema": 1, "platform": "android", "appVersion": "11.9.0", "sourceSha": "aaaa...",
  "toolchain": { "rn": "0.78.3", "metro": "0.81.5", "hermescSha256": "sha256:a82e...", "hbcVersion": 96, "hermescFlags": "-O -emit-binary -g0" },
  "host":  { "file": "host.hbc", "hash": "sha256:c4ff...", "size": 28800, "zstdSize": 16046 },
  "units": { "cabs": { "file": "units/cabs.hbc", "hash": "sha256:0ef8...", "size": 1092, "zstdSize": 784, "entryModuleId": 11960423920495 } },
  "ids": { "file": "ids.json", "hash": "sha256:dacf..." },
  "unitsMap": { "file": "units.json", "hash": "sha256:5259..." },
  "delta": { "enabled": true, "baseBuild": "sha256:76a5...",
             "files": { "host.hbc": { "baseHbc": "sha256:c4ff...", "js": "sha256:9d1e..." } } } }
```
`delta` (optional; absent in builds made before delta mode) records hermesc delta compile (`-base-bytecode`): `enabled`, `baseBuild` = sha256 of the base build's `build.json` (always the embedded base build; null when not enabled), and per `.hbc` file the sha256 of the base `.hbc` used (`baseHbc`, only when enabled) and of the JS compiled (`js`, always; an unchanged JS means the base `.hbc` is copied). Base builds and `--delta off` builds have `enabled: false`. The delta base `.hbc` bytes are not in the artifact store (only hashes in `base.json`): see `ota-build archive-base` in the [pipeline doc](../architecture/02-build-and-patch-pipeline.md). `unitsMap` is the splitter output (below); it is present in the fixture and not shown in the DESIGN.md example. Enforced in code: referenced files exist and match their hash (`verifyBuildDir` in [`bundle.ts`](../../packages/ota-build/src/bundle.ts)). Schema: [`build.schema.json`](../../schemas/build.schema.json); example: [`fixtures/build.json`](../../schemas/fixtures/build.json).

## Patch report (`patch-report.json`)

Output of `ota-build patch --base <build> --new <build>` per platform. Input of the verify checks (`changedUnits`, `hostChanged`, sizes) and of `ota-build deploy-args`.

```json
{ "schema": 1, "platform": "android", "appVersion": "11.9.0", "base": "sha256:76a5...", "new": "sha256:6385...",
  "baseSourceSha": "aaaa...", "newSourceSha": "bbbb...", "deltaMode": true, "hostChanged": false, "changedUnits": ["cabs"], "idsChanged": false,
  "items": [ { "unit": "cabs", "patchFile": "cabs.android.0ef871d161ec-fd0eed1957cc.delta.hdiff", "patchSize": 333,
               "updateType": "patch", "builtHash": "sha256:fd0e...", "baseHash": "sha256:0ef8...",
               "ratioOfZstdFull": 0.3886, "deltaPatchSize": 333, "newZstdSize": 857,
               "plainEquivalentSize": 365, "deltaOverPlain": 0.9123 } ],
  "toolchain": { "...": "same object as in build.json" },
  "algo": { "patchAlgoVer": "v1", "compressor": "zstd", "zstdLevel": 19, "minMatchScore": 4, "patchStepMemSize": 262144, "fullThreshold": 0.6 },
  "tools": { "hdiffz_tool": "sha256:6edd...", "ota_apply": "sha256:8987..." } }
```
`updateType` becomes `full` when the patch would exceed `fullThreshold` (0.6) of the zstd size of the new bundle. `base`/`new` are hashes of the two `build.json` files. `deltaMode` = the new build was compiled with `hermesc -base-bytecode`; `plainEquivalentSize` / `deltaOverPlain` (= `deltaPatchSize` / `plainEquivalentSize`) are present only with `ota-build patch --report-plain`. Enforced in code: `hostChanged`/`changedUnits` consistent with `items`. Schema: [`patch-report.schema.json`](../../schemas/patch-report.schema.json); example: [`fixtures/patch-report.json`](../../schemas/fixtures/patch-report.json). Pipeline details: [02-build-and-patch-pipeline.md](../architecture/02-build-and-patch-pipeline.md).

## Splitter output (`units.json` in the build dir)

Written by `unit-splitter` next to `host.js` and `units/*.js`: module ids per bundle, async `paths`, cycles, check summaries and the recorded public API. Top-level keys (from the fixture): `format` (1), `platform`, `idBits` (48), `host` {`file`, `moduleIds`, `packages`, `assets`}, `paths` (entry module id -> unit name, used by `__loadBundleAsync`), `units` {name: `file`, `entryId`, `entryPath`, `moduleIds`, `packages`, `assets`}, `cycles` {host/unit: [...]}, `warnings`, `checks` {per rule family: `severity`, `count`, ...}, `publicApi`. The next patch build reads the base build's copy as "base" (cycle ratchet, `publicApi`). Enforced in code: id sets disjoint, `paths` target existing units. Schema: [`units.output.schema.json`](../../schemas/units.output.schema.json); example: [`fixtures/units.output.json`](../../schemas/fixtures/units.output.json). Rule ids: [rules-catalog.md](rules-catalog.md).

Since the asset and native-module rules: `assets[]` entries also carry `name`, `type`, `httpServerLocation`, `scales`, `androidResource`, `iosPath` and `variants[]` (path + sha256 per scale), and there is a required top-level `nativeRefs` map `{ <ModuleName>: { owners: [...], methods: [...], kinds: ['module'|'turbo'|'view'] } }`. Patch builds compare both against the base build's `units.json` (`asset-not-in-base`, `asset-path-changed`, `native-module-new`; see [rules-catalog.md](rules-catalog.md)). Native glue must take Android resource names from `assets[].androidResource` instead of deriving them.

## Audit (`audit.json`)

One record per state version, hash-chained (`AuditRecord`, `auditHash` = sha256 of the canonical JSON of the previous record).

```json
{ "stateVersion": 3, "previousVersion": 2, "prevAuditHash": "sha256:282a...",
  "command": "rollout", "unit": "cabs", "patchId": "cabs-pr42",
  "params": { "percent": 10, "platforms": ["android", "ios"] },
  "requester": "dev", "approver": "alice", "breakGlass": false, "ticket": "CAB-1", "pr": 42,
  "sourceSha": "bbbb...", "jobUrl": "https://ci.example.com/job/ota-deploy/7", "ts": "2026-01-01T00:00:00.000Z" }
```
`command` is one of `init|deploy|rollout|halt|restore`. `params` for `deploy` contains `files` (patch file refs `{platform,name,key}`, used by the CDN publish and by reconcile) and `builtHashes`; for `restore` `fromVersion`; for `init` `releaseTag`. `approver` is null only for halt, init and break-glass. `breakGlass` is optional in the type; the CLI always writes it (`false` unless `--break-glass`), `init` omits it. Enforced in code: chain continuity (`verifyAuditChain`). Schema: [`audit.schema.json`](../../schemas/audit.schema.json); examples: [`audit.json`](../../schemas/fixtures/audit.json), [`audit.init.json`](../../schemas/fixtures/audit.init.json).

## State layout

The logical artifact-store layout (`ArtifactStorePort`, see [ports-and-adapters.md](ports-and-adapters.md)); the local adapter in [`store.ts`](../../packages/ota-cli/src/adapters/local-fs/store.ts) uses it verbatim under `--store`:

```
ota-base/<appVersion>/base.json
ota-patches/<fileHash12>-<basename>              immutable, content addressed
ota-state/<appVersion>/v<N>/android/manifest.json
                           /android/manifest.json.sig
                           /ios/manifest.json
                           /ios/manifest.json.sig
                           /audit.json
ota-state/<appVersion>/.lock/owner.json           lease lock (local adapter only; transient)
```
A version `vN` is written to a temp dir and renamed into place (create-if-absent, all-or-nothing). Both platforms share the same `N` even if only one changed. Served CDN layout: `<cdn>/<platform>/<appVersion>/{manifest.json, manifest.json.sig, <patch files>}`.

## Pin file

`<version>/<unit>.json` in the `ota-deployments` repo: which commit to ship. Type `Pin`.
```json
{ "branch": "ota/cabs/11.9.0", "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
```
Enforced in code (`validatePin`, `parsePinPath` in [`pin.ts`](../../packages/ota-core/src/pin.ts)): `branch` must be exactly `ota/<unit>/<version>`; `sha` a full 40-char lowercase hex; the path must match `^[0-9]+\.[0-9]+\.[0-9]+/[a-z][a-z0-9-]*\.json$`. `$schema` is allowed in this file. Schema: [`pin.schema.json`](../../schemas/pin.schema.json); example: [`fixtures/pin.json`](../../schemas/fixtures/pin.json).

## Governance `units.json` (summary)

Type `UnitsConfig`: `superAdminTeam`, optional `enforceJira`, `acceptableTicketStatuses`, `defaultSoftLimit`/`defaultHardLimit` ({`bytes`?,`ratio`?}), `units` {name: `ownerTeam`, `jiraProjects`, optional `softLimit`/`hardLimit`}; the unit `host` must be declared. Fields and checks: [config-reference.md](config-reference.md); schema [`ota-units-governance.schema.json`](../../schemas/ota-units-governance.schema.json); example [`fixtures/ota-units-governance.json`](../../schemas/fixtures/ota-units-governance.json).

## Regenerating fixtures and schemas

`npm run schemas:fixtures` (needs the external tools, see [troubleshooting.md](../guides/troubleshooting.md)) and `npm run schemas:test`. When a producer or a type changes: update the schema, regenerate fixtures, let `schemas.test.ts` report drift.
