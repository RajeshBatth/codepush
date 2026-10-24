#!/usr/bin/env node
// node scripts/prepare-spike-assets.mjs [android|ios ...]   -> .spike-assets/<platform>/ per SPIKE.md
// Pipeline: ota-build bundle (Metro splitter + hermesc -O -emit-binary -g0) of the REAL RN project, three times:
//   base (embedded/), "patched" (host marker + cabs v2; patched/), plus fixtures derived from the base build.
import fs from 'node:fs';
import path from 'node:path';
import { APP, WORK, bundle, compileHbc, resolveHermesc, hashId, sha256, rm, mkdirp, withEdits, swap } from './lib.mjs';

const platforms = process.argv.slice(2).length ? process.argv.slice(2) : ['android', 'ios'];
const UNITS = ['cabs', 'bus', 'travelplex'];
const OUT_ROOT = path.join(APP, '.spike-assets');

for (const platform of platforms) {
  const t0 = Date.now();
  const work = path.join(WORK, 'spike-prepare', platform);
  rm(work); mkdirp(work);
  const out = path.join(OUT_ROOT, platform);
  rm(out);
  for (const d of ['embedded/units', 'patched/units', 'fixtures']) mkdirp(path.join(out, d));

  console.log(`[${platform}] base build`);
  const base = await bundle({ project: APP, platform, out: path.join(work, 'base'), appVersion: '0.0.1' });
  console.log(`[${platform}] patched build (host marker + cabs v2)`);
  const patched = await withEdits(
    [['src/host/marker.js', swap("'embedded'", "'patched'")], ['src/units/cabs/marker.js', swap("'v1'", "'v2'")]],
    () => bundle({ project: APP, platform, out: path.join(work, 'patched'), appVersion: '0.0.1' }),
  );
  const bb = path.join(work, 'base'), pb = path.join(work, 'patched');

  // sanity: the patch must change exactly host + cabs
  for (const u of UNITS) {
    const changed = base.build.units[u].hash !== patched.build.units[u].hash;
    if (changed !== (u === 'cabs')) throw new Error(`unexpected: unit ${u} changed=${changed} between base and patched`);
  }
  if (base.build.host.hash === patched.build.host.hash) throw new Error('host did not change in patched build');

  const copy = (from, to) => fs.copyFileSync(from, path.join(out, to));
  copy(path.join(bb, 'host.hbc'), 'embedded/host.hbc');
  for (const u of UNITS) copy(path.join(bb, 'units', `${u}.hbc`), `embedded/units/${u}.hbc`);
  copy(path.join(pb, 'host.hbc'), 'patched/host.hbc');
  copy(path.join(pb, 'units/cabs.hbc'), 'patched/units/cabs.hbc');

  // ---- fixtures
  const cabs = fs.readFileSync(path.join(bb, 'units/cabs.hbc'));
  const wrong = Buffer.from(cabs);
  const realVersion = wrong.readUInt32LE(8);
  wrong.writeUInt32LE(realVersion === 98 ? 97 : 98, 8); // bytes 8..11 = bytecode version
  fs.writeFileSync(path.join(out, 'fixtures/unit-wrong-version.hbc'), wrong);
  fs.writeFileSync(path.join(out, 'fixtures/unit-text.js'),
    '// PLAIN JS, not bytecode. If this ever runs, the loader failed to reject it.\nglobalThis.__otaProbe.pwned = true;\n');
  fs.writeFileSync(path.join(out, 'fixtures/unit-truncated.hbc'), cabs.subarray(0, 6));
  // bad entry: a real hermesc-compiled unit whose entry factory throws; __d registers fine, __r(entryId) throws.
  const badEntryId = hashId('src/units/badentry/entry.js', 48);
  const badJs = path.join(work, 'bad-entry.js');
  fs.writeFileSync(badJs,
    `__d(function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {\n  throw new Error('OTA_SPIKE bad entry module');\n},${badEntryId},[]);\n`);
  const h = resolveHermesc({});
  compileHbc(h, badJs, path.join(work, 'hw'), path.join(out, 'fixtures/unit-bad-entry.hbc'), 'bad-entry');

  // ---- spike.json
  const file = (rel) => { const b = fs.readFileSync(path.join(out, rel)); return { file: rel, hash: sha256(b), size: b.length }; };
  const spike = {
    hbcVersion: base.build.toolchain.hbcVersion,
    platform,
    toolchain: base.build.toolchain,
    units: Object.fromEntries(UNITS.map((u) => [u, {
      entryId: base.build.units[u].entryModuleId,
      hash: base.build.units[u].hash,
      file: `units/${u}.hbc`,
      size: base.build.units[u].size,
    }])),
    host: { file: 'host.hbc', hash: base.build.host.hash, size: base.build.host.size },
    patched: {
      host: file('patched/host.hbc'),
      cabs: { ...file('patched/units/cabs.hbc'), entryId: patched.build.units.cabs.entryModuleId },
    },
    fixtures: {
      'unit-wrong-version.hbc': { ...file('fixtures/unit-wrong-version.hbc'), note: `bytes 8..11 = ${wrong.readUInt32LE(8)} (real ${realVersion})` },
      'unit-text.js': file('fixtures/unit-text.js'),
      'unit-truncated.hbc': file('fixtures/unit-truncated.hbc'),
      'unit-bad-entry.hbc': { ...file('fixtures/unit-bad-entry.hbc'), entryId: badEntryId },
    },
    // JS-side facts for the native test runner
    js: {
      requireFn: '__otaRequire',
      note: 'Use globalThis.__otaRequire(entryId) instead of __r(entryId) to see unit entry exceptions: Metro __r reports them via ErrorUtils.reportFatalError and does not rethrow (RN: fatal = crash in release).',
      loadBundleAsync: 'defined by the host only if NativeOtaUnits exists; called with the unit name',
    },
    markers: {
      host: { embedded: 'HOST:embedded', patched: 'HOST:patched' },
      cabs: { v1: 'CABS:v1', v2: 'CABS:v2' },
      bus: 'BUS:v1',
      travelplex: 'TRAVELPLEX:v1',
      probe: 'globalThis.__otaProbe = { host: "embedded"|"patched", units: { <unit>: "v1"|"v2" }, pwned: false }',
      surfaces: ['SpikeHost', 'cabs', 'bus', 'travelplex'],
    },
  };
  fs.writeFileSync(path.join(out, 'spike.json'), JSON.stringify(spike, null, 2) + '\n');
  rm(work);
  console.log(`[${platform}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
  walk(out);
  for (const f of files.sort()) { const b = fs.readFileSync(f); console.log(`  ${String(b.length).padStart(8)}  ${sha256(b).slice(0, 19)}  ${path.relative(out, f)}`); }
}
