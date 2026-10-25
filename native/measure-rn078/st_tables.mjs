#!/usr/bin/env node
// Render matrix.json (from st_matrix.mjs) as markdown tables.   node st_tables.mjs results/matrix.json
import fs from 'node:fs';
import { med, pct } from './st_lib.mjs';
const rows = JSON.parse(fs.readFileSync(process.argv[2] || 'results/matrix.json', 'utf8'));
const names = { E1: 'E1 numeric literal', E2: 'E2 string, same length, reworded', E2t: 'E2t string, same length, 1-char tweak', E3: 'E3 string, longer, reworded (prefix)', E3t: 'E3t string, longer, suffix appended', E4: 'E4 new string in existing fn', E5: 'E5 new fn, appended as new module at END', E5b: 'E5b new fn, end of a random module', E6: 'E6 new fn, start of a random module', E7: 'E7 remove a string', E8: 'E8 rename property' };
const mm = (a) => `${Math.min(...a)} / ${med(a)} / ${Math.max(...a)}`;
for (const sz of [...new Set(rows.map((r) => r.size))]) {
  const R = rows.filter((r) => r.size === sz);
  const r0 = R[0];
  const fullMed = med(R.map((r) => r.fullNew));
  console.log(`\n#### ${sz === 'host' ? 'RN host (examples/spike-app, android)' : `~${Number(sz) / 1000} KB unit`}: hbc ${r0.hbcOld} B, JS ${r0.jsOld} B, \`full\` (zstd-19 of new hbc) ~${fullMed} B\n`);
  console.log('| edit | src diff (med) | hbc diff min / med / max (B) | med as % of full | full cheaper (cells) | `-base-bytecode` diff min / med / max (B) | med % of full |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const k of Object.keys(names)) {
    const c = R.filter((r) => r.edit === k);
    if (!c.length) continue;
    const d = c.map((r) => r.diff), dd = c.map((r) => r.diffDelta), f = med(c.map((r) => r.fullNew));
    console.log(`| ${names[k]} (n=${c.length}) | ${med(c.map((r) => r.srcDiff))} | ${mm(d)} | ${pct(med(d), f)}% | ${c.filter((r) => r.diff >= r.fullNew).length}/${c.length} | ${mm(dd)} | ${pct(med(dd), f)}% |`);
  }
}
