# ADR-0012: Asset rule: patches may only reference assets already in the binary

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 4 (last row of the static checks table) and 5.9 "Assets are an unresolved gap"](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** **planned, not implemented.** No check exists in `packages/unit-splitter` or `packages/ota-core/src/verify.ts`. **Rationale:** [DESIGN.md 4 (last row of the static checks table) and 5.9 "Assets are an unresolved gap"](../../../DESIGN.md).

## Context
An image is an ordinary module (`registerAsset(...)`) owned by the unit, but its bytes are in no bundle. Android resolves a drawable name derived from the path; iOS a bundle path. A patch that references a new asset would render nothing.

## Decision (proposed)
New Tier 1 rule: every asset module of a patched unit must exist in the base build with the same path and hash, otherwise verify fails. Shipping new assets OTA is out of scope for v1.

## Consequences
- The data needed exists: the splitter's output `units.json` already lists `assets` with path and sha256 per owner (`packages/unit-splitter/src/build.js`), so the rule is a comparison of base vs new.
- Until implemented, reviewers must check asset changes manually ([writing-a-unit](../../guides/writing-a-unit.md)); this is on the NOT DONE YET list in [adopting-in-your-monorepo](../../guides/adopting-in-your-monorepo.md).
