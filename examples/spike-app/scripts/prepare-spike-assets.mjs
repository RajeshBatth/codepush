#!/usr/bin/env node
// node scripts/prepare-spike-assets.mjs [android|ios ...]   -> .spike-assets/<platform>/ per SPIKE.md
// Pipeline: ota-build bundle (Metro splitter + hermesc -O -emit-binary -g0) of the REAL RN project, three times:
//   base (embedded/), "patched" (host marker + new function/string + cabs v2; patched/) built in hermesc DELTA mode
//   (-base-bytecode=<embedded .hbc>) against the base build, a plain-mode twin of it (sizes only), the .hdiff patches
//   (ota-build createPatches, zstd, round-trip verified through ota_apply), plus fixtures derived from the base build.
import fs from 'node:fs';
import path from 'node:path';
import { APP, WORK, createPatches, bundle, compileHbc, resolveHermesc, hashId, sha256, rm, mkdirp, withEdits, swap } from './lib.mjs';

const platforms = process.argv.slice(2).length ? process.argv.slice(2) : ['android', 'ios'];
const UNITS = ['cabs', 'bus', 'travelplex'];
const OUT_ROOT = path.join(APP, '.spike-assets');

for (const platform of platforms) {
  const t0 = Date.now();
  const work = path.join(WORK, 'spike-prepare', platform);
  rm(work); mkdirp(work);
  const out = path.join(OUT_ROOT, platform);
  rm(out);
  for (const d of ['embedded/units', 'patched/units', 'patches', 'fixtures']) mkdirp(path.join(out, d));

  console.log(`[${platform}] base build`);
  const base = await bundle({ project: APP, platform, out: path.join(work, 'base'), appVersion: '0.0.1' });
  const bb = path.join(work, 'base');
  // The patched edits: host marker 'embedded'->'patched' (changed STRING), a NEW function + new strings in marker.js that probe.js
  // calls (exposed as __otaProbe.hostFn), and cabs VERSION v1->v2.
  const HOST_FN = `
export function hostPatchedFn(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += i * i;
  return 'HOSTFN:v2:' + s + ':' + HOST_MARKER.toUpperCase();
}
`;
  const patchEdits = [
    ['src/host/marker.js', (t) => swap("'embedded'", "'patched'")(t) + HOST_FN],
    ['src/host/probe.js', (t) => swap("import {HOST_MARKER} from './marker';", "import {HOST_MARKER, hostPatchedFn} from './marker';")(t) + "globalThis.__otaProbe.hostFn = hostPatchedFn(7);\n"],
    ['src/units/cabs/marker.js', swap("'v1'", "'v2'")],
  ];
  const buildPatched = (delta, name) => withEdits(patchEdits,
    () => bundle({ project: APP, platform, out: path.join(work, name), appVersion: '0.0.1', baseBuild: bb, delta }));
  console.log(`[${platform}] patched build, hermesc DELTA mode vs embedded base`);
  const patched = await buildPatched('on', 'patched');
  console.log(`[${platform}] patched build, plain mode (for patch-size comparison only)`);
  const plain = await buildPatched('off', 'patched-plain');
  if (!patched.build.delta.enabled || plain.build.delta.enabled) throw new Error('delta flags not as expected');
  const pb = path.join(work, 'patched');

  // sanity: the patch must change exactly host + cabs
  for (const u of UNITS) {
    const changed = base.build.units[u].hash !== patched.build.units[u].hash;
    if (changed !== (u === 'cabs')) throw new Error(`unexpected: unit ${u} changed=${changed} between base and patched`);
  }
  if (base.build.host.hash === patched.build.host.hash) throw new Error('host did not change in patched build');

  // ---- cabs v3: a UNIT-ONLY edit that (a) adds a NEW function, (b) adds NEW strings, (c) changes an existing string, (d) appends a NEW
  // module file (new module id) to the unit. Built in DELTA mode against the embedded build; the host source is untouched.
  const V3_EXPECTED = 'UNITFN:v3:560:V3:newmod';
  const V3_MODULE = `import {VERSION} from './marker';
import {fareChecksum} from './fares';
export function unitFn() {
  const parts = ['UNITFN', 'v3', String(fareChecksum()), VERSION.toUpperCase(), 'newmod'];
  return parts.join(':');
}
`;
  const v3Edits = [
    ['src/units/cabs/marker.js', swap("'v1'", "'v3'")],
    ['src/units/cabs/fares.js', (t) => swap('`${f.name} ${formatMoney(f.fare)}`', '`${f.name} fare: ${formatMoney(f.fare)}`')(t) +
      "\nexport function fareChecksum() {\n  let total = 0;\n  for (const f of BASE) total += f.fare;\n  if (total !== 560) throw new Error('fare table drifted: ' + total);\n  return total;\n}\nexport const FARE_NOTE = 'surge pricing may apply';\n"],
    ['src/units/cabs/entry.js', (t) => swap("import {VERSION} from './marker';", "import {VERSION} from './marker';\nimport {unitFn} from './unitfn';")(t)
      .replace("AppRegistry.registerComponent", "globalThis.__otaProbe.unitFn = unitFn();\nAppRegistry.registerComponent")],
  ];
  const v3File = path.join(APP, 'src/units/cabs/unitfn.js');
  const buildV3 = async (delta, name) => {
    fs.writeFileSync(v3File, V3_MODULE);
    try {
      return await withEdits(v3Edits, () => bundle({ project: APP, platform, out: path.join(work, name), appVersion: '0.0.1', baseBuild: bb, delta }));
    } finally { rm(v3File); }
  };
  console.log(`[${platform}] cabs v3 build, DELTA mode (+ plain twin for size comparison)`);
  const v3 = await buildV3('on', 'v3');
  const v3plain = await buildV3('off', 'v3-plain');
  if (!v3.build.delta.enabled || v3plain.build.delta.enabled) throw new Error('v3 delta flags not as expected');
  const v3b = path.join(work, 'v3');
  const v3Patch = createPatches({ base: bb, new: v3b, out: path.join(work, 'patches-v3'), fullThreshold: 100 });
  const v3PlainPatch = createPatches({ base: bb, new: path.join(work, 'v3-plain'), out: path.join(work, 'patches-v3-plain'), fullThreshold: 100 });
  const hostBytesEqual = fs.readFileSync(path.join(bb, 'host.hbc')).equals(fs.readFileSync(path.join(v3b, 'host.hbc')));
  if (v3Patch.hostChanged !== false || v3Patch.changedUnits.join() !== 'cabs' || !hostBytesEqual || base.build.host.hash !== v3.build.host.hash)
    throw new Error(`v3 must be a unit-only change: hostChanged=${v3Patch.hostChanged} changedUnits=${v3Patch.changedUnits} hostBytesEqual=${hostBytesEqual}`);
  for (const u of ['bus', 'travelplex']) if (base.build.units[u].hash !== v3.build.units[u].hash) throw new Error(`${u} changed in v3`);
  const v3di = v3Patch.items.find((i) => i.unit === 'cabs'), v3pi = v3PlainPatch.items.find((i) => i.unit === 'cabs');
  if (!v3di || v3di.updateType !== 'patch') throw new Error('no v3 delta patch');
  console.log(`[${platform}] cabs v3: plain-built patch ${v3pi.patchSize} B, delta-built patch ${v3di.patchSize} B (new zstd ${v3di.newZstdSize} B, unit ${v3.build.units.cabs.size} B vs base ${base.build.units.cabs.size} B); hostChanged=${v3Patch.hostChanged} changedUnits=${v3Patch.changedUnits} hostBytesEqual=${hostBytesEqual}`);

  const copy = (from, to) => fs.copyFileSync(from, path.join(out, to));
  copy(path.join(bb, 'host.hbc'), 'embedded/host.hbc');
  for (const u of UNITS) copy(path.join(bb, 'units', `${u}.hbc`), `embedded/units/${u}.hbc`);
  copy(path.join(pb, 'host.hbc'), 'patched/host.hbc');
  copy(path.join(pb, 'units/cabs.hbc'), 'patched/units/cabs.hbc');
  copy(path.join(v3b, 'units/cabs.hbc'), 'patched/units/cabs-v3.hbc');
  fs.copyFileSync(path.join(work, 'patches-v3', v3di.patchFile), path.join(out, 'patches/cabs-v3.hdiff'));

  // ---- patches (fullThreshold huge: the spike wants the delta-against-embedded patch even for the tiny cabs unit, where the
  // production policy would emit `full`; plain-mode patch sizes come from a second createPatches run)
  const dPatch = createPatches({ base: bb, new: pb, out: path.join(work, 'patches-delta'), fullThreshold: 100 });
  const pPatch = createPatches({ base: bb, new: path.join(work, 'patched-plain'), out: path.join(work, 'patches-plain'), fullThreshold: 100 });
  const patchInfo = {};
  for (const [unit, key] of [['host', 'host'], ['cabs', 'cabs']]) {
    const di = dPatch.items.find((i) => i.unit === unit), pi = pPatch.items.find((i) => i.unit === unit);
    if (!di || di.updateType !== 'patch') throw new Error(`no delta patch for ${unit}`);
    fs.copyFileSync(path.join(work, 'patches-delta', di.patchFile), path.join(out, `patches/${key}.hdiff`));
    patchInfo[key] = { file: `patches/${key}.hdiff`, size: di.patchSize, builtHash: di.builtHash, baseHash: di.baseHash,
      plainBuiltPatchSize: pi.patchSize, newZstdSize: di.newZstdSize, roundTripVerified: true };
    console.log(`[${platform}] ${unit}: plain-built patch ${pi.patchSize} B, delta-built patch ${di.patchSize} B (new zstd ${di.newZstdSize} B)`);
  }
  if (dPatch.changedUnits.join() !== 'cabs' || !dPatch.hostChanged) throw new Error('patch report: expected host + cabs only');

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
      deltaBuilt: patched.build.delta.enabled === true,
      deltaBaseBuild: patched.build.delta.baseBuild,
      deltaFiles: patched.build.delta.files,
      host: { ...file('patched/host.hbc'), baseHash: base.build.host.hash },
      cabs: { ...file('patched/units/cabs.hbc'), entryId: patched.build.units.cabs.entryModuleId, baseHash: base.build.units.cabs.hash },
      probe: { hostFn: 'HOSTFN:v2:91:PATCHED' },
      cabsV3: { ...file('patched/units/cabs-v3.hbc'), entryId: v3.build.units.cabs.entryModuleId, baseHash: base.build.units.cabs.hash,
        deltaBuilt: v3.build.delta.enabled === true, hostChanged: v3Patch.hostChanged, changedUnits: v3Patch.changedUnits,
        hostBytesIdentical: hostBytesEqual, hostHashBase: base.build.host.hash, hostHashV3: v3.build.host.hash,
        probe: { unitFn: V3_EXPECTED }, surface: 'CABS:v3' },
    },
    patches: {
      ...patchInfo,
      'cabs-v3': { file: 'patches/cabs-v3.hdiff', size: v3di.patchSize, builtHash: v3di.builtHash, baseHash: v3di.baseHash,
        plainBuiltPatchSize: v3pi.patchSize, newZstdSize: v3di.newZstdSize, roundTripVerified: true },
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
      cabs: { v1: 'CABS:v1', v2: 'CABS:v2', v3: 'CABS:v3' },
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
