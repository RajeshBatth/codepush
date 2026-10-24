# Safety and failure modes

**Purpose:** One table of what can go wrong, what the system does about it, where that is enforced and which test proves it. Also the limits that no mechanism covers.
**Audience:** Reviewers, on-call engineers, anyone changing a safety-relevant file; AI assistants checking a change against existing guarantees.
**Source of truth:** [DESIGN.md](../../DESIGN.md) sections 5.2-5.9, 7.3, 8, 10; `packages/ota-core/src/{verify,select,state,audit,manifest}.ts`, `packages/ota-cli/src/job.ts`, `packages/unit-splitter/src/{analyze,checks}.js`, `packages/ota-build/src/patch.ts`, `native/otacore/{src,runtime}`, tests as cited. Test names are quoted from the files; none was re-run for this document.

Invariant behind almost every row: **the embedded bundle is always the fallback**, and a unit bundle contains only `__d(...)` definitions, so a bundle that fails before registration leaves the VM clean ([ADR-0011](decisions/README.md), [05-client-runtime](05-client-runtime.md)). Rule ids are explained in [rules-catalog](../reference/rules-catalog.md). Status: "impl" = in code with the cited test; "planned" = designed, not implemented.

## A. Build and verify time

| Failure | What happens | Enforced in | Proving test |
|---|---|---|---|
| Unit imports another unit, host statically imports a unit, host imports a non-entry unit module | Build fails (`unit-to-unit`, `host-to-unit-static`, `host-imports-non-entry`, `lazyUnit-name-mismatch`) | `analyze.js` | `rules.test.js` "(i) unit -> other unit import fails", "(ii) static host -> unit import fails", "(ii) host import() of a non-entry unit module fails", "lazyUnit name must match..." |
| Overlapping unit roots, 48-bit id collision | Build fails | `config.js`, `ids.js` | `rules.test.js` "unit roots must be disjoint", "module id collision is detected..." |
| Unit needs a package at a different version than the base host, or a module not in the base host, or a new native-looking package | Patch build fails (`package-version-mismatch`, `missing-in-base-host`, `native-package`) | `analyze.js` (patch mode, needs `--base`) | `rules.test.js` "(iii) ..." (three tests) |
| New cycle, dynamic `require`, name not exported by the host, deep import of a public package, breaking public API change | Build fails (`cycle`, `dynamic-require`, `host-export-missing`, `public-deep-import`, `public-api-breaking`) | `checks.js`, `public-api.js` | `checks.test.js`, `two-package.test.js` |
| Patch changes the host or a second unit | Verify error `only-one-unit`; `deploy-args` refuses | `verify.ts`, `ota-build/src/handoff.ts` | `governance.test.ts` "verify: host change or other units changed -> one-unit rule"; `pipeline.test.ts` "host change -> hostChanged...", "two units changed at once..." |
| Nothing changed vs base | Verify error `has-change`; nothing emitted | `verify.ts`, `patch.ts` | `pipeline.test.ts` "identical builds -> no items, nothing to deploy" |
| Patch too large | Soft limit warns, hard limit fails (`size-soft`, `size-hard`) | `units.ts` `evaluateSize`, `verify.ts` | `governance.test.ts` "size limits: soft warns, hard blocks..." |
| Build is not reproducible (paths, TZ, LANG differ) | `verify-repro` fails; "only one unit differs" cannot be trusted | `ota-build/src/bundle.ts`, `tools/repro_check.py` | `pipeline.test.ts` "verify-repro: two builds in different directories are byte-identical", `determinism.test.js` |
| Wrong Hermes compiler or bytecode version | Pinned sha256 checked before run; `.hbc` header validated (magic + version) | `pins.ts`, `tools.ts`, `hbc.ts` | `pipeline.test.ts` "toolchain: hermesc is the pinned...", "hbc validation rejects wrong version / non-bytecode" |
| Patch does not apply, or applies to something else | Never emitted: mandatory round trip with the shipped C++ apply and hash check | `patch.ts` `roundTrip` | `pipeline.test.ts` "round trip detects a tampered patch...", "never emits an unverified patch..." |
| Toolchain, platform or app version differ between base and new builds | Error before diffing | `patch.ts` | `pipeline.test.ts` "toolchain / platform / app-version mismatch..." |
| Unsupported Metro version | Splitter refuses with a clear message | `metro-compat.js` | `metro-project.test.js` "gate applies to the Metro that was LOCATED..." |
| PR touches more than one file or commit, bad pin, unknown unit, retired or unknown version | Verify errors (`single-commit`, `single-file`, `pin`, `known-unit`, `live-version`) | `verify.ts`, `pin.ts` | `governance.test.ts` "verify: each rule fires", "pin paths and pins" |
| Verify build in the pinned toolchain image; deploy rebuild must equal verify hashes; stale-pin refusal; Jira checks | **planned** (Jira checks exist behind `enforceJira`, default off) | not in `verifyPinPr` / `runCommand` | `governance.test.ts` "verify: Jira checks are off by default (deferred)" |
| Asset not in the binary, new `NativeModules` reference | **planned** (no rule) | n/a | none |

## B. Deploy and state

| Failure | What happens | Enforced in | Proving test |
|---|---|---|---|
| Requester approves own request, approver not in the owner team, host without super-admin | Denied before any state change | `authz.ts`, `job.ts` | `governance.test.ts` "authz: ..."; `job.test.ts` "authorization is enforced before any state change" |
| Ramp of a non-latest patch, unknown unit, invalid percent | Rejected | `ladder.ts`, `job.ts` | `job.test.ts` "ramp only for the latest patch..."; `core.test.ts` "ladder: only the latest patch can be ramped; halt works on any" |
| Two commands at once | Serialized by a per-app-version lock; no lost update, contiguous versions | `ArtifactStorePort.withLock` | `job.test.ts` "concurrent commands serialize...", "CLI end to end, including parallel processes racing"; `lease-and-pair.test.ts` (stale, dead-pid, live locks) |
| Existing state version overwritten | Refused even without the lock (create-if-absent) | store adapter | `job.test.ts` "immutability: writing an existing state version fails even without the lock" |
| Tampered state or audit chain | Job refuses to build on it; `verify` reports it | `job.ts`, `audit.ts` | `job.test.ts` "tampered state is refused...", "tampered audit history is detected"; `governance.test.ts` "audit chain: ..." |
| CDN step fails after the store write (state ahead of CDN) | `reconcile` redeploys; detects CDN ahead of state | `job.ts` `reconcile` | `job.test.ts` "reconcile redeploys the CDN when it lags..." |
| Reader sees the old manifest with the new signature during a publish (the only mixed pair) | Fails signature verification; SDK keeps the current manifest and retries | `CdnPort` ordering (patches, signature, manifest last) | `lease-and-pair.test.ts` "during a publish the only mixed pair is...", "a reader that reads the manifest and the signature at DIFFERENT moments never accepts an unverifiable pair" |
| Version leaves the live window | Only halt (or break-glass) accepted | `job.ts` | `job.test.ts` "retired versions accept only halt" |
| Jira, GitHub or Jenkins down during an incident | Break-glass by a super-admin, flagged in the audit record | `authz.ts` | `job.test.ts` "break-glass: only super-admin, bypasses approval, flagged in the audit record" |
| Audit record signed with KMS (DESIGN 7.7 provenance) | **planned**: only the manifests are signed; `audit.json` is hash-chained, not signed | n/a | none |
| Nothing authenticates `--requester/--approver/--ticket` in `ota-cli` | by design of the emulator: trusted flags; the real job must call GitHub/Jira | `cli.ts` | none |

## C. Device

| Failure | What happens | Enforced in | Proving test |
|---|---|---|---|
| Manifest signature invalid, wrong platform or app version, version lower than highest seen | Rejected, old manifest kept; `highestManifestVersion` persisted before adoption (fail closed) | `native/otacore/runtime/src/runtime.cpp` | `scn_manifest.cpp` `rejected_manifests_keep_old` |
| Manifest fetch fails | Backoff with jitter; cached manifest or embedded | runtime | `scn_manifest.cpp` `manifest_fetch_fails_backs_off`, `cold_start_no_cache_embedded_only` |
| Patch `baseHash` differs, algorithm unsupported, bucket not in any range, `requiresHost` mismatch | Embedded unit | `select.ts`, `native/otacore/src/select.cpp` | `core.test.ts` "selectUnit matches conformance vectors" (32 cases); `scn_units.cpp` `requires_host_skipped_until_vm_runs_host` |
| Downloaded patch corrupt or built hash mismatch | Discarded, no output file left, marked bad and persisted, embedded used | `native/otacore/src/patch.cpp`, runtime | `native/tests/test_patch.cpp`; `scn_units.cpp` `corrupt_patch_hash_mismatch_is_bad_and_persisted` |
| Built file modified on disk after build | Detected at verification, not evaluated | runtime | `scn_units.cpp` `tampered_built_file_is_detected` |
| Transient IO or network error | Retries with backoff up to `maxRetries`, never persisted as bad | runtime | `io_error_during_build_falls_back_then_recovers`, `io_error_retries_are_bounded`, `download_failure_retries_with_backoff` |
| Patch still downloading at tap time | Wait up to `unitBudgetMs`, then embedded; download continues for next time | runtime | `inflight_patch_arrives_within_budget`, `inflight_patch_exceeds_budget_next_vm_uses_patch` |
| Large patch on cellular | Deferred until a better network | runtime | `cellular_size_cap_defers_download` |
| Bytes not aligned, no Hermes magic (would be compiled as JS source), wrong bytecode version, path escape, size mismatch | Pre-evaluate check fails; patch marked bad; embedded evaluated | `hermes.h` `checkHermesBytecode`, `Runtime::preEvaluate` | `scn_units.cpp` `pre_evaluate_checks_reject_before_evaluate`; spike S4 |
| Hermes rejects the bytecode on evaluate | Nothing executed; embedded evaluated in the same VM | runtime | `scn_units.cpp` `evaluate_fails_for_patch_falls_back_to_embedded`, `evaluate_fails_for_embedded_reports_error_once`; spike S4 |
| Unit entry throws on require | Load fails with `RequireError` (no fatal crash); VM is polluted, so patch blacklisted and VM recreated at next zero-views moment | `__otaRequire`, runtime | `initializer.test.js` "an initializer that throws at import time..."; `scn_host.cpp` `entry_failure_poisons_vm`; spike S5 |
| App dies repeatedly before `markReady` | After K unconfirmed processes (default 2) the patch is blacklisted; embedded used. `markReady` clears the counter | runtime | `scn_host.cpp` `crash_loop_unit_blacklists_after_k_attempts`, `mark_ready_clears_attempts` |
| Patched host fails to boot or crash-loops | Host blacklisted, VM created once more from the embedded host | runtime | `scn_host.cpp` `crash_loop_host_boot_guard`, `patched_host_boot_failure_falls_back_once` |
| Crash counter cannot be persisted | Embedded used (fail closed) | runtime | `scn_units.cpp` `attempt_persist_failure_uses_embedded` |
| Halt while a VM already loaded the bad patch | **Not fixed** for that VM until it is recreated; new VMs and unloaded units use embedded. Mitigated by the crash-loop guard | design | `scn_units.cpp` `rollout_change_affects_only_unloaded_units`; spike S6 |
| Two units on different manifest snapshots in one VM | Allowed: consistency is per unit | runtime | `mixed_snapshots_per_unit_pin` |
| Host patch arrives with views mounted or a load in flight | VM left alone until zero views and no load in flight; taps during recreate are queued | runtime | `scn_host.cpp` `host_patch_with_views_waits_for_zero_views`, `recreate_waits_for_inflight_load`, `open_during_recreate_is_queued` |
| App upgrade | Cache of other app versions deleted; everything not referenced by the manifest garbage collected | `native/otacore/src/cache.cpp` | `scn_manifest.cpp` `app_upgrade_and_cache_gc`; `native/tests/test_cache.cpp` |
| Ed25519 verification on device, real `Http`/`Store`/`VmController`, release builds, physical devices, iOS | **not implemented or not run** | n/a | none |

## D. Limits no rule can catch

From [DESIGN.md 4](../../DESIGN.md) and 5.5: a LoB changing the shape of data it writes into a host store that other LoBs read; behaviour regressions; data-shape contracts through host events; host behaviour changes an old unit did not expect. These rely on LoB testing and staged rollout. Host string-literal edits produce large patches (22-35 KB on the spike host). Namespace imports are checked only for `ns.member`; see the "Limits of the export checks" list in DESIGN.md section 4.

## E. When you change a safety mechanism

Update this table, add or point to a test, and link the ADR it relates to ([decisions](decisions/README.md)). If a row says "planned" and you implement it, change the status here, in [rules-catalog](../reference/rules-catalog.md) section A4 and in the NOT DONE YET list of [adopting-in-your-monorepo](../guides/adopting-in-your-monorepo.md).
