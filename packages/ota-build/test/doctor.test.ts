import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor, type Check, type Status } from '../src/doctor.ts';
import { HERMESC_PINS } from '../src/tools.ts';
import { REPO_ROOT, rmrf, toolsDir } from '../src/util.ts';
import { BUILD_CLI, copyDemo, missingTools, runNode, workRoot } from './helpers.ts';

const root = workRoot('doctor');
after(() => rmrf(root));
let n = 0;
const fresh = (): string => copyDemo(join(root, `p${n++}`));
const wj = (p: string, v: unknown): void => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const status = (cs: Check[], id: string): Status => {
  const c = cs.find((x) => x.id === id);
  assert.ok(c, `no check ${id} in [${cs.map((x) => x.id)}]`);
  return c.status;
};
const doctor = async (project: string, platform?: 'android' | 'ios') => (await runDoctor({ project, platform })).checks;
const hermescDir = HERMESC_PINS[process.platform]?.dir ?? 'osx-bin';

/** A project that looks like a real RN 0.78.3 app: fake RN/Metro package.json files, the real pinned hermesc, a wired metro.config.js. */
function richProject(): string {
  const p = fresh();
  wj(join(p, 'node_modules/react-native/package.json'), { name: 'react-native', version: '0.78.3' });
  wj(join(p, 'node_modules/metro/package.json'), { name: 'metro', version: '0.81.5' });
  wj(join(p, 'node_modules/metro-config/package.json'), { name: 'metro-config', version: '0.81.5' });
  const dest = join(p, 'node_modules/react-native/sdks/hermesc', hermescDir);
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(toolsDir().path, 'hermesc-rn0.78.3', HERMESC_PINS[process.platform]?.binary ?? 'hermesc'), join(dest, HERMESC_PINS[process.platform]?.binary ?? 'hermesc'));
  wj(join(p, 'units.config.json'), { metroConfig: 'metro.config.js', units: [{ name: 'cabs', roots: ['src/units/cabs'], entry: 'src/units/cabs/entry.js' }] });
  const splitter = join(REPO_ROOT, 'packages/unit-splitter/src/with-ota-units.js');
  writeFileSync(join(p, 'metro.config.js'), `const {withOtaUnits} = require(${JSON.stringify(splitter)});
const units = require('./units.config.json').units;
module.exports = withOtaUnits({transformer: {babelTransformerPath: 'x'}, resolver: {blockList: [/\\/ios\\/(Pods|build)\\/.*/, /\\/android\\/(app\\/build|build|\\.gradle|\\.cxx)\\/.*/]}}, {units, projectRoot: __dirname});
`);
  mkdirSync(join(p, 'android'), { recursive: true });
  writeFileSync(join(p, 'android/gradle.properties'), 'hermesEnabled=true\n');
  mkdirSync(join(p, 'ios'), { recursive: true });
  writeFileSync(join(p, 'ios/Podfile'), "use_react_native!(:path => 'x', :hermes_enabled => true)\n");
  return p;
}

describe('ota-build doctor', () => {
  test('demo-app copy: no FAIL (WARN for the pieces a prototype does not have), via the CLI with --json', () => {
    const p = fresh();
    const r = runNode(BUILD_CLI, ['doctor', '--project', p, '--json']);
    const rep = JSON.parse(r.stdout) as { ok: boolean; checks: Check[] };
    for (const id of ['units-config', 'units-resolve', 'host-entry', 'node-modules']) assert.equal(status(rep.checks, id), 'PASS', id);
    for (const id of ['react-native', 'metro', 'metro-config-wired']) assert.equal(status(rep.checks, id), 'WARN', id);
    assert.equal(status(rep.checks, 'hermes-engine'), 'MANUAL');
    const failed = rep.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);
    // only missing external tools may FAIL here; the project itself is healthy
    assert.ok(failed.every((id) => ['hermesc', 'hdiffz', 'ota-apply', 'tools-dir'].includes(id)), `unexpected FAIL: ${failed}`);
    assert.equal(r.status, failed.length ? 1 : 0);
  });

  const skip = missingTools();
  describe('realistic RN 0.78.3 layout', { skip }, () => {
    test('healthy project: every automatable check PASSes, exit code 0', async () => {
      const p = richProject();
      const rep = await runDoctor({ project: p });
      assert.deepEqual(rep.checks.filter((c) => c.status === 'FAIL' || c.status === 'WARN').map((c) => `${c.id}: ${c.detail}`), []);
      assert.equal(rep.ok, true);
      assert.equal(runNode(BUILD_CLI, ['doctor', '--project', p, '--platform', 'android']).status, 0);
    });
    test('metro 0.80 (unsupported line) -> FAIL', async () => {
      const p = richProject();
      wj(join(p, 'node_modules/metro/package.json'), { name: 'metro', version: '0.80.9' });
      const rep = await runDoctor({ project: p });
      assert.equal(status(rep.checks, 'metro'), 'FAIL');
      assert.equal(rep.ok, false);
      assert.equal(runNode(BUILD_CLI, ['doctor', '--project', p]).status, 1);
    });
    test('metro 0.81.2 vs splitter 0.81.5 -> WARN only; metro-config mismatch -> WARN', async () => {
      const p = richProject();
      wj(join(p, 'node_modules/metro/package.json'), { name: 'metro', version: '0.81.2' });
      const cs = await doctor(p);
      assert.equal(status(cs, 'metro'), 'WARN');
      assert.equal(status(cs, 'metro-config'), 'WARN');
      assert.equal(status(cs, 'metro-runs'), 'FAIL', 'the splitter gate refuses metro 0.81.2 + metro-config 0.81.5');
    });
    test('metro-runs reports the PROJECT\'s Metro as the one that runs; a project without metro -> WARN fallback', async () => {
      const p = richProject();
      const c = (await doctor(p)).find((x) => x.id === 'metro-runs')!;
      assert.equal(c.status, 'PASS');
      assert.match(c.detail, /PROJECT's metro 0\.81\.5/);
      // (a separate copy: Node caches package lookups per process, so deleting stubs in place is not reliable)
      const f = (await doctor(fresh())).find((x) => x.id === 'metro-runs')!;
      assert.equal(f.status, 'WARN', f.detail);
      assert.match(f.detail, /FALLBACK/);
    });
    test('react-native 0.79 -> WARN', async () => {
      const p = richProject();
      wj(join(p, 'node_modules/react-native/package.json'), { name: 'react-native', version: '0.79.0' });
      assert.equal(status(await doctor(p), 'react-native'), 'WARN');
    });
    test('project hermesc differs from the pinned one -> FAIL; absent -> WARN', async () => {
      const p = richProject();
      const h = join(p, 'node_modules/react-native/sdks/hermesc', hermescDir, 'hermesc');
      writeFileSync(h, 'not the pinned hermesc');
      chmodSync(h, 0o755);
      assert.equal(status(await doctor(p), 'hermesc'), 'FAIL');
      rmSync(h);
      assert.equal(status(await doctor(p), 'hermesc'), 'WARN');
    });
    test('metro.config.js that does not call withOtaUnits -> FAIL; one that throws -> FAIL; unnamed -> auto-detected PASS; "metroConfig": false -> WARN', async () => {
      const p = richProject();
      writeFileSync(join(p, 'metro.config.js'), 'module.exports = { resolver: {} };\n');
      assert.equal(status(await doctor(p), 'metro-config-wired'), 'FAIL');
      writeFileSync(join(p, 'metro.config.js'), "throw new Error('boom in config');\n");
      const c = (await doctor(p)).find((x) => x.id === 'metro-config-wired')!;
      assert.equal(c.status, 'FAIL');
      assert.match(c.detail, /boom in config/);
      // no "metroConfig" key: metro.config.js is AUTO-DETECTED (PASS); "metroConfig": false opts out (WARN: the file is ignored)
      wj(join(p, 'units.config.json'), { units: [{ name: 'cabs', roots: ['src/units/cabs'], entry: 'src/units/cabs/entry.js' }] });
      writeFileSync(join(p, 'metro.config.js'), richCfg());
      assert.equal(status(await doctor(p), 'metro-config-used'), 'PASS');
      wj(join(p, 'units.config.json'), { metroConfig: false, units: [{ name: 'cabs', roots: ['src/units/cabs'], entry: 'src/units/cabs/entry.js' }] });
      assert.equal(status(await doctor(p), 'metro-config-used'), 'WARN');
    });
    test('hermes disabled in gradle.properties / Podfile -> FAIL, honoring --platform', async () => {
      const p = richProject();
      writeFileSync(join(p, 'android/gradle.properties'), 'hermesEnabled=false\n');
      assert.equal(status(await doctor(p, 'android'), 'hermes-engine'), 'FAIL');
      assert.equal(status(await doctor(p, 'ios'), 'hermes-engine'), 'PASS', 'android setting is irrelevant for an ios check');
      writeFileSync(join(p, 'android/gradle.properties'), 'hermesEnabled=true\n');
      writeFileSync(join(p, 'ios/Podfile'), "use_react_native!(:hermes_enabled => false)\n");
      assert.equal(status(await doctor(p, 'ios'), 'hermes-engine'), 'FAIL');
    });
    test('dangling symlink under ios/Pods that the blockList does not cover -> WARN; covered -> PASS', async () => {
      const p = richProject();
      mkdirSync(join(p, 'ios/Pods/Headers'), { recursive: true });
      symlinkSync(join(p, 'does/not/exist'), join(p, 'ios/Pods/Headers/dangling'));
      assert.equal(status(await doctor(p), 'metro-crawl'), 'PASS');
      writeFileSync(join(p, 'metro.config.js'), writeCfgWithoutBlockList());
      const c = (await doctor(p)).find((x) => x.id === 'metro-crawl')!;
      assert.equal(c.status, 'WARN');
      assert.match(c.detail, /dangling/);
    });
  });

  test('missing units.config.json -> FAIL', async () => {
    const p = fresh();
    rmSync(join(p, 'units.config.json'));
    const rep = await runDoctor({ project: p });
    assert.equal(status(rep.checks, 'units-config'), 'FAIL');
    assert.equal(rep.ok, false);
  });
  test('malformed units.config.json -> FAIL', async () => {
    const p = fresh();
    writeFileSync(join(p, 'units.config.json'), '{ nope');
    assert.equal(status(await doctor(p), 'units-config'), 'FAIL');
  });
  test('unit root that is neither a directory nor an installed package -> FAIL with the unit named', async () => {
    const p = fresh();
    wj(join(p, 'units.config.json'), { units: [{ name: 'ghost', roots: ['src/units/ghost'], entry: 'src/units/ghost/entry.js' }] });
    const c = (await doctor(p)).find((x) => x.id === 'units-resolve')!;
    assert.equal(c.status, 'FAIL');
    assert.match(c.detail, /ghost/);
  });
  test('missing entry -> FAIL; overlapping roots -> FAIL (not disjoint)', async () => {
    const p = fresh();
    wj(join(p, 'units.config.json'), { units: [{ name: 'cabs', roots: ['src/units/cabs'], entry: 'src/units/cabs/nope.js' }] });
    const c = (await doctor(p)).find((x) => x.id === 'units-resolve')!;
    assert.equal(c.status, 'FAIL');
    assert.match(c.detail, /entry/);
    wj(join(p, 'units.config.json'), { units: [
      { name: 'cabs', roots: ['src/units/cabs'], entry: 'src/units/cabs/entry.js' },
      { name: 'all', roots: ['src/units'], entry: 'src/units/bus/entry.js' },
    ] });
    const d = (await doctor(p)).find((x) => x.id === 'units-resolve')!;
    assert.equal(d.status, 'FAIL');
    assert.match(d.detail, /disjoint/);
  });
  test('missing host entry -> FAIL', async () => {
    const p = fresh();
    rmSync(join(p, 'src/host/index.js'));
    assert.equal(status(await doctor(p), 'host-entry'), 'FAIL');
  });
  test('node_modules that is a symlink -> FAIL', async () => {
    const p = fresh();
    rmSync(join(p, 'node_modules'), { recursive: true });
    const real = join(root, 'real-node-modules');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(p, 'node_modules'));
    assert.equal(status(await doctor(p), 'node-modules'), 'FAIL');
  });
  test('missing project dir / package.json -> FAIL; hermesc missing from the machine is reported by the hermesc check', async () => {
    assert.equal(status(await doctor(join(root, 'nope')), 'project'), 'FAIL');
    const p = fresh();
    rmSync(join(p, 'package.json'));
    assert.equal(status(await doctor(p), 'project'), 'FAIL');
    const saved = process.env.OTA_HERMESC;
    process.env.OTA_HERMESC = join(root, 'no-such-hermesc');
    try { assert.equal(status(await doctor(fresh()), 'hermesc'), 'FAIL'); } finally { if (saved === undefined) delete process.env.OTA_HERMESC; else process.env.OTA_HERMESC = saved; }
  });
});

function richCfg(): string {
  const splitter = join(REPO_ROOT, 'packages/unit-splitter/src/with-ota-units.js');
  return `const {withOtaUnits} = require(${JSON.stringify(splitter)});
module.exports = withOtaUnits({transformer: {babelTransformerPath: 'x'}, resolver: {}}, {units: require('./units.config.json').units, projectRoot: __dirname});
`;
}

function writeCfgWithoutBlockList(): string {
  const splitter = join(REPO_ROOT, 'packages/unit-splitter/src/with-ota-units.js');
  return `const {withOtaUnits} = require(${JSON.stringify(splitter)});
module.exports = withOtaUnits({transformer: {babelTransformerPath: 'x'}, resolver: {}}, {units: require('./units.config.json').units, projectRoot: __dirname});
`;
}
