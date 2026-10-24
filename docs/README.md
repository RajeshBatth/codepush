# Documentation index

**Purpose:** Entry point to the structured documentation of the OTA ("CodePush") tooling for a hybrid bare React Native 0.78 app, plus reading paths per audience.
**Audience:** New engineers, people adopting this code into another monorepo, and AI assistants (Cursor) working in the repo.
**Source of truth:** the code (it wins over any doc), [DESIGN.md](../DESIGN.md) (design spec and decision record, 679 lines; kept at the repo root and linked from here for rationale), [README.md](../README.md) (status table). Each doc below names its own sources in its header.

Conventions: "implemented" means code plus tests exist in this repo; "planned" means designed (DESIGN.md) but not written. Every doc keeps a 3-line header (Purpose / Audience / Source of truth). Terms are defined in [glossary.md](glossary.md).

## Reading paths

**(a) New engineer**
1. [00-overview.md](00-overview.md), then [glossary.md](glossary.md)
2. [architecture/01-units-and-ownership.md](architecture/01-units-and-ownership.md)
3. [architecture/02-build-and-patch-pipeline.md](architecture/02-build-and-patch-pipeline.md)
4. [architecture/03-manifest-state-and-signing.md](architecture/03-manifest-state-and-signing.md), [architecture/04-release-workflow.md](architecture/04-release-workflow.md)
5. [architecture/05-client-runtime.md](architecture/05-client-runtime.md), [architecture/06-safety-and-failure-modes.md](architecture/06-safety-and-failure-modes.md)
6. [spikes/summary.md](spikes/summary.md), then skim the [ADRs](architecture/decisions/README.md)
7. Hands on: [guides/shipping-a-patch.md](guides/shipping-a-patch.md), [guides/writing-a-unit.md](guides/writing-a-unit.md)

**(b) Adopting into a monorepo**
1. [00-overview.md](00-overview.md) (what you get and what you do not)
2. [guides/adopting-in-your-monorepo.md](guides/adopting-in-your-monorepo.md) (phased plan, risk register, NOT DONE YET list)
3. [guides/troubleshooting.md](guides/troubleshooting.md) (run Phase 0 first)
4. [guides/splitting-a-lob-into-a-unit.md](guides/splitting-a-lob-into-a-unit.md), [guides/two-package-pattern.md](guides/two-package-pattern.md), [reference/config-reference.md](reference/config-reference.md), [reference/rules-catalog.md](reference/rules-catalog.md)
5. [reference/ports-and-adapters.md](reference/ports-and-adapters.md) (what you must implement for Jenkins/store/CDN/KMS), [architecture/04-release-workflow.md](architecture/04-release-workflow.md)
6. [reference/native-api.md](reference/native-api.md), [guides/android-ios-integration.md](guides/android-ios-integration.md) (native SDK)
7. [guides/incident-runbook.md](guides/incident-runbook.md) before the first production patch

**(c) AI assistant**
1. This file, then [glossary.md](glossary.md) (use its words exactly), then [00-overview.md](00-overview.md).
2. Find the file for a task with the table below; read the doc's header "Source of truth" and open those code paths. If a doc and the code disagree, the code wins: say so and propose the doc fix.
3. Before changing behaviour read [architecture/06-safety-and-failure-modes.md](architecture/06-safety-and-failure-modes.md) and the relevant [ADR](architecture/decisions/README.md); keep the matching test green and update the table.
4. Never invent a feature: if a doc says "planned", it does not exist. Check [guides/adopting-in-your-monorepo.md](guides/adopting-in-your-monorepo.md) "NOT DONE YET".

## Where is the code for X?

| Task | Start in |
|---|---|
| Manifest, bucket, selection, ladder, state, audit, authz, PR verify | `packages/ota-core/src/` |
| Deploy job, CLI emulator, ports and local adapters | `packages/ota-cli/src/` (`job.ts`, `ports.ts`, `adapters/`) |
| Metro split, rules, module ids | `packages/unit-splitter/src/` (`analyze.js`, `checks.js`, `split.js`, `with-ota-units.js`) |
| hermesc, patch creation, doctor, hand-off to deploy | `packages/ota-build/src/` |
| C++ core and orchestrator | `native/otacore/` (`src`, `include`, `runtime/`) |
| Platform glue examples | `examples/spike-app/{shared,android,ios}` |
| JSON schemas | `schemas/` ([README](../schemas/README.md)) |
| Machine scripts | `scripts/`, `tools/` |

## Documents

### Top level
| Doc | One line |
|---|---|
| [00-overview.md](00-overview.md) | What the system is and is not, goals, one end-to-end diagram, actors, implementation status |
| [glossary.md](glossary.md) | Every term with a one-line definition and where it lives in code |

### architecture/
| Doc | One line |
|---|---|
| [01-units-and-ownership.md](architecture/01-units-and-ownership.md) | Ownership by path/package, host, direction and encapsulation rules, initializers |
| [02-build-and-patch-pipeline.md](architecture/02-build-and-patch-pipeline.md) | Splitter, hermesc recipe, HDiffPatch, round trip, reports, per-platform builds, reproducibility |
| [03-manifest-state-and-signing.md](architecture/03-manifest-state-and-signing.md) | Manifest, bucketing, ladder, state versions, audit hash chain, detached signature, anti-replay |
| [04-release-workflow.md](architecture/04-release-workflow.md) | Repos, branches, pin PR, verify checks, commands, approvals, halt, break-glass, live versions |
| [05-client-runtime.md](architecture/05-client-runtime.md) | Hybrid lifecycle, native-driven loading, orchestrator, per-VM pin, crash-loop guard, host swap |
| [06-safety-and-failure-modes.md](architecture/06-safety-and-failure-modes.md) | Failure to behaviour to enforcement to test table |
| [decisions/README.md](architecture/decisions/README.md) | Index of the 12 ADRs (ownership, Metro serializer, HDiffPatch, signature, manifest, state, approvals, native loading, `__otaRequire`, two packages, per-VM pin, asset rule) |

### reference/
| Doc | One line |
|---|---|
| [rules-catalog.md](reference/rules-catalog.md) | Every splitter and verify rule id: tier, severity, config key, trigger, message, fix |
| [config-reference.md](reference/config-reference.md) | `units.config.json`, governance `units.json`, pin file, `OTA_*` environment variables |
| [cli-reference.md](reference/cli-reference.md) | Every command of `ota-cli`, `ota-build`, the splitter CLI, `tools/`, `scripts/`, native tools |
| [file-formats.md](reference/file-formats.md) | Manifest, base, build, patch-report, units output, audit, state layout, with schemas |
| [ports-and-adapters.md](reference/ports-and-adapters.md) | The four ports, invariants, how to write and certify an adapter |
| [native-api.md](reference/native-api.md) | `otacore` C/C++ API and the orchestrator interfaces platform glue must implement |

### guides/
| Doc | One line |
|---|---|
| [adopting-in-your-monorepo.md](guides/adopting-in-your-monorepo.md) | Phased adoption plan, customisation points, risk register, NOT DONE YET list |
| [splitting-a-lob-into-a-unit.md](guides/splitting-a-lob-into-a-unit.md) | Declare one LoB as a unit and get a passing base build |
| [two-package-pattern.md](guides/two-package-pattern.md) | Public host-owned package plus private unit, worked example |
| [writing-a-unit.md](guides/writing-a-unit.md) | Conventions for unit code and how to test locally |
| [shipping-a-patch.md](guides/shipping-a-patch.md) | Fix to ramp, with the commands that exist today and what is manual or planned |
| [incident-runbook.md](guides/incident-runbook.md) | Halt, restore, break-glass, what a halt does not fix, verifying state |
| [android-ios-integration.md](guides/android-ios-integration.md) | Using the spike glue as a template; API facts and build fixes |
| [troubleshooting.md](guides/troubleshooting.md) | Symptom, cause, fix, including environment quirks |

### spikes/ and research/
| Doc | One line |
|---|---|
| [spikes/summary.md](spikes/summary.md) | What each spike proved and did not, with numbers |
| [research/rn-0.78-loader.md](research/rn-0.78-loader.md) | RN 0.78.3 source research on booting a patched host and evaluating a unit (unverified items marked) |

## Related files outside docs/
[DESIGN.md](../DESIGN.md) (rationale), [schemas/README.md](../schemas/README.md), [packages/ota-build/README.md](../packages/ota-build/README.md), [packages/ota-cli/README.md](../packages/ota-cli/README.md), [packages/unit-splitter/README.md](../packages/unit-splitter/README.md), [native/README.md](../native/README.md), [native/otacore/runtime/README.md](../native/otacore/runtime/README.md), spike notes under [examples/spike-app](../examples/spike-app/SPIKE.md).

## Maintenance rules
1. Code wins. When you change behaviour, change the doc in the same commit.
2. Do not hardcode test counts; they differ between existing READMEs.
3. Re-run the rule-id coverage check whenever `analyze.js`, `checks.js`, `public-api.js` or `verify.ts` change (see the end of [reference/rules-catalog.md](reference/rules-catalog.md) if present, or grep every `rule:`/`check` id).
4. Keep "implemented / planned" labels honest; update the NOT DONE YET list when something lands.
5. Keep terminology identical to [glossary.md](glossary.md).
