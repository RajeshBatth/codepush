// The splitter on a REAL React Native 0.78.3 project (examples/spike-app, config via withOtaUnits in its metro.config.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, hashDir } from '../src/build.js';
import { tmp } from './helpers.js';

const SPIKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/spike-app');
const have = fs.existsSync(path.join(SPIKE, 'node_modules/react-native'));

test('real RN project: host + 3 units, asset and platform file owned by the unit, byte-identical rebuild', { skip: !have && 'examples/spike-app has no node_modules' }, async () => {
  const a = await build({ projectRoot: SPIKE, outDir: tmp('spk-a-'), platform: 'android' });
  const b = await build({ projectRoot: SPIKE, outDir: tmp('spk-b-'), platform: 'android' }); // 2nd build in one process: config re-evaluated
  assert.deepEqual(a.files, b.files);
  const u = a.unitsJson;
  assert.deepEqual(Object.keys(u.units).sort(), ['bus', 'cabs', 'travelplex']);
  assert.ok(u.host.moduleIds.length > 300, 'RN internals are in the host');
  assert.deepEqual(u.units.bus.assets.map((x) => x.path), ['src/units/bus/assets/bus-icon.png']);
  const ids = JSON.parse(fs.readFileSync(path.join(a.outDir, 'ids.json'), 'utf8'));
  assert.ok(u.units.bus.moduleIds.some((id) => ids[id] === 'src/units/bus/seat-label.android.js'));
  const host = fs.readFileSync(path.join(a.outDir, 'host.js'), 'utf8');
  assert.match(host, /"paths":\{"\d+":"cabs"/); // import() of a unit entry carries the unit name
  assert.equal(Object.keys(hashDir(a.outDir)).length, 6);
  // static checks on the real graph: nothing enforced is violated; RN-internal cycles are only counted
  assert.equal(a.checks.cycles.count, 0);
  assert.equal(a.checks['register-component'].count, 0, 'spike units register their component (checks.requireRegisterComponent)');
  assert.equal(a.checks['dynamic-require'].count, 0);
  assert.equal(a.checks['single-import-site'].count, 0);
  assert.ok(a.checks.cycles.thirdPartyHostCycles >= 0);
  assert.deepEqual(a.warnings, []);
});
