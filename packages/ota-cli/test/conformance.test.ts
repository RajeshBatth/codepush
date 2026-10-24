// Runs the port conformance suites against the local adapters. An owner of another adapter copies this file and swaps the factories.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@ota/core';
import { LocalEd25519Signer, LocalFsArtifactStore, LocalFsCdn } from '../src/index.ts';
import { runStoreConformance } from './conformance/store.conformance.ts';
import { runCdnConformance } from './conformance/cdn.conformance.ts';
import { plantForeignLock } from './lock-helpers.ts';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const fresh = (tag: string): { dir: string; dispose: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), `ota-conf-${tag}-`));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
};

const LEASE_MS = 600;
runStoreConformance(() => {
  const { dir, dispose } = fresh('store');
  return { adapter: new LocalFsArtifactStore(dir, { leaseMs: LEASE_MS }), dispose };
}, {
  makeSecondHandle: (first) => new LocalFsArtifactStore((first as LocalFsArtifactStore).root, { leaseMs: LEASE_MS }),
  crashedHolder: { leaseMs: LEASE_MS, plant: (s, v) => plantForeignLock((s as LocalFsArtifactStore).root, v) },
});

runCdnConformance(() => {
  const { dir, dispose } = fresh('cdn');
  return { adapter: new LocalFsCdn(dir), dispose };
}, { signer: new LocalEd25519Signer(generateKeyPair()) });

describe('LocalEd25519Signer (SignerPort)', () => {
  const signer = new LocalEd25519Signer(generateKeyPair());
  test('sign/verify round trip; deterministic; tamper, wrong key and garbage -> false, never throw', () => {
    const bytes = Buffer.from('{"a":1}');
    const sig = signer.sign(bytes);
    assert.equal(signer.sign(bytes), sig);
    assert.equal(signer.verify(bytes, sig), true);
    assert.equal(signer.verify('{"a":1}', sig), true, 'string and bytes are the same UTF-8 payload');
    assert.equal(signer.verify(Buffer.from('{"a":2}'), sig), false);
    assert.equal(signer.verify(bytes, new LocalEd25519Signer(generateKeyPair()).sign(bytes)), false);
    assert.equal(signer.verify(bytes, 'not base64 !!'), false);
    assert.equal(signer.verify(bytes, ''), false);
  });
});
