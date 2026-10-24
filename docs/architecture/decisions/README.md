# Architecture decision records

**Purpose:** Short Context / Decision / Consequences records for the twelve decisions that shape the system. The full rationale stays in [DESIGN.md](../../../DESIGN.md); each ADR links the section and the tests that prove the behaviour.
**Audience:** Engineers who want to change something and need to know why it is the way it is; AI assistants deciding whether a proposed change contradicts a decision.
**Source of truth:** DESIGN.md sections cited per ADR; the tests cited per ADR. Status "accepted" means implemented unless the ADR says planned.

| ADR | Decision | Status |
|---|---|---|
| [0001](ADR-0001-unit-ownership-by-path.md) | A unit owns the modules under its declared roots; everything else is host | accepted, implemented |
| [0002](ADR-0002-one-metro-graph-custom-serializer.md) | One Metro graph partitioned by a custom serializer; no Re.Pack | accepted, implemented |
| [0003](ADR-0003-hdiffpatch-zstd.md) | Patches are HDiffPatch single compressed diffs (zstd), `full` as diff against empty | accepted, implemented |
| [0004](ADR-0004-detached-signature-over-served-bytes.md) | Detached Ed25519 signature over the exact served bytes | accepted; signing implemented in ota-core, native verification not done |
| [0005](ADR-0005-static-manifest-device-bucketing.md) | One static manifest per platform and app version; rollout bucketing on device | accepted, implemented |
| [0006](ADR-0006-state-as-versioned-immutable-artifact.md) | State is the signed manifest, stored as immutable versions | accepted, implemented against local-fs |
| [0007](ADR-0007-pr-comment-commands-owner-approval.md) | PR-comment commands; the unit's owner approves, never the requester; halt needs no approval | accepted; rules implemented, Jenkins/Jira not done |
| [0008](ADR-0008-native-driven-loading-cpp-orchestrator.md) | Native-driven loading with one C++ orchestrator behind injected interfaces | accepted; orchestrator implemented, real glue is spike quality |
| [0009](ADR-0009-host-provided-otarequire.md) | Entry modules run through a host-provided `__otaRequire` | accepted, verified on Android debug |
| [0010](ADR-0010-two-package-pattern.md) | Public host-owned package plus private patchable unit | accepted, implemented in checks |
| [0011](ADR-0011-per-vm-unit-pin.md) | A unit is resolved once per VM and pinned | accepted, implemented |
| [0012](ADR-0012-asset-rule.md) | Patches may only reference assets already in the binary | **planned**, not implemented |

To add an ADR: copy the shape of an existing one (Status, Context, Decision, Consequences, Links), number it next, add a row above, and link it from the glossary term it introduces.
