/**
 * Ports of the deploy job (DESIGN.md 7.1, 7.7, 10). The job logic in job.ts depends ONLY on these interfaces;
 * `src/adapters/**` holds the local-filesystem / local-Ed25519 implementations used by tests and the CLI.
 * To run against Jenkins + an artifact store + a CDN + KMS, implement the four ports and pass them in a `JobContext`.
 * Every implementation MUST pass the conformance suites in `test/conformance/` (see README "Ports and adapters").
 *
 * SYNC OR ASYNC: every method of every port returns `T | Promise<T>`. An adapter may be synchronous (the local ones)
 * or asynchronous (S3/GCS artifact store, HTTP CDN, KMS, GitHub API); the job (job.ts) `await`s every call, so both
 * behave identically. A synchronous throw and a rejected promise are equivalent failures. The conformance suites await
 * every call and run against both flavours (test/async-adapters.test.ts wraps the local adapters in delayed proxies).
 *
 * Terminology: "app version" = the binary release line (e.g. "11.9.0"); "state version" `n` = the monotonic integer of
 * the manifest set (v1 written by `init`, then one per command).
 */
import type { AuditRecord, BaseInfo, Manifest, Platform, SignedManifest } from '@ota/core';

/** Ports return `T | Promise<T>`: adapters may be sync or async. */
export type MaybePromise<T> = T | Promise<T>;

/** What `ArtifactStorePort.readState` returns. */
export interface StoredState {
  /** parsed from `raw[p].json` */
  manifests: Record<Platform, Manifest>;
  /** the EXACT signed bytes that were written (what must be verified; never re-serialize) */
  raw: Record<Platform, SignedManifest>;
  audit: AuditRecord;
}

/** Result of `putPatch`. */
export interface PutPatchResult {
  /** store key, `<fileHash12>-<basename>`; stable function of (content, basename). Pass it to `patchPath`. */
  key: string;
  /** first 12 hex chars of sha256(file content) */
  fileHash12: string;
  /** byte size of the content */
  size: number;
}

/**
 * The CI artifact store: durable, authoritative record of base releases, patch files and the immutable signed state
 * history. Logical layout (DESIGN.md 7.1): `ota-base/<app>/base.json`, `ota-patches/<hash12>-<name>`,
 * `ota-state/<app>/v<N>/{android,ios}/manifest.json(+.sig) + audit.json`.
 *
 * INVARIANTS every adapter MUST guarantee:
 *  1. IMMUTABILITY: a state version, once `writeState` returned, is never modified or deleted by this port. A patch
 *     key, once present, always maps to the same bytes.
 *  2. CREATE-IF-ABSENT: `writeState(app, n, ...)` throws if `ota-state/<app>/v<n>` already exists, enforced BY THE STORE
 *     (conditional put / exclusive create / rename-no-replace), not only by the lock. The existing version stays byte-identical.
 *  3. ATOMICITY: `writeState` is all-or-nothing. A reader (`stateVersions`, `latestVersion`, `readState`, `allAudits`)
 *     must never observe a version with a missing platform, a missing signature or a missing audit, nor one that is
 *     half written. If the write throws for any reason, the version does not exist afterwards and can be written again.
 *  4. EXACT BYTES: `readState(...).raw[p]` is byte-for-byte what `writeState` received (`json` verbatim; `sig` equal to
 *     the written value modulo surrounding whitespace). Signatures are verified over these bytes.
 *  5. MONOTONIC VERSIONS: `latestVersion` is the max of `stateVersions` and never decreases. `stateVersions` is ascending.
 *     (Contiguity is NOT enforced by the store; `verifyStore` reports gaps. The job writes `latest + 1` under the lock.)
 *  6. LOCK EXCLUSION: for the same app version at most one `withLock` callback runs at a time across ALL processes/agents
 *     that share the store; different app versions never block each other. The lock is released when the callback
 *     settles (resolve or reject) and when acquisition times out nothing is left held.
 *  7. READ-YOUR-WRITES: after `writeState` / `writeBase` / `putPatch` returns, every subsequent read through the same
 *     store (any process) sees it (strong consistency; an eventually consistent store needs a consistent index in front).
 */
export interface ArtifactStorePort {
  /** Optional capability: the lock lease in milliseconds (see `withLock`). */
  readonly leaseMs?: number;

  // ---- base releases (written by the base release job; `init` calls writeBase) ----

  /** Create or REPLACE `ota-base/<base.appVersion>/base.json`. Replace is only used to set `retired: true`. Idempotent. */
  writeBase(base: BaseInfo): MaybePromise<void>;
  /** Throws `no base release recorded for <version>` if absent. */
  readBase(version: string): MaybePromise<BaseInfo>;
  /** App versions that have a base record and are not `retired`. Order unspecified. */
  liveVersions(): MaybePromise<string[]>;

  // ---- patches (content addressed) ----

  /**
   * Store the file at local path `file` as `ota-patches/<hash12>-<basename>`. IDEMPOTENT: storing the same
   * content+basename again is a no-op returning the same result; it never rewrites an existing key. Different content
   * with the same basename yields a different key (the hash is part of it).
   */
  putPatch(file: string): MaybePromise<PutPatchResult>;
  /** A LOCAL readable file path holding the patch bytes for `key` (adapters backed by remote storage download to a cache). Throws if unknown. */
  patchPath(key: string): MaybePromise<string>;

  // ---- state history ----

  /** Ascending state versions that exist for `version` (only fully written ones). `[]` if none. */
  stateVersions(version: string): MaybePromise<number[]>;
  /** Highest entry of `stateVersions`, or `null`. */
  latestVersion(version: string): MaybePromise<number | null>;
  /** Throws `state <app>/v<n> does not exist` if absent. */
  readState(version: string, n: number): MaybePromise<StoredState>;
  /** CREATE-IF-ABSENT and ATOMIC (invariants 2 and 3). Throws `... already exists (immutable)` if v<n> exists. `signed` must contain every platform. */
  writeState(version: string, n: number, signed: Record<Platform, SignedManifest>, audit: AuditRecord): MaybePromise<void>;
  /** Audit records of all existing state versions, ordered by state version ascending. */
  allAudits(version: string): MaybePromise<AuditRecord[]>;

  // ---- lock ----

  /**
   * Run `fn` holding the exclusive lock of app version `version` (invariant 6) and return its result. Waits for the
   * lock up to `timeoutMs` (default 15000) then rejects with an error matching /timed out/ WITHOUT running `fn`.
   * Not re-entrant.
   *
   * THE LOCK IS A LEASE. A holder that dies (agent killed, node lost, network partition) must NOT block the version
   * forever: an adapter must expire a lock after a lease (`leaseMs`, default 10 minutes, configurable) so that the next
   * `withLock` can take it over, and SHOULD also detect a provably dead holder sooner (same host + dead pid; Jenkins:
   * the lockable resource is released when the build ends; DynamoDB/S3: conditional put with a TTL). Consequences:
   *  - `leaseMs` MUST be longer than the longest critical section (a holder that outlives its lease can be preempted;
   *    the store's create-if-absent `writeState` (invariant 2) still prevents a lost update in that case);
   *  - a released/preempted lock is only removed by its own owner token (a late `finally` of a preempted holder never
   *    deletes the new holder's lock);
   *  - waiting keeps the `timeoutMs` semantics: if the lock is neither free nor expired within `timeoutMs`, reject /timed out/.
   * Adapters that implement leases SHOULD expose the effective value as the optional `leaseMs` property
   * (the conformance suite then runs the crashed-holder case, see `StoreConformanceOptions.crashedHolder`).
   */
  withLock<T>(version: string, fn: () => Promise<T> | T, timeoutMs?: number): Promise<T>;
}

/**
 * The CDN origin that devices read: `<platform>/<app-version>/manifest.json`, `manifest.json.sig` and the patch files
 * next to them. Only the deploy job writes.
 *
 * INVARIANTS every adapter MUST guarantee:
 *  1. ORDERING: `publish` makes the patch files durable and readable FIRST, then the signature, then the manifest
 *     LAST. A served manifest therefore never references a missing patch file. If any patch cannot be stored, `publish`
 *     throws and the previously served manifest (or absence) is unchanged.
 *  2. ATOMIC MANIFEST SWAP: each of the manifest and the signature is replaced atomically (never a torn file). The
 *     manifest is the commit point of a publish. Between the signature swap and the manifest swap a reader can see
 *     the old manifest with the new signature; devices reject that by the signature check and retry, and adapters
 *     SHOULD shrink the window (e.g. publish both under a versioned key and flip a single pointer).
 *  2b. PAIR CONSISTENCY (the manifest and its detached signature are two objects): the write order is
 *     patches -> SIGNATURE -> MANIFEST, so the only inconsistent pair a reader can observe is {old manifest, new
 *     signature} (never a manifest with a missing signature, never a half written file). That pair fails signature
 *     verification, so the window fails SAFE: nothing unsigned or wrongly signed is accepted. A reader that fetches the
 *     two objects non-atomically can additionally see {old manifest, new signature} or, if it reads the manifest
 *     before and the signature after a swap, {old manifest, new signature} again; every such pair fails verification.
 *     THE SDK/CLIENT MUST THEREFORE TREAT A SIGNATURE MISMATCH AS A TRANSIENT FAILURE: keep the manifest it already
 *     has (do not downgrade, do not apply the new one), retry with backoff (the native runtime does this, see
 *     native/otacore/runtime), and only alarm after the retries are exhausted (a persistent mismatch means tampering
 *     or a failed publish: `ota verify` / `ota reconcile`). Do NOT redesign this into one object without a wire
 *     format change; an adapter whose backend can publish a pair atomically (single versioned prefix + pointer flip) may.
 *  3. IDEMPOTENT PATCHES: publishing a patch name that already exists keeps the existing object (names embed the content hash).
 *     `publish` of the same manifest twice is harmless (reconcile relies on it).
 *  4. EXACT BYTES: `readSigned` returns the `json` bytes that were published verbatim, and the `sig` (modulo surrounding whitespace).
 *  5. NO DELETES: this port never removes files (old patches stay for devices still on older manifests).
 */
export interface CdnPort {
  /** `patchFiles[i].path` is a LOCAL readable file (from `ArtifactStorePort.patchPath`); it is served as `<platform>/<version>/<name>`. */
  publish(platform: Platform, version: string, signed: SignedManifest, patchFiles: { name: string; path: string }[]): MaybePromise<void>;
  /** The currently served manifest + signature bytes, or `null` if nothing is served. */
  readSigned(platform: Platform, version: string): MaybePromise<SignedManifest | null>;
  /** `manifest.version` of the served manifest, or `null`. */
  servedVersion(platform: Platform, version: string): MaybePromise<number | null>;
  /** Parsed served manifest, or `null`. */
  readManifest(platform: Platform, version: string): MaybePromise<Manifest | null>;
  /** True if `<platform>/<version>/<name>` is served (patch files and `manifest.json`/`manifest.json.sig`). */
  hasFile(platform: Platform, version: string, name: string): MaybePromise<boolean>;
}

/**
 * Signs manifest bytes. In production the private key lives in KMS and never reaches the job.
 *
 * INVARIANTS:
 *  1. Ed25519 (pure, no prehash) detached signature over the exact bytes given, returned as base64. Devices verify it
 *     with the public key embedded in the app, so the algorithm is not negotiable.
 *  2. `sign` is deterministic per (key, bytes) (Ed25519 is; a KMS adapter must not add framing).
 *  3. `verify(bytes, sig)` is true iff `sig` is a valid signature of `bytes` by the SAME key pair as `sign`; never throws
 *     (malformed input -> false). It is used to refuse building on tampered state.
 *  4. `publicKeyPem` (SPKI PEM) is the key devices embed; `verify` must agree with it.
 */
export interface SignerPort {
  sign(bytes: Uint8Array): MaybePromise<string>;
  verify(bytes: Uint8Array | string, sigBase64: string): MaybePromise<boolean>;
  readonly publicKeyPem: string;
}

/** GitHub team membership lookup (Jenkins/GitHub Enterprise API in production; a JSON file for the CLI). */
export interface TeamDirectoryPort {
  /** True iff `user` is a member of `team`. Unknown team/user -> false. Must not throw for "not found"; throwing aborts the job (fail closed). */
  isMember(team: string, user: string): MaybePromise<boolean>;
}
