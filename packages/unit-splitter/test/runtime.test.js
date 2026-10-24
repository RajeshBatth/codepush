// Runtime behaviour in the vm harness: lazy loading, corrupt-unit fallback, define() semantics,
// patched unit, concurrency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from '../src/build.js';
import { diffAgainstBase } from '../src/diff.js';
import { createRuntime } from '../harness/harness.js';
import { baseBuild, copyProject, edit, tmp } from './helpers.js';

const metroVersion = createRequire(import.meta.url)('metro/package.json').version;

const EXPECT = {
  cabs: ['Cabs: 10km costs INR 170.00', { km: 10 }],
  bus: ['Bus: 2 seats (ios) cost INR 810.00', { seats: 2 }],
  travelplex: ['Travelplex: 3 day trip, 3d total', { days: 3 }],
};

test('(1) every unit lazy-loads through plain import() -> asyncRequire -> __loadBundleAsync', async () => {
  const base = await baseBuild();
  const rt = createRuntime({ distDir: base.dir });
  assert.deepEqual(Array.from(rt.app().listUnits()), ['bus', 'cabs', 'travelplex']);
  assert.deepEqual(rt.registered, [], 'booting the host must not register any unit module');
  for (const [name, [out, props]] of Object.entries(EXPECT)) {
    assert.equal(await rt.openUnit(name, props), out);
  }
  // the loader was invoked with the unit NAME taken from the emitted `paths` map
  assert.deepEqual(Array.from(rt.loadCalls).sort(), ['bus', 'cabs', 'travelplex']);
  // unit modules registered; host singleton store shared with units (same module instance)
  assert.equal(rt.evalCount('cabs'), 1);
});

test('(1b) units/host files have the shape the design assumes', async () => {
  const base = await baseBuild();
  const host = fs.readFileSync(path.join(base.dir, 'host.js'), 'utf8');
  assert.match(host, /global\.__r = metroRequire/);
  assert.match(host, /"paths":\{"\d+":"(cabs|bus|travelplex)"/);
  for (const u of Object.keys(base.unitsJson.units)) {
    const code = fs.readFileSync(path.join(base.dir, 'units', u + '.js'), 'utf8');
    assert.ok(!code.includes('global.__r = metroRequire'), 'no Metro runtime in a unit');
    assert.ok(code.startsWith('__d('));
    // host.js must contain none of the unit's module ids as definitions
    for (const id of base.unitsJson.units[u].moduleIds) assert.ok(!host.includes(`},${id},`), `unit module ${id} leaked into host`);
  }
});

test('(2) corrupt / invalid unit is rejected BEFORE any module registers; fallback to embedded works', async () => {
  const base = await baseBuild();
  const patch = tmp('patch-');
  fs.mkdirSync(path.join(patch, 'units'));
  const good = fs.readFileSync(path.join(base.dir, 'units/cabs.js'), 'utf8');

  // (a) truncated file
  fs.writeFileSync(path.join(patch, 'units/cabs.js'), good.slice(0, Math.floor(good.length / 2)));
  let rt = createRuntime({ distDir: base.dir, patchDir: patch });
  assert.equal(await rt.openUnit('cabs', { km: 10 }), EXPECT.cabs[0]);
  assert.deepEqual(rt.events.map((e) => `${e.source}:${e.status}`), ['patch:rejected', 'embedded:ok']);
  // nothing from the corrupt file registered: only the embedded unit's own modules
  assert.deepEqual(rt.registered.slice().sort(), base.unitsJson.units.cabs.moduleIds.slice().sort());

  // (b) valid JS but with a side effect outside __d(...): rejected without running
  fs.writeFileSync(path.join(patch, 'units/cabs.js'), 'globalThis.pwned = 1;\n' + good);
  rt = createRuntime({ distDir: base.dir, patchDir: patch });
  assert.equal(await rt.openUnit('cabs', { km: 10 }), EXPECT.cabs[0]);
  assert.equal(rt.ctx.pwned, undefined);
  assert.match(rt.events[0].reason, /not a __d/);

});

test('(2c) unit that fails everywhere rejects the import() and can be retried', async () => {
  const base = await baseBuild();
  const broken = tmp('broken-');
  fs.cpSync(base.dir, broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'units/bus.js'), '__d(function(){');
  const rt = createRuntime({ distDir: broken });
  await assert.rejects(rt.openUnit('bus', { seats: 1 }), /failed to load/);
  assert.equal(rt.registered.length, 0);
  fs.copyFileSync(path.join(base.dir, 'units/bus.js'), path.join(broken, 'units/bus.js')); // "retry" with a good file
  assert.equal(await rt.openUnit('bus', EXPECT.bus[1]), EXPECT.bus[0]);
});

test('(3) Metro define() ignores a second definition of an already-defined module id', async () => {
  const base = await baseBuild();
  // patched cabs: same module ids, different behaviour
  const proj = copyProject();
  edit(proj, 'src/units/cabs/fare.js', (s) => s.replace("getConfig('rates.cab.base')", '1000'));
  const patchOut = tmp('patched-');
  await build({ projectRoot: proj, outDir: patchOut, base: base.dir });
  const patchedFile = path.join(patchOut, 'units/cabs.js');
  const baseFile = path.join(base.dir, 'units/cabs.js');
  assert.notEqual(fs.readFileSync(patchedFile, 'utf8'), fs.readFileSync(baseFile, 'utf8'));

  // Case A: base unit loaded AND initialized, then the patched file is evaluated in the same context.
  let rt = createRuntime({ distDir: base.dir });
  assert.equal(await rt.openUnit('cabs', { km: 10 }), 'Cabs: 10km costs INR 170.00');
  const before = rt.registered.length;
  rt.evalUnitFile(patchedFile); // no throw, no warning: silently ignored
  assert.equal(rt.registered.length, before + 2, 'patched __d calls were made (2 modules) ...');
  assert.equal(await rt.openUnit('cabs', { km: 10 }), 'Cabs: 10km costs INR 170.00', '... but the old definition still wins');
  assert.equal(rt.evalCount('cabs'), 1);

  // Case B: base unit evaluated (defined, NOT yet initialized), then patched file: still first-wins.
  rt = createRuntime({ distDir: base.dir });
  rt.evalUnitFile(baseFile);
  rt.evalUnitFile(patchedFile);
  assert.equal(await rt.openUnit('cabs', { km: 10 }), 'Cabs: 10km costs INR 170.00');

  // Case C (control): patched file FIRST in a fresh context => patched behaviour (first definition wins).
  rt = createRuntime({ distDir: base.dir });
  rt.evalUnitFile(patchedFile);
  rt.evalUnitFile(baseFile);
  assert.equal(await rt.openUnit('cabs', { km: 10 }), 'Cabs: 10km costs INR 1120.00');
  console.log(`# observed (metro ${metroVersion}): define() returns early when modules.has(id); first definition wins, second is a silent no-op (no throw/warn); applies before and after initialization`);
});

test('(4) patched cabs loads in a FRESH context; host and other units byte-identical to base', async () => {
  const base = await baseBuild();
  const proj = copyProject();
  edit(proj, 'src/units/cabs/fare.js', (s) => s.replace("getConfig('rates.cab.base')", '1000'));
  const patchOut = tmp('patched-');
  await build({ projectRoot: proj, outDir: patchOut, base: base.dir });

  assert.deepEqual(diffAgainstBase(base.dir, patchOut), { changedUnits: ['cabs'], hostChanged: false, addedUnits: [], removedUnits: [] });
  for (const f of ['units/bus.js', 'units/travelplex.js', 'host.js', 'ids.json']) {
    assert.ok(fs.readFileSync(path.join(base.dir, f)).equals(fs.readFileSync(path.join(patchOut, f))), f + ' differs');
  }

  // What would be shipped: only the changed unit(s). Embedded host + base units, overlay holds cabs only.
  const overlay = tmp('overlay-');
  fs.mkdirSync(path.join(overlay, 'units'));
  fs.copyFileSync(path.join(patchOut, 'units/cabs.js'), path.join(overlay, 'units/cabs.js'));
  const rt = createRuntime({ distDir: base.dir, patchDir: overlay });
  assert.equal(await rt.openUnit('cabs', { km: 10 }), 'Cabs: 10km costs INR 1120.00');
  assert.equal(await rt.openUnit('bus', EXPECT.bus[1]), EXPECT.bus[0]);
  assert.equal(await rt.openUnit('travelplex', EXPECT.travelplex[1]), EXPECT.travelplex[0]);
  assert.deepEqual(rt.events.filter((e) => e.unit === 'cabs').map((e) => e.source), ['patch']);
  // a patch dir that only has cabs: others fall back to embedded transparently
  assert.deepEqual(rt.events.filter((e) => e.unit === 'bus').map((e) => [e.source, e.status]).pop(), ['embedded', 'ok']);
  assert.equal(rt.evalCount('cabs'), 1);
});

test('diffAgainstBase: host change is reported as host (and units stay identical)', async () => {
  const base = await baseBuild();
  const proj = copyProject();
  edit(proj, 'src/host/shared/format.js', (s) => s.replace("currency + ' '", "currency + '  '"));
  const out = tmp('hostchg-');
  await build({ projectRoot: proj, outDir: out });
  assert.deepEqual(diffAgainstBase(base.dir, out), { changedUnits: [], hostChanged: true, addedUnits: [], removedUnits: [] });
});

test('diffAgainstBase: identical builds => nothing changed; changing a unit root only touches that unit', async () => {
  const base = await baseBuild();
  assert.deepEqual(diffAgainstBase(base.dir, base.dir), { changedUnits: [], hostChanged: false, addedUnits: [], removedUnits: [] });
  const proj = copyProject();
  edit(proj, 'src/units/bus/seats.js', (s) => s.replace('rows', 'rows2').replace("'rows2'", "'rows'"));
  edit(proj, 'src/units/travelplex/itinerary.js', (s) => s + '\n// touched\n');
  const out = tmp('two-');
  await build({ projectRoot: proj, outDir: out, base: base.dir });
  const d = diffAgainstBase(base.dir, out);
  assert.equal(d.hostChanged, false);
  assert.deepEqual(d.changedUnits, ['bus', 'travelplex']); // (two units changed: a check rule 2 would reject this patch)
});

test('(5) concurrent first use of the same unit evaluates it once', async () => {
  const base = await baseBuild();
  // via lazyUnit + native single-flight
  let rt = createRuntime({ distDir: base.dir });
  const [a, b] = await Promise.all([rt.openUnit('cabs', { km: 1 }), rt.openUnit('cabs', { km: 2 })]);
  assert.equal(a, 'Cabs: 1km costs INR 62.00');
  assert.equal(b, 'Cabs: 2km costs INR 74.00');
  assert.equal(rt.loadCalls.length, 1);
  assert.equal(rt.fileEvals.length, 1);
  assert.equal(rt.evalCount('cabs'), 1);

  // Worst case: NO single-flight in the loader and two raw import() promises racing.
  // define() makes the second file evaluation a no-op for the module registry, so module code still runs once.
  rt = createRuntime({ distDir: base.dir, dedupe: false });
  const entry = Object.entries(base.unitsJson.paths).find(([, n]) => n === 'cabs')[0];
  const req = rt.ctx.__r(Number(Object.entries(JSON.parse(fs.readFileSync(path.join(base.dir, 'ids.json'), 'utf8'))).find(([, p]) => p === 'node_modules/metro-runtime/src/modules/asyncRequire.js')[0]));
  const paths = { [entry]: 'cabs' };
  const [m1, m2] = await Promise.all([req(Number(entry), paths), req(Number(entry), paths)]);
  assert.equal(m1.default.name, 'cabs');
  assert.equal(m1.default, m2.default);
  assert.equal(rt.loadCalls.length, 2, 'loader called twice without single-flight');
  assert.equal(rt.fileEvals.length, 2, 'file evaluated twice without single-flight');
  assert.equal(rt.evalCount('cabs'), 1, 'but the unit module factory ran once (define ignores duplicates)');
});
