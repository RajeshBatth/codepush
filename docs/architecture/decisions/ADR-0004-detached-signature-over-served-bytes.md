# ADR-0004: Detached signature over the exact served bytes

**Purpose:** Record why this decision was made and what follows from it.
**Audience:** Engineers changing the area; AI assistants checking a change against it.
**Source of truth:** [DESIGN.md 6, 10](../../../DESIGN.md), plus the code and tests under Links below.

**Status:** accepted. Signing and verification are implemented in `packages/ota-core`; native (CryptoKit / `java.security`) verification is **not done** (the runtime takes a `SignatureVerifier` interface). **Rationale:** [DESIGN.md 6, 10](../../../DESIGN.md).

## Context
Devices must never need to canonicalize JSON to verify it, and a signature must not be replayable across platforms or app versions.

## Decision
The CDN serves `manifest.json` (canonical JSON: sorted keys, no whitespace) and `manifest.json.sig` (base64 Ed25519 over those exact bytes). Devices verify the received bytes, then parse. `platform` and `appVersion` are inside the signed bytes; `version` is monotonic. The signing key lives in KMS and is held only by the deploy job; the public key (more than one, planned: current + next) is embedded in the binary.

## Consequences
- Native verifiers are trivial.
- A reader can briefly see an old manifest with a new signature during publish; it never verifies, the SDK keeps the old manifest and retries (proved by test).
- Key rotation needs several embedded keys and a key id in the signature file (open [DECIDE]).

## Links
Code: `packages/ota-core/src/manifest.ts` (`canonicalize`, `signManifest`, `verifyManifestBytes`). Tests: [core.test.ts](../../../packages/ota-core/test/core.test.ts) ("detached signature over served bytes"), [lease-and-pair.test.ts](../../../packages/ota-cli/test/lease-and-pair.test.ts) (mixed manifest/signature pairs), `native/tests/runtime/scn_manifest.cpp` (`rejected_manifests_keep_old`). Docs: [03-manifest-state-and-signing](../03-manifest-state-and-signing.md).
