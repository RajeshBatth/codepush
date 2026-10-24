# Overview: what this system is and is not

**Purpose:** Explain the problem, the goals, the moving parts and the end-to-end path from a code change to a device, in one page.
**Audience:** Anyone new to the repo (engineers, reviewers, AI assistants). Read this before any other doc.
**Source of truth:** [DESIGN.md](../DESIGN.md) sections 1-3, 5.1, 6, 7; root [README.md](../README.md) (status table); the packages named in the diagram below. Where this page and the code differ, the code wins (see the status column in [section 5](#5-what-is-implemented-today)).

## 1. The problem

The host app is a hybrid app: a native shell (Home/Common, Flights, Hotels) plus React Native lines of business (LoBs: Bus, Rails, Cabs, Holidays, Chatbot/Travelplex, more to come). RN 0.78 (bridgeless/Fabric), Hermes, Metro 0.81. The first screen is native and RN surfaces open on demand. See [DESIGN.md 1](../DESIGN.md).

A monthly release train (freeze, dev test, release-branch merge, QA sign-off, Android then iOS) costs about 40% of bandwidth, and a fix that misses the cut waits a month. This system lets a LoB ship a JavaScript-only fix after the cut, to a percentage of devices, and roll it back in minutes, without touching the train and without a new server.

## 2. What it is and is not

| It is | It is not |
|---|---|
| A way to ship **Hermes bytecode patches** for one **unit** (a LoB, or the special unit `host`) against the exact bundle embedded in a given app version | A general OTA/CodePush clone that replaces whole bundles; patches are binary diffs against the embedded bytes ([ADR-0003](architecture/decisions/README.md)) |
| Built on Metro + Hermes + the current RN, no bundler migration | A Re.Pack/webpack setup ([ADR-0002](architecture/decisions/README.md)) |
| Static files: one signed `manifest.json` per platform and app version on a CDN; the device decides its own rollout bucket | A server, a telemetry pipeline or an auto-halt system. LoBs judge health with their own analytics ([DESIGN.md 9](../DESIGN.md)) |
| A set of build-time rules that **block** bad structure (cycles, cross-LoB imports, dynamic requires) instead of accommodating it | Something that fixes LoB code quality. A LoB that fails the rules stays in the host and is not patchable |
| JS-only: no native code, no new native modules, no new assets (assets rule is planned) | Able to patch native code or anything the store forbids |

## 3. Goals and non-goals (from [DESIGN.md 2](../DESIGN.md))

Goals: G1 ship after the cut in hours/days; G2 relieve train sign-off pressure; G3 staged, observable, reversible rollouts (rollback in minutes); G4 LoBs release independently (approval only from the LoB's own team); G5 make bad design visible and blocking.

Non-goals: patching native code; LoBs that break unit rules; cross-LoB atomic releases (they wait for the train); automating cleanup.

Design tenets that decide disputes: reuse existing systems (git, Jira, Jenkins, artifact store, CDN); no new server or analytics; audit and authorization beat simplicity and cost; no toolchain change ([DESIGN.md 3](../DESIGN.md)).

## 4. The end-to-end picture

```
 DEVELOPER (LoB team)                                        COMMON TEAM (owns base + pipeline)
 ------------------                                          ---------------------------------
 fix merged into monorepo branch ota/<unit>/<version>        base release (the train): builds embedded bundles
        |                                                    -> base.json (hashes of host.hbc + every unit.hbc,
        | tools/ota-propose.mjs <unit> <version>                hermesc sha256, HBC version) in the artifact store
        v
 PR in ota-deployments repo:  <version>/<unit>.json = {branch, sha}      "pin"  (human, reviewed, in git)
        |
        | VERIFY (Jenkins job: PLANNED. Today the pieces exist: ota-build + ota-core verifyPinPr(), nothing calls them together)
        |   ota-build bundle      Metro + unit-splitter -> host.js, units/*.js, ids.json, units.json
        |                         hermesc -O -emit-binary -g0 -> host.hbc, units/*.hbc, build.json
        |   ota-build patch       hdiffz (zstd) base.hbc -> new.hbc, round trip with the app's C++ apply,
        |                         `full` fallback if patch > 0.6 x zstd(new) -> patch-report.json
        |   ota-core verify       one commit/one file, one-unit rule, size soft/hard limits, (Jira: deferred)
        v
 owner team approves + merges the pin PR            (merging changes nothing for users)
        |
        | PR comment: ota-deploy   -> Jira ticket -> owner approves (never the requester)
        v
 DEPLOY JOB (Jenkins; today emulated by ota-cli)   <- only holder of signing key + CDN write
        |  lock per app version; read ota-state/<version>/vN; [planned] rebuild, require hashes == verify report
        |  apply change (new patch at 0%) -> validate -> sign (Ed25519, detached) -> write v(N+1) (immutable)
        |  deploy manifest.json + manifest.json.sig (+ patch files) to CDN; purge
        v
 ARTIFACT STORE  ota-state/<version>/vN/{android,ios}/manifest.json(+.sig), audit.json
 CDN             <cdn>/<platform>/<app-version>/manifest.json, manifest.json.sig, <unit>-pr<N>.<hash12>.patch
        |
        |  ota-rollout 5 | 25 | 50 | 100   (each ramp approved)    ota-rollout 0 = HALT (no approval)
        v
 DEVICE (native SDK: C++ orchestrator `otaruntime` + `otacore`, platform glue)
        1. conditional GET manifest, verify signature, anti-replay (version >= highest seen)
        2. bucket = sha256(deviceId \n unit) -> [0,1); pick the entry whose range contains it
        3. download patch, apply to the EMBEDDED unit (HDiffPatch), verify sha256, keep built unit
        4. native entry point tap -> openUnit("cabs"): pre-evaluate checks -> evaluate .hbc -> __otaRequire(entry)
        5. markReady after first healthy render; crash-loop guard blacklists unconfirmed patches
        any failure at any step -> embedded unit (always the fallback)
```

Compact form: **code change -> pin PR -> verify -> approve -> `ota-deploy` (0%) -> `ota-rollout N` -> device**. The state (what is published, at what percentage) is the signed manifest itself, stored as immutable versions `ota-state/<version>/vN` ([ADR-0006](architecture/decisions/README.md), [03-manifest-state-and-signing.md](architecture/03-manifest-state-and-signing.md)).

## 5. What is implemented today

| Part | Path | Status |
|---|---|---|
| Shared logic: manifest, bucket, select, ladder, signing, audit, authz, verify | [packages/ota-core](../packages/ota-core) | implemented, TypeScript, conformance vectors for native |
| Deploy-job emulator: local artifact store, local CDN, lock, `init/deploy/rollout/halt/restore/show/verify/reconcile` | [packages/ota-cli](../packages/ota-cli) | implemented against local-fs adapters; real Jenkins/S3/CDN/KMS adapters **not done** ([ports-and-adapters](reference/ports-and-adapters.md)) |
| Metro split into host + units, rule engine | [packages/unit-splitter](../packages/unit-splitter) | implemented (Metro 0.81.x and 0.87.x) |
| Bundle -> hermesc -> patch pipeline, `doctor` | [packages/ota-build](../packages/ota-build) | implemented |
| C++ core (sha256, bucket, selection, manifest, patch apply, cache GC) and the orchestrator | [native/otacore](../native/otacore), [native/otacore/runtime](../native/otacore/runtime) | implemented, tested with simulations |
| Android glue | [examples/spike-app/android](../examples/spike-app/android) | spike quality, S1-S10 pass on an emulator |
| iOS glue | [examples/spike-app/ios](../examples/spike-app/ios) | compiled for the simulator SDK, **never run** |
| Jenkins jobs, Jira integration, `lazyUnit` runtime package, reusable Android library / iOS pod, asset rule, native-module scan, eager units | | **planned / not started**; see the NOT DONE YET list in [guides/adopting-in-your-monorepo.md](guides/adopting-in-your-monorepo.md) |

Details and numbers: [spikes/summary.md](spikes/summary.md).

## 6. Actors

| Actor | Role in the flow | Where it shows up |
|---|---|---|
| **LoB team** | Owns a unit; merges fixes to `ota/<unit>/<version>`, opens pin PRs, requests deploys/ramps, approves for its own unit (never for its own request) | `units.json` owner team; [authz.ts](../packages/ota-core/src/authz.ts) |
| **Common team** | Owns `host`, the base bundle, the splitter, the pipeline, `units.json`, size limits; the `host` lane needs the super-admin team | [DESIGN.md 7.4](../DESIGN.md) |
| **Jenkins** | Verify job, deploy job (the only writer of state, KMS signer, CDN writer), reconcile job, base release job | planned; emulated by `ota-cli` |
| **Artifact store** | `ota-base/`, `ota-patches/`, `ota-state/` (immutable, versioned) | `ArtifactStorePort` |
| **CDN** | Serves manifest, signature, patches | `CdnPort` |
| **SDK** | On-device: fetch/verify/select/apply/evaluate/confirm/fallback | [05-client-runtime.md](architecture/05-client-runtime.md) |
| **VM** | The Hermes runtime. A unit is evaluated once per VM and pinned for its life | [glossary: per-VM pin](glossary.md) |
| **Jira / GitHub Enterprise** | Approvals, tickets, teams (SSO), CODEOWNERS, branch protection | [04-release-workflow.md](architecture/04-release-workflow.md); Jira integration not done |

## 7. Where to go next

[docs/README.md](README.md) has reading paths per audience. Terms: [glossary.md](glossary.md). Safety summary: [06-safety-and-failure-modes.md](architecture/06-safety-and-failure-modes.md).
