// Negative fixtures: each direction/dependency rule must FAIL the build with a clear message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/build.js';
import { copyProject, edit, write, baseBuild, expectViolation, tmp } from './helpers.js';

test('baseline: the demo app passes all rules', async () => {
  const b = await baseBuild();
  assert.deepEqual(Object.keys(b.unitsJson.units).sort(), ['bus', 'cabs', 'travelplex']);
});

test('(i) unit -> other unit import fails', async (t) => {
  const p = copyProject();
  edit(p, 'src/units/cabs/fare.js', (s) => "import { seatPrice } from '../bus/seats';\nexport const x = seatPrice;\n" + s);
  await expectViolation(t, assert, p, 'unit-to-unit');
});

test('(ii) static host -> unit import fails', async (t) => {
  const p = copyProject();
  edit(p, 'src/host/index.js', (s) => "import cabs from '../units/cabs/entry';\nglobalThis.__cabsStatic = cabs;\n" + s);
  await expectViolation(t, assert, p, 'host-to-unit-static');
});

test('(ii) host import() of a non-entry unit module fails', async (t) => {
  const p = copyProject();
  edit(p, 'src/host/index.js', (s) => s.replace("import('../units/cabs/entry')", "import('../units/cabs/fare')"));
  await expectViolation(t, assert, p, 'host-imports-non-entry');
});

test('lazyUnit name must match the unit owning the imported entry', async (t) => {
  const p = copyProject();
  edit(p, 'src/host/index.js', (s) => s.replace("lazyUnit('cabs'", "lazyUnit('bus'"));
  await expectViolation(t, assert, p, 'lazyUnit-name-mismatch');
});

test('unit roots must be disjoint', async () => {
  const p = copyProject();
  edit(p, 'units.config.json', (s) => s.replace('"roots": ["src/units/bus"]', '"roots": ["src/units/bus", "src/units/cabs"]'));
  await assert.rejects(build({ projectRoot: p, outDir: tmp('o-') }), /not disjoint/);
});

test('module id collision is detected at build time (4-bit ids)', async () => {
  await assert.rejects(build({ projectRoot: copyProject(), outDir: tmp('o-'), bits: 4 }), /module id collision/);
});

// ---- patch-mode rules (need the base build) ----
test('(iii) unit imports a host package at a DIFFERENT version than base host: fails', async (t) => {
  const base = await baseBuild();
  const p = copyProject();
  edit(p, 'node_modules/lodash.get/package.json', (s) => s.replace('"version": "4.4.2"', '"version": "4.4.3"'));
  await expectViolation(t, assert, p, 'package-version-mismatch', { base: base.dir });
});

test('(iii) unit imports a host module that does not exist in base host: fails', async (t) => {
  const base = await baseBuild();
  const p = copyProject();
  write(p, 'src/host/shared/brandnew.js', 'export const n = 1;\n');
  edit(p, 'src/units/cabs/fare.js', (s) => "import { n } from '../../host/shared/brandnew';\nexport const y = n;\n" + s);
  await expectViolation(t, assert, p, 'missing-in-base-host', { base: base.dir });
});

test('(iii) unit imports a NEW native-looking package: fails', async (t) => {
  const base = await baseBuild();
  const p = copyProject();
  write(p, 'node_modules/fancy-native/package.json', '{"name":"fancy-native","version":"1.0.0","main":"index.js"}');
  write(p, 'node_modules/fancy-native/index.js', 'module.exports = 1;\n');
  write(p, 'node_modules/fancy-native/ios/Fancy.m', '// native\n');
  edit(p, 'src/units/cabs/fare.js', (s) => "import fancy from 'fancy-native';\nexport const y = fancy;\n" + s);
  await expectViolation(t, assert, p, 'native-package', { base: base.dir });
});

test('(iii) unit imports a NEW pure-JS package: allowed and bundled INTO the unit, host untouched', async () => {
  const base = await baseBuild();
  const p = copyProject();
  write(p, 'node_modules/tiny-pure/package.json', '{"name":"tiny-pure","version":"1.2.3","main":"index.js"}');
  write(p, 'node_modules/tiny-pure/index.js', 'module.exports = function tinyPure(x) { return "<" + x + ">"; };\n');
  edit(p, 'src/units/cabs/entry.js', (s) => "import tinyPure from 'tiny-pure';\n" + s.replace("'Cabs: '", "tinyPure('Cabs') + ': '"));
  const out = tmp('patch-');
  const r = await build({ projectRoot: p, outDir: out, base: base.dir });
  assert.deepEqual(r.unitsJson.units.cabs.packages, { 'tiny-pure': '1.2.3' });
  const cabs = fs.readFileSync(path.join(out, 'units/cabs.js'), 'utf8');
  assert.match(cabs, /tinyPure/);
  assert.doesNotMatch(fs.readFileSync(path.join(out, 'host.js'), 'utf8'), /tinyPure/);
  const ids = JSON.parse(fs.readFileSync(path.join(out, 'ids.json'), 'utf8'));
  const unitKeys = r.unitsJson.units.cabs.moduleIds.map((id) => ids[id]);
  assert.ok(unitKeys.includes('node_modules/tiny-pure/index.js'));
});
