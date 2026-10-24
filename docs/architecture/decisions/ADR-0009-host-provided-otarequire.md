# ADR-0009: Entry modules run through a host-provided `__otaRequire`

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 5.9 "New requirements found by the spike"](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted, verified on Android (debug) and in a Node `vm`; iOS unverified. **Rationale:** [DESIGN.md 5.9 "New requirements found by the spike"](../../../DESIGN.md).

## Context
Metro's `__r(id)` catches an exception in a module factory and calls `ErrorUtils.reportFatalError`, which crashes a release app and never throws to the loader. A unit whose entry throws at import time would therefore crash instead of falling back.

## Decision
The host bundle defines `globalThis.__otaRequire(id)` (an SDK pre-module). It hides `ErrorUtils` for the duration of the call so the exception propagates, and the native loader gets a `RequireError`. The loader prefers `__otaRequire` and falls back to `__r`. Entry ids are 48-bit numbers and are passed as a `double`.

## Consequences
- An entry that throws leaves the VM polluted (Metro's `define` ignores re-registration), so the runtime blacklists the patch, reports the error and recreates the VM at the next zero-views moment instead of trying embedded in the same VM.
- Units must not do work at import time that can throw ([writing-a-unit](../../guides/writing-a-unit.md)).

## Links
Code: `examples/spike-app/src/host/loader.js` (line 21), `examples/spike-app/shared/ota_unit_jsi.h`. Tests: [initializer.test.js](../../../packages/unit-splitter/test/initializer.test.js) ("an initializer that throws at import time makes the load fail (RequireError)"), spike S5, `native/tests/runtime/scn_host.cpp` (`entry_failure_poisons_vm`).
