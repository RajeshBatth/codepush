/**
 * Conformance suite for ArtifactStorePort. Run it against ANY adapter:
 *
 *   import { runStoreConformance } from './conformance/store.conformance.ts';
 *   runStoreConformance(async () => {
 *     const store = new MyJenkinsArtifactStore(testConfig);        // fresh, empty namespace per call
 *     return { adapter: store, dispose: () => store.cleanup() };
 *   });
 *
 * `makeStore` is called once per test and must return an EMPTY store (isolated prefix/bucket/dir). To test lock
 * exclusion across processes, also create a second instance on the same backing data via `makeSecondHandle` (optional).
 * Every port call is awaited, so asynchronous adapters work too.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ArtifactStorePort } from '../../src/ports.ts';
import { auditFor, baseFor, scratchDir, signedSet, sleep, writeTmpFile, type Made, type MaybePromise } from './fixtures.ts';

export interface StoreConformanceOptions {
  /** Another handle on the SAME backing data as `first` (simulates a second Jenkins agent). Defaults to reusing `first`. */
  makeSecondHandle?: (first: ArtifactStorePort) => MaybePromise<ArtifactStorePort>;
  /**
   * Optional LEASE capability (ports.ts `withLock`). Provide it if the adapter expires locks. `plant` must leave
   * `version` locked by a holder that is gone for good and cannot be proven dead except by the lease (e.g. another
   * host), acquired just now. `leaseMs` is the store's configured lease (use a small one in tests, e.g. 400).
   */
  crashedHolder?: { leaseMs: number; plant: (store: ArtifactStorePort, version: string) => MaybePromise<void> };
}

export function runStoreConformance(makeStore: () => MaybePromise<Made<ArtifactStorePort>>, opts: StoreConformanceOptions = {}): void {
  const V = '11.9.0';
  async function withStore(fn: (s: ArtifactStorePort, tmp: string, made: Made<ArtifactStorePort>) => Promise<void>): Promise<void> {
    const made = await makeStore();
    const { dir, cleanup } = scratchDir();
    try {
      await fn(made.adapter, dir, made);
    } finally {
      cleanup();
      await made.dispose?.();
    }
  }

  describe('ArtifactStorePort conformance', () => {
    test('base: write/read round trip; unknown version throws; retired versions are not live', () => withStore(async (s) => {
      await assert.rejects(async () => s.readBase('1.0.0'), /no base release recorded/);
      assert.deepEqual(await s.liveVersions(), []);
      await s.writeBase(baseFor('1.0.0'));
      await s.writeBase(baseFor('2.0.0'));
      assert.deepEqual(await s.readBase('1.0.0'), baseFor('1.0.0'));
      assert.deepEqual([...(await s.liveVersions())].sort(), ['1.0.0', '2.0.0']);
      await s.writeBase(baseFor('1.0.0', true)); // replace is allowed (retire)
      assert.equal((await s.readBase('1.0.0')).retired, true);
      assert.deepEqual(await s.liveVersions(), ['2.0.0']);
    }));

    test('putPatch is content addressed and idempotent; patchPath returns the exact bytes', () => withStore(async (s, tmp) => {
      const f = writeTmpFile(tmp, 'a.patch', 'patch-bytes-1');
      const r1 = await s.putPatch(f);
      const r2 = await s.putPatch(f);
      assert.deepEqual(r2, r1);
      assert.equal(r1.size, 'patch-bytes-1'.length);
      assert.match(r1.key, /^[0-9a-f]{12}-a\.patch$/);
      assert.equal(readFileSync(await s.patchPath(r1.key), 'utf8'), 'patch-bytes-1');
      // same name, different content: new key, old key unchanged (immutable)
      const f2 = writeTmpFile(tmp, 'a.patch', 'patch-bytes-2');
      const r3 = await s.putPatch(f2);
      assert.notEqual(r3.key, r1.key);
      assert.equal(readFileSync(await s.patchPath(r1.key), 'utf8'), 'patch-bytes-1');
      assert.equal(readFileSync(await s.patchPath(r3.key), 'utf8'), 'patch-bytes-2');
      await assert.rejects(async () => s.patchPath('000000000000-nope'));
    }));

    test('state: empty history -> no versions, latestVersion null, readState throws', () => withStore(async (s) => {
      assert.deepEqual(await s.stateVersions(V), []);
      assert.equal(await s.latestVersion(V), null);
      assert.deepEqual(await s.allAudits(V), []);
      await assert.rejects(async () => s.readState(V, 1), /does not exist/);
    }));

    test('readState returns exactly the written bytes (json verbatim, sig modulo whitespace) and the audit', () => withStore(async (s) => {
      const signed = signedSet(V, 1);
      // odd-but-legal bytes must survive untouched (no re-serialization, no newline normalization)
      signed.android = { json: '{"b":1,\n "a":"\u00e9"}\n\n', sig: signed.android.sig };
      const audit = auditFor(1);
      await s.writeState(V, 1, signed, audit);
      const got = await s.readState(V, 1);
      assert.equal(got.raw.android.json, signed.android.json);
      assert.equal(got.raw.ios.json, signed.ios.json);
      assert.equal(got.raw.android.sig.trim(), signed.android.sig);
      assert.equal(got.raw.ios.sig.trim(), signed.ios.sig);
      assert.deepEqual(got.audit, audit);
    }));

    test('writeState is create-if-absent: a second write to the same version fails and changes nothing', () => withStore(async (s) => {
      await s.writeState(V, 1, signedSet(V, 1), auditFor(1));
      const before = await s.readState(V, 1);
      await assert.rejects(async () => s.writeState(V, 1, signedSet(V, 1, '-other'), auditFor(1)), /already exists/);
      assert.deepEqual(await s.readState(V, 1), before);
      assert.deepEqual(await s.stateVersions(V), [1]);
    }));

    test('racing writers for the same version: exactly one wins, the loser leaves nothing behind', () => withStore(async (s, _t, made) => {
      const second = opts.makeSecondHandle ? await opts.makeSecondHandle(s) : s;
      const results = await Promise.allSettled([
        (async () => s.writeState(V, 1, signedSet(V, 1, '-A'), auditFor(1)))(),
        (async () => second.writeState(V, 1, signedSet(V, 1, '-B'), auditFor(1)))(),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one create-if-absent succeeds');
      const raw = (await s.readState(V, 1)).raw;
      const winner = raw.android.sig === signedSet(V, 1, '-A').android.sig ? '-A' : '-B';
      assert.deepEqual(raw, signedSet(V, 1, winner), 'the winner is stored whole, never a mix of both writers');
      void made;
    }));

    test('a failed write is never visible and the version can be written again (all-or-nothing)', () => withStore(async (s) => {
      await s.writeState(V, 1, signedSet(V, 1), auditFor(1));
      const broken = signedSet(V, 2);
      delete (broken as Partial<typeof broken>).ios; // missing platform
      await assert.rejects(async () => s.writeState(V, 2, broken, auditFor(2)));
      const circular: Record<string, unknown> = {};
      circular.self = circular; // audit that cannot be serialized, after the manifests were already "written"
      await assert.rejects(async () => s.writeState(V, 2, signedSet(V, 2), circular as never));
      assert.deepEqual(await s.stateVersions(V), [1], 'no partial v2');
      assert.equal(await s.latestVersion(V), 1);
      await assert.rejects(async () => s.readState(V, 2), /does not exist/);
      await s.writeState(V, 2, signedSet(V, 2), auditFor(2));
      assert.deepEqual(await s.stateVersions(V), [1, 2]);
    }));

    test('stateVersions ascending; latestVersion is the max and never decreases; histories are per app version', () => withStore(async (s) => {
      let last = 0;
      for (const n of [1, 2, 3, 10]) {
        await s.writeState(V, n, signedSet(V, n), auditFor(n));
        const latest = (await s.latestVersion(V))!;
        assert.ok(latest >= last, 'monotonic');
        last = latest;
      }
      await assert.rejects(async () => s.writeState(V, 2, signedSet(V, 2), auditFor(2)));
      assert.equal(await s.latestVersion(V), 10, 'a rejected write does not move latest (numeric, not lexicographic: 10 > 3)');
      assert.deepEqual(await s.stateVersions(V), [1, 2, 3, 10]);
      assert.equal(await s.latestVersion('12.0.0'), null);
    }));

    test('allAudits are ordered by state version', () => withStore(async (s) => {
      const a1 = auditFor(1);
      const a2 = auditFor(2, a1);
      await s.writeState(V, 2, signedSet(V, 2), a2); // written out of order on purpose
      await s.writeState(V, 1, signedSet(V, 1), a1);
      assert.deepEqual((await s.allAudits(V)).map((a) => a.stateVersion), [1, 2]);
    }));

    test('withLock: concurrent critical sections for one app version never overlap (no lost update)', () => withStore(async (s) => {
      let active = 0;
      let maxActive = 0;
      let counter = 0;
      await Promise.all(Array.from({ length: 8 }, () => s.withLock(V, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        const seen = counter;
        await sleep(15); // read-modify-write across an await: only mutual exclusion keeps this correct
        counter = seen + 1;
        active--;
      })));
      assert.equal(maxActive, 1);
      assert.equal(counter, 8);
    }));

    test('withLock: returns fn result; different app versions do not block each other', () => withStore(async (s) => {
      assert.equal(await s.withLock(V, () => 42), 42);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const a = s.withLock('1.0.0', () => held);
      await sleep(30);
      const b = await s.withLock('2.0.0', () => 'ran while 1.0.0 is locked', 1000);
      assert.equal(b, 'ran while 1.0.0 is locked');
      release();
      await a;
    }));

    test('withLock: times out with /timed out/ without running fn, and is released after fn throws or after a timeout', () => withStore(async (s) => {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const holder = s.withLock(V, () => held);
      await sleep(30);
      let ran = false;
      await assert.rejects(s.withLock(V, () => { ran = true; }, 150), /timed out/);
      assert.equal(ran, false);
      release();
      await holder;
      await assert.rejects(s.withLock(V, () => { throw new Error('boom'); }), /boom/);
      assert.equal(await s.withLock(V, () => 'free again', 1000), 'free again');
    }));

    test('withLock: exclusion also holds across two handles on the same data (second agent)', () => withStore(async (s) => {
      const second = opts.makeSecondHandle ? await opts.makeSecondHandle(s) : s;
      let active = 0;
      let maxActive = 0;
      const crit = async () => { active++; maxActive = Math.max(maxActive, active); await sleep(20); active--; };
      await Promise.all([s.withLock(V, crit), second.withLock(V, crit), s.withLock(V, crit), second.withLock(V, crit)]);
      assert.equal(maxActive, 1);
    }));

    if (opts.crashedHolder) {
      const { leaseMs, plant } = opts.crashedHolder;
      test('withLock lease: a live lock is respected within the lease; a crashed holder is taken over after it', () => withStore(async (s) => {
        await plant(s, V);
        let ran = false;
        await assert.rejects(s.withLock(V, () => { ran = true; }, Math.floor(leaseMs / 4)), /timed out/);
        assert.equal(ran, false, 'a fresh foreign lock blocks until the lease runs out');
        assert.equal(await s.withLock(V, () => 'took over', leaseMs * 10), 'took over');
        assert.equal(await s.withLock(V, () => 'and released', 500), 'and released');
      }));
    }
  });
}
