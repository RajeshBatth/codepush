// C1 cycles, C2 encapsulation / package-name ownership, C3 dynamic references, C4 registerComponent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build, generateCycleBaseline } from '../src/build.js';
import { tarjan, signatureOf, parseChecks, findRequireContext, checkRegisterComponent } from '../src/checks.js';
import { copyProject, edit, write, baseBuild, expectViolation, tmp } from './helpers.js';

const setChecks = (p, checks) => edit(p, 'units.config.json', (s) => JSON.stringify({ ...JSON.parse(s), checks }, null, 2));
const messages = (e, rule) => e.violations.filter((v) => v.rule === rule).map((v) => v.message);
async function failing(p, opts = {}) {
  try { await build({ projectRoot: p, outDir: tmp('out-'), ...opts }); } catch (e) { return e; }
  assert.fail('build unexpectedly passed');
}

// ---------------------------------------------------------------- C1 cycles
test('C1 tarjan is iterative (100k-deep chain + back edge)', () => {
  const n = 100000;
  const nodes = Array.from({ length: n }, (_, i) => i);
  const sccs = tarjan(nodes, (v) => (v + 1 < n ? [v + 1] : [0]));
  assert.equal(sccs.length, 1);
  assert.equal(sccs[0].length, n);
});

test('C1 cycle inside a unit fails with the module chain and a stable signature', async () => {
  const p = copyProject();
  write(p, 'src/units/cabs/util.js', "import { fare } from './fare';\nexport const u = () => fare;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import { u } from './util';\nexport const viaU = u;\n" + s);
  const e = await failing(p);
  const [m] = messages(e, 'cycle');
  assert.match(m, /unit cabs: src\/units\/cabs\/(fare|util)\.js -> src\/units\/cabs\/(fare|util)\.js -> src\/units\/cabs\/(fare|util)\.js/);
  const sig = signatureOf(['src/units/cabs/fare.js', 'src/units/cabs/util.js']);
  assert.ok(m.includes(sig.slice(0, 12)), m);
});

test('C1 self-loop and cycle in first-party host code fail; the third-party part of the host is not checked', async () => {
  const p = copyProject();
  write(p, 'src/host/shared/self.js', "import { x } from './self';\nexport const y = x;\nexport const x2 = 1;\n");
  edit(p, 'src/host/index.js', (s) => "import './shared/self';\n" + s);
  const e = await failing(p);
  assert.match(messages(e, 'cycle')[0], /first-party host code: src\/host\/shared\/self\.js -> src\/host\/shared\/self\.js/);
});

test('C1 ratchet: baseline file accepts existing cycles, new ones still fail; generate-baseline output is usable', async () => {
  const p = copyProject();
  write(p, 'src/units/cabs/util.js', "import { fare } from './fare';\nexport const u = () => fare;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import { u } from './util';\nexport const viaU = u;\n" + s);
  const bl = await generateCycleBaseline({ projectRoot: p });
  assert.equal(bl.cycles.cabs.length, 1);
  assert.deepEqual(bl.cycles.cabs[0].modules, ['src/units/cabs/fare.js', 'src/units/cabs/util.js']);
  fs.writeFileSync(path.join(p, 'cycles.baseline.json'), JSON.stringify(bl));
  setChecks(p, { cycleBaseline: 'cycles.baseline.json' });
  const r = await build({ projectRoot: p, outDir: tmp('out-') });
  assert.equal(r.checks.cycles.baselined, 1);
  assert.equal(r.checks.cycles.count, 0);
  assert.equal(r.unitsJson.cycles.cabs.length, 1, 'cycles are recorded in units.json');
  // a NEW cycle (bus) still fails
  write(p, 'src/units/bus/u2.js', "import { seatPrice } from './seats';\nexport const q = seatPrice;\n");
  edit(p, 'src/units/bus/seats.js', (s) => "import { q } from './u2';\nexport const qq = q;\n" + s);
  const e = await failing(p);
  assert.match(messages(e, 'cycle')[0], /unit bus/);
  assert.equal(messages(e, 'cycle').length, 1);
});

test('C1 baseline entry matched by {owner, modules} alone (hand-written)', async () => {
  const p = copyProject();
  write(p, 'src/units/cabs/util.js', "import { fare } from './fare';\nexport const u = () => fare;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import { u } from './util';\nexport const viaU = u;\n" + s);
  fs.writeFileSync(path.join(p, 'b.json'), JSON.stringify({ cycles: { cabs: [{ modules: ['src/units/cabs/util.js', 'src/units/cabs/fare.js'] }] } }));
  setChecks(p, { cycleBaseline: 'b.json' });
  await build({ projectRoot: p, outDir: tmp('out-') });
});

test('C1 severity warn: reported in the result, build passes; off: silent', async () => {
  const p = copyProject();
  write(p, 'src/units/cabs/util.js', "import { fare } from './fare';\nexport const u = () => fare;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import { u } from './util';\nexport const viaU = u;\n" + s);
  setChecks(p, { cycles: 'warn' });
  const r = await build({ projectRoot: p, outDir: tmp('out-') });
  assert.equal(r.warnings.filter((w) => w.rule === 'cycle').length, 1);
  assert.equal(r.checks.cycles.severity, 'warn');
  assert.deepEqual(r.unitsJson.warnings, r.warnings);
  setChecks(p, { cycles: 'off' });
  const r2 = await build({ projectRoot: p, outDir: tmp('out-') });
  assert.equal(r2.warnings.length, 0);
});

test('C1 a cycle that needs an import() edge is only a warning', async () => {
  const p = copyProject();
  write(p, 'src/units/cabs/lazy.js', "import { fare } from './fare';\nexport const l = fare;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "export const load = () => import('./lazy');\n" + s);
  const r = await build({ projectRoot: p, outDir: tmp('out-') });
  const w = r.warnings.filter((x) => x.rule === 'cycle-async');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /import\(\) edge/);
  assert.equal(r.checks.cycles.count, 0);
});

test('C1 patch mode: only cycles NEW compared to the base build fail (cycles recorded in units.json)', async () => {
  const p = copyProject();
  write(p, 'src/units/cabs/util.js', "import { fare } from './fare';\nexport const u = () => fare;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import { u } from './util';\nexport const viaU = u;\n" + s);
  setChecks(p, { cycles: 'warn' });
  const baseOut = tmp('cbase-');
  await build({ projectRoot: p, outDir: baseOut }); // base with an (adopted) cycle
  assert.equal(JSON.parse(fs.readFileSync(path.join(baseOut, 'units.json'), 'utf8')).cycles.cabs.length, 1);
  setChecks(p, { cycles: 'error' });
  const r = await build({ projectRoot: p, outDir: tmp('out-'), base: baseOut });
  assert.equal(r.checks.cycles.baselined, 1);
  // add a new cycle in bus
  write(p, 'src/units/bus/u2.js', "import { seatPrice } from './seats';\nexport const q = seatPrice;\n");
  edit(p, 'src/units/bus/seats.js', (s) => "import { q } from './u2';\nexport const qq = q;\n" + s);
  const e = await failing(p, { base: baseOut });
  assert.match(messages(e, 'cycle')[0], /new compared to the base build/);
  // base without a `cycles` record: falls back to the baseline file and says so
  const old = tmp('cold-');
  fs.cpSync(baseOut, old, { recursive: true });
  const uj = JSON.parse(fs.readFileSync(path.join(old, 'units.json'), 'utf8'));
  delete uj.cycles;
  fs.writeFileSync(path.join(old, 'units.json'), JSON.stringify(uj));
  const e2 = await failing(p, { base: old });
  assert.ok(e2.warnings.some((w) => w.rule === 'cycles-base-missing'));
  assert.equal(messages(e2, 'cycle').length, 2);
});

test('C1 demo app has no cycles; units.json carries cycles/warnings/checks', async () => {
  const b = await baseBuild();
  assert.deepEqual(b.unitsJson.cycles, { host: [], cabs: [], bus: [], travelplex: [] });
  assert.deepEqual(b.unitsJson.warnings, []);
  assert.equal(b.unitsJson.checks.cycles.severity, 'error');
  assert.equal(typeof b.unitsJson.checks.cycles.thirdPartyHostCycles, 'number');
});

test('config: bad checks values are rejected', () => {
  assert.throws(() => parseChecks({ cycles: 'maybe' }), /checks\.cycles/);
  assert.throws(() => parseChecks({ nope: 1 }), /unknown key/);
  assert.throws(() => parseChecks({ requireRegisterComponent: 'yes' }), /boolean/);
  assert.equal(parseChecks({}).singleImportSite, 'warn');
});

// ---------------------------------------------------------------- C2 encapsulation
test('C2 another unit async-importing a unit entry is still unit-to-unit', async (t) => {
  const p = copyProject();
  edit(p, 'src/units/bus/seats.js', (s) => "export const loadCabs = () => import('../cabs/entry');\n" + s);
  await expectViolation(t, assert, p, 'unit-to-unit');
});

test('C2 host require() of a unit module fails', async (t) => {
  const p = copyProject();
  edit(p, 'src/host/index.js', (s) => "globalThis.__r1 = require('../units/cabs/fare');\n" + s);
  await expectViolation(t, assert, p, 'host-to-unit-static');
});

test('C2 host `export ... from` re-export of a unit module fails', async (t) => {
  const p = copyProject();
  write(p, 'src/host/shared/reexport.js', "export { seatPrice } from '../../units/bus/seats';\n");
  edit(p, 'src/host/index.js', (s) => "import './shared/reexport';\n" + s);
  await expectViolation(t, assert, p, 'host-to-unit-static');
});

test('C2 a unit module re-exported through a host barrel file fails', async (t) => {
  const p = copyProject();
  write(p, 'src/host/shared/barrel.js', "export * from './format';\nexport * from '../../units/cabs/entry';\n");
  edit(p, 'src/host/index.js', (s) => "import * as barrel from './shared/barrel';\nglobalThis.__barrel = barrel;\n" + s);
  await expectViolation(t, assert, p, 'host-to-unit-static');
});

test('C2 another unit importing a NON-entry module of a unit fails', async (t) => {
  const p = copyProject();
  edit(p, 'src/units/travelplex/itinerary.js', (s) => "import { fare } from '../cabs/fare';\nexport const f2 = fare;\n" + s);
  await expectViolation(t, assert, p, 'unit-to-unit');
});

test('C2 second import site of a unit entry: warn by default, error when configured', async () => {
  const p = copyProject();
  write(p, 'src/host/second.js', "export const again = () => import('../units/cabs/entry');\n");
  edit(p, 'src/host/index.js', (s) => "import { again } from './second';\nglobalThis.__again = again;\n" + s);
  const r = await build({ projectRoot: p, outDir: tmp('out-') });
  const w = r.warnings.find((x) => x.rule === 'multiple-import-sites');
  assert.ok(w, 'warning expected');
  assert.match(w.message, /unit cabs.*src\/host\/index\.js import\('\.\.\/units\/cabs\/entry'\).*src\/host\/second\.js/);
  assert.equal(r.checks['single-import-site'].count, 1);
  setChecks(p, { singleImportSite: 'error' });
  const e = await failing(p);
  assert.equal(messages(e, 'multiple-import-sites').length, 1);
  setChecks(p, { singleImportSite: 'off' });
  assert.equal((await build({ projectRoot: p, outDir: tmp('out-') })).warnings.length, 0);
});

// ---- ownership by package name
const BUS_PKG = {
  'package.json': '{"name":"@lob/bus","version":"1.0.0","main":"entry.js"}',
  'entry.js': "import { seatPrice } from './seats';\nimport { seatLabel } from './seat-label';\nexport default { name: 'bus', render: ({ seats }) => 'Bus: ' + seatLabel(seats) + ' cost ' + seatPrice(seats) };\n",
  'seats.js': "import get from 'lodash.get';\nexport function seatPrice(n, layout) { return n * 10 + get(layout, 'rows', 10); }\n",
  'seat-label.ios.js': "export const seatLabel = (n) => n + ' seats (ios)';\n",
  'seat-label.android.js': "export const seatLabel = (n) => n + ' seats (android)';\n",
};
function packageProject(mode) {
  const p = copyProject();
  fs.rmSync(path.join(p, 'src/units/bus'), { recursive: true });
  let pkgDir;
  let cleanup = () => {};
  if (mode === 'copy') pkgDir = path.join(p, 'node_modules/@lob/bus');
  else if (mode === 'link-inside') pkgDir = path.join(p, 'packages/bus-pkg');
  else { pkgDir = path.join(tmp('ws-'), 'bus-pkg'); cleanup = () => fs.rmSync(path.dirname(pkgDir), { recursive: true, force: true }); }
  for (const [f, c] of Object.entries(BUS_PKG)) write(pkgDir, f, c);
  if (mode !== 'copy') {
    fs.mkdirSync(path.join(p, 'node_modules/@lob'), { recursive: true });
    fs.symlinkSync(pkgDir, path.join(p, 'node_modules/@lob/bus'), 'dir');
  }
  edit(p, 'units.config.json', (s) => s.replace('"roots": ["src/units/bus"], "entry": "src/units/bus/entry.js"', '"roots": ["@lob/bus"], "entry": "@lob/bus/entry.js"'));
  edit(p, 'src/host/index.js', (s) => s.replace("import('../units/bus/entry')", "import('@lob/bus/entry')"));
  return { p, cleanup };
}
for (const [mode, keyPrefix] of [['copy', 'node_modules/@lob/bus'], ['link-inside', 'packages/bus-pkg'], ['link-outside', 'node_modules/@lob/bus']]) {
  test(`C2 ownership by package name (${mode}): package modules belong to the unit, not the host`, async () => {
    const { p, cleanup } = packageProject(mode);
    try {
      const out = tmp('out-');
      const r = await build({ projectRoot: p, outDir: out });
      const ids = JSON.parse(fs.readFileSync(path.join(out, 'ids.json'), 'utf8'));
      const unitKeys = r.unitsJson.units.bus.moduleIds.map((id) => ids[id]).sort();
      assert.deepEqual(unitKeys, [`${keyPrefix}/entry.js`, `${keyPrefix}/seat-label.ios.js`, `${keyPrefix}/seats.js`]);
      const hostKeys = r.unitsJson.host.moduleIds.map((id) => ids[id]);
      assert.ok(!hostKeys.some((k) => k.includes('bus')), 'nothing of the package is in the host');
      assert.equal(r.unitsJson.units.bus.entryPath, `${keyPrefix}/entry.js`);
      assert.match(fs.readFileSync(path.join(out, 'host.js'), 'utf8'), /"paths":\{[^}]*"bus"/);
      assert.doesNotMatch(fs.readFileSync(path.join(out, 'host.js'), 'utf8'), /seatLabel/);
    } finally { cleanup(); }
  });
}

test('C2 package-name unit: rules still apply (unit->unit, static host import, lazyUnit name)', async (t) => {
  const p1 = packageProject('copy').p;
  edit(p1, 'src/units/cabs/fare.js', (s) => "import { seatPrice } from '@lob/bus/seats';\nexport const x = seatPrice;\n" + s);
  await expectViolation(t, assert, p1, 'unit-to-unit');
  const p2 = packageProject('copy').p;
  edit(p2, 'src/host/index.js', (s) => "import bus from '@lob/bus/entry';\nglobalThis.__b = bus;\n" + s);
  await expectViolation(t, assert, p2, 'host-to-unit-static');
  const p3 = packageProject('copy').p;
  edit(p3, 'src/host/index.js', (s) => s.replace("lazyUnit('bus'", "lazyUnit('cabs'"));
  await expectViolation(t, assert, p3, 'lazyUnit-name-mismatch');
});

test('C2 a root that is neither a directory nor an installed package is a config error', async () => {
  const p = copyProject();
  edit(p, 'units.config.json', (s) => s.replace('"roots": ["src/units/bus"]', '"roots": ["@lob/not-installed"]'));
  await assert.rejects(build({ projectRoot: p, outDir: tmp('o-') }), /not-installed/);
});

// ---------------------------------------------------------------- C3 dynamic references
test('C3 non-literal require() in a unit / in host code: Metro rejects, translated to rule dynamic-require', async (t) => {
  const p = copyProject();
  edit(p, 'src/units/cabs/fare.js', (s) => "export const dyn = (n) => require('./' + n + (globalThis.suffix));\n" + s);
  const e = await failing(p);
  assert.ok(e.violations.some((v) => v.rule === 'dynamic-require' && /src\/units\/cabs\/fare\.js:1/.test(v.message)), e.message);
  const h = copyProject();
  edit(h, 'src/host/shared/format.js', (s) => "export const dyn = (n) => require(n);\n" + s);
  await expectViolation(t, assert, h, 'dynamic-require');
});

test('C3 non-literal import() in host code is translated too', async (t) => {
  const p = copyProject();
  edit(p, 'src/host/shared/format.js', (s) => "export const dyn = (n) => import(n);\n" + s);
  await expectViolation(t, assert, p, 'dynamic-require');
});

test('C3 require.context in a unit fails (Metro would only throw at runtime)', async (t) => {
  const p = copyProject();
  edit(p, 'src/units/cabs/fare.js', (s) => "export const ctx = () => require.context('./', false, /x/);\n" + s);
  const e = await failing(p);
  assert.ok(e.violations.some((v) => v.rule === 'dynamic-require' && /require\.context/.test(v.message)), e.message);
  assert.equal(findRequireContext("const a = 1; require.context('./x');", 'a.js').length, 1);
  assert.equal(findRequireContext("// require.context('./x')\nconst a = 1;", 'a.js').length, 0);
  setChecks(p, { dynamicRequire: 'warn' });
  const r = await build({ projectRoot: p, outDir: tmp('out-') });
  assert.ok(r.warnings.some((w) => w.rule === 'dynamic-require'));
  setChecks(p, { dynamicRequire: 'off' });
  assert.equal((await build({ projectRoot: p, outDir: tmp('out-') })).warnings.length, 0);
});

test('C3 a new pure-JS package bundled INTO a unit (patch mode) with a non-literal require fails; in the host it is only counted', async () => {
  const base = await baseBuild();
  const p = copyProject();
  write(p, 'node_modules/dyn-pure/package.json', '{"name":"dyn-pure","version":"1.0.0","main":"index.js"}');
  write(p, 'node_modules/dyn-pure/index.js', 'module.exports = function (n) { return require("./lib/" + n); };\n');
  edit(p, 'src/units/cabs/entry.js', (s) => "import dyn from 'dyn-pure';\nglobalThis.__dyn = dyn;\n" + s);
  const e = await failing(p, { base: base.dir });
  assert.ok(e.violations.some((v) => v.rule === 'dynamic-require' && /node_modules\/dyn-pure\/index\.js:1/.test(v.message) && /unit cabs/.test(v.message)), e.message);
  // the same package imported by the host: counted, not enforced
  const h = copyProject();
  write(h, 'node_modules/dyn-pure/package.json', '{"name":"dyn-pure","version":"1.0.0","main":"index.js"}');
  write(h, 'node_modules/dyn-pure/index.js', 'module.exports = function (n) { return require("./lib/" + n); };\n');
  edit(h, 'src/host/index.js', (s) => "import dyn from 'dyn-pure';\nglobalThis.__dyn = dyn;\n" + s);
  const r = await build({ projectRoot: h, outDir: tmp('out-') });
  assert.deepEqual(r.checks['dynamic-require'].thirdPartyModules, ['node_modules/dyn-pure/index.js']);
  assert.equal(r.checks['dynamic-require'].count, 0);
});

// ---------------------------------------------------------------- C4 registerComponent
test('C4 requireRegisterComponent: off by default; on => entry must register its unit name as a literal', async () => {
  const p = copyProject();
  setChecks(p, { requireRegisterComponent: true });
  let e = await failing(p);
  assert.equal(messages(e, 'register-component').length, 3);
  assert.match(messages(e, 'register-component')[0], /never calls AppRegistry\.registerComponent/);
  const reg = (name) => `const AppRegistry = { registerComponent() {} };\nAppRegistry.registerComponent(${name}, () => null);\n`;
  edit(p, 'src/units/cabs/entry.js', (s) => reg("'cabs'") + s);
  edit(p, 'src/units/bus/entry.js', (s) => reg("'cabz'") + s);
  edit(p, 'src/units/travelplex/entry.js', (s) => reg('globalThis.n') + s);
  e = await failing(p);
  const ms = messages(e, 'register-component');
  assert.equal(ms.length, 2);
  assert.ok(ms.some((m) => /registers 'cabz' but the unit is named 'bus'/.test(m)));
  assert.ok(ms.some((m) => /non-literal name/.test(m)));
  edit(p, 'src/units/bus/entry.js', (s) => s.replace("'cabz'", "'bus'"));
  edit(p, 'src/units/travelplex/entry.js', (s) => s.replace('globalThis.n', '"travelplex"'));
  const r = await build({ projectRoot: p, outDir: tmp('out-') });
  assert.equal(r.checks['register-component'].count, 0);
  assert.equal(checkRegisterComponent(path.join(p, 'src/units/cabs/entry.js'), 'cabs'), null);
});
