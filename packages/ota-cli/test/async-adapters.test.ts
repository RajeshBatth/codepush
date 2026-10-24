// The conformance suites against ASYNC adapters: the local-fs adapters behind proxies answering after a random 0-5 ms delay.
// (The job scenarios over async adapters run in job.test.ts, mode "async".)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from '@ota/core';
import { LocalEd25519Signer, LocalFsArtifactStore, LocalFsCdn, StaticTeamDirectory } from '../src/index.ts';
import { runStoreConformance } from './conformance/store.conformance.ts';
import { runCdnConformance } from './conformance/cdn.conformance.ts';
import { asyncify } from './async-adapters.ts';
import { plantForeignLock } from './lock-helpers.ts';

const fresh = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `ota-async-${tag}-`));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
};
const LEASE_MS = 600;

describe('ASYNC adapters', () => {
  runStoreConformance(() => {
    const { dir, dispose } = fresh('store');
    return { adapter: asyncify(new LocalFsArtifactStore(dir, { leaseMs: LEASE_MS })), dispose };
  }, {
    makeSecondHandle: (first) => asyncify(new LocalFsArtifactStore((first as LocalFsArtifactStore).root, { leaseMs: LEASE_MS })),
    crashedHolder: { leaseMs: LEASE_MS, plant: (s, v) => plantForeignLock((s as LocalFsArtifactStore).root, v) },
  });

  const signer = asyncify(new LocalEd25519Signer(generateKeyPair()));
  runCdnConformance(() => {
    const { dir, dispose } = fresh('cdn');
    return { adapter: asyncify(new LocalFsCdn(dir)), dispose };
  }, { signer });

  test('signer and directory behind promises keep their contract', async () => {
    const bytes = Buffer.from('{"a":1}');
    const sig = await signer.sign(bytes);
    assert.equal(await signer.sign(bytes), sig);
    assert.equal(await signer.verify(bytes, sig), true);
    assert.equal(await signer.verify(Buffer.from('{"a":2}'), sig), false);
    assert.equal(await signer.verify(bytes, 'not base64 !!'), false);
    const dir = asyncify(new StaticTeamDirectory({ t: ['u'] }));
    assert.equal(await dir.isMember('t', 'u'), true);
    assert.equal(await dir.isMember('t', 'x'), false);
    assert.equal(await dir.isMember('nope', 'u'), false);
  });
});
