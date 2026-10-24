# ADR-0010: Two-package pattern: public host-owned package plus private patchable unit

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 4.1](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted, enforced by checks; worked example in `examples/two-package-app`. **Rationale:** [DESIGN.md 4.1](../../../DESIGN.md).

## Context
Some LoB code must run outside its unit (a socket, remote config) or is consumed statically by the rest of the app. Static consumption of a unit is forbidden by the direction rule.

## Decision
The package boundary is the patch boundary. The public package (`@travelplex/core`) is host-owned, additive-only and snapshot-checked, holds transport, singletons, an idempotent `init()` and the thin shell that is the only place that `import()`s the unit. The private package (`@travelplex/ui`) is the unit. Units may import the public package only through its entry or `exports` (`public-deep-import`) and only names that exist at runtime (`host-export-missing`); removing a name fails (`public-api-breaking`).

## Consequences
- A unit patch is verified per live app version against that version's host, so the same change can pass for the latest version and fail for an older one.
- A new public API plus UI that uses it is a train release; later UI-only changes are OTA again.
- Hotfixing initializer logic without a host release would need an eager unit (planned, not v1).

## Links
Code: `packages/unit-splitter/src/{public-api,exports,checks}.js`. Tests: [two-package.test.js](../../../packages/unit-splitter/test/two-package.test.js) (23 tests). Docs: [two-package-pattern](../../guides/two-package-pattern.md), [rules-catalog](../../reference/rules-catalog.md).
