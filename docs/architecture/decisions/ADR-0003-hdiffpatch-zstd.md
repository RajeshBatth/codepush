# ADR-0003: HDiffPatch single compressed diff with zstd (`patchAlgoVer` v1)

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 5.1, 5.7, 7.8](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted, implemented. **Rationale:** [DESIGN.md 5.1, 5.7, 7.8](../../../DESIGN.md).

## Context
A patch is a diff against the embedded bytes of the exact app version (no chains, no negotiation). Hermes bytecode diffs are 30-180x larger than source diffs, and uncompressed diffs are 4-5x bigger than compressed ones.

## Decision
`hdiffz_tool -c zstd -l 19 -m 4` (`create_single_compressed_diff`). Applied on device by the same C++ the build uses to verify (`otacore::applyPatch`, atomic, hash-verified, streaming). A patch bigger than 0.6 x zstd(new) is emitted as `updateType: "full"`, the same format diffed against an empty old file, so there is one decoder. Any parameter change needs a new `patchAlgoVer` and therefore a new binary. lzma is supported by the apply code but not used.

## Consequences
- Patch size: about 14 KB for five literal tweaks on the open-source corpus; 80 B for a one-line unit change on the real spike host; a string-literal edit in host code costs 22-35 KB (probable string-table renumbering, not verified).
- Size limits must be defined against the zstd-compressed embedded unit, not raw size.
- The build must round-trip every patch before emitting it; only built hashes must be reproducible, not patch bytes.

## Links
Code: `packages/ota-build/src/patch.ts`, `native/otacore/src/patch.cpp`. Tests: [pipeline.test.ts](../../../packages/ota-build/test/pipeline.test.ts) (round trip, `full` fallback, tampered patch, garbage diff tool), `native/tests/test_patch.cpp`. Numbers: [spikes/summary.md](../../spikes/summary.md).
