# ADR-0005: Static manifest with on-device bucketing

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 3, 6](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted, implemented. **Rationale:** [DESIGN.md 3, 6](../../../DESIGN.md).

## Context
There is no OTA server and no telemetry pipeline (tenet 2). A static file is identical for every client, so percentage rollout cannot be decided by the server.

## Decision
One manifest per `(platform, appVersion)`. Each patch entry carries a `range` over `[0,1)`. The device computes `bucket = uint32_be(sha256(deviceId \n unitName)[0..4]) / 2^32` once and uses the entry whose range contains it. Ranges of a unit's entries are disjoint; unassigned range means embedded. The `deviceId` is a random install-scoped UUID that never leaves the device.

## Consequences
- The CDN sees only anonymous conditional GETs; rollout and halt are manifest edits.
- Halt latency is bounded below by `ttlSec` plus the next sync, and does not fix a VM that already loaded the patch.
- The bucket function is a cross-language contract: `packages/ota-core/vectors/bucket.json` (24 vectors) and `select.json` (32 cases) are checked by both TypeScript and C++.

## Links
Code: `packages/ota-core/src/{bucket,select,ranges,ladder}.ts`, `native/otacore/src/select.cpp`. Tests: [core.test.ts](../../../packages/ota-core/test/core.test.ts) (bucket and select vectors, ladder), `native/tests/` (same vectors). Docs: [03-manifest-state-and-signing](../03-manifest-state-and-signing.md).
