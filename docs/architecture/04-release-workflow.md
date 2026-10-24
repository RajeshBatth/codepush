# Release workflow

**Purpose:** The human and CI process that turns a fix into a ramped OTA patch: repos, branches, the pin PR, verify checks, PR-comment commands, approvals, halt, break-glass, dot releases, live versions. Each step is marked implemented (in code in this repo), emulated, or planned.
**Audience:** LoB developers, release owners, whoever builds the Jenkins/Jira integration.
**Source of truth:** [DESIGN.md](../../DESIGN.md) section 7 (spec); code: [`verify.ts`](../../packages/ota-core/src/verify.ts), [`authz.ts`](../../packages/ota-core/src/authz.ts), [`pin.ts`](../../packages/ota-core/src/pin.ts), [`units.ts`](../../packages/ota-core/src/units.ts), [`job.ts`](../../packages/ota-cli/src/job.ts), [`cli.ts`](../../packages/ota-cli/src/cli.ts), [`tools/ota-propose.mjs`](../../tools/ota-propose.mjs), [`handoff.ts`](../../packages/ota-build/src/handoff.ts).

## Status legend

| Mark | Meaning |
|---|---|
| implemented | logic exists as code with tests in this repo |
| emulated | `ota-cli` does it from a shell, with flags standing in for the approved ticket/PR |
| planned | designed in DESIGN.md, no code (Jenkins jobs, GitHub webhooks, Jira) |

## Repos, branches, stores

| Thing | What | Status |
|---|---|---|
| Monorepo branch `ota/<unit>/<version>` | cut from the release tag of that version (byte-identical to the embedded base); fix PRs merge here; protected by name pattern, CODEOWNERS = unit team | branch name rule implemented (`branchFor`, `validatePin`); branch protection and CODEOWNERS are repo settings (planned/manual) |
| `ota-deployments` repo | pins only: `units.json` (governance), `CODEOWNERS` (generated from it), `<version>/<unit>.json` pin files | file formats implemented ([file-formats.md](../reference/file-formats.md)); the repo itself and CODEOWNERS generation: planned |
| CI artifact store | `ota-base/`, `ota-patches/`, `ota-state/` written only by the deploy job | port + local-fs adapter implemented; real store planned ([ports-and-adapters.md](../reference/ports-and-adapters.md)) |
| Pin vs state | pin = which commit we intend to ship (human, git); state = what is published at which percentage (machine, artifact store, literally the manifest). `ota-rollout 10` changes no git file | design; implemented by the split between pin files and `ota-state` |

One PR = one unit = one app version. Supported targets: the latest 3 release lines; a fix for two lines is two branches and two PRs.

## Flow

| # | Step | Who | Status |
|---|---|---|---|
| 1 | Fix merged into `ota/<unit>/<version>` (normal reviewed PR) | developer | manual (git) |
| 2 | Propose: write `<version>/<unit>.json` pin and open PR in `ota-deployments`; title starts with the Jira key | developer | `node tools/ota-propose.mjs <unit> <version> --monorepo P --deployments P [--ticket K] [--title T]` writes the pin from the branch HEAD and PRINTS the `git`/`gh pr create` commands; nothing is executed or pushed. The DESIGN name `ota propose` is this script |
| 3 | Verify (required status, posts report) | Jenkins | rule logic implemented as `verifyPinPr`; the Jenkins job that gathers its inputs and posts the PR comment: planned |
| 4 | Review: one approval from the unit's owner team (CODEOWNERS) + green verify; merging changes nothing for users | owner team | GitHub settings; planned |
| 5 | `ota-deploy` PR comment -> Jira deploy ticket -> owner approves (not the requester) -> job rebuilds, requires built hashes == verify report, stores patches, writes next state with the patch at 0%, deploys | anyone requests | job logic emulated by `ota-cli deploy`; ticket creation, webhook, rebuild-and-compare gate: planned |
| 6 | `ota-rollout <percent> [android\|ios]` -> ticket -> approval -> next state with the new range | anyone requests | emulated by `ota-cli rollout` |
| 7 | `ota-rollout 0` = halt, no approval | anyone with repo access | emulated by `ota-cli halt` or `rollout --percent 0` |
| 8 | Audit: PR thread + `audit.json` chain | | `audit.json` chain implemented; PR-thread linking planned |

Step-by-step commands that exist today: [shipping-a-patch.md](../guides/shipping-a-patch.md).

## Verify checks (`verifyPinPr`)

Pure function: inputs are PR facts, pin, git facts and the verify-build output; any finding with severity `error` fails the required check; warnings go to the PR report. Check ids as emitted:

| Check id | Severity | Condition |
|---|---|---|
| `single-commit` | error | PR commit count != 1 |
| `single-file` | error | PR changes != 1 file |
| `pin-path` | error | the file is not `<version>/<unit>.json` (`parsePinPath`) |
| `known-unit` | error | unit not declared in governance `units.json` |
| `live-version` | error | version not in `liveVersions` |
| `pin` | error | `validatePin`: branch must be `ota/<unit>/<version>`; sha 40 hex |
| `jira-title`, `jira-unit`, `jira-exists`, `jira-status` | error | only when `enforceJira: true` (default off, deferred): title starts with a key; key's project maps to this unit; ticket exists; status in `acceptableTicketStatuses` |
| `sha-on-branch` | error | pinned sha not reachable from the branch (fact supplied by Jenkins) |
| `descends-from-tag` | error | sha does not descend from the release tag |
| `branch-protected` | error | branch not protected |
| `tier1` | error | one per Tier 1 error string from the verify build |
| `only-one-unit` | error | host changed in a non-host PR, or other units differ from base |
| `has-change` | error | non-host unit byte-identical to base |
| `size-hard` / `size-soft` | error / warning | per platform, `evaluateSize`: hard limit blocks, soft warns; either bytes or ratio triggers; per-unit override else defaults |

Tests: `packages/ota-core/test/governance.test.ts` / `core.test.ts` ("verify: a good PR passes", "each rule fires", "one-unit rule"). Splitter-side rule ids (Tier 1/2/3 findings) are in [rules-catalog.md](../reference/rules-catalog.md). Not covered by `verifyPinPr` (planned, DESIGN.md 7.3): the build in the pinned toolchain image, "ota-deploy rebuild must match verify hashes", and the stale-pin check (job refuses if the pin on main changed since the request).

What fills the build inputs today: `ota-build bundle` + `ota-build patch` give `changedUnits`, `hostChanged` and `patchSize` (see [02-build-and-patch-pipeline.md](02-build-and-patch-pipeline.md)); `ota-build deploy-args` already enforces the one-unit rule per platform (`RULE_ONE_UNIT`) and refuses when nothing changed (`NOTHING_TO_DEPLOY`).

## Authorization (`authorize`)

"Anyone can request; the unit's owner team approves; the approver is never the requester." Evaluated BEFORE any state change (job.test.ts "authorization is enforced before any state change").

| Case | Result |
|---|---|
| unknown unit | denied |
| `breakGlass` | allowed only if requester is in `superAdminTeam`; recorded as `breakGlass: true` in the audit record |
| `halt` | allowed with no approver |
| other command, no approver | denied ("approval required") |
| approver == requester | denied |
| approver must be member of `ownerTeam` of the unit, or `superAdminTeam` when unit is `host` | else denied |

`restore` without `--unit` is treated as unit `host`, so it needs a super-admin approver. Jira's "approver is not reporter" rule and the GitHub/Jira API re-checks happen in Jenkins (planned); the code re-checks team membership via `TeamDirectoryPort`.

## Deploy job rules (`runCommand`)

Under the per-app-version lock: read base; if `base.retired` only `halt` (or break-glass) is accepted; read the latest state and verify its signatures; apply; sign; write `v(N+1)`; publish to CDN (patches, signature, manifest). If the CDN step fails after the store write, the state is ahead of the CDN and `reconcile` fixes it. Ramp is accepted only for the latest (newest) patch of the unit; halt for any. Commands: [cli-reference.md](../reference/cli-reference.md).

## Live versions, retirement, dot releases

- A version is live if `ota-base/<v>/base.json` exists and is not `retired` (`liveVersions()` on the store port). "Latest 3 release lines" is the policy; the code only reads the `retired` flag, which the base release job (planned) sets when a line leaves the window. Retired versions accept no new pin or deploy; halt still works.
- A dot release (11.9.1) is its own app version: own `<version>/` dir, own base, own manifest path. Patches for 11.9.0 do not apply (different `baseHash`; `select` returns `base-mismatch`). Reusing an identical patch artifact across dot releases is optional tooling, not implemented.
- Builds are keyed per live version; the same unit change may verify for the latest version and fail for an older one (host exports differ).

## Halt, break-glass, restore

- Halt = remove the entry (`ota-rollout 0`). No approval. Effective after the job finishes + `ttlSec` + the device's next sync; devices that already loaded the patch keep it until their VM is recreated ([05-client-runtime.md](05-client-runtime.md)).
- Break-glass: a super-admin runs the job manually (`--break-glass`) bypassing tickets and approval; works on retired versions; always audited. Meant for when Jira/GitHub/Jenkins are down; in this repo it is just the CLI flag.
- Restore: publish the content of state version K as N+1. Procedures with commands: [incident-runbook.md](../guides/incident-runbook.md).

## Known differences between DESIGN.md and code

- Patch file naming includes the platform (`<id>.<hash12>.<platform>.patch`); DESIGN.md 6 omits it.
- The `ota-cli` CLI takes `--requester/--approver/--ticket/--pr` as trusted flags; nothing validates them against GitHub or Jira.
- DESIGN.md 7.2 says ramp-up is only for the latest deployed patch; implemented in `setPercent`.
- The `audit.json` KMS provenance signature (DESIGN.md 7.7) is not implemented.
