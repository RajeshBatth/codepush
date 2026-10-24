// Shared builders for the conformance suites. Adapter-independent: they only construct port arguments.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORMS, makeAudit, serializeManifest, sha256, type AuditRecord, type BaseInfo, type Manifest, type Platform, type SignedManifest } from '@ota/core';

export type MaybePromise<T> = T | Promise<T>;
/** What a `make*` factory returns: the adapter under test plus an optional cleanup (called after each test). */
export interface Made<T> { adapter: T; dispose?: () => MaybePromise<void> }

export function scratchDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ota-conf-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function manifestFor(platform: Platform, appVersion: string, version: number): Manifest {
  return {
    schema: 1, platform, appVersion, patchAlgoVer: 'v1', version, ttlSec: 3600,
    mainBundle: { id: 'host', entries: [] }, units: [],
  } as unknown as Manifest;
}

/** Deterministic fake signatures: stores/CDNs must treat them as opaque bytes. */
export function signedFor(platform: Platform, appVersion: string, version: number, tag = ''): SignedManifest {
  const json = serializeManifest(manifestFor(platform, appVersion, version));
  return { json, sig: Buffer.from(`sig-${platform}-${appVersion}-${version}${tag}`).toString('base64') };
}
export function signedSet(appVersion: string, version: number, tag = ''): Record<Platform, SignedManifest> {
  return Object.fromEntries(PLATFORMS.map((p) => [p, signedFor(p, appVersion, version, tag)])) as Record<Platform, SignedManifest>;
}

export function auditFor(version: number, prev: AuditRecord | null = null): AuditRecord {
  return makeAudit(prev ? { record: prev } : null, {
    stateVersion: version, command: version === 1 ? 'init' : 'rollout', unit: null, patchId: null, params: {},
    requester: 'alice', approver: null, ticket: null, pr: null, sourceSha: null, jobUrl: null, ts: '2026-10-21T00:00:00.000Z',
  });
}

export function baseFor(appVersion: string, retired = false): BaseInfo {
  const P = (s: string) => ({ android: sha256(`${s}-a`), ios: sha256(`${s}-i`) });
  return {
    appVersion, releaseTag: `release/${appVersion}`, toolchainImage: 'img@sha256:1', patchAlgoVer: 'v1',
    hbc: { bytecodeVersion: 96, hermescSha256: sha256('hermesc') }, host: P('host'), units: {},
    sizes: { host: { android: 1, ios: 1 }, units: {} }, ...(retired ? { retired } : {}),
  };
}

export function writeTmpFile(dir: string, name: string, content: string | Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
