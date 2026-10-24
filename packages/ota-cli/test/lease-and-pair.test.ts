// LocalFs lock lease (task: stale-lock recovery) and CDN manifest/signature pair consistency.
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from '@ota/core';
import { LocalEd25519Signer, LocalFsArtifactStore, LocalFsCdn, DEFAULT_LEASE_MS } from '../src/index.ts';
import { plantForeignLock } from './lock-helpers.ts';
import { manifestFor } from './conformance/fixtures.ts';
import { serializeManifest } from '@ota/core';

const V = '11.9.0';
const tmp = () => mkdtempSync(join(tmpdir(), 'ota-lease-'));
const lockDir = (root: string) => join(root, 'ota-state', V, '.lock');

describe('LocalFs lock lease', () => {
  test('default lease is 10 minutes and configurable', () => {
    const d = tmp();
    try {
      assert.equal(DEFAULT_LEASE_MS, 600_000);
      assert.equal(new LocalFsArtifactStore(d).leaseMs, 600_000);
      assert.equal(new LocalFsArtifactStore(d, { leaseMs: 42 }).leaseMs, 42);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('stale lock (older than leaseMs, foreign host) is stolen', async () => {
    const d = tmp();
    try {
      const s = new LocalFsArtifactStore(d, { leaseMs: 1000 });
      plantForeignLock(d, V, { acquiredAt: Date.now() - 5000 });
      assert.equal(await s.withLock(V, () => 'ran', 500), 'ran');
      assert.equal(existsSync(lockDir(d)), false, 'released afterwards');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('live lock (fresh, foreign host) is respected: times out without running fn', async () => {
    const d = tmp();
    try {
      const s = new LocalFsArtifactStore(d, { leaseMs: 60_000 });
      plantForeignLock(d, V);
      let ran = false;
      await assert.rejects(s.withLock(V, () => { ran = true; }, 150), /timed out/);
      assert.equal(ran, false);
      assert.equal(JSON.parse(readFileSync(join(lockDir(d), 'owner.json'), 'utf8')).token, 'crashed-holder', 'foreign lock untouched');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('fresh lock held by a DEAD pid on this host is stolen immediately (no lease wait)', async () => {
    const d = tmp();
    try {
      const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      await new Promise((r) => child.on('close', r));
      const s = new LocalFsArtifactStore(d, { leaseMs: 60_000 });
      plantForeignLock(d, V, { pid: child.pid!, host: hostname() });
      const t0 = Date.now();
      assert.equal(await s.withLock(V, () => 'ran', 2000), 'ran');
      assert.ok(Date.now() - t0 < 1000);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('fresh lock held by a LIVE pid on this host is respected', async () => {
    const d = tmp();
    try {
      const s = new LocalFsArtifactStore(d, { leaseMs: 60_000 });
      plantForeignLock(d, V, { pid: process.pid, host: hostname() });
      await assert.rejects(s.withLock(V, () => 'no', 150), /timed out/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('legacy ownerless lock dir: respected while young, stolen after the lease (by mtime)', async () => {
    const d = tmp();
    try {
      mkdirSync(lockDir(d), { recursive: true });
      writeFileSync(join(lockDir(d), 'junk'), 'x'); // an EMPTY dir would be replaced by the atomic rename; unknown content is not
      await assert.rejects(new LocalFsArtifactStore(d, { leaseMs: 60_000 }).withLock(V, () => 1, 100), /timed out/);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(await new LocalFsArtifactStore(d, { leaseMs: 30 }).withLock(V, () => 'ok', 500), 'ok');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a preempted holder never deletes the new holder lock; many racing stealers keep exclusion', async () => {
    const d = tmp();
    try {
      const s = new LocalFsArtifactStore(d, { leaseMs: 50 });
      let inner!: Promise<string>;
      const outer = s.withLock(V, async () => {
        await new Promise((r) => setTimeout(r, 120)); // outlives its lease
        return 'outer';
      });
      await new Promise((r) => setTimeout(r, 90));
      inner = s.withLock(V, async () => { await new Promise((r) => setTimeout(r, 200)); return 'inner'; }, 1000);
      await new Promise((r) => setTimeout(r, 100)); // outer finished while inner holds the stolen lock
      assert.equal(await outer, 'outer');
      assert.ok(existsSync(lockDir(d)), 'outer finally did not remove the preempting lock');
      assert.equal(await inner, 'inner');

      // stale lock + 6 concurrent waiters: exactly one at a time
      plantForeignLock(d, V, { acquiredAt: Date.now() - 10_000 });
      let active = 0, max = 0;
      await Promise.all(Array.from({ length: 6 }, () => new LocalFsArtifactStore(d, { leaseMs: 5000 }).withLock(V, async () => {
        active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 10)); active--;
      }, 5000)));
      assert.equal(max, 1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('CDN pair consistency (manifest + detached signature are two objects)', () => {
  const signer = new LocalEd25519Signer(generateKeyPair());
  const signedAt = (n: number) => {
    const json = serializeManifest(manifestFor('android', V, n));
    return { json, sig: signer.sign(Buffer.from(json, 'utf8')) };
  };
  /** Reference SDK policy: accept a manifest ONLY if its signature verifies; otherwise keep the old one and retry. */
  async function sdkFetch(cdn: LocalFsCdn, current: { json: string; sig: string } | null, retries = 3): Promise<{ accepted: typeof current; attempts: number }> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const got = cdn.readSigned('android', V);
      if (got && signer.verify(got.json, got.sig)) return { accepted: got, attempts: attempt };
      await new Promise((r) => setTimeout(r, 5 * attempt)); // backoff
    }
    return { accepted: current, attempts: retries };
  }

  test('during a publish the only mixed pair is {old manifest, new signature}; it never verifies and the SDK keeps the old manifest', async () => {
    const d = tmp();
    try {
      const cdn = new LocalFsCdn(d);
      const v1 = signedAt(1), v2 = signedAt(2);
      cdn.publish('android', V, v1, []);
      const seen: { stage: string; json: string; sig: string; ok: boolean }[] = [];
      const snap = (stage: string) => { const g = cdn.readSigned('android', V)!; seen.push({ stage, ...g, ok: signer.verify(g.json, g.sig) }); };
      cdn.hooks.afterSignature = () => snap('window');
      cdn.hooks.afterManifest = () => snap('done');
      cdn.publish('android', V, v2, []);
      const win = seen.find((x) => x.stage === 'window')!;
      assert.equal(win.json, v1.json);
      assert.equal(win.sig, v2.sig, 'old manifest + new signature');
      assert.equal(win.ok, false, 'fails verification: fail safe');
      assert.equal(seen.find((x) => x.stage === 'done')!.ok, true);
      // every observable pair is one of the two whole publishes or a failing mix
      for (const x of seen) assert.ok(x.ok ? (x.json === v1.json && x.sig === v1.sig) || (x.json === v2.json && x.sig === v2.sig) : true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a reader that lands in the window rejects, keeps the old manifest, retries with backoff and then accepts the new one', async () => {
    const d = tmp();
    try {
      const cdn = new LocalFsCdn(d);
      const v1 = signedAt(1), v2 = signedAt(2);
      cdn.publish('android', V, v1, []);
      let first: Awaited<ReturnType<typeof sdkFetch>> | undefined;
      let pending!: Promise<Awaited<ReturnType<typeof sdkFetch>>>;
      cdn.hooks.afterSignature = () => { pending = sdkFetch(cdn, v1); }; // reader's first read is inside the window
      cdn.publish('android', V, v2, []); // completes synchronously right after; reader's retry sees v2
      first = await pending;
      assert.equal(first.attempts, 2, 'first attempt was the mismatch (transient), second succeeded');
      assert.deepEqual(first.accepted, v2);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a reader that reads the manifest and the signature at DIFFERENT moments never accepts an unverifiable pair (all interleavings)', () => {
    const d = tmp();
    try {
      const cdn = new LocalFsCdn(d);
      const v1 = signedAt(1), v2 = signedAt(2), v3 = signedAt(3);
      cdn.publish('android', V, v1, []);
      const manifests: string[] = [], sigs: string[] = [];
      const grab = () => {
        manifests.push(readFileSync(join(d, 'android', V, 'manifest.json'), 'utf8'));
        sigs.push(readFileSync(join(d, 'android', V, 'manifest.json.sig'), 'utf8').trim());
      };
      grab();
      cdn.hooks.afterSignature = grab; cdn.hooks.afterManifest = grab;
      cdn.publish('android', V, v2, []);
      cdn.publish('android', V, v3, []);
      let accepted = 0, rejected = 0;
      for (const m of manifests) for (const s of sigs) {
        if (signer.verify(m, s)) { accepted++; assert.ok([v1, v2, v3].some((v) => v.json === m && v.sig === s), 'accepted pairs are always a real publish'); } else rejected++;
      }
      assert.ok(accepted >= 3 && rejected > 0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('first publish: a signature without a manifest is "not served" (null); a manifest without a signature is never served', () => {
    const d = tmp();
    try {
      const cdn = new LocalFsCdn(d);
      cdn.hooks.afterSignature = () => assert.equal(cdn.readSigned('android', V), null);
      cdn.publish('android', V, signedAt(1), []);
      assert.notEqual(cdn.readSigned('android', V), null);
      rmSync(join(d, 'android', V, 'manifest.json.sig'));
      assert.equal(cdn.readSigned('android', V), null, 'unsigned data is never returned');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
