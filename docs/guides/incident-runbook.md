# Incident runbook

**Purpose:** What to do when a patch misbehaves: halt, roll back, restore, break-glass, and how to check that the published state is sound.
**Audience:** On-call engineers and release owners.
**Source of truth:** [`packages/ota-cli/src/cli.ts`](../../packages/ota-cli/src/cli.ts), [`job.ts`](../../packages/ota-cli/src/job.ts) (`runCommand`, `reconcile`, `verifyStore`), [`state.ts`](../../packages/ota-core/src/state.ts), [`authz.ts`](../../packages/ota-core/src/authz.ts), [`packages/ota-cli/test/job.test.ts`](../../packages/ota-cli/test/job.test.ts); client behaviour from [DESIGN.md](../../DESIGN.md) 5.3, 8 and [05-client-runtime.md](../architecture/05-client-runtime.md).

**Scope note.** Today these are `ota-cli` commands run by hand with local adapters. In production the same job is meant to run from Jenkins, triggered by PR comments (`ota-rollout 0`) and Jira approvals; that wiring is **planned**. Define the context once (same flags as in [shipping-a-patch.md](shipping-a-patch.md)):
```sh
export OTA_CLI="node packages/ota-cli/src/cli.ts"
C="--store <store> --cdn <cdn> --units <units.json> --teams <teams.json> --key <private.pem> --pub <public.pem>"
```

## 1. Halt (first action, no approval)

```sh
$OTA_CLI halt $C --version 11.9.0 --unit cabs --pr 42 --requester <you>
# equivalent: $OTA_CLI rollout $C ... --percent 0 --requester <you>
# one platform only: add --platform android
```
`--pr` is the PR number in the patch id `<unit>-pr<N>`. Halt works for any of the unit's patches (older ones too). A ticket for the record is planned (automatic in production design; here pass `--ticket KEY` optionally).

What halt does: removes the entry from the unit's ladder in a new immutable state version `N+1`, signs it, publishes it. If it was the newest entry, the previous entry is extended back to bucket 0, so devices return to what they had before the ramp; if no previous entry, to the embedded bundle. Tests: `core.test.ts` "ladder: halting newest restores previous to bucket 0"; `job.test.ts` halt scenarios.

What halt does NOT do:
- It is not instant: devices see it after the job completes + CDN purge (planned for real CDNs) + the manifest `ttlSec` (default 120) + their next sync.
- It does not fix a device that already loaded the bad patch in its current VM: a unit evaluates once per VM and the pin is per VM, so those users keep it until the VM is recreated (cold start, OS kill, host swap). The VM is deliberately not recreated on halts (DESIGN.md 5.3).
- The on-device safety nets help in the meantime: crash-loop guard (K unconfirmed processes blacklists the patch persistently; default K = 2 in the C++ runtime config) and fallback to embedded on any verify/evaluate failure.
- It cannot revert data a bad patch already wrote into host stores.
- A built patch the device already downloaded is deleted at its next manifest sync.

## 2. Reduce a ramp (not a halt)

```sh
$OTA_CLI rollout $C --version 11.9.0 --unit cabs --pr 42 --percent 5 --requester <you> --approver <owner-team-member> --ticket KEY
```
Needs an approver from the unit's owner team who is not the requester. Only the newest patch can be ramped (else `ramp is only allowed for the latest patch`). Ramping down returns buckets to the previous entry (test "ladder: ramp-down returns buckets to previous").

## 3. Roll back to an earlier state (restore)

Find the good version:
```sh
$OTA_CLI show $C --version 11.9.0              # latest
$OTA_CLI show $C --version 11.9.0 --state 4    # an earlier one: command, patch, requester, approver, ts, ranges per entry
```
Publish its content as a NEW version (manifest `version` must stay monotonic; devices reject lower versions):
```sh
$OTA_CLI restore $C --version 11.9.0 --from 4 --requester <you> --approver <approver> --ticket KEY [--unit cabs]
```
The old version's signature is verified first (`v4 signature invalid: cannot restore` otherwise). Without `--unit` authorization treats it as the `host` unit, so the approver must be in the super-admin team; with `--unit` the unit's owner team approves. Restore replaces BOTH platforms' manifests wholesale; patches deployed after version K disappear from the manifest (their files stay on the CDN, which never deletes). Prefer halt for a single bad patch; use restore for multi-step damage.

## 4. Break-glass (Jira/GitHub/Jenkins down)

A super-admin runs the job directly, skipping approval and tickets:
```sh
$OTA_CLI restore $C --version 11.9.0 --from 4 --requester <super-admin> --break-glass
$OTA_CLI halt    $C --version 11.9.0 --unit cabs --pr 42 --requester <super-admin> --break-glass
```
Allowed only if `--requester` is a member of `superAdminTeam` (else `not authorized: break-glass requires the super-admin team`). The audit record carries `breakGlass: true`. It also works on retired versions. Test: `job.test.ts` "break-glass: only super-admin, bypasses approval, flagged in the audit record". Note: nothing in the CLI authenticates `--requester`; in production the Jenkins job must supply identity from SSO.

## 5. Verify the published state

```sh
$OTA_CLI verify $C --version 11.9.0     # exit 0 + "OK: ..." or exit 1 + one "PROBLEM ..." line each
```
`verifyStore` checks: state versions contiguous from v1; `audit.stateVersion` and manifest `version` equal N; platform/appVersion; `validateManifest`; every stored signature over the stored bytes; the audit hash chain; and against the CDN, per platform: a manifest is served, its version equals the latest state, bytes and signature identical to state, served signature verifies, every patch file referenced by an entry exists.

| Problem text | Meaning | Action |
|---|---|---|
| `CDN: <p> serves v<a>, latest is v<b>` / `has no manifest` | publish failed after the state write | `reconcile` |
| `CDN: ... missing patch file ...` | patch not uploaded | `reconcile` (republishes all patch files from the audit chain) |
| `bad signature` / `signature check failed ... tampered state` | stored state altered or wrong key | stop; investigate store access; restore from a good version needs a valid signature on it |
| `audit: ... prevAuditHash does not match` | audit history altered or missing | treat as tampering; compare with CDN copies |
| `state versions are not contiguous` | a version was deleted/missing | investigate store retention |

## 6. Reconcile (CDN behind state)

```sh
$OTA_CLI reconcile $C --version 11.9.0     # prints "redeployed android, ios" or "CDN already up to date"
```
Republishes the latest state's exact stored bytes for platforms whose served version is older (or absent). If the CDN serves a version HIGHER than the latest state it refuses (`CDN serves v.. > latest state v..: manual investigation required`). Publishing the same manifest twice is harmless. A periodic reconcile job is part of the design (planned).

## 7. Concurrency and failed commands

Commands take a lock per app version; concurrent callers serialize and versions stay contiguous (test: eight parallel ramps). A lock timeout shows `timed out`; a crashed holder is taken over after the lease (default 10 minutes). If a command fails before `writeState`, nothing changed; if it fails after (CDN step), run `reconcile`.

## 8. After the incident

Record why in the PR thread (audit trail convention, DESIGN.md 7.6). The cause analysis uses the LoB's own analytics tagged with `unit`/`patchId` (SDK attribution API planned, DESIGN.md 9). If a rule would have caught it, add a check ([rules-catalog.md](../reference/rules-catalog.md)). Related: [06-safety-and-failure-modes.md](../architecture/06-safety-and-failure-modes.md).
