// Which Metro runs (project's vs the splitter's fallback), the version gate on that Metro, withOtaUnits on partial configs,
// and metro.config.js auto-detection. Location/gate logic is tested with package.json-only stub projects (no second real Metro).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { locateMetro, checkMetroVersions, describeMetro, MetroCompatError } from '../src/metro-compat.js';
import { resolveMetroConfigFile } from '../src/config.js';
import { withOtaUnits } from '../src/with-ota-units.js';
import { build } from '../src/build.js';
import { DEMO, copyProject, write, tmp } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPLITTER = path.resolve(HERE, '..');
const COMPAT = path.join(SPLITTER, 'src/metro-compat.js');

/** A project dir whose node_modules holds package.json-only stubs: { metro: '0.81.5', 'metro-config': '0.81.5', ... } */
function stubProject(versions) {
  const root = tmp('stub-');
  write(root, 'package.json', JSON.stringify({ name: 'stub-app', version: '1.0.0' }));
  for (const [name, version] of Object.entries(versions)) {
    write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version, main: 'index.js' }));
    write(root, `node_modules/${name}/index.js`, 'module.exports = {};');
  }
  return root;
}
const all = (v) => ({ metro: v, 'metro-config': v, 'metro-runtime': v });
const rel = (p) => fs.realpathSync(p);

test('locateMetro: the PROJECT\'s metro/metro-config/metro-runtime win over the splitter\'s copy', () => {
  const root = stubProject(all('0.81.5'));
  const l = locateMetro(root);
  assert.equal(l.source, 'project');
  for (const n of ['metro', 'metro-config', 'metro-runtime']) {
    assert.equal(l.packages[n].from, 'project');
    assert.equal(rel(l.packages[n].pkgPath), rel(path.join(root, 'node_modules', n, 'package.json')));
  }
});

test('locateMetro: a project without metro falls back to the splitter\'s copy and says so', () => {
  const root = stubProject({});
  const l = locateMetro(root);
  assert.equal(l.source, 'fallback');
  assert.equal(l.packages.metro.from, 'fallback');
  assert.ok(l.packages.metro.pkgPath.startsWith(SPLITTER), l.packages.metro.pkgPath);
  // describeMetro is the doctor's view of the same decision
  const d = describeMetro(root);
  assert.equal(d.source, 'fallback');
  assert.equal(d.version, JSON.parse(fs.readFileSync(path.join(SPLITTER, 'node_modules/metro/package.json'), 'utf8')).version);
});

test('locateMetro: real demo app (metro-runtime of its own, no metro) -> metro falls back, metro-runtime comes from the project', () => {
  const l = locateMetro(DEMO);
  assert.equal(l.source, 'fallback');
  assert.equal(l.packages['metro-runtime'].from, 'project');
  assert.equal(l.packages['metro-config'].from, 'metro', 'metro-config is taken next to the chosen metro');
});

test('gate applies to the Metro that was LOCATED: unsupported project Metro fails with a clear message naming it', () => {
  const root = stubProject(all('0.99.0'));
  assert.throws(() => checkMetroVersions(locateMetro(root)), (e) => {
    assert.ok(e instanceof MetroCompatError);
    assert.match(e.message, /unsupported Metro 0\.99\.0/);
    assert.match(e.message, /the project's Metro/);
    assert.ok(e.message.includes(path.join(rel(root), 'node_modules/metro')), e.message);
    assert.match(e.message, /0\.81\.x, 0\.87\.x/);
    return true;
  });
  assert.equal(checkMetroVersions(locateMetro(stubProject(all('0.81.5')))), '0.81');
  assert.equal(checkMetroVersions(locateMetro(stubProject(all('0.87.1')))), '0.87');
  assert.throws(() => checkMetroVersions(locateMetro(stubProject({ metro: '0.81.5', 'metro-config': '0.81.4', 'metro-runtime': '0.81.5' }))), /metro 0\.81\.5 and metro-config 0\.81\.4 differ/);
});

test('initMetro in a fresh process: unsupported project Metro -> MetroCompatError; fallback project loads the splitter\'s Metro', () => {
  const run = (root) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { initMetro, metroVersion, metroSource } from ${JSON.stringify(COMPAT)}; initMetro(${JSON.stringify(root)}); console.log(JSON.stringify({ metroVersion, metroSource }));`], { encoding: 'utf8' });
  const bad = run(stubProject(all('0.99.0')));
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /MetroCompatError/);
  assert.match(bad.stderr, /unsupported Metro 0\.99\.0/);
  const ok = run(DEMO);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout.trim().split('\n').pop()).metroSource, 'fallback');
});

test('withOtaUnits on a partial base config: no crash, only serializer is added (object, Promise and function forms)', async () => {
  const units = [{ name: 'cabs', roots: ['src/units/cabs'], entry: 'src/units/cabs/entry.js' }];
  const o = { units, projectRoot: DEMO, enabled: true };
  for (const base of [{}, { resolver: {} }, { transformer: {} }, { serializer: { keep: 1 } }]) {
    const c = withOtaUnits(base, o);
    assert.equal(typeof c.serializer.customSerializer, 'function');
    assert.equal(typeof c.serializer.createModuleIdFactory, 'function');
    assert.deepEqual({ ...c, serializer: undefined }, { ...base, serializer: undefined }, 'everything else untouched');
    if (base.serializer) assert.equal(c.serializer.keep, 1);
  }
  assert.equal(typeof (await withOtaUnits(Promise.resolve({}), o)).serializer.customSerializer, 'function');
  assert.equal(typeof (await withOtaUnits(async () => ({ resolver: {} }), o)({})).serializer.customSerializer, 'function');
  const inert = {};
  assert.equal(withOtaUnits(inert, { units, projectRoot: DEMO, enabled: false }), inert, 'inert mode returns the very same object');
});

test('withOtaUnits: clear errors for bad arguments (naming the key and the fix)', () => {
  assert.throws(() => withOtaUnits({}, { projectRoot: DEMO }), /`units` is required.*units\.config\.json/);
  assert.throws(() => withOtaUnits({}, { units: [] }), /projectRoot is required/);
  assert.throws(() => withOtaUnits(undefined, { units: [], projectRoot: DEMO }), /first argument must be the Metro config/);
});

test('resolveMetroConfigFile: named > auto-detected metro.config.js/.cjs > none; false/null disables', () => {
  const root = tmp('mc-');
  assert.deepEqual(resolveMetroConfigFile(root, {}), { file: null, source: 'none' });
  write(root, 'metro.config.js', '');
  assert.deepEqual(resolveMetroConfigFile(root, {}), { file: 'metro.config.js', source: 'auto-detected' });
  assert.deepEqual(resolveMetroConfigFile(root, { metroConfig: false }), { file: null, source: 'disabled' });
  assert.deepEqual(resolveMetroConfigFile(root, { metroConfig: null }), { file: null, source: 'disabled' });
  assert.deepEqual(resolveMetroConfigFile(root, { metroConfig: 'other.js' }), { file: 'other.js', source: 'units.config.json' });
  fs.rmSync(path.join(root, 'metro.config.js'));
  write(root, 'metro.config.cjs', '');
  assert.deepEqual(resolveMetroConfigFile(root, {}), { file: 'metro.config.cjs', source: 'auto-detected' });
});

test('build(): metro.config.js is auto-detected (no "metroConfig" key) and used; a metro.config.js without withOtaUnits fails clearly; "metroConfig": false opts out', async () => {
  const proj = copyProject();
  const rnMetroConfig = createRequire(import.meta.url).resolve('@react-native/metro-config');
  write(proj, 'metro.config.js', `
const fs = require('fs'); const path = require('path');
fs.writeFileSync(path.join(__dirname, 'config-loaded.marker'), '1');
const { getDefaultConfig, mergeConfig } = require(${JSON.stringify(rnMetroConfig)});
const { withOtaUnits } = require(${JSON.stringify(path.join(SPLITTER, 'src/with-ota-units.js'))});
module.exports = withOtaUnits(mergeConfig(getDefaultConfig(__dirname), { serializer: { getModulesRunBeforeMainModule: () => [] }, resolver: { nodeModulesPaths: [path.join(__dirname, 'node_modules')] } }),
  { units: require('./units.config.json').units, projectRoot: __dirname });
`);
  const out = tmp('out-');
  const r = await build({ projectRoot: proj, outDir: out });
  assert.ok(fs.existsSync(path.join(proj, 'config-loaded.marker')), 'the app\'s metro.config.js was loaded without being named');
  assert.ok(fs.existsSync(path.join(out, 'host.js')));
  assert.deepEqual(Object.keys(r.unitsJson.units).sort(), ['bus', 'cabs', 'travelplex']);

  // a config that forgets withOtaUnits: explicit error with the fix
  write(proj, 'metro.config.js', 'module.exports = {};');
  await assert.rejects(build({ projectRoot: proj, outDir: tmp('out-') }), /did not call withOtaUnits.*"metroConfig": false/s);
  // opt-out: the splitter assembles its own config again
  const cfg = JSON.parse(fs.readFileSync(path.join(proj, 'units.config.json'), 'utf8'));
  write(proj, 'units.config.json', JSON.stringify({ ...cfg, metroConfig: false }));
  await assert.doesNotReject(build({ projectRoot: proj, outDir: tmp('out-') }));
});
