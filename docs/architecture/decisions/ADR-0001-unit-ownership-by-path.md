# ADR-0001: Unit ownership by path/package; host is everything else

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md section 4](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted, implemented. **Rationale:** [DESIGN.md section 4](../../../DESIGN.md).

## Context
LoB code quality is uneven (cycles, singletons, duplicated libraries). Ownership defined by reachability would make a unit's content depend on what other code imports, so shared libraries could be silently duplicated into units or patched by the wrong team.

## Decision
A unit is exactly the source under the `roots` (directories or package names) declared in `units.config.json`. Every other module, including all third-party packages and Common code, is the host. Roots are realpath'd (Metro reports symlink-resolved paths) and must be disjoint. Declaring a LoB is the opt-in; passing Tier 2 is the entry requirement; an undeclared LoB stays in the host.

## Consequences
- Shared code is patchable only through the host lane (Common-owned, planned for production).
- The host is larger (it contains libraries used by one LoB); upgrading a library needs the train or a host patch.
- Authorization falls out of ownership: one PR = one unit = one owner team.
- Package-name roots work for a real copy, a symlink inside the project and a symlink outside it (outside dirs are added to `watchFolders`).

## Links
Code: `packages/unit-splitter/src/config.js`, `analyze.js`. Tests: [rules.test.js](../../../packages/unit-splitter/test/rules.test.js) ("unit roots must be disjoint"), [two-package.test.js](../../../packages/unit-splitter/test/two-package.test.js). Docs: [01-units-and-ownership](../01-units-and-ownership.md), [glossary](../../glossary.md).
