// Generates conformance vectors that native (Kotlin/Swift/C++) ports must reproduce exactly.
// Run: npm run vectors   (then commit vectors/*.json; tests assert the JS impl matches them)
import { writeFileSync } from 'node:fs';
import { bucket, selectUnit, sha256, type Manifest } from '../src/index.ts';

const devices = ['device-0001', 'device-0002', 'A1B2-C3D4', 'ünïcode-🚀', '', 'x'.repeat(200)];
const units = ['cabs', 'bus', 'travelplex', 'host'];
const bucketVectors = devices.flatMap((d) => units.map((u) => ({ deviceId: d, unit: u, bucket: bucket(d, u) })));
writeFileSync(new URL('../vectors/bucket.json', import.meta.url), JSON.stringify(bucketVectors, null, 2) + '\n');

const h = (s: string) => sha256(s);
const manifest: Manifest = {
  schema: 1, platform: 'android', appVersion: '11.9.0', patchAlgoVer: 'v1', version: 7, ttlSec: 120,
  mainBundle: { baseHash: h('host'), entries: [{ id: 'host-pr88', patchUrl: 'u', hash: h('h88'), size: 10, updateType: 'patch', range: [0, 0.5] }] },
  units: [{
    unitName: 'cabs', baseHash: h('cabs-base'),
    entries: [
      { id: 'cabs-pr12', patchUrl: 'u', hash: h('c12'), size: 10, updateType: 'patch', range: [0, 0.2] },
      { id: 'cabs-pr9', patchUrl: 'u', hash: h('c9'), size: 10, updateType: 'patch', range: [0.2, 0.5] },
      { id: 'cabs-pr13', patchUrl: 'u', hash: h('c13'), size: 10, updateType: 'patch', range: [0.5, 0.6], requiresHost: 'host-pr88' },
    ],
  }],
};
const cases = [];
for (const b of [0, 0.1, 0.2, 0.35, 0.5, 0.55, 0.6, 0.99]) {
  for (const [embedded, running, algos] of [
    ['cabs-base', 'embedded', ['v1']],
    ['cabs-base', 'host-pr88', ['v1']],
    ['other', 'embedded', ['v1']],
    ['cabs-base', 'embedded', ['v2']],
  ] as const) {
    const ctx = { bucket: b, embeddedHash: h(embedded), supportedAlgos: [...algos], runningHostId: running };
    const r = selectUnit(manifest, 'cabs', ctx);
    cases.push({ ctx, unit: 'cabs', expect: { source: r.source, entryId: r.entry?.id ?? null, reason: r.reason } });
  }
}
writeFileSync(new URL('../vectors/select.json', import.meta.url), JSON.stringify({ manifest, cases }, null, 2) + '\n');
console.log(`wrote ${bucketVectors.length} bucket vectors, ${cases.length} select cases`);
