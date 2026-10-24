// Pure logic: the hermesc pin table and the selection by host OS/arch; the configurable-path resolution order.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HERMESC_PINS, HERMESC_PIN_TABLE, HERMES_COMMIT, HERMES_VERSION_TAG, PIN_KEYS, RN_VERSION, parsePinKey, pinKeyForHost } from '../src/pins.ts';
import { pickPath, DEFAULT_TOOLS_DIR, DEFAULT_WORK_DIR, describeOrigin } from '../src/util.ts';

describe('hermesc pin table', () => {
  test('one pin per OS for RN 0.78.3, well-formed sha256, Hermes commit recorded', () => {
    assert.equal(RN_VERSION, '0.78.3');
    assert.deepEqual([...PIN_KEYS], ['osx', 'linux64', 'win64']);
    assert.ok(HERMES_VERSION_TAG.endsWith(HERMES_COMMIT));
    assert.match(HERMES_COMMIT, /^[0-9a-f]{40}$/);
    const seen = new Set<string>();
    for (const k of PIN_KEYS) {
      const p = HERMESC_PIN_TABLE[k];
      assert.equal(p.key, k);
      assert.match(p.sha256, /^sha256:[0-9a-f]{64}$/);
      assert.ok(!seen.has(p.sha256), 'distinct binaries');
      seen.add(p.sha256);
      for (const h of Object.values(p.companions)) assert.match(h, /^sha256:[0-9a-f]{64}$/);
    }
    assert.equal(HERMESC_PIN_TABLE.osx.sha256, 'sha256:a82e519e1fa3737f6b95554cdb9edaaf37458fb03abcdc2144f039fa0b3302ab');
    assert.equal(HERMESC_PIN_TABLE.linux64.dir, 'linux64-bin');
    assert.equal(HERMESC_PIN_TABLE.win64.binary, 'hermesc.exe');
  });
  test('selection by host platform/arch', () => {
    assert.equal(pinKeyForHost('darwin', 'arm64'), 'osx');
    assert.equal(pinKeyForHost('darwin', 'x64'), 'osx');
    assert.equal(pinKeyForHost('linux', 'x64'), 'linux64');
    assert.equal(pinKeyForHost('win32', 'x64'), 'win64');
    assert.equal(pinKeyForHost('linux', 'arm64'), null, 'no pin: fail with a clear message instead of using the wrong binary');
    assert.equal(pinKeyForHost('freebsd', 'x64'), null);
  });
  test('--platform parsing; legacy node-platform view', () => {
    assert.equal(parsePinKey('linux64'), 'linux64');
    assert.throws(() => parsePinKey('linux'), /expected one of osx, linux64, win64/);
    assert.equal(HERMESC_PINS.darwin!.dir, 'osx-bin');
    assert.equal(HERMESC_PINS.linux!.sha256, HERMESC_PIN_TABLE.linux64.sha256);
    assert.equal(HERMESC_PINS.win32!.binary, 'hermesc.exe');
  });
});

describe('configurable locations: flag > env > default', () => {
  const env = { OTA_TOOLS_DIR: '/env/tools', OTA_HDIFFZ: '/env/hdiffz', OTA_HDIFFZ_TOOL: '/legacy/hdiffz' };
  test('order', () => {
    const base = { envNames: ['OTA_TOOLS_DIR'], flagName: '--tools-dir', dflt: DEFAULT_TOOLS_DIR };
    assert.deepEqual(pickPath({ ...base, flag: '/flag/t' }, env), { path: '/flag/t', origin: { kind: 'flag', name: '--tools-dir' } });
    assert.deepEqual(pickPath(base, env), { path: '/env/tools', origin: { kind: 'env', name: 'OTA_TOOLS_DIR' } });
    assert.deepEqual(pickPath(base, {}), { path: DEFAULT_TOOLS_DIR, origin: { kind: 'default' } });
    assert.equal(pickPath({ envNames: ['OTA_WORK_DIR'], dflt: DEFAULT_WORK_DIR }, {}).path, DEFAULT_WORK_DIR);
  });
  test('canonical env name wins over the legacy alias; describeOrigin text', () => {
    const r = pickPath({ envNames: ['OTA_HDIFFZ', 'OTA_HDIFFZ_TOOL'], dflt: '/d' }, env);
    assert.equal(r.path, '/env/hdiffz');
    assert.equal(pickPath({ envNames: ['OTA_HDIFFZ', 'OTA_HDIFFZ_TOOL'], dflt: '/d' }, { OTA_HDIFFZ_TOOL: '/legacy/hdiffz' }).path, '/legacy/hdiffz');
    assert.equal(describeOrigin(r.origin), 'env OTA_HDIFFZ');
    assert.equal(describeOrigin({ kind: 'default' }), 'default');
  });
});
