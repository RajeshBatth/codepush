/**
 * Conformance suite for CdnPort. Run it against ANY adapter:
 *
 *   import { runCdnConformance } from './conformance/cdn.conformance.ts';
 *   runCdnConformance(async () => {
 *     const cdn = new MyCdn(testBucketPrefix);                      // fresh, empty origin per call
 *     return { adapter: cdn, dispose: () => cdn.cleanup() };
 *   });
 *
 * `makeCdn` is called once per test and must return an EMPTY origin. Every port call is awaited, so asynchronous adapters work too.
 * An optional `signer` (any SignerPort) enables the round trip check that served bytes still verify.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { CdnPort, SignerPort } from '../../src/ports.ts';
import { manifestFor, scratchDir, signedFor, writeTmpFile, type Made, type MaybePromise } from './fixtures.ts';
import { serializeManifest } from '@ota/core';

export function runCdnConformance(makeCdn: () => MaybePromise<Made<CdnPort>>, opts: { signer?: SignerPort } = {}): void {
  const V = '11.9.0';
  async function withCdn(fn: (c: CdnPort, tmp: string) => Promise<void>): Promise<void> {
    const made = await makeCdn();
    const { dir, cleanup } = scratchDir();
    try {
      await fn(made.adapter, dir);
    } finally {
      cleanup();
      await made.dispose?.();
    }
  }

  describe('CdnPort conformance', () => {
    test('nothing published: readSigned/servedVersion/readManifest null, hasFile false', () => withCdn(async (c) => {
      assert.equal(await c.readSigned('android', V), null);
      assert.equal(await c.servedVersion('android', V), null);
      assert.equal(await c.readManifest('android', V), null);
      assert.equal(await c.hasFile('android', V, 'manifest.json'), false);
    }));

    test('publish then readSigned round trip: exact bytes, version, platform isolation, patch files served', () => withCdn(async (c, tmp) => {
      const s = signedFor('android', V, 1);
      const p = writeTmpFile(tmp, 'x.patch', 'patch-1');
      await c.publish('android', V, s, [{ name: 'cabs-pr1.abc.android.patch', path: p }]);
      assert.deepEqual(await c.readSigned('android', V), s);
      assert.equal(await c.servedVersion('android', V), 1);
      assert.deepEqual(await c.readManifest('android', V), manifestFor('android', V, 1));
      assert.equal(await c.hasFile('android', V, 'cabs-pr1.abc.android.patch'), true);
      assert.equal(await c.hasFile('android', V, 'manifest.json'), true);
      assert.equal(await c.hasFile('android', V, 'manifest.json.sig'), true);
      assert.equal(await c.hasFile('android', V, 'other.patch'), false);
      assert.equal(await c.readSigned('ios', V), null, 'other platform untouched');
      assert.equal(await c.readSigned('android', '12.0.0'), null, 'other app version untouched');
    }));

    test('served bytes keep their exact form (no re-serialization) and the signature still verifies', () => withCdn(async (c) => {
      const json = `${serializeManifest(manifestFor('ios', V, 7))}`;
      const sig = opts.signer ? await opts.signer.sign(Buffer.from(json, 'utf8')) : Buffer.from('opaque').toString('base64');
      await c.publish('ios', V, { json, sig }, []);
      const got = (await c.readSigned('ios', V))!;
      assert.equal(got.json, json);
      assert.equal(got.sig.trim(), sig);
      if (opts.signer) assert.equal(await opts.signer.verify(got.json, got.sig), true);
    }));

    test('ordering: if a patch cannot be stored, publish fails and the previous manifest is still what is served', () => withCdn(async (c, tmp) => {
      const v1 = signedFor('android', V, 1);
      await c.publish('android', V, v1, []);
      const v2 = signedFor('android', V, 2);
      await assert.rejects(async () => c.publish('android', V, v2, [{ name: 'missing.patch', path: `${tmp}/does-not-exist` }]));
      assert.deepEqual(await c.readSigned('android', V), v1, 'manifest is the LAST write: a failed patch upload never advances it');
      assert.equal(await c.servedVersion('android', V), 1);
      assert.equal(await c.hasFile('android', V, 'missing.patch'), false);
    }));

    test('invariant after every successful publish: a served manifest implies all its patch files are served', () => withCdn(async (c, tmp) => {
      for (let n = 1; n <= 3; n++) {
        const name = `p${n}.patch`;
        await c.publish('android', V, signedFor('android', V, n), [{ name, path: writeTmpFile(tmp, name, `bytes-${n}`) }]);
        assert.equal(await c.servedVersion('android', V), n);
        for (let k = 1; k <= n; k++) assert.equal(await c.hasFile('android', V, `p${k}.patch`), true, `p${k}.patch still served`);
      }
    }));

    test('manifest swap is atomic and never torn: after repeated publishes the pair (json, sig) is always one whole publish', () => withCdn(async (c) => {
      for (const n of [1, 2, 3, 4, 5]) {
        const s = signedFor('android', V, n);
        await c.publish('android', V, s, []);
        const got = (await c.readSigned('android', V))!;
        assert.deepEqual(got, s);
        assert.equal(JSON.parse(got.json).version, n);
      }
    }));

    test('publishing the same manifest again is harmless (reconcile); existing patch objects are kept', () => withCdn(async (c, tmp) => {
      const s = signedFor('android', V, 1);
      const p = writeTmpFile(tmp, 'same.patch', 'AAAA');
      await c.publish('android', V, s, [{ name: 'same.patch', path: p }]);
      await c.publish('android', V, s, [{ name: 'same.patch', path: p }]);
      assert.deepEqual(await c.readSigned('android', V), s);
      assert.equal(await c.hasFile('android', V, 'same.patch'), true);
    }));
  });
}
