# ADR-0006: State is the signed manifest, stored as immutable versions

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 7.1, 7.7](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted, implemented against the local-fs adapter; the real artifact store adapter is **not done**. **Rationale:** [DESIGN.md 7.1, 7.7](../../../DESIGN.md).

## Context
Rollout percentages change often; keeping them in git would add commits and conflicts, and the deployed manifest must be exactly what was approved.

## Decision
The deployable state is `ota-state/<version>/vN/{android,ios}/manifest.json(+.sig), audit.json`, written only by the deploy job, never overwritten. Every command (deploy, rollout, halt, restore) reads the latest vN under a per-version lock, validates, signs and writes v(N+1). The pin (intent) stays in git; the state (what is live at what percentage) is in the store. Restore of version K publishes K's content as N+1. A reconcile job redeploys the latest state if the CDN lags.

## Consequences
- No `git revert` for rollouts; restore is an explicit command.
- The artifact store becomes critical: retention exemption for `ota-*`, create-if-absent semantics, access control (open question 9 in DESIGN.md).
- Each state version links to the previous one by `prevAuditHash`, so tampering is detectable.

## Links
Code: `packages/ota-core/src/{state,audit}.ts`, `packages/ota-cli/src/{job,ports}.ts`. Tests: [job.test.ts](../../../packages/ota-cli/test/job.test.ts) (immutability, tampered state, tampered audit, reconcile, concurrency), [conformance.test.ts](../../../packages/ota-cli/test/conformance.test.ts). Docs: [03](../03-manifest-state-and-signing.md), [ports-and-adapters](../../reference/ports-and-adapters.md).
