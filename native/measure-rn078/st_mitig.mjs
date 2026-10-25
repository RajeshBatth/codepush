#!/usr/bin/env node
// Mitigation experiments. Subcommands (each prints markdown):
//   flags    hermesc flags vs diff size            node st_mitig.mjs flags [--size=300000|host]
//   scale    diff size vs unit size                node st_mitig.mjs scale
//   copy     UI copy: inline vs data module vs JSON blob   node st_mitig.mjs copy
//   params   HDiffPatch params / lzma on worst cells       node st_mitig.mjs params [--size=host]
//   validate semantic equivalence + determinism of -base-bytecode output   node st_mitig.mjs validate [--size=30000]
import fs from 'node:fs';
import path from 'node:path';
import * as L from './st_lib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const M = (a) => L.med(a);
const row = (...c) => '| ' + c.join(' | ') + ' |';
const sep = (n) => '|' + '---|'.repeat(n);

// ----------------------------------------------------------------------------- flags
function flags() {
  const sz = args.size || '300000';
  const u = L.loadUnit(sz, args.host);
  const js0 = L.unitText(u);
  const edits = ['E1', 'E2', 'E4', 'E5', 'E6', 'E8'];
  const picks = Object.fromEntries(edits.map((k) => [k, L.pickEdits(u, k, 3)]));
  const cfgs = [
    ['-O -g0 (shipping recipe)', ['-O', '-emit-binary', '-g0']],
    ['-O0 -g0', ['-O0', '-emit-binary', '-g0']],
    ['-Og -g0', ['-Og', '-emit-binary', '-g0']],
    ['-O (default -g1: file name + line tables)', ['-O', '-emit-binary']],
    ['-O -g0 -finline', ['-O', '-emit-binary', '-g0', '-finline']],
    ['-O -g0 -fno-inline', ['-O', '-emit-binary', '-g0', '-fno-inline']],
    ['-O -g0 -fstrip-function-names', ['-O', '-emit-binary', '-g0', '-fstrip-function-names']],
    ['-O -g0 -reuse-prop-cache', ['-O', '-emit-binary', '-g0', '-reuse-prop-cache']],
    ['-O -g0 -fno-static-builtins', ['-O', '-emit-binary', '-g0', '-fno-static-builtins']],
    ['-O -g0 -eager', ['-O', '-emit-binary', '-g0', '-eager']],
  ];
  console.log(`\n#### flags, unit ${sz}: median diff (B) over 3 positions; \`plain\` = recipe flags, \`delta\` = same + -base-bytecode=<old.hbc>\n`);
  console.log(row('flags', 'base hbc B', 'full zstd B', ...edits.map((k) => `${k} plain`), ...edits.map((k) => `${k} delta`)));
  console.log(sep(3 + 2 * edits.length));
  for (const [name, fl] of cfgs) {
    let base;
    try { base = L.compile(js0, fl); } catch (e) { console.log(row(name, 'FAILED', '', ...edits.map(() => ''), ...edits.map(() => ''))); continue; }
    const bf = L.stash(base, 'flags-base.hbc');
    const plain = [], delta = [];
    for (const k of edits) {
      const p = [], d = [];
      for (const e of picks[k]) {
        const js1 = L.unitText(e.unit);
        p.push(L.diffSize(base, L.compile(js1, fl)));
        d.push(L.diffSize(base, L.compile(js1, fl, ['-base-bytecode=' + bf])));
      }
      plain.push(M(p)); delta.push(M(d));
    }
    console.log(row(name, base.length, L.fullSize(base), ...plain, ...delta));
  }
}

// ----------------------------------------------------------------------------- scale
function scale() {
  const sizes = (args.sizes || '3000,10000,30000,100000,300000,450000,host').split(',');
  const edits = ['E2', 'E4', 'E5', 'E6'];
  console.log('\n#### diff size vs unit size (median of 3 positions; library units are shuffled corpus modules, host = RN 0.78.3 host bundle)\n');
  console.log(row('unit', 'hbc B', 'functions', 'full zstd B', ...edits.map((k) => `${k} plain`), ...edits.map((k) => `${k} delta`), 'E2 plain % of full', 'E2 delta % of full'));
  console.log(sep(5 + 2 * edits.length + 2));
  for (const sz of sizes) {
    const u = L.loadUnit(sz, args.host);
    const base = L.compile(L.unitText(u)); const bf = L.stash(base, 'scale-base.hbc');
    const full = L.fullSize(base);
    const nfn = base.readUInt32LE(40);
    const plain = [], delta = [];
    for (const k of edits) {
      const p = [], d = [];
      for (const e of L.pickEdits(u, k, 3)) {
        const js1 = L.unitText(e.unit);
        p.push(L.diffSize(base, L.compile(js1)));
        d.push(L.diffSize(base, L.compile(js1, L.REC, ['-base-bytecode=' + bf])));
      }
      plain.push(M(p)); delta.push(M(d));
    }
    console.log(row(sz === 'host' ? 'RN host' : `~${sz / 1000} KB`, base.length, nfn, full, ...plain, ...delta, L.pct(plain[0], full) + '%', L.pct(delta[0], full) + '%'));
  }
}

// ----------------------------------------------------------------------------- copy
const VOCAB = 'book now your seat travel bus cab ride select pay ticket price total fare date time from to seats available cancel confirm trip offer discount booking details passenger name phone email add remove change search results filter sort cheapest fastest departure arrival duration review rating help support contact refund policy terms login logout profile wallet history upcoming past return one way round select continue back next done save apply promo code invalid expired try again loading please wait welcome hello thanks success failed error retry network offline connection settings language currency notifications privacy about version rate share invite earn reward points'.split(' ');
function copyStrings(n, seed = 5) {
  const r = L.lcg(seed), out = new Set();
  while (out.size < n) {
    const w = []; const len = 2 + r(5);
    for (let i = 0; i < len; i++) w.push(VOCAB[r(VOCAB.length)]);
    const s = w.join(' ');
    out.add(s.charAt(0).toUpperCase() + s.slice(1));
  }
  return [...out];
}
const q = (s) => "'" + s + "'";
// items = [{key, text}] (keys are stable ids, like real i18n keys; an added copy gets a fresh key)
function screenModule(form, items) {
  const per = 10, fns = [];
  for (let f = 0; f * per < items.length; f++) {
    const body = items.slice(f * per, f * per + per).map((it, j) => `  items.push(h('Text', { style: S }, ${form === 'inline' ? q(it.text) : form === 'array' ? 'C[' + (f * per + j) + ']' : 'C.' + it.key}));`).join('\n');
    fns.push(`function screen${f}(h, S, C) {\n  var items = [];\n${body}\n  return items;\n}\nmodule.exports.screen${f} = screen${f};`);
  }
  return fns.join('\n');
}
function dataModule(form, items) {
  if (form === 'object') return `module.exports = {\n${items.map((it) => `  ${it.key}: ${q(it.text)},`).join('\n')}\n};`;
  if (form === 'json') return `module.exports = JSON.parse(${JSON.stringify(JSON.stringify(Object.fromEntries(items.map((it) => [it.key, it.text]))))});`;
  if (form === 'array') return `module.exports = [\n${items.map((it) => `  ${q(it.text)},`).join('\n')}\n];`;
  return '';
}
function copyUnit(form, items) {
  const lib = L.makeLibraryUnit(Number(args.size || 100000), 7);
  const mods = lib.mods.slice();
  const mid = mods.length >> 1;
  mods.splice(mid, 0, L.wrapModule(screenModule(form, items), 500000));
  if (form !== 'inline') mods.splice(mid + 1, 0, L.wrapModule(dataModule(form, items), 500001));
  return { pre: '', mods, post: '' };
}
function copy() {
  const N = Number(args.n || 150);
  const copies = copyStrings(N);
  const items0 = copies.map((text, i) => ({ key: 'copy_' + String(i).padStart(3, '0'), text }));
  const r = L.lcg(99);
  const idxs = [r(N), r(N), r(N)];
  const extra = copyStrings(N + 5, 5).slice(N); // 5 unseen strings
  const forms = ['inline', 'object', 'json', 'array'];
  const editKinds = ['rewording (other text)', 'typo (1 char)', 'longer (+20 chars)', 'add a new copy string', 'remove a copy string'];
  console.log(`\n#### UI copy placement: ${N} copy strings in a screen module inside a ~${Number(args.size || 100000) / 1000} KB library unit; median of 3 copy positions\n`);
  console.log(row('form', 'hbc B', 'full zstd B', ...editKinds.flatMap((e) => [`${e} plain`, `${e} delta`])));
  console.log(sep(3 + 2 * editKinds.length));
  for (const form of forms) {
    const base0 = copyUnit(form, items0);
    const js0 = L.unitText(base0);
    const base = L.compile(js0); const bf = L.stash(base, 'copy-base.hbc');
    const cells = [];
    for (const ek of editKinds) {
      const p = [], d = [];
      idxs.forEach((i, n) => {
        const c = items0.map((x) => ({ ...x }));
        if (ek.startsWith('rewording')) c[i].text = extra[n % extra.length];
        else if (ek.startsWith('typo')) { const s = c[i].text; const m = s.length >> 1; c[i].text = s.slice(0, m) + (s[m] === 'q' ? 'z' : 'q') + s.slice(m + 1); }
        else if (ek.startsWith('longer')) c[i].text += ' (limited time)';
        else if (ek.startsWith('add')) c.splice(i, 0, { key: 'copy_new_' + n, text: extra[n % extra.length] });
        else c.splice(i, 1);
        const js1 = L.unitText(copyUnit(form, c));
        p.push(L.diffSize(base, L.compile(js1)));
        d.push(L.diffSize(base, L.compile(js1, L.REC, ['-base-bytecode=' + bf])));
      });
      cells.push(M(p), M(d));
    }
    console.log(row(form === 'inline' ? 'inline literals in code' : form === 'object' ? 'object-literal data module' : form === 'json' ? 'JSON.parse(one string)' : 'array-literal data module', base.length, L.fullSize(base), ...cells));
  }
  console.log('\n(add/remove also adds/removes the consuming call site and, for data modules, the key; keys are stable ids)');
}

// ----------------------------------------------------------------------------- params
function params() {
  const sz = args.size || '300000';
  const u = L.loadUnit(sz, args.host);
  const base = L.compile(L.unitText(u)); const bf = L.stash(base, 'params-base.hbc');
  const edits = ['E2', 'E4', 'E6'];
  const pairs = [];
  for (const k of edits) { const e = L.pickEdits(u, k, 1)[0]; const js1 = L.unitText(e.unit); pairs.push({ k, plain: L.compile(js1), delta: L.compile(js1, L.REC, ['-base-bytecode=' + bf]) }); }
  const cfgs = [
    ['zstd -l 19 -m 4 (shipping)', { c: 'zstd', l: 19, m: 4 }], ['zstd -l 22 -m 4', { c: 'zstd', l: 22, m: 4 }], ['zstd -l 9 -m 4', { c: 'zstd', l: 9, m: 4 }],
    ['zstd -l 19 -m 1', { c: 'zstd', l: 19, m: 1 }], ['zstd -l 19 -m 2', { c: 'zstd', l: 19, m: 2 }], ['zstd -l 19 -m 8', { c: 'zstd', l: 19, m: 8 }], ['zstd -l 19 -m 16', { c: 'zstd', l: 19, m: 16 }], ['zstd -l 19 -m 32', { c: 'zstd', l: 19, m: 32 }],
    ['lzma -l 9 -m 4', { c: 'lzma', l: 9, m: 4 }], ['lzma -l 9 -m 2', { c: 'lzma', l: 9, m: 2 }], ['none -m 4 (uncompressed diff)', { c: 'none', l: 0, m: 4 }],
  ];
  console.log(`\n#### HDiffPatch parameters, unit ${sz} (one position per edit)\n`);
  console.log(row('params', ...pairs.flatMap((p) => [`${p.k} plain`, `${p.k} delta`])));
  console.log(sep(1 + 2 * pairs.length));
  for (const [name, p] of cfgs) console.log(row(name, ...pairs.flatMap((x) => [L.diffSize(base, x.plain, p), L.diffSize(base, x.delta, p)])));
}

// ----------------------------------------------------------------------------- validate
function funcTexts(txt) {
  const out = [];
  for (const m of txt.matchAll(/^Function<([^>]*)>\(([^)]*)\):\n(?:Offset in debug table[^\n]*\n)?((?:    [^\n]*\n|L\d+:\n)*)/gm)) out.push(m[0].replace(/^Offset in debug table[^\n]*\n/m, '').replace(/^( {4}\w+?)(?:Short|LongIndex|Long)(?=\s)/gm, '$1').replace(/^( {4}(?:NewObjectWithBuffer|NewArrayWithBuffer)\w* )[^\n]*/gm, '$1').replace(/ +/g, ' '));
  return out;
}
function dumpHbc(buf) {
  const d = L.tmpDir('vd'); fs.writeFileSync(path.join(d, 'x.hbc'), buf);
  const o = L.run(L.HERMESC, ['-b', '-dump-bytecode', 'x.hbc'], { cwd: d }); fs.rmSync(d, { recursive: true, force: true }); return o;
}
function strs(txt) { return new Set([...txt.matchAll(/^[si]\d+\[(?:ASCII|UTF-16), \d+\.\.\d+\](?: #[0-9A-F]+)?: (.*)$/gm)].map((m) => m[1])); }
function validate() {
  const sz = args.size || '30000';
  const u = L.loadUnit(sz, args.host);
  const base = L.compile(L.unitText(u)); const bf = L.stash(base, 'val-base.hbc');
  console.log(`\n#### -base-bytecode validity, unit ${sz} (hermesc -b -dump-bytecode parses both binaries; compare function texts - instruction width variants Short/Long are folded, object/array-buffer offsets ignored - and string sets)\n`);
  console.log(row('edit', 'functions equal as multiset', 'plain strings subset of delta', 'extra (dead, from base) strings in delta', 'delta rebuilt in other cwd == same bytes', 'hbc B plain / delta'));
  console.log(sep(6));
  for (const k of L.EDIT_ORDER) {
    const e = L.pickEdits(u, k, 1)[0]; if (!e) continue;
    const js1 = L.unitText(e.unit);
    const p = L.compile(js1), d = L.compile(js1, L.REC, ['-base-bytecode=' + bf]), d2 = L.compile(js1, L.REC, ['-base-bytecode=' + L.stash(base, 'sub/val-base-copy.hbc')]);
    const tp = dumpHbc(p), td = dumpHbc(d);
    const fp = funcTexts(tp).sort(), fd = funcTexts(td).sort();
    const sp = strs(tp), sd = strs(td);
    const extra = [...sd].filter((s) => !sp.has(s)).length, missing = [...sp].filter((s) => !sd.has(s)).length;
    console.log(row(k, fp.length === fd.length && fp.every((x, i) => x === fd[i]) ? `yes (${fp.length})` : `NO (${fp.length} vs ${fd.length})`, missing === 0 ? 'yes' : `NO (${missing} missing)`, extra, d.equals(d2) ? 'yes' : 'NO', `${p.length} / ${d.length}`));
  }
}

// ----------------------------------------------------------------------------- churn
function churn() {
  const sizes = (args.sizes || '30000,300000,host').split(',');
  const counts = (args.counts || '1,3,10,30,100').split(',').map(Number);
  const mix = ['E4', 'E1', 'E2', 'E5b', 'E8', 'E3']; // string-adding, numeric, reword, new fn mid-module, rename, longer
  console.log('\n#### many edits at once (mixed classes E4,E1,E2,E5b,E8,E3 round-robin at random positions): patch size vs number of edits\n');
  console.log(row('unit', 'edits', 'src diff', 'plain diff', 'plain % of full', 'delta diff', 'delta % of full', 'hybrid min(plain, delta)'));
  console.log(sep(8));
  for (const sz of sizes) {
    const u0 = L.loadUnit(sz, args.host);
    const base = L.compile(L.unitText(u0)); const bf = L.stash(base, 'churn-base.hbc'); const full = L.fullSize(base);
    for (const n of counts) {
      let u = u0, done = 0;
      for (let i = 0; done < n && i < n * 6; i++) { const e = L.applyEdit(u, mix[i % mix.length], 1000 + i * 17); if (e) { u = e.unit; done++; } }
      const js1 = L.unitText(u);
      const p = L.diffSize(base, L.compile(js1)), d = L.diffSize(base, L.compile(js1, L.REC, ['-base-bytecode=' + bf]));
      console.log(row(sz === 'host' ? 'RN host' : `~${sz / 1000} KB`, done, L.diffSize(Buffer.from(L.unitText(u0)), Buffer.from(js1)), p, L.pct(p, full) + '%', d, L.pct(d, full) + '%', Math.min(p, d)));
    }
  }
}

const table = { flags, scale, copy, params, validate, churn };
if (!table[cmd]) { console.error('usage: st_mitig.mjs flags|scale|copy|params|validate|churn [--size=..]'); process.exit(2); }
table[cmd]();
