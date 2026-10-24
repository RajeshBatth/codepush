# Shipping a patch

**Purpose:** A developer walkthrough from a merged fix to a ramped patch, with the exact commands that exist today and a clear marker for manual and planned steps.
**Audience:** LoB developers and release owners trying the flow locally or preparing the real one.
**Source of truth:** [`packages/ota-build/src/cli.ts`](../../packages/ota-build/src/cli.ts), [`packages/ota-cli/src/cli.ts`](../../packages/ota-cli/src/cli.ts), [`tools/ota-propose.mjs`](../../tools/ota-propose.mjs), [`packages/ota-cli/test/job.test.ts`](../../packages/ota-cli/test/job.test.ts) ("CLI end to end"), [`packages/ota-build/test/pipeline.test.ts`](../../packages/ota-build/test/pipeline.test.ts); process spec [DESIGN.md](../../DESIGN.md) 7. Workflow context: [04-release-workflow.md](../architecture/04-release-workflow.md).

Everything below runs on one machine with local adapters. In production the "approver" and "ticket" come from Jira and the commands from PR comments handled by Jenkins; that integration is **planned** (see [adopting-in-your-monorepo.md](adopting-in-your-monorepo.md)).

Prerequisites: Node >= 24 (nvm shells: put `~/.nvm/versions/node/v24*/bin` on `PATH`, see [troubleshooting.md](troubleshooting.md)); external tools fetched/built once: `scripts/fetch-tools.sh` (hermesc) and `scripts/native-build.sh --tools` (`hdiffz_tool`, `ota_apply`); `ota-build doctor --project <app>` should show no FAIL. Shell setup used below (run from the repo root; scratch dir `.work/ship`, not `/tmp`):
```sh
export OTA_BUILD="node packages/ota-build/src/cli.ts" OTA_CLI="node packages/ota-cli/src/cli.ts"
```

## 0. One-time per app version (base release; not per patch)

The base release produced the embedded bundles. Record them and initialise state:
```sh
mkdir -p .work/ship && S=.work/ship
$OTA_BUILD bundle --project <app> --platform android --out $S/base-android --source-sha <releaseSha> --app-version 11.9.0
$OTA_BUILD bundle --project <app> --platform ios     --out $S/base-ios     --source-sha <releaseSha> --app-version 11.9.0
$OTA_BUILD base-info --android $S/base-android --ios $S/base-ios --release-tag release/11.9.0 --out $S/base.json
$OTA_CLI keygen --out $S/keys
# governance units.json + teams.json: see ../reference/config-reference.md and schemas/fixtures/ota-units-governance.json
C="--store $S/store --cdn $S/cdn --units $S/units.json --teams $S/teams.json --key $S/keys/private.pem --pub $S/keys/public.pem"
$OTA_CLI init $C --base $S/base.json --requester release-bot
```
Status: `bundle`, `base-info`, `init` implemented. Extracting hashes from the shipped APK/IPA and running the reproducibility gate on the base release (`ota-build verify-repro`) is a manual step; the base release Jenkins job is planned.

## 1. Fix and merge (manual)

Branch `ota/<unit>/<version>` is cut from the release tag; merge your reviewed fix PR into it. Run the unit's tests locally. If the fix needs host changes or touches two units, split it: verify fails the one-unit rule otherwise.

## 2. Build the new bundles and the patch (implemented)

From a checkout of the pinned sha, per platform:
```sh
for P in android ios; do
  $OTA_BUILD bundle --project <app> --platform $P --out $S/new-$P --source-sha <sha> --app-version 11.9.0 --base-build $S/base-$P      # runs the splitter in patch mode against the base build (Tier 1 checks)
  $OTA_BUILD patch  --base $S/base-$P --new $S/new-$P --out $S/patch-$P
done
cat $S/patch-android/patch-report.json     # changedUnits, hostChanged, items[].patchSize / ratioOfZstdFull / updateType
```
`patch` round-trips every patch through the shipped C++ apply code and picks `full` above 0.6 of the zstd size. Splitter errors (Tier 1/2 rules) stop `bundle`: fix them using [rules-catalog.md](../reference/rules-catalog.md). Add `--allow-unpinned-hermesc` only for local experiments. Optionally prove reproducibility: `$OTA_BUILD verify-repro --project <app> --platform android`.

## 3. Propose the pin (script only)

```sh
node tools/ota-propose.mjs cabs 11.9.0 --monorepo <monorepo> --deployments <ota-deployments checkout> --ticket CAB-1 --title "fix empty state"
```
Writes `11.9.0/cabs.json` (`{branch, sha}`) from the branch head and prints `git checkout -b`, `git commit` and `gh pr create` lines; run them yourself. Status: script implemented; the repo, required status checks and CODEOWNERS are planned/manual.

## 4. Verify (logic implemented, job planned)

`verifyPinPr` (ota-core) encodes the PR checks ([04-release-workflow.md](../architecture/04-release-workflow.md)). There is no CLI that runs it yet; the closest local equivalents are `patch-report.json` inspection and the `deploy-args` one-unit check in the next step.

## 5. Deploy at 0% (emulated)

```sh
$OTA_BUILD deploy-args --report $S/patch-android/patch-report.json --report $S/patch-ios/patch-report.json --unit cabs --version 11.9.0 --pr 42
```
prints the flags (`--version --unit --pr --patch-<p> --built-<p> --update-type-<p>`); a platform whose bytes did not change is omitted with a warning. Then supply who/what:
```sh
$OTA_CLI deploy $C <flags from deploy-args> --requester alice --approver bob --ticket CAB-1 --sha <sha> --job-url <url>
```
Approver must be in the unit's `ownerTeam` in `teams.json` and differ from the requester; otherwise `error: not authorized: ...`. Result: state `v2`, entry `cabs-pr42` at `[0,0]`. Production requires approval via Jira and a rebuild whose hashes must equal the verify report (planned).

## 6. Ramp (emulated)

```sh
$OTA_CLI rollout $C --version 11.9.0 --unit cabs --pr 42 --percent 5  --requester alice --approver bob --ticket CAB-2
$OTA_CLI rollout $C --version 11.9.0 --unit cabs --pr 42 --percent 25 --requester alice --approver bob --ticket CAB-3
$OTA_CLI show $C --version 11.9.0
```
Each ramp is a new state version (`show` prints percent per entry). Only the newest patch can be ramped; add `--platform android|ios` to ramp one platform. Conventions (soak time, small first step, watch your own dashboards by `unit`/`patchId`): DESIGN.md 7.6; not enforced by tooling.

## 7. Halt if something looks wrong (emulated)

```sh
$OTA_CLI halt $C --version 11.9.0 --unit cabs --pr 42 --requester anyone
```
No approver needed. See [incident-runbook.md](incident-runbook.md) for what halt does and does not fix.

## 8. Check

`$OTA_CLI verify $C --version 11.9.0` must print `OK`. Consider `reconcile` if the CDN step failed.

## Manual or planned summary

| Step | Today |
|---|---|
| Base release job, extraction of shipped hashes | manual |
| PR creation, branch protection, CODEOWNERS | script prints commands; settings manual |
| Verify job + PR report comment | planned (logic in ota-core) |
| `ota-deploy` / `ota-rollout` as PR comments, Jira tickets and approvals | planned; CLI flags stand in |
| Rebuild at deploy and hash equality gate | planned |
| Real store, CDN, KMS | planned (ports only) |
| Attribution API for LoB analytics (`getActivePatch`) and lifecycle callbacks | planned (DESIGN.md 9) |
