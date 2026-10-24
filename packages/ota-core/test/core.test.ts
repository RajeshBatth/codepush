import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bucket, selectUnit, validateManifest, signManifest, verifyManifestBytes, generateKeyPair, canonicalize,
  initState, applyDeploy, applyRollout, applyHalt, applyRestore, latestPatchId, addPatch, setPercent, halt,
  type Manifest, type Entry,
} from '../src/index.ts';
import { h, makeBase, patch } from './helpers.ts';

const vec = (n: string) => JSON.parse(readFileSync(new URL(`../vectors/${n}.json`, import.meta.url), 'utf8'));

test('bucket matches conformance vectors and is in [0,1)', () => {
  for (const v of vec('bucket')) {
    assert.equal(bucket(v.deviceId, v.unit), v.bucket);
    assert.ok(v.bucket >= 0 && v.bucket < 1);
  }
});

test('bucket is stable and differs per unit', () => {
  assert.equal(bucket('d1', 'cabs'), bucket('d1', 'cabs'));
  assert.notEqual(bucket('d1', 'cabs'), bucket('d1', 'bus'));
});

test('selectUnit matches conformance vectors', () => {
  const { manifest, cases } = vec('select');
  assert.deepEqual(validateManifest(manifest), []);
  for (const c of cases) {
    const r = selectUnit(manifest, c.unit, c.ctx);
    assert.deepEqual({ source: r.source, entryId: r.entry?.id ?? null, reason: r.reason }, c.expect);
  }
});

test('canonicalize sorts keys and drops undefined', () => {
  assert.equal(canonicalize({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
});

test('detached signature over served bytes: round-trip and tamper detection', () => {
  const kp = generateKeyPair();
  const { manifests } = initState(makeBase());
  const { json, sig } = signManifest(manifests.android, kp.privateKeyPem);
  assert.ok(verifyManifestBytes(json, sig, kp.publicKeyPem));
  assert.ok(verifyManifestBytes(Buffer.from(json), sig + '\n', kp.publicKeyPem), 'sidecar trailing newline tolerated');
  const parsed = JSON.parse(json);
  assert.ok(!verifyManifestBytes(JSON.stringify({ ...parsed, version: parsed.version + 1 }), sig, kp.publicKeyPem), 'version tamper');
  assert.ok(!verifyManifestBytes(json.replace('"android"', '"ios"'), sig, kp.publicKeyPem), 'cross-platform replay');
  assert.ok(!verifyManifestBytes(json, sig, generateKeyPair().publicKeyPem), 'wrong key');
  assert.ok(!verifyManifestBytes(json, 'not-base64!!', kp.publicKeyPem), 'garbage signature');
});

test('validateManifest rejects overlap, bad hashes, dup ids, bad requiresHost', () => {
  const base = initState(makeBase()).manifests.android;
  const e = (id: string, range: [number, number]): Entry => ({ id, patchUrl: 'u', hash: h(id), size: 1, updateType: 'patch', range });
  const m: Manifest = { ...base, units: [{ unitName: 'cabs', baseHash: h('x'), entries: [e('a', [0, 0.5]), e('b', [0.4, 0.6])] }] };
  assert.match(validateManifest(m).join('|'), /overlap/);
  const bad: Manifest = { ...base, units: [{ unitName: 'cabs', baseHash: 'nope', entries: [{ ...e('a', [0, 1]), hash: 'x' }, e('a', [0, 0])] }] };
  const errs = validateManifest(bad).join('|');
  assert.match(errs, /baseHash invalid/);
  assert.match(errs, /hash must be sha256/);
  assert.match(errs, /duplicate/);
  const rh: Manifest = { ...base, units: [{ unitName: 'cabs', baseHash: h('x'), entries: [{ ...e('a', [0, 0.1]), requiresHost: 'nope' }] }] };
  assert.match(validateManifest(rh).join('|'), /requiresHost/);
});

// ---- ladder ----
const E = (id: string): Entry => ({ id, patchUrl: 'u', hash: h(id), size: 1, updateType: 'patch' });
const rng = (es: Entry[]) => es.map((e) => `${e.id}:${e.range![0]}-${e.range![1]}`).join(' ');

test('ladder: new patch starts at 0% and previous keeps its users', () => {
  let es = addPatch([], E('p1'));
  es = setPercent(es, 'p1', 50);
  es = addPatch(es, E('p2'));
  assert.equal(rng(es), 'p2:0-0 p1:0-0.5');
});

test('ladder: ramping newest takes buckets from previous (forward only), retires at 100%', () => {
  let es = setPercent(addPatch([], E('p1')), 'p1', 50);
  es = addPatch(es, E('p2'));
  es = setPercent(es, 'p2', 20);
  assert.equal(rng(es), 'p2:0-0.2 p1:0.2-0.5');
  es = setPercent(es, 'p2', 60); // beyond previous's end: embedded users move forward too
  assert.equal(rng(es), 'p2:0-0.6');
  es = setPercent(addPatch(setPercent(addPatch([], E('a')), 'a', 30), E('b')), 'b', 100);
  assert.equal(rng(es), 'b:0-1');
});

test('ladder: ramp-down returns buckets to previous', () => {
  let es = setPercent(addPatch([], E('p1')), 'p1', 50);
  es = setPercent(addPatch(es, E('p2')), 'p2', 30);
  es = setPercent(es, 'p2', 10);
  assert.equal(rng(es), 'p2:0-0.1 p1:0.1-0.5');
});

test('ladder: halting newest restores previous to bucket 0 (users return to what they had)', () => {
  let es = setPercent(addPatch([], E('p1')), 'p1', 50);
  es = setPercent(addPatch(es, E('p2')), 'p2', 30);
  es = halt(es, 'p2');
  assert.equal(rng(es), 'p1:0-0.5');
  assert.deepEqual(halt(es, 'p1'), []);
});

test('ladder: only the latest patch can be ramped; halt works on any', () => {
  let es = setPercent(addPatch([], E('p1')), 'p1', 50);
  es = addPatch(es, E('p2'));
  assert.throws(() => setPercent(es, 'p1', 80), /latest/);
  assert.equal(rng(halt(es, 'p1')), 'p2:0-0');
  assert.throws(() => setPercent(es, 'nope', 5), /unknown/);
  assert.throws(() => addPatch(es, E('p2')), /already exists/);
});

// ---- state bundle ops ----
test('state: deploy -> rollout -> halt -> restore keeps invariants and monotonic versions', () => {
  const base = makeBase();
  let s = initState(base);
  assert.equal(s.version, 1);
  s = applyDeploy(s, base, { unit: 'cabs', patchId: 'cabs-pr10', perPlatform: patch('cabs-pr10') });
  assert.equal(s.version, 2);
  assert.equal(latestPatchId(s.manifests.android, 'cabs'), 'cabs-pr10');
  assert.deepEqual(s.manifests.android.units[0].entries[0].range, [0, 0]);
  assert.equal(s.manifests.android.units[0].baseHash, base.units.cabs.android);
  assert.notEqual(s.manifests.android.units[0].entries[0].hash, s.manifests.ios.units[0].entries[0].hash);

  const v3 = applyRollout(s, { unit: 'cabs', patchId: 'cabs-pr10', percent: 10 });
  assert.deepEqual(v3.manifests.android.units[0].entries[0].range, [0, 0.1]);
  const v3a = applyRollout(s, { unit: 'cabs', patchId: 'cabs-pr10', percent: 25, platforms: ['android'] });
  assert.deepEqual(v3a.manifests.android.units[0].entries[0].range, [0, 0.25]);
  assert.deepEqual(v3a.manifests.ios.units[0].entries[0].range, [0, 0], 'ios untouched');
  assert.equal(v3a.manifests.ios.version, 3, 'both manifests share the state version');

  const v4 = applyHalt(v3, { unit: 'cabs', patchId: 'cabs-pr10' });
  assert.equal(v4.manifests.android.units[0].entries.length, 0);
  const v5 = applyRestore(v4, v3);
  assert.equal(v5.version, 5);
  assert.deepEqual(v5.manifests.android.units[0].entries[0].range, [0, 0.1]);
});

test('state: host patches and unknown units', () => {
  const base = makeBase();
  const s = applyDeploy(initState(base), base, { unit: 'host', patchId: 'host-pr3', perPlatform: patch('host-pr3') });
  assert.equal(s.manifests.ios.mainBundle.entries[0].id, 'host-pr3');
  assert.throws(() => applyDeploy(initState(base), base, { unit: 'nope', patchId: 'nope-pr1', perPlatform: patch('x') }), /unknown unit/);
});

test('state: end-to-end device selection follows rollout', () => {
  const base = makeBase();
  let s = applyDeploy(initState(base), base, { unit: 'cabs', patchId: 'cabs-pr10', perPlatform: patch('cabs-pr10') });
  const ctx = (d: string) => ({ bucket: bucket(d, 'cabs'), embeddedHash: base.units.cabs.android, supportedAlgos: ['v1'], runningHostId: 'embedded' });
  const devices = Array.from({ length: 4000 }, (_, i) => `dev-${i}`);
  const share = (st: typeof s) => devices.filter((d) => selectUnit(st.manifests.android, 'cabs', ctx(d)).source === 'patch').length / devices.length;
  assert.equal(share(s), 0);
  s = applyRollout(s, { unit: 'cabs', patchId: 'cabs-pr10', percent: 10 });
  const s10 = share(s);
  assert.ok(Math.abs(s10 - 0.1) < 0.02, `~10% got ${s10}`);
  const on10 = new Set(devices.filter((d) => selectUnit(s.manifests.android, 'cabs', ctx(d)).source === 'patch'));
  s = applyRollout(s, { unit: 'cabs', patchId: 'cabs-pr10', percent: 40 });
  for (const d of on10) assert.equal(selectUnit(s.manifests.android, 'cabs', ctx(d)).source, 'patch', 'ramp-up never moves a device back');
  assert.ok(Math.abs(share(s) - 0.4) < 0.03);
});

test('state: a change affecting one platform deploys, ramps and halts only there', () => {
  const base = makeBase();
  const both = patch('cabs-pr1');
  let s = applyDeploy(initState(base), base, { unit: 'cabs', patchId: 'cabs-pr1', perPlatform: both });
  s = applyRollout(s, { unit: 'cabs', patchId: 'cabs-pr1', percent: 50 });
  // android-only fix
  s = applyDeploy(s, base, { unit: 'cabs', patchId: 'cabs-pr2', perPlatform: { android: patch('cabs-pr2').android } });
  assert.equal(latestPatchId(s.manifests.android, 'cabs'), 'cabs-pr2');
  assert.equal(latestPatchId(s.manifests.ios, 'cabs'), 'cabs-pr1', 'ios untouched');
  assert.equal(s.manifests.ios.version, s.version, 'both manifests still share the state version');
  // default scope = platforms where the patch exists
  s = applyRollout(s, { unit: 'cabs', patchId: 'cabs-pr2', percent: 10 });
  assert.deepEqual(s.manifests.android.units[0].entries[0].range, [0, 0.1]);
  assert.deepEqual(s.manifests.ios.units[0].entries[0].range, [0, 0.5], 'ios ladder unchanged');
  assert.throws(() => applyRollout(s, { unit: 'cabs', patchId: 'cabs-pr2', percent: 20, platforms: ['ios'] }), /does not exist on ios/);
  assert.throws(() => applyRollout(s, { unit: 'cabs', patchId: 'nope', percent: 20 }), /unknown patch/);
  assert.throws(() => applyDeploy(s, base, { unit: 'cabs', patchId: 'cabs-pr3', perPlatform: {} }), /at least one platform/);
  s = applyHalt(s, { unit: 'cabs', patchId: 'cabs-pr2' });
  assert.equal(latestPatchId(s.manifests.android, 'cabs'), 'cabs-pr1');
});
