#!/usr/bin/env node
// node scripts/measure.mjs  -> sizes + patch sizes on the real RN app (android + ios) and on the demo app; writes .work/measure/results.json
import fs from 'node:fs';
import path from 'node:path';
import { APP, REPO, WORK, bundle, rm, mkdirp, withEdits, swap } from './lib.mjs';
const { createPatches } = await import(path.join(REPO, 'packages/ota-build/src/patch.ts'));
const DEMO = path.join(REPO, 'examples/demo-app');
const M = path.join(WORK, 'measure');
rm(M); mkdirp(M);

const seq = (...fs_) => (t) => fs_.reduce((a, f) => f(a), t);
const SPIKE = [
  ['a one-line change in a unit (cabs fare 120 -> 125)', [['src/units/cabs/fares.js', swap('fare: 120', 'fare: 125')]]],
  ['b new function in a unit (cabs surge())', [['src/units/cabs/fares.js', seq(
    swap('export function fares() {', 'function surge(fare, m) {\n  return Math.round(fare * m * 100) / 100;\n}\n\nexport function fares() {'),
    swap('formatMoney(f.fare)', 'formatMoney(surge(f.fare, 1.1))'))]]],
  ['c1 host app code: string literal changed, new length (HOST_MARKER embedded -> patched)', [['src/host/marker.js', swap("'embedded'", "'patched'")]]],
  ['c2 host app code: string literal changed, same length (embedded -> embeddeX)', [['src/host/marker.js', swap("'embedded'", "'embeddeX'")]]],
  ['c3 host app code: numeric literal (SpikeHost padding 24 -> 28)', [['src/host/SpikeHost.js', swap('padding: 24', 'padding: 28')]]],
  ['d1 node_modules (numeric): react-native TimingAnimation default duration 500 -> 501', [['node_modules/react-native/Libraries/Animated/animations/TimingAnimation.js', swap('?? 500', '?? 501')]]],
  ['d2 node_modules (numeric): virtualized-lists windowSize default 21 -> 22', [['node_modules/react-native/node_modules/@react-native/virtualized-lists/Lists/VirtualizedListProps.js', swap('windowSize ?? 21', 'windowSize ?? 22')]]],
  ['d3 node_modules (string): react-native Dimensions invariant message changed', [['node_modules/react-native/Libraries/Utilities/Dimensions.js', swap("'No dimension set for key '", "'No dimension was set for key '")]]],
];
const DEMO_VARIANTS = [
  ['a one-line change in a unit (cabs fare.js)', [['src/units/cabs/fare.js', swap('getConfig(\'rates.cab.base\')', 'getConfig(\'rates.cab.base\') + 1')]]],
  ['c one-line change in host app code (config.js)', [['src/host/shared/config.js', swap('perKm: 12', 'perKm: 13')]]],
];

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
async function timed(fn) { const t = Date.now(); const r = await fn(); return [r, (Date.now() - t) / 1000]; }
const jsSize = (dir, rel) => fs.statSync(path.join(dir, 'js', rel)).size;

async function run(label, project, platform, variants) {
  const dir = path.join(M, `${label}-${platform}`);
  const [base, tBase] = await timed(() => bundle({ project, platform, out: path.join(dir, 'base'), appVersion: '1' }));
  const units = JSON.parse(fs.readFileSync(path.join(dir, 'base/units.json'), 'utf8'));
  const res = {
    label, platform, buildSeconds: tBase,
    modules: { host: units.host.moduleIds.length, ...Object.fromEntries(Object.entries(units.units).map(([n, u]) => [n, u.moduleIds.length])) },
    js: { host: jsSize(path.join(dir, 'base'), 'host.js'), ...Object.fromEntries(Object.keys(units.units).map((n) => [n, jsSize(path.join(dir, 'base'), `units/${n}.js`)])) },
    hbc: { host: base.build.host.size, ...Object.fromEntries(Object.entries(base.build.units).map(([n, u]) => [n, u.size])) },
    zstd: { host: base.build.host.zstdSize, ...Object.fromEntries(Object.entries(base.build.units).map(([n, u]) => [n, u.zstdSize])) },
    variants: [],
  };
  let i = 0;
  for (const [name, edits] of variants) {
    const nd = path.join(dir, `v${i++}`);
    const root = project;
    await withEdits(edits, () => bundle({ project, platform, out: nd, appVersion: '1' }), root);
    const rep = createPatches({ base: path.join(dir, 'base'), new: nd, out: path.join(dir, `patch-v${i}`), overwrite: true });
    res.variants.push({
      name, hostChanged: rep.hostChanged, changedUnits: rep.changedUnits,
      items: rep.items.map((x) => ({ unit: x.unit, type: x.updateType, patchSize: x.patchSize, deltaPatchSize: x.deltaPatchSize, newZstdSize: x.newZstdSize, ratio: +x.ratioOfZstdFull.toFixed(3) })),
    });
    rm(nd); rm(path.join(dir, `patch-v${i}`));
  }
  rm(path.join(dir));
  return res;
}

const results = [];
for (const platform of ['android', 'ios']) results.push(await run('spike', APP, platform, SPIKE));
results.push(await run('demo', DEMO, 'android', DEMO_VARIANTS));
fs.writeFileSync(path.join(M, 'results.json'), JSON.stringify(results, null, 1));
for (const r of results) {
  console.log(`\n## ${r.label} ${r.platform}: Metro+hermesc ${r.buildSeconds.toFixed(1)} s`);
  console.log('modules', JSON.stringify(r.modules)); console.log('js', JSON.stringify(r.js)); console.log('hbc', JSON.stringify(r.hbc)); console.log('zstd', JSON.stringify(r.zstd));
  for (const v of r.variants) console.log(`- ${v.name}: hostChanged=${v.hostChanged} units=${v.changedUnits}  ` + v.items.map((x) => `${x.unit} ${x.type} ${x.patchSize} B (delta ${x.deltaPatchSize}, zstd-full ${x.newZstdSize}, ${(x.ratio * 100).toFixed(1)}%)`).join('; '));
}
