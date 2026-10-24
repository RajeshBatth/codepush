# ADR-0008: Native-driven loading with a C++ orchestrator behind injected interfaces

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 5.6 C, 5.8](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted. Orchestrator and core implemented and simulation-tested; Android glue is spike quality; iOS glue compiled only. **Rationale:** [DESIGN.md 5.6 C, 5.8](../../../DESIGN.md).

## Context
The app is hybrid: the first screen is native and no RN VM is needed to render it. Loading before the surface exists keeps Suspense and the JS thread out of the path and lets the SDK time out and fall back before any RN code runs.

## Decision
`openUnit("cabs")` is called by the native entry point; the SDK resolves embedded or patch, waits at most `unitBudgetMs`, runs pre-evaluate checks, evaluates the bytecode into the VM on the JS thread, runs the entry through `__otaRequire`, then mounts the surface. `lazyUnit` is the fallback for navigation inside RN and calls the same native `load`. All decisions run on one serial "ota queue". The logic is written once in C++ (`native/otacore/runtime`) against injected interfaces (Clock, Scheduler, Worker, Http, FileSystem, Store, SignatureVerifier, EmbeddedAssets, PatchBuilder, VmController, Observer); Kotlin and ObjC++ implement only the interfaces. Evaluation uses our own JSI `evaluateJavaScript` call because RN 0.78 offers no public second-bundle API in bridgeless mode.

## Consequences
- Deterministic simulation tests (virtual time, fake network) cover the state machine; real-thread, real Http/Store/VmController, Ed25519 and mmap are not covered.
- Uses framework-only surface (Android `@FrameworkAPI` holder passed as `Object`; iOS undeclared `[RCTBridge runtime]` selectors), so each RN upgrade needs a spike re-run.

## Links
Code: `native/otacore/runtime/`. Tests: `native/tests/runtime/scn_*.cpp` (37 scenarios per DESIGN 5.8), spike S1-S10. Research: [rn-0.78-loader.md](../../research/rn-0.78-loader.md). Docs: [05-client-runtime](../05-client-runtime.md), [native-api](../../reference/native-api.md).
