# ADR-0011: A unit is resolved once per VM and pinned (per-unit consistency)

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 5.2, 5.3, 5.5](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted, implemented. **Rationale:** [DESIGN.md 5.2, 5.3, 5.5](../../../DESIGN.md).

## Context
Metro's `define()` ignores a second definition of an already-defined module id, so a unit cannot be swapped inside a live runtime. Per-session manifest snapshots would not remove mixed versions across units (cohorts already cause them) and would add machinery.

## Decision
The contract is per-unit consistency, not per-session: when a unit is first loaded in a VM its source (embedded or patch id) is fixed for that VM's lifetime. The manifest snapshot is swapped atomically; each lookup reads the current one, so unit A may be pinned from an old snapshot and unit B from a newer one. Units have no edges between them and all patches are built against the same base host, so this is safe. `requiresHost` is the only coupling escape hatch.

## Consequences
- A halt does not fix users who already loaded the bad patch; it takes effect when their VM is next created (mitigated by the crash-loop guard). VMs are deliberately not recreated on halts.
- A new patch downloaded after a unit loaded is used the next time the unit loads in a fresh VM.

## Links
Tests: [runtime.test.js](../../../packages/unit-splitter/test/runtime.test.js) ("(3) Metro define() ignores a second definition"), spike S6, `native/tests/runtime/scn_units.cpp` (`mixed_snapshots_per_unit_pin`, `rollout_change_affects_only_unloaded_units`). Docs: [05-client-runtime](../05-client-runtime.md), [incident-runbook](../../guides/incident-runbook.md).
