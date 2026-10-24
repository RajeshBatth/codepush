# CodePush: over-the-air updates for a hybrid React Native app

Reference implementation and design for patching **units** (per-LoB slices of an RN app) over the air, in an app whose first page is native and whose RN surfaces are opened from native entry points. React Native 0.78 (Fabric/bridgeless, Hermes), Metro 0.81.

**How it works in one paragraph:** one Metro build is split into a **host** bundle (shipped in the binary) and per-LoB **units**. A change to one unit becomes a small HDiffPatch+zstd diff of its Hermes bytecode, verified by round-tripping through the same C++ code the app ships. Patches are published as a **signed, static manifest** on a CDN; the rollout percentage is decided on the device. Every release, ramp and halt is an immutable, audited state version approved by the unit's owner team. There is no OTA server and no telemetry pipeline.

## Start here
- **AI assistants / Cursor:** [AGENTS.md](AGENTS.md) (map, invariants, commands) and `.cursor/rules/`.
- **Humans:** [docs/README.md](docs/README.md) (reading paths), then [docs/guides/adopting-in-your-monorepo.md](docs/guides/adopting-in-your-monorepo.md).
- **Full design and decision record:** [DESIGN.md](DESIGN.md).

## Status
| Component | What | State |
|---|---|---|
| `packages/ota-core` | formats, validation, signing, selection, ladder, audit, authz | 155 tests + typecheck |
| `packages/ota-cli` | deploy job over ports, local adapters, conformance suites | 76 tests |
| `packages/unit-splitter` | Metro splitter + static checks (ownership, cycles, encapsulation, dynamic requires, host-export, public API snapshot) | 83 tests |
| `packages/ota-build` | bundle, patch (round-trip verified), reproducibility, doctor | 39 tests |
| `native/` | C++ core, HDiffPatch apply, loader orchestrator | 41 CTest (also under ASan/UBSan) |
| `schemas/` | JSON Schemas for every file format | validated against generated artifacts |
| `examples/spike-app` | real RN 0.78.3 hybrid app, S1-S10 device tests | Android: all pass on an arm64 emulator (debug build); iOS: compiles, not run |

**Not done yet:** reusable Android library / iOS pod extracted from the spike glue, Jenkins job definitions, Jira wiring, real S3/CDN/KMS adapters, the asset rule, the native-module scan, an iOS device run, `preloadUnit`. See the "NOT DONE YET" list in the adoption guide.

## Quick start
Requires Node >= 22.12 (developed on 24); the native part also needs CMake and clang.
```
bash scripts/doctor.sh            # is this machine ready?
bash scripts/test-all.sh --fast   # core + cli (omit --fast for splitter + ota-build, add --native for C++)
node packages/ota-build/src/cli.ts doctor --project examples/spike-app --platform android
```
Environment notes (lazy `node` in subprocesses, broken ccache symlinks, scratch dirs): see [AGENTS.md](AGENTS.md) and [docs/guides/troubleshooting.md](docs/guides/troubleshooting.md).

## Repository layout
```
packages/   ota-core  ota-cli  ota-build  unit-splitter     (TypeScript/JS, run by Node type stripping)
native/     otacore (C++ core) + runtime (orchestrator) + tools + third_party (vendored)
schemas/    JSON Schemas + fixtures
examples/   demo-app  two-package-app  spike-app
docs/       architecture, reference, guides, spikes, research
scripts/    test-all, doctor, env, native-build, fetch-tools, clean
tools/      repro_check.py, ota-propose.mjs
```

## License
**Not open source.** All rights reserved; the repository is publicly visible for a limited time for viewing and review only. See [LICENSE](LICENSE). Vendored third-party code under `native/third_party` keeps its own licenses (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
