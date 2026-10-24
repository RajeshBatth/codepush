# Ports and adapters

**Purpose:** Contracts of the four ports the deploy job depends on, their invariants, and how to write and certify a real adapter (Jenkins artifact store, CDN, KMS, GitHub).
**Audience:** Engineers wiring the job into Jenkins/cloud infrastructure; AI assistants asked to "add an S3 store" or similar.
**Source of truth:** [`packages/ota-cli/src/ports.ts`](../../packages/ota-cli/src/ports.ts) (the JSDoc is normative), [`job.ts`](../../packages/ota-cli/src/job.ts), local adapters in [`src/adapters/`](../../packages/ota-cli/src/adapters/), conformance suites in [`test/conformance/`](../../packages/ota-cli/test/conformance/), [`packages/ota-cli/README.md`](../../packages/ota-cli/README.md). Rationale: [DESIGN.md](../../DESIGN.md) 7.1, 7.7, 10.

## Shape

`job.ts` (authorize -> lock -> read verified latest -> apply -> sign -> write immutable `vN+1` -> publish to CDN) imports only `@ota/core` and `ports.ts`. Everything it touches is injected through `JobContext`:

```ts
interface JobContext {
  store: ArtifactStorePort; cdn: CdnPort; signer: SignerPort; directory: TeamDirectoryPort;
  units: UnitsConfig;      // governance units.json, already parsed
  cdnBaseUrl: string;      // prefix of patchUrl in manifests
  now?: () => Date;        // test seam
}
```
Entry points to call from your Jenkins wrapper: `initVersion`, `runCommand`, `reconcile`, `verifyStore` (all in `job.ts`; wiring example: `context()` in [`cli.ts`](../../packages/ota-cli/src/cli.ts)).

**Sync or async.** Every port method returns `T | Promise<T>` (`MaybePromise`). The job `await`s each call; a sync throw equals a rejection. The authorize step resolves team membership asynchronously first, then runs the synchronous `authorize` from ota-core (`authorizeAsync` in `job.ts`).

| Port | Local adapter in repo | Production (planned, not implemented) |
|---|---|---|
| `ArtifactStorePort` | `LocalFsArtifactStore` (`adapters/local-fs/store.ts`) | Jenkins artifact store / S3 / GCS |
| `CdnPort` | `LocalFsCdn` (`adapters/local-fs/cdn.ts`) | CDN origin + cache purge |
| `SignerPort` | `LocalEd25519Signer` (`adapters/local-ed25519.ts`, PEM key in process) | KMS Ed25519 |
| `TeamDirectoryPort` | `StaticTeamDirectory` (`adapters/local-teams.ts`, `teams.json`) | GitHub Enterprise API |

No remote adapter exists in this repo. Layout the store must expose: [file-formats.md#state-layout](file-formats.md#state-layout).

## ArtifactStorePort

Methods: `writeBase`, `readBase`, `liveVersions` · `putPatch`, `patchPath` · `stateVersions`, `latestVersion`, `readState`, `writeState`, `allAudits` · `withLock`; optional `leaseMs`.

Invariants (numbering as in `ports.ts`):
1. **Immutability.** A written state version is never modified or deleted by the port; a patch key always maps to the same bytes.
2. **Create-if-absent.** `writeState(app, n, ...)` throws if `v<n>` exists, enforced by the store (conditional put, exclusive create, rename-no-replace), not only by the lock.
3. **Atomicity.** All-or-nothing: no reader ever sees a version missing a platform, signature or audit; a failed write leaves nothing and can be retried.
4. **Exact bytes.** `readState().raw[p]` is byte-identical to what was written (signatures are verified over these bytes, never over a re-serialization).
5. **Monotonic versions.** `latestVersion` = max of `stateVersions`, ascending; contiguity is not enforced by the store (`verifyStore` reports gaps).
6. **Lock exclusion.** At most one `withLock` callback per app version across all processes sharing the store; different versions do not block each other; released on resolve or reject; on timeout reject with a message matching `/timed out/` without running `fn` (default 15000 ms).
7. **Read-your-writes** (strong consistency).

Other contract details: `writeBase` creates or replaces (replace is only used to set `retired`); `putPatch(file)` stores `ota-patches/<hash12>-<basename>`, idempotent, returns `{key, fileHash12, size}`; `patchPath(key)` returns a LOCAL readable path (a remote adapter downloads to a cache); `liveVersions()` = versions with a base record that is not `retired`.

**The lock is a lease.** A dead holder must not block a version forever: expire after `leaseMs` (default 10 min, `DEFAULT_LEASE_MS`), detect a provably dead holder sooner if possible, release only by owner token. `leaseMs` must exceed the longest critical section; create-if-absent still prevents a lost update if a holder is preempted anyway. The local adapter keeps `ota-state/<v>/.lock/owner.json` = `{token,pid,host,acquiredAt}`.

## CdnPort

Methods: `publish(platform, version, signed, patchFiles)`, `readSigned`, `servedVersion`, `readManifest`, `hasFile`.

1. **Ordering.** Patch files durable and readable first, then the signature, the manifest LAST (commit point). If a patch cannot be stored, `publish` throws and the previously served manifest is unchanged.
2. **Atomic swap** of the manifest and of the signature individually (never a torn file). Pair consistency (2b): the only inconsistent pair a reader can see is {old manifest, new signature}, which fails signature verification (fails safe). **Clients must treat a signature mismatch as transient**: keep the current manifest, retry with backoff, alarm only after retries are exhausted (the native runtime does this, see [native-api.md](native-api.md)). A backend that can flip one pointer to a versioned prefix may remove the window without a wire change.
3. **Idempotent**: existing patch names keep their object (names embed the content hash); publishing the same manifest twice is harmless (reconcile relies on it).
4. **Exact bytes** from `readSigned` (signature modulo surrounding whitespace).
5. **No deletes**: old patches stay for devices still on older manifests.

Served names: `<platform>/<version>/manifest.json`, `manifest.json.sig`, patch files (`hasFile` answers for all three kinds). Cache purge for the manifest is the adapter's job (planned; the local adapter has none).

## SignerPort

`sign(bytes) -> base64`, `verify(bytes|string, sigBase64) -> boolean`, `publicKeyPem` (SPKI PEM; the key apps embed).
1. Ed25519 pure (no prehash), detached, over exactly the bytes given; algorithm not negotiable.
2. `sign` deterministic per (key, bytes); a KMS adapter must not add framing.
3. `verify` true iff signed by the same key pair; never throws (malformed -> false). Used to refuse building on tampered state.
4. `verify` agrees with `publicKeyPem`.

Key rotation (current + next key, key id in the signature file) is designed but not implemented: DESIGN.md 5.8 "Keys" [DECIDE].

## TeamDirectoryPort

`isMember(team, user)`: unknown team/user -> `false`, must not throw for "not found"; throwing aborts the job (fail closed). Production: GitHub Enterprise teams synced from SSO; cache per job run.

## Writing and certifying an adapter

1. Implement the interface in your own module (e.g. `adapters/s3/store.ts`); do not change `job.ts`.
2. Copy [`test/conformance.test.ts`](../../packages/ota-cli/test/conformance.test.ts), replace the factories. Each factory call must return a FRESH, EMPTY instance (use a unique prefix per call):
```ts
import { runStoreConformance } from './conformance/store.conformance.ts';
import { runCdnConformance } from './conformance/cdn.conformance.ts';
runStoreConformance(async () => {
  const store = new MyArtifactStore({ prefix: `conf-${crypto.randomUUID()}/` });
  return { adapter: store, dispose: () => store.deleteAll() };
}, { makeSecondHandle: (first) => new MyArtifactStore({ prefix: (first as MyArtifactStore).prefix }) });
runCdnConformance(() => ({ adapter: new MyCdn(freshOrigin()), dispose: cleanup }), { signer: mySigner });
```
3. Run `node --test path/to/your.test.ts` (Node >= 24, TypeScript by type stripping).
4. If you implement leases, expose `leaseMs` and pass `crashedHolder: { leaseMs, plant }` so the crashed-holder case runs.
5. Async adapters: nothing special; see [`test/async-adapters.ts`](../../packages/ota-cli/test/async-adapters.ts) (`asyncify` wraps local adapters with 0-5 ms delays) and `async-adapters.test.ts`.

What the suites check (store): base round trip and retire; `putPatch` idempotent and content addressed; exact bytes; create-if-absent with exactly one winner under a race; failed/partial writes invisible and retryable; numeric-monotonic `latestVersion`; audits ordered; lock serialization, per-version independence, timeout without running `fn`, release after throw, exclusion across two handles, crashed-holder takeover. CDN: nothing published, exact-byte round trip, failed patch upload keeps the previous manifest, served manifest implies its patches, repeated swaps never torn, republish harmless. Related tests: [`lease-and-pair.test.ts`](../../packages/ota-cli/test/lease-and-pair.test.ts) (CDN pair interleavings via `LocalFsCdn.hooks` test seams), [`job.test.ts`](../../packages/ota-cli/test/job.test.ts) (scenarios in sync and async mode).

## Known gaps

- No Jenkins job definitions, Jira validation, real GitHub membership, KMS signer or remote store/CDN exist (only the ports). See [adopting-in-your-monorepo.md](../guides/adopting-in-your-monorepo.md).
- Cross-host lease recovery is by `leaseMs` only (local adapter detects dead pids on the same host).
- The job does not itself re-check Jira, the stale-pin rule, or size limits; verify-time checks live in `verifyPinPr` ([04-release-workflow.md](../architecture/04-release-workflow.md)).
