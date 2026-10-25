#!/usr/bin/env node
// Does the sort rank of a NEW string decide how much shifts?  Insert one new string literal (same place, same code) whose text
// sorts at the start / middle / end of the alphabet, and diff.      node st_rank.mjs [--size=300000|host]
import * as L from './st_lib.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const sz = args.size || '300000';
const u = L.loadUnit(sz, args.host);
const base = L.compile(L.unitText(u)); const bf = L.stash(base, 'rank-base.hbc');
const e0 = L.pickEdits(u, 'E4', 1)[0];
const m0 = e0.module;
console.log(`\n#### rank of a new string, unit ${sz}: same code, only the new literal's text differs\n`);
console.log('| new literal | plain diff | delta diff |\n|---|---:|---:|');
for (const lit of ['!first', 'AAAA new string', 'aaaa new string', 'mmmm new string', 'tttt new string', 'zzzz new string', '~last']) {
  const mods = u.mods.slice();
  mods[m0] = e0.unit.mods[m0].replace(/ota-new-string-\d+/, lit);
  const js1 = L.unitText({ ...u, mods });
  console.log(`| \`${lit}\` | ${L.diffSize(base, L.compile(js1))} | ${L.diffSize(base, L.compile(js1, L.REC, ['-base-bytecode=' + bf]))} |`);
}
