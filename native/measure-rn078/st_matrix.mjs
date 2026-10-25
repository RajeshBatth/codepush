#!/usr/bin/env node
// Measurement matrix: edit classes E1..E8 x unit sizes x 3 random positions -> JSON.
//   node st_matrix.mjs --sizes=30000,300000,host --out=results/matrix.json [--positions=3] [--edits=E1,E2,...] [--host=<host.js>]
// Per cell: plain hermesc (-O -emit-binary -g0) and "delta" hermesc (same + -base-bytecode=<old.hbc>), HDiffPatch zstd-19 -m 4 sizes,
// source diff (same tool on the JS text), `full` cost (diff against empty file).
import fs from 'node:fs';
import path from 'node:path';
import * as L from './st_lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const sizes = (args.sizes || '30000,300000,host').split(',');
const positions = Number(args.positions || 3);
const edits = (args.edits || L.EDIT_ORDER.join(',')).split(',');
const out = args.out || path.join(L.WORK, 'results/matrix.json');
const hostJs = args.host || path.join(L.WORK, 'hostb/js/host.js');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(path.join(L.WORK, 'tmp'), { recursive: true });
const rows = [];
const save = () => fs.writeFileSync(out, JSON.stringify(rows, null, 1));

for (const sz of sizes) {
  const u = sz === 'host' ? L.unitFromMetroBundle(hostJs) : L.makeLibraryUnit(Number(sz), 7);
  const js0 = L.unitText(u);
  const t0 = Date.now();
  const base = L.compile(js0);
  const baseFile = path.join(L.WORK, 'tmp', `base-${sz}.hbc`);
  fs.writeFileSync(baseFile, base);
  const fullBase = L.fullSize(base);
  console.error(`[${sz}] js ${js0.length} hbc ${base.length} full(zstd19) ${fullBase} modules ${u.mods.length} (compile ${Date.now() - t0} ms)`);
  for (const k of edits) {
    const seen = new Set();
    let n = 0;
    for (let seed = 1; seed <= 60 && n < positions; seed++) {
      const e = L.applyEdit(u, k, seed);
      if (!e) break;
      const key = e.module + '|' + e.what;
      if (seen.has(key)) continue;
      seen.add(key); n++;
      const js1 = L.unitText(e.unit);
      const plain = L.compile(js1);
      const delta = L.compile(js1, ['-O', '-emit-binary', '-g0'], ['-base-bytecode=' + baseFile]);
      const row = {
        size: sz, edit: k, seed, what: e.what, jsOld: js0.length, jsNew: js1.length,
        hbcOld: base.length, hbcNew: plain.length, hbcNewDelta: delta.length,
        diff: L.diffSize(base, plain), diffDelta: L.diffSize(base, delta),
        fullNew: L.fullSize(plain), srcDiff: L.diffSize(Buffer.from(js0), Buffer.from(js1)),
      };
      rows.push(row); save();
      console.error(`  ${k} #${seed} ${row.what.slice(0, 40)}: diff ${row.diff} delta-mode ${row.diffDelta} full ${row.fullNew} src ${row.srcDiff}`);
    }
    if (n < positions) console.error(`  ${k}: only ${n} distinct positions available`);
  }
}
save();
