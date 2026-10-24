# ota-cli

## Purpose
The single Jenkins "deploy job" of DESIGN.md 7.7/10 as a library plus a thin CLI: `authorize -> lock -> read verified latest state -> apply command -> sign -> write immutable state vN+1 -> publish to the CDN`. The job logic depends ONLY on four ports (`ArtifactStorePort`, `CdnPort`, `SignerPort`, `TeamDirectoryPort`); this package ships local implementations (filesystem store/CDN, in-process Ed25519, JSON team file) so everything runs and is tested on one machine. The real Jenkins / artifact store / CDN / KMS / GitHub implementations are meant to be plugged in behind the same ports and certified with the conformance suites.

## Public API (modules / commands)
| module | exports |
|---|---|
| `src/ports.ts` | interfaces `ArtifactStorePort`, `CdnPort`, `SignerPort`, `TeamDirectoryPort` (all methods `T | Promise<T>`), types `MaybePromise`, `StoredState`, `PutPatchResult`. The JSDoc states the invariants every adapter MUST guarantee. |
| `src/job.ts` | `JobContext`, `initVersion`, `runCommand` (deploy / rollout / halt / restore), `reconcile`, `verifyStore` (async), request types (`Request`, `Who`, `PlatformBuild`). Imports only `@ota/core` and `ports.ts`. |
| `src/adapters/local-fs/` | `LocalFsArtifactStore` (lease lock, `leaseMs`), `DEFAULT_LEASE_MS`, `LocalFsCdn` |
| `src/adapters/local-ed25519.ts` | `LocalEd25519Signer` (PEM key in process; stand-in for KMS) |
| `src/adapters/local-teams.ts` | `StaticTeamDirectory` (`{team: [users]}`) |
| `src/index.ts` | re-exports all of the above |
| `src/cli.ts` | the `ota` command; the only place that wires the local adapters |

## Ports and adapters
```
            job.ts  (authorize, state machine, audit chain; no I/O of its own)
              |  JobContext { store, cdn, signer, directory, units, cdnBaseUrl, now? }
   +----------+-----------+------------+----------------+
   v                      v            v                v
ArtifactStorePort      CdnPort     SignerPort     TeamDirectoryPort
   |                      |            |                |
local-fs/store.ts   local-fs/cdn.ts  local-ed25519.ts  local-teams.ts      <- adapters in this repo
(Jenkins artifact store)  (CDN origin)   (KMS)       (GitHub Enterprise)    <- yours
```
| port | methods | invariants (full text in `ports.ts`) |
|---|---|---|
| `ArtifactStorePort` | `writeBase readBase liveVersions` · `putPatch patchPath` · `stateVersions latestVersion readState writeState allAudits` · `withLock` | state versions immutable; `writeState` create-if-absent enforced by the store and all-or-nothing; exact bytes returned; `latestVersion` monotonic; per-app-version lock exclusion across processes, with timeout (`/timed out/`) and release on throw; strong read-your-writes |
| `CdnPort` | `publish readSigned servedVersion readManifest hasFile` | patches first, then signature, then manifest (commit point); each file replaced atomically; same-manifest republish harmless; no deletes |
| `SignerPort` | `sign(bytes) -> base64`, `verify(bytes, sig)`, `publicKeyPem` | Ed25519 detached over the exact bytes, deterministic, `verify` never throws |
| `TeamDirectoryPort` | `isMember(team, user)` | unknown team/user -> false; errors abort the job (fail closed) |

**Sync or async.** Every method of every port returns `T | Promise<T>` (`MaybePromise` in `ports.ts`); `job.ts` `await`s every call, and `verifyStore` is `async`. A synchronous throw and a rejected promise are the same failure. The local adapters are synchronous; `test/async-adapters.ts` (`asyncify`) wraps them in proxies that answer after a random 0-5 ms delay, and both the conformance suites (`test/async-adapters.test.ts`) and the job scenarios (`test/job.test.ts`, mode `[async]`: concurrent commands under `withLock`, reconcile, tamper detection) run against the wrappers. `TeamDirectoryPort` answers are resolved before the (synchronous) `authorize` of ota-core runs.

**The lock is a lease.** `withLock` must not let a dead holder block a version forever. `LocalFsArtifactStore(root, { leaseMs })` (default 10 min, `DEFAULT_LEASE_MS`) keeps `ota-state/<v>/.lock/owner.json` = `{token, pid, host, acquiredAt}`, created atomically (temp dir renamed into place). A waiter steals a lock whose owner is on the same host and whose pid is dead, or which is older than `leaseMs`; waiting still ends with `/timed out/` after `timeoutMs`. Only the owner token releases (a preempted holder never deletes the new holder's lock). `leaseMs` must exceed the longest critical section; create-if-absent `writeState` still prevents a lost update if a holder is preempted anyway. Adapters expose the optional `leaseMs` property; the store conformance suite runs the crashed-holder case when given `crashedHolder: { leaseMs, plant }`.

**CDN pair consistency.** The manifest and its detached signature are two objects. `publish` writes patches, then the signature, then the manifest, so the only inconsistent pair a reader can see is {old manifest, new signature}, which fails verification (fail safe; a manifest is never served without a signature). **The SDK MUST treat a signature mismatch as a TRANSIENT failure**: keep the manifest it has, retry with backoff, alarm only when retries are exhausted (the native runtime does this: `native/otacore/runtime`). `test/lease-and-pair.test.ts` simulates the interleavings (`LocalFsCdn.hooks` test seams) and proves a reader that verifies never accepts an unverifiable pair.

### Conformance suites (certify your adapter)
`test/conformance/store.conformance.ts` and `cdn.conformance.ts` export `runStoreConformance(makeStore, opts?)` and `runCdnConformance(makeCdn, opts?)` (node:test). They check: base round trip and retire; `putPatch` idempotent and content addressed; `readState` returns exactly the written bytes; create-if-absent (and exactly one winner when two handles race); failed / partial writes never visible and retryable; `latestVersion` numeric-monotonic; audits ordered; lock serialization, per-version independence, timeout without running `fn`, release after throw/timeout, exclusion across two handles, and (optional `crashedHolder` capability) a crashed holder is taken over after the lease while a live one is respected; CDN: nothing-published, round trip of exact bytes, failed patch upload leaves the previous manifest, served manifest implies its patches, repeated swaps never torn, republish harmless. Every call is `await`ed, so async adapters pass too.

Run them against your adapter by copying `test/conformance.test.ts` and replacing the factories:
```ts
import { runStoreConformance } from './conformance/store.conformance.ts';
import { runCdnConformance } from './conformance/cdn.conformance.ts';
runStoreConformance(async () => {
  const store = new MyArtifactStore({ prefix: `conf-${crypto.randomUUID()}/` });   // EMPTY namespace per call
  return { adapter: store, dispose: () => store.deleteAll() };
}, { makeSecondHandle: (first) => new MyArtifactStore({ prefix: (first as MyArtifactStore).prefix }) });  // same data, second "agent"
runCdnConformance(() => ({ adapter: new MyCdn(freshOrigin()), dispose: cleanup }), { signer: mySigner });
```
`node --test path/to/your.test.ts`. The suites need no knowledge of your backend; a factory must return a fresh, empty instance per test.

## Commands with examples
`node src/cli.ts <command> [flags]` (flags: `--store DIR --cdn DIR --units units.json --teams teams.json --key private.pem --pub public.pem --cdn-base-url URL`). In production these flags come from the approved Jira ticket and PR.
```sh
node src/cli.ts keygen --out /tmp/ota/keys
node src/cli.ts init     --store S --cdn C --units units.json --teams teams.json --key K --pub P --base base.json --requester alice
node src/cli.ts deploy   ... --version 11.9.0 --unit cabs --pr 42 --patch-android a.hdiff --built-android sha256:... \
                             --patch-ios i.hdiff --built-ios sha256:... --requester alice --approver bob --ticket CAB-1
node src/cli.ts rollout  ... --version 11.9.0 --unit cabs --pr 42 --percent 10 --requester alice --approver bob --ticket CAB-1
node src/cli.ts halt | restore | show | verify | reconcile ...
```
`ota-build deploy-args` prints the exact `deploy` flags; `test/job.test.ts` ("CLI end to end") has a full sequence, including parallel processes racing on one version.

## How to run the tests
```sh
N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH   # nvm shells: node/npm are lazy functions
cd packages/ota-cli && npm install && npm test       # 76 tests: job scenarios x {sync, async} + CLI, conformance (sync + async adapters), lease, CDN pair, signer
node packages/ota-core/node_modules/typescript/bin/tsc --noEmit -p packages/ota-core/tsconfig.json   # typechecks ota-cli src+test
```
Node >= 24 (TypeScript by type stripping: erasable syntax only). Tests use `os.tmpdir()`; no external tools needed.

## Depends on / depended on by
- Depends on `@ota/core` (`file:../ota-core`): manifest/state/audit/authz logic, signing helpers. No other runtime dependency.
- Depended on by `packages/ota-build` tests (they drive the real `src/cli.ts` end to end) and by the Jenkins job definitions (not started).

## WHERE TO EXTEND
- **Jenkins artifact store**: implement `ArtifactStorePort` (create-if-absent via conditional put or `If-None-Match: *`; lock via Jenkins lockable resources or a lease object), then run `runStoreConformance` against it. Nothing in `job.ts` changes.
- **CDN**: implement `CdnPort` (upload patches, then `.sig`, then `manifest.json`; invalidate caches for the manifest only), run `runCdnConformance`.
- **KMS**: implement `SignerPort` with the KMS Ed25519 sign call; `publicKeyPem` is the key the apps embed.
- **GitHub Enterprise**: implement `TeamDirectoryPort.isMember` (cache per job run).
- **Wiring**: build a `JobContext` in your Jenkins entry point (see `context()` in `src/cli.ts`) and call `runCommand` / `initVersion` / `reconcile` / `verifyStore`.
- **New command**: add a case to `runCommand` in `job.ts` and the matching pure function in `@ota/core`; audit `params` is the extension point for command-specific data.

## Known limitations / not done
- The CDN pair window (old manifest + new signature) still exists on the local adapter; it fails safe and clients must retry (see above). A backend that can flip one pointer to a versioned prefix can remove it without a wire change.
- The local lease lock relies on a shared filesystem with atomic `rename` and on pid liveness only for same-host holders; a different-host crashed holder is recovered only after `leaseMs`. Real lease backends (conditional put with TTL) are yours to write; the conformance case checks the behavior.
- A remote adapter's `patchPath` must download to a local cache (the contract returns a local path).
- `writeBase` replaces (needed for `retired`); base records are not versioned.
- Jenkins job definitions, Jira ticket validation, GitHub API membership and KMS are not implemented here (only the ports).
