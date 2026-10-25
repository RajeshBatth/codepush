#!/usr/bin/env node
// Mechanism evidence: for an (unit size, edit, seed) pair - which string IDs shift, which function bodies change although their
// instruction text is identical (= pure ID renumbering), which functions get a new index, and which file regions carry the diff bytes.
//   node st_mech.mjs --size=300000|host --edit=E2|all --seed=1 [--delta=1] [--host=<host.js>]
import fs from 'node:fs';
import path from 'node:path';
import * as L from './st_lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const size = args.size || '300000', seed = Number(args.seed || 1);
const kinds = !args.edit || args.edit === 'all' ? L.EDIT_ORDER : args.edit.split(',');
const u = size === 'host' ? L.unitFromMetroBundle(args.host || path.join(L.WORK, 'hostb/js/host.js')) : L.makeLibraryUnit(Number(size), 7);
fs.mkdirSync(path.join(L.WORK, 'tmp'), { recursive: true });
const baseFile = path.join(L.WORK, 'tmp/mech-base.hbc');
const js0 = L.unitText(u);
const b0 = L.compile(js0); fs.writeFileSync(baseFile, b0);

function parseDump(txt) {
  const strings = new Map(); // id -> {s, ident}
  for (const m of txt.matchAll(/^([si])(\d+)\[(?:ASCII|UTF-16), \d+\.\.\d+\](?: #[0-9A-F]+)?: (.*)$/gm)) strings.set(Number(m[2]), { s: m[3], ident: m[1] === 'i' });
  const funcs = [];
  for (const m of txt.matchAll(/^Function<([^>]*)>\(([^)]*)\):\n(?:Offset in debug table[^\n]*\n)?((?:    [^\n]*\n|L\d+:\n)*)/gm)) funcs.push(m[0].replace(/^Offset in debug table[^\n]*\n/m, ''));
  return { strings, funcs };
}
function funcBodies(b) {
  const fh = L.hbcRegions(b).regions.find((r) => r.name === 'funcHeaders');
  const out = [];
  for (let o = fh.start; o < fh.end; o += 16) {
    const w0 = b.readUInt32LE(o), w1 = b.readUInt32LE(o + 4), w3 = b.readUInt32LE(o + 12);
    out.push(((w3 >>> 24) >> 5) & 1 ? null : b.subarray(w0 & 0x1ffffff, (w0 & 0x1ffffff) + (w1 & 0x7fff)));
  }
  return out;
}
const dump = (js, extra) => { const d = L.tmpDir('dd'); fs.writeFileSync(path.join(d, 'bundle.js'), js); const o = L.run(L.HERMESC, ['-O', '-g0', ...extra, '-dump-bytecode', 'bundle.js'], { cwd: d }); fs.rmSync(d, { recursive: true, force: true }); return o; };
const d0 = parseDump(dump(js0, [])), f0 = funcBodies(b0), R0 = L.hbcRegions(b0).regions;
console.log(`unit ${size}: ${d0.strings.size} strings (${[...d0.strings.values()].filter((v) => v.ident).length} identifiers), ${d0.funcs.length} functions, hbc ${b0.length} B`);

const groups = { 'func headers': ['funcHeaders'], 'string tables (kinds/hashes/small/overflow)': ['stringKinds', 'identHashes', 'smallStrTable', 'overflowStrTable'], 'string storage': ['stringStorage'], 'array/object buffers': ['arrayBuffer', 'objKeyBuffer', 'objValBuffer'], 'function bodies+info': ['fnBodies+info'], 'header+footer (hash/len)': ['header', 'footerSha1'] };
const head = '| edit | variant | strings w/ new ID | fns text-identical but body bytes differ | fns w/ new index | fns whose text changed (unmatched) | body size changed | whole diff B | headers | str tables | storage | buffers | bodies | hdr+ftr |';
console.log('\n' + head + '\n|' + '---|'.repeat(14));
for (const k of kinds) {
  const e = L.applyEdit(u, k, seed);
  if (!e) { console.log(`| ${k} | n/a |`); continue; }
  const js1 = L.unitText(e.unit);
  const vs = { plain: [L.compile(js1), []] };
  if (args.delta) vs.delta = [L.compile(js1, ['-O', '-emit-binary', '-g0'], ['-base-bytecode=' + baseFile]), ['-base-bytecode=' + baseFile]];
  for (const [name, [b1, extra]] of Object.entries(vs)) {
    const d1 = parseDump(dump(js1, extra)), f1 = funcBodies(b1), R1 = L.hbcRegions(b1).regions;
    const idOld = new Map([...d0.strings].map(([id, v]) => [v.s, id])), idNew = new Map([...d1.strings].map(([id, v]) => [v.s, id]));
    let common = 0, moved = 0;
    for (const [s, id] of idOld) if (idNew.has(s)) { common++; if (idNew.get(s) !== id) moved++; }
    const q = new Map(); d0.funcs.forEach((t, i) => { if (!q.has(t)) q.set(t, []); q.get(t).push(i); });
    let last = -1, matched = 0, bodyDiff = 0, lenDiff = 0, newIdx = 0;
    d1.funcs.forEach((t, j) => {
      const lst = q.get(t); if (!lst) return;
      const i = lst.find((x) => x > last); if (i === undefined) return;
      last = i; matched++;
      if (i !== j) newIdx++;
      const a = f0[i], b = f1[j];
      if (!a || !b) return;
      if (a.length !== b.length) lenDiff++;
      if (!a.equals(b)) bodyDiff++;
    });
    const gd = Object.values(groups).map((names) => {
      const a = Buffer.concat(names.map((n) => { const r = R0.find((x) => x.name === n); return r ? b0.subarray(r.start, r.end) : Buffer.alloc(0); }));
      const b = Buffer.concat(names.map((n) => { const r = R1.find((x) => x.name === n); return r ? b1.subarray(r.start, r.end) : Buffer.alloc(0); }));
      return a.equals(b) ? 0 : L.diffSize(a, b);
    });
    console.log(`| ${k} | ${name} | ${moved}/${common} (${L.pct(moved, common)}%) | ${bodyDiff}/${matched} (${L.pct(bodyDiff, matched)}%) | ${newIdx} | ${d1.funcs.length - matched} | ${lenDiff} | ${L.diffSize(b0, b1)} | ${gd.join(' | ')} |`);
  }
}
console.log('\n(region columns = standalone HDiffPatch zstd-19 size of that region group, old vs new; identical group = 0; each non-zero cell includes ~30-60 B of container overhead, so they over-add vs the whole-file diff)');
