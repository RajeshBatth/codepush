# AGENTS.md: map and rules for AI assistants (Cursor, Claude Code, others) and new engineers

Read this first. Everything else is linked from here. Human-oriented index: [docs/README.md](docs/README.md). Full design and decision record: [DESIGN.md](DESIGN.md).

## What this repo is
OTA ("CodePush") tooling for a **hybrid bare React Native 0.78 app** (native first page, RN surfaces opened from native entry points; Hermes; Metro 0.81). One Metro build is split into a **host** bundle (in the binary) and per-LoB **units** that can be patched over the air. Patches are HDiffPatch+zstd diffs against the embedded bytecode, published as a signed static manifest with on-device percentage rollout, approved per unit owner, audited. No OTA server, no telemetry pipeline.

## Invariants: do not break these
1. **Ownership is by path/package.** A module belongs to a unit iff it is under that unit's declared roots; everything else (third-party, shared, Common code) is the **host**. (`packages/unit-splitter/src/config.js: ownerOf`)
2. **Direction rule.** Only the host may import a unit, only through a plain async `import()` of the unit's declared **entry**. Never unit -> unit, never a static host -> unit edge. Units may import host modules. (`analyze.js`)
3. **Metro internals live only in `packages/unit-splitter/src/metro-compat.js`.** Nowhere else imports `metro/src/*` or `metro/private/*`. The adapter supports Metro 0.81.x and 0.87.x only and fails loudly otherwise.
4. **Fail closed, fall back to embedded.** Anything that decides what code runs on a device must verify first (signature over the *exact served bytes*, patch hash, Hermes magic + bytecode version, alignment) and fall back to the embedded bundle on any failure. Never evaluate unverified bytes; never re-serialize a manifest before verifying it.
5. **Deterministic builds.** `hermesc -O -emit-binary -g0`, fixed relative file name, pinned compiler (`packages/ota-build/src/pins.ts`). Output must be byte-identical across directories/machines (`ota-build verify-repro`). Never put absolute paths, timestamps or random ids in build outputs.
6. **State is immutable and audited.** `ota-state/<version>/vN` is created-if-absent, never overwritten; each audit record hashes its predecessor. Only the single deploy job writes it.
7. **Pure logic stays pure.** `packages/ota-core` does no IO. IO lives behind ports in `packages/ota-cli` (`ports.ts`); the job depends only on ports.
8. **Per-VM pin.** A unit is evaluated once per VM; a second definition of a loaded module id is ignored by Metro. Never design around swapping a unit inside a live VM.
9. **Native core (`native/otacore`)**: C++17, no exceptions across the public API, no platform headers, orchestrator is single-threaded behind injected interfaces.

## Repo map
| Path | What | Language / run |
|---|---|---|
| `packages/ota-core` | Types, manifest validation + canonical JSON + signing, bucketing, selection, rollout ladder, state transitions, audit chain, authz, size limits, PR verify. Conformance `vectors/` for native ports. | TS (Node type stripping) |
| `packages/ota-cli` | The deploy job (`job.ts`) against **ports** (`ports.ts`), local-fs/ed25519 adapters, conformance suites, CLI. | TS |
| `packages/ota-build` | `bundle` -> hermesc -> `patch` (round-trip verified) -> `base-info`/`deploy-args`, `verify-repro`, `fetch-tools`, `doctor`. | TS |
| `packages/unit-splitter` | Metro splitting serializer, ownership, all static checks (rules), `withOtaUnits`, vm harness. | JS (ESM) |
| `native/otacore` | C++ core: sha256, bucket, manifest, selection, HDiffPatch apply, cache; `runtime/` = the loader orchestrator. | C++17, CMake/CTest |
| `native/third_party` | Vendored HDiffPatch, zstd, LZMA, nlohmann/json (licenses in `VERSIONS.md`). | do not edit |
| `schemas/` | JSON Schemas for every file format + `fixtures/`. | validated by `packages/ota-core/test/schemas.test.ts` |
| `examples/demo-app` | Plain-JS fixture used by most tests. | |
| `examples/two-package-app` | Worked example of the public-package + private-unit pattern. | |
| `examples/spike-app` | Real RN 0.78.3 app + Android/iOS glue + S1-S10 device tests (spike quality, not product code). | |
| `scripts/`, `tools/` | `test-all.sh`, `doctor.sh`, `env.sh`, ...; `repro_check.py`, `ota-propose.mjs`. | bash/node/python |
| `docs/` | Architecture, reference, guides, ADRs, spike results, research. | markdown |

## Commands (run from the repo root)
```
bash scripts/doctor.sh                 # machine readiness
bash scripts/test-all.sh               # all suites (add --fast to skip the slow ones, --native for C++)
node packages/ota-build/src/cli.ts doctor --project <app dir> [--platform android|ios] [--deep]   # project readiness
cd packages/<pkg> && npm test          # one package (ota-core also: node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json)
```
Expected today: ota-core 166 (+ typecheck), ota-cli 76, unit-splitter 103, ota-build 57, native ctest 72.

**Environment quirks (they bite spawned shells and CI):** `node`/`npm` are lazy-loaded shell functions here, so subprocesses do not see them: `N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH` (or `source scripts/env.sh`). `/usr/local/bin/clang*` are broken ccache symlinks: pass `-DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++`. Use `.work/` (gitignored) for scratch, not `/tmp`. Never leave long-running processes (emulators, Gradle daemons, hung shells).

## How to make common changes
| Change | Touch | Also update |
|---|---|---|
| New static check / rule | `packages/unit-splitter/src/{analyze,checks,public-api}.js`; config key in `checks.js` | negative + positive tests in `packages/unit-splitter/test/`, `docs/reference/rules-catalog.md`, `schemas/units.config.schema.json` (+ fixtures/drift test) |
| New manifest/state field | `packages/ota-core/src/{types,manifest,state}.ts` | `schemas/*.json`, `schemas/fixtures` (`npm run schemas:fixtures`), `native/otacore` parser + `vectors/`, `docs/reference/file-formats.md` |
| New storage/CDN/KMS backend | implement ports in `packages/ota-cli/src/ports.ts` | run `test/conformance/*` against it (see `docs/reference/ports-and-adapters.md`) |
| Loader behavior | `native/otacore/runtime` (start at the reading guide in `src/runtime_impl.h`; one file per concern) | add a deterministic scenario test in `native/tests/runtime/`, update `docs/architecture/05-client-runtime.md` |
| Patch algorithm / flags | `packages/ota-build/src/patch.ts`, `native/otacore/src/patch.cpp` | bump `patchAlgoVer`, round-trip tests, ADR |

## Conventions
- TypeScript runs through Node type stripping: **erasable syntax only** (no `enum`, `namespace`, parameter properties), import with explicit `.ts` extensions, `node:test` for tests, exact-pinned dependencies.
- Every rule/check has a stable id, a severity configurable via `units.config.json -> checks`, a negative fixture test and a catalog entry.
- Mark anything not implemented as **planned** in docs; link the DESIGN.md section.
- Prefer small, deterministic tests with temp dirs under `.work/` that are cleaned up.

## Not done yet (do not assume it exists)
Reusable Android library / iOS pod extracted from the spike glue; Jenkins job definitions; Jira wiring; real S3/CDN/KMS adapters; the native-side module inventory (the implemented native-module scan derives its inventory from the BASE JS graph only: a module that is in the binary but unused by the base JS cannot be adopted OTA) and `contractHash`; a first-party host-file native-reference check in patches; iOS tests run on a simulator/device; `preloadUnit` and the host-init hook; Linux/Windows runs of the toolchain. Spec items not yet in code: `verifyPinPr` is never called outside tests (no Jenkins verify job), rebuild-hash-equals-verify gate, stale-pin refusal, pinned-image build in verify, KMS signature on `audit.json`, SDK `getActivePatch` and lifecycle callbacks. `ota-cli` trusts `--requester/--approver/--ticket/--pr` (the Jenkins/Jira layer must supply them).
