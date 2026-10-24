# ADR-0002: One Metro graph partitioned by a custom serializer; no Re.Pack

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 3 (tenet 4), 5.6](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted, implemented. **Rationale:** [DESIGN.md 3 (tenet 4), 5.6](../../../DESIGN.md).

## Context
Units must share module ids with the host. Replacing Metro (Re.Pack/webpack) would need the whole organization to change its build months ahead, which the "no toolchain change" tenet rules out.

## Decision
Run Metro once. A `serializer.customSerializer` (installed by `withOtaUnits`) receives the whole graph, returns the host as the primary result and writes `units/<unit>.js` through a side channel. Module ids are a 48-bit hash of the project-relative path with a build-failing collision check. The splitter writes `paths` itself so `import()` compiles to `asyncRequire(id, paths)` with `paths[entryId] === "<unit>"`. All Metro-internal access lives in `src/metro-compat.js`, which accepts only 0.81.x and 0.87.x and fails loudly otherwise. Fallback (c): split the stock bundle at `__d` statements; it is byte-identical and covered by a test.

## Consequences
- No extra graph, no duplicate modules, consistent ids.
- A Metro upgrade needs `scripts/metro-matrix.sh <version>` and possibly a `metro-compat.js` change.
- The Metro cache is disabled in the split build for determinism.
- Approach (b), several Metro runs with filters, was not built.

## Links
Code: `packages/unit-splitter/src/{split,metro-compat,metro-run,ids,with-ota-units}.js`. Tests: [determinism.test.js](../../../packages/unit-splitter/test/determinism.test.js) (serializer vs post-process identical; different paths/TZ/LANG), [runtime.test.js](../../../packages/unit-splitter/test/runtime.test.js), [metro-project.test.js](../../../packages/unit-splitter/test/metro-project.test.js). Docs: [02-build-and-patch-pipeline](../02-build-and-patch-pipeline.md).
