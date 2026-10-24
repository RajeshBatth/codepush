# ADR-0007: PR-comment commands; owner approves, never the requester; halt needs no approval

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 3 (tenet 3), 7.2, 7.7, 10](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted. Authorization, audit and the deploy job are implemented in `ota-core` / `ota-cli`; the Jenkins webhook, Jira ticket and approval wiring are **not done**. **Rationale:** [DESIGN.md 3 (tenet 3), 7.2, 7.7, 10](../../../DESIGN.md).

## Context
Authorization and audit should reuse existing systems (GitHub Enterprise without Actions, Jenkins, Jira) instead of a new approval system.

## Decision
Anyone may request `ota-deploy` or `ota-rollout <percent>` by PR comment. The approver must be a member of the unit's owner team (`host` and break-glass need the super-admin team) and must not be the requester; the deploy job re-checks both. Every ramp needs approval. `ota-rollout 0` (halt) needs none, because it only reduces exposure. Break-glass bypasses tickets for a super-admin and is flagged in `audit.json`. Ramp is accepted only for the latest patch of a unit; halt for any.

## Consequences
- Simplicity loses to audit and authorization when they conflict.
- The PR thread, Jira tickets and the `audit.json` chain are the audit trail.
- A stale pin cannot be deployed (the job refuses if the pin on main changed).

## Links
Code: `packages/ota-core/src/{authz,audit,pin}.ts`, `packages/ota-cli/src/job.ts`. Tests: [governance.test.ts](../../../packages/ota-core/test/governance.test.ts) ("authz: anyone requests, owner approves...", "halt needs no approval"), [job.test.ts](../../../packages/ota-cli/test/job.test.ts) ("authorization is enforced before any state change", "break-glass"). Docs: [04-release-workflow](../04-release-workflow.md), [incident-runbook](../../guides/incident-runbook.md).
