#!/usr/bin/env node
// Upper-bound experiment for a bytecode-aware diff ("remap the base before diffing").
//   old.hbc --(remap string IDs / function IDs in instruction operands, function-header names, string-table + identifier-hash order)--> old'
//   patch = HDiffPatch(old' -> new) + side info (the ID permutations).  Device: rebuild old' from old + side info, apply, verify sha256.
//   node st_norm.mjs --selftest                         decoder self-test against `hermesc -dump-bytecode` opcode histograms
//   node st_norm.mjs --size=300000|host --edit=E2,E4,E6 [--seed=1]
// Needs BytecodeList.def from the pinned Hermes commit: st_fetch_hermes_src.sh (default <repo>/.work/st/hsrc).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import * as L from './st_lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const DEF = args.def || path.join(L.WORK, 'hsrc/BytecodeList.def');

// ---------------------------------------------------------------- opcode table from BytecodeList.def
const TSIZE = { Reg8: 1, Reg32: 4, UInt8: 1, UInt16: 2, UInt32: 4, Addr8: 1, Addr32: 4, Imm32: 4, Double: 8 };
function loadOpcodes() {
  const src = fs.readFileSync(DEF, 'utf8').replace(/\/\/[^\n]*/g, '');
  const ops = [];
  const strId = new Map(), fnId = new Map();
  const re = /^(DEFINE_OPCODE_\d|DEFINE_JUMP_\d|OPERAND_STRING_ID|OPERAND_FUNCTION_ID)\(([^)]*)\)/gm;
  for (const m of src.matchAll(re)) {
    const parts = m[2].split(',').map((s) => s.trim());
    if (m[1].startsWith('DEFINE_OPCODE')) ops.push({ name: parts[0], types: parts.slice(1) });
    else if (m[1].startsWith('DEFINE_JUMP')) {
      const n = Number(m[1].slice(-1));
      const rest = ['Reg8', 'Reg8'].slice(0, n - 1);
      ops.push({ name: parts[0], types: ['Addr8', ...rest] }, { name: parts[0] + 'Long', types: ['Addr32', ...rest] });
    } else (m[1] === 'OPERAND_STRING_ID' ? strId : fnId).set(parts[0], Number(parts[1]) - 1);
  }
  for (const o of ops) { o.size = 1 + o.types.reduce((a, t) => a + TSIZE[t], 0); o.str = strId.get(o.name); o.fn = fnId.get(o.name); }
  return ops;
}
const OPS = loadOpcodes();

// ---------------------------------------------------------------- HBC parsing
function parse(b) {
  const { regions, H } = L.hbcRegions(b);
  const R = Object.fromEntries(regions.map((r) => [r.name, r]));
  const strings = [], isIdent = [];
  // kinds RLE
  for (let o = R.stringKinds.start; o < R.stringKinds.end; o += 4) {
    const d = b.readUInt32LE(o); const cnt = d & 0x7fffffff, ident = d >>> 31;
    for (let i = 0; i < cnt; i++) isIdent.push(ident);
  }
  const ov = R.overflowStrTable ? R.overflowStrTable.start : 0;
  const stor = R.stringStorage.start;
  const entries = [];
  for (let i = 0, o = R.smallStrTable.start; i < H.stringCount; i++, o += 4) {
    const w = b.readUInt32LE(o);
    let utf16 = w & 1, off = (w >>> 1) & 0x7fffff, len = w >>> 24;
    if (len === 255) { const e = ov + off * 8; off = b.readUInt32LE(e); len = b.readUInt32LE(e + 4); }
    const bytes = b.subarray(stor + off, stor + off + len * (utf16 ? 2 : 1));
    strings.push((utf16 ? 'u:' : 'a:') + bytes.toString('latin1'));
    entries.push(w);
  }
  const funcs = [];
  for (let i = 0, o = R.funcHeaders.start; i < H.functionCount; i++, o += 16) {
    const w0 = b.readUInt32LE(o), w1 = b.readUInt32LE(o + 4), w3 = b.readUInt32LE(o + 12);
    const overflowed = ((w3 >>> 24) >> 5) & 1;
    funcs.push({ hdr: o, off: w0 & 0x1ffffff, size: w1 & 0x7fff, name: w1 >>> 15, overflowed });
  }
  return { b, R, H, strings, isIdent, entries, funcs };
}
/** decode a function body: [{pos, op, ops:[{pos,size,type,v}]}] */
function decode(b, f) {
  const out = [];
  let p = f.off, end = f.off + f.size;
  while (p < end) {
    const op = OPS[b[p]];
    if (!op || p + op.size > end) return { insns: out, ok: false };
    const ops = []; let q = p + 1;
    op.types.forEach((t, i) => { const size = TSIZE[t]; ops.push({ pos: q, size, type: t, str: op.str === i, fn: op.fn === i }); q += size; });
    out.push({ pos: p, op, ops });
    if (op.name === 'SwitchImm') { const tbl = p + b.readUInt32LE(ops[1].pos); end = Math.min(end, tbl); }
    p = q;
  }
  return { insns: out, ok: p === end };
}
const rd = (b, o) => (o.size === 1 ? b[o.pos] : o.size === 2 ? b.readUInt16LE(o.pos) : b.readUInt32LE(o.pos));
const wr = (b, o, v) => (o.size === 1 ? (b[o.pos] = v) : o.size === 2 ? b.writeUInt16LE(v, o.pos) : b.writeUInt32LE(v, o.pos));

// ---------------------------------------------------------------- selftest
if (args.selftest) {
  const u = L.makeLibraryUnit(Number(args.size || 30000), 7);
  const js = L.unitText(u); const b = L.compile(js); const p = parse(b);
  const hist = {}; let bad = 0, withStr = 0, withFn = 0;
  for (const f of p.funcs) {
    if (f.overflowed) continue;
    const d = decode(b, f);
    if (!d.ok) bad++;
    for (const i of d.insns) { hist[i.op.name] = (hist[i.op.name] || 0) + 1; if (i.op.str !== undefined) withStr++; if (i.op.fn !== undefined) withFn++; }
  }
  const dump = L.dumpBytecode(js); const dh = {};
  for (const l of dump.split('\n')) { const g = /^ {4}(\w+)/.exec(l); if (g) dh[g[1]] = (dh[g[1]] || 0) + 1; }
  const diffs = [...new Set([...Object.keys(hist), ...Object.keys(dh)])].filter((k) => k !== 'bc' && (hist[k] || 0) !== (dh[k] || 0));
  console.log(`opcodes in table: ${OPS.length}; functions ${p.funcs.length}, decode failures ${bad}, string-ID operands ${withStr}, function-ID operands ${withFn}`);
  console.log(`opcode histogram vs hermesc -dump-bytecode: ${diffs.length === 0 ? 'IDENTICAL' : 'DIFFERENT ' + diffs.map((k) => `${k}:${hist[k] || 0}/${dh[k] || 0}`).join(' ')}`);
  console.log(`strings decoded ${p.strings.length}/${p.H.stringCount}, identifiers ${p.isIdent.filter(Boolean).length}/${p.H.identifierCount}`);
  process.exit(0);
}

// ---------------------------------------------------------------- the transform
const vbytes = (n) => { const o = []; n = n >>> 0; while (n >= 128) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return o; };
const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
/** side-info cost: zstd-19 of zigzag-varint deltas of the permutation */
function sideCost(map) {
  const bytes = []; let prev = -1;
  for (const v of map) { if (v < 0) bytes.push(0); else { bytes.push(...vbytes(zz(v - prev - 1) + 1)); prev = v; } }
  return L.zstdSize(Buffer.from(bytes));
}
function funcKey(p, f, sMap) {
  if (f.overflowed) return 'ovf' + f.off;
  const d = decode(p.b, f);
  const h = [p.strings[f.name] ?? '', f.size];
  for (const i of d.insns) {
    h.push(i.op.name);
    for (const o of i.ops) h.push(o.str ? 's:' + (p.strings[rd(p.b, o)] ?? '?') : o.fn ? 'f' : o.pos);
  }
  return h.join('|').replace(/\|\d+(?=\||$)/g, '|');
}
function transform(po, pn) {
  const newIdOf = new Map(); pn.strings.forEach((s, i) => newIdOf.set(s, i));
  const S = po.strings.map((s) => (newIdOf.has(s) ? newIdOf.get(s) : -1));
  // functions: greedy monotone match on content keys
  const ko = po.funcs.map((f) => funcKey(po, f)), kn = pn.funcs.map((f) => funcKey(pn, f));
  const q = new Map(); ko.forEach((k, i) => { if (!q.has(k)) q.set(k, []); q.get(k).push(i); });
  const F = new Array(po.funcs.length).fill(-1); let last = -1;
  kn.forEach((k, j) => { const l = q.get(k); if (!l) return; const i = l.find((x) => x > last); if (i === undefined) return; F[i] = j; last = i; });
  const b = Buffer.from(po.b);
  let remappedOps = 0, changedOps = 0;
  for (const f of po.funcs) {
    if (f.overflowed) continue;
    for (const i of decode(b, f).insns) for (const o of i.ops) {
      if (!o.str && !o.fn) continue;
      const v = rd(b, o); const m = o.str ? S[v] : F[v];
      remappedOps++;
      if (m >= 0 && m !== v && m < 2 ** (8 * o.size)) { wr(b, o, m); changedOps++; }
    }
    // function-name string id inside the header (bits 15..31 of word 1)
    const w1 = b.readUInt32LE(f.hdr + 4); const nm = S[w1 >>> 15];
    if (nm >= 0 && nm < 2 ** 17) b.writeUInt32LE(((nm << 15) | (w1 & 0x7fff)) >>> 0, f.hdr + 4);
  }
  // string-table + identifier-hash permutation into the new table sizes
  const smallNew = Buffer.alloc(pn.H.stringCount * 4);
  po.entries.forEach((w, i) => { if (S[i] >= 0 && S[i] < pn.H.stringCount && (w >>> 24) !== 255) smallNew.writeUInt32LE(w, S[i] * 4); });
  const hashOld = new Map(); let k = 0;
  po.isIdent.forEach((id, i) => { if (id) { hashOld.set(po.strings[i], b.readUInt32LE(po.R.identHashes.start + 4 * k)); k++; } });
  const hashNew = Buffer.alloc(pn.H.identifierCount * 4); k = 0;
  pn.isIdent.forEach((id, i) => { if (id) { hashNew.writeUInt32LE(hashOld.get(pn.strings[i]) ?? 0, 4 * k); k++; } });
  const R = po.R;
  const out = Buffer.concat([b.subarray(0, R.identHashes.start), hashNew, b.subarray(R.identHashes.end, R.smallStrTable.start), smallNew, b.subarray(R.smallStrTable.end)]);
  return { out, S, F, remappedOps, changedOps };
}

/** ID-free textual form of a bytecode dump: strings sorted by content (no ids/offsets/hashes), functions with callee names, no buffers */
function semText(js) {
  const t = L.dumpBytecode(js);
  const strs = [...t.matchAll(/^([si])\d+\[(?:ASCII|UTF-16), \d+\.\.\d+\](?: #[0-9A-F]+)?: (.*)$/gm)].map((m) => m[1] + ':' + m[2]).sort();
  const fns = [...t.matchAll(/^Function<[^>]*>\([^)]*\):\n(?:Offset in debug table[^\n]*\n)?(?:    [^\n]*\n|L\d+:\n)*/gm)].map((m) => m[0].replace(/^Offset in debug table[^\n]*\n/m, '').replace(/^( {4}(?:NewObjectWithBuffer|NewArrayWithBuffer)\w* )[^\n]*/gm, '$1'));
  return Buffer.from(strs.join('\n') + '\n' + fns.join('\n'));
}
const semOld = semText(L.unitText(L.loadUnit(args.size || '300000', args.host)));

// ---------------------------------------------------------------- run
const size = args.size || '300000', seed = Number(args.seed || 1);
const kinds = (args.edit || 'E2,E4,E5b,E6,E7,E8').split(',');
const u = L.loadUnit(size, args.host);
const b0 = L.compile(L.unitText(u)); const bf = L.stash(b0, 'norm-base.hbc');
const po = parse(b0);
console.log(`\n#### structure-aware upper bound, unit ${size} (hbc ${b0.length} B, ${po.strings.length} strings, ${po.funcs.length} functions); seed ${seed}\n`);
console.log('| edit | plain diff | `-base-bytecode` diff (no device change) | remap-base diff (old\' -> new) | side info S / F | remap total | remap applied to the `-base-bytecode` output | ID-free dump-text diff (semantic floor) |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const k of kinds) {
  const e = L.pickEdits(u, k, seed)[seed - 1]; if (!e) continue;
  const js1 = L.unitText(e.unit);
  const b1 = L.compile(js1), bd = L.compile(js1, L.REC, ['-base-bytecode=' + bf]);
  const pn = parse(b1), pdn = parse(bd);
  const t = transform(po, pn), td = transform(po, pdn);
  const sc = sideCost(t.S), fc = sideCost(t.F);
  const d1 = L.diffSize(t.out, b1), dd = L.diffSize(td.out, bd);
  console.log(`| ${k} (${e.what.slice(0, 28)}) | ${L.diffSize(b0, b1)} | ${L.diffSize(b0, bd)} | ${d1} | ${sc} / ${fc} | ${d1 + sc + fc} | ${dd + sideCost(td.S) + sideCost(td.F)} (vs ${L.diffSize(b0, bd)} without) | ${L.diffSize(semOld, semText(js1))} |`);
}
