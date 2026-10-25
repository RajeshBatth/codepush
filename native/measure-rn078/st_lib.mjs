// Shared helpers for the HBC string-table / diff-size study (see STRING_TABLE.md).
// Node >= 24 (ESM, no deps). Everything runs from a scratch dir (default <repo>/.work/st), never /tmp.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const WORK = process.env.ST_WORK || path.join(REPO, '.work/st');
export const HERMESC = process.env.ST_HERMESC || path.join(REPO, '.tools/hermesc-rn0.78.3/hermesc');
export const HDIFFZ = process.env.ST_HDIFFZ || path.join(REPO, 'native/build-ota-tools/hdiffz_tool');
export const ZSTD = process.env.ST_ZSTD || 'zstd';
export const SRC = process.env.ST_SRC || path.join(WORK, 'src'); // {lodash,rxjs,date-fns,moment}/package, see st_fetch_corpus.sh

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 300_000, cwd: opts.cwd, maxBuffer: 1 << 28 });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 4).join(' ')} failed: ${r.error || ''} ${(r.stderr || '').slice(0, 400)}`);
  return r.stdout;
}

let tmpCounter = 0;
export function tmpDir(tag = 't') {
  const d = path.join(WORK, 'tmp', `${tag}-${process.pid}-${tmpCounter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Same recipe as packages/ota-build (cwd with a fixed relative bundle.js, -O -emit-binary -g0). `flags` replaces the default flags. */
export function compile(js, flags = ['-O', '-emit-binary', '-g0'], extra = []) {
  const d = tmpDir('hc');
  fs.writeFileSync(path.join(d, 'bundle.js'), js);
  run(HERMESC, [...flags, ...extra, '-out', 'out.hbc', 'bundle.js'], { cwd: d });
  const hbc = fs.readFileSync(path.join(d, 'out.hbc'));
  fs.rmSync(d, { recursive: true, force: true });
  return hbc;
}

/** Dump (text) of a JS compiled with the given flags. */
export function dumpBytecode(js, flags = ['-O', '-g0']) {
  const d = tmpDir('dump');
  fs.writeFileSync(path.join(d, 'bundle.js'), js);
  const out = run(HERMESC, [...flags, '-dump-bytecode', 'bundle.js'], { cwd: d });
  fs.rmSync(d, { recursive: true, force: true });
  return out;
}

export const PATCH = { c: 'zstd', l: 19, m: 4 }; // packages/ota-build/src/patch.ts PATCH_ALGO
/** HDiffPatch single compressed diff size in bytes. */
export function diffSize(a, b, p = PATCH) {
  const d = tmpDir('df');
  fs.writeFileSync(path.join(d, 'a'), a);
  fs.writeFileSync(path.join(d, 'b'), b);
  const args = ['-c', p.c, ...(p.l ? ['-l', String(p.l)] : []), '-m', String(p.m ?? 4), path.join(d, 'a'), path.join(d, 'b'), path.join(d, 'p')];
  run(HDIFFZ, args, { timeout: 600_000 });
  const n = fs.statSync(path.join(d, 'p')).size;
  fs.rmSync(d, { recursive: true, force: true });
  return n;
}
/** What a `full` patch costs (patch.ts diffs against an empty old file with the same tool). */
export const fullSize = (b, p = PATCH) => diffSize(Buffer.alloc(0), b, p);
export function zstdSize(b) {
  const r = spawnSync(ZSTD, ['-19', '-q', '-c'], { input: b, maxBuffer: 1 << 28 });
  return r.stdout.length;
}

// ---------------------------------------------------------------- corpus
let seed0 = 1;
export function lcg(seed) {
  let s = seed >>> 0 || 1;
  return (n) => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff), s % n);
}
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.min.js') && !p.includes('/esm/') && !p.includes('/locale/')) acc.push(p);
  }
  return acc;
}
/** CJS-only library modules of the same open-source corpora as native/tools/make_hbc_corpus.mjs (size-capped so small units hold several). */
export function corpusModules(maxBytes = 40000) {
  const dirs = ['lodash/package', 'rxjs/package/dist/cjs', 'date-fns/package', 'moment/package'].map((d) => path.join(SRC, d));
  const files = dirs.flatMap((d) => walk(d));
  return files
    .map((f) => fs.readFileSync(f, 'utf8'))
    .filter((s) => s.length > 400 && s.length < maxBytes && !/^\s*(import\s[^(]*from\s|import\s*['"]|export\s)/m.test(s));
}
export const HEAD = 'function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {';
export const wrapModule = (body, id) => `__d(${HEAD}\n${body}\n},${id},[]);\n`;

/**
 * A "unit": {pre, mods[], post}; text = pre + mods.join('') + post. Metro layout: every module chunk starts at a line `__d(`.
 * Library unit: shuffled corpus modules until the compiled .hbc reaches ~target bytes (calibrated by compiling).
 */
export function makeLibraryUnit(targetHbc, seed = 7) {
  const mods = corpusModules();
  const r = lcg(seed);
  for (let i = mods.length - 1; i > 0; i--) { const j = r(i + 1); [mods[i], mods[j]] = [mods[j], mods[i]]; }
  const take = (n) => ({ pre: '', mods: mods.slice(0, n).map((b, i) => wrapModule(b, 1000 + i)), post: '' });
  let lo = 1, hi = mods.length, best = take(1);
  // binary search on module count so that hbc size is closest to target
  for (let it = 0; it < 14 && lo <= hi; it++) {
    const mid = (lo + hi) >> 1;
    const u = take(mid);
    const sz = compile(unitText(u)).length;
    best = u;
    if (sz < targetHbc) lo = mid + 1; else hi = mid - 1;
    if (Math.abs(sz - targetHbc) < targetHbc * 0.03) break;
  }
  return best;
}
export const unitText = (u) => u.pre + u.mods.join('') + u.post;
/** Split an existing Metro bundle (host.js) into prelude / __d chunks. */
export function unitFromMetroBundle(file) {
  const t = fs.readFileSync(file, 'utf8');
  const parts = t.split(/^(?=__d\()/m);
  return { pre: parts[0], mods: parts.slice(1), post: '' };
}

// ---------------------------------------------------------------- edits
const STR_RE = /(?<![\w$])(['"])([A-Za-z][A-Za-z ]{5,19})\1(?![\w$]|\s*:)/g;
const BADSTR = new Set(['function', 'object', 'string', 'number', 'undefined', 'boolean', 'symbol', 'use strict', 'default', 'constructor']);

const wordUnique = (st, s) => !/^[\w$]+$/.test(s) || st.word.get(s) === 1;
function bodyRange(m) {
  const a = m.indexOf('{\n') + 2; // first line is the __d(function(...) { header
  const b = m.lastIndexOf('\n},');
  return [a, b > a ? b : m.length];
}
const isCodeLine = (m, idx) => {
  const s = m.lastIndexOf('\n', idx) + 1;
  const line = m.slice(s, m.indexOf('\n', idx) < 0 ? m.length : m.indexOf('\n', idx)).trimStart();
  return !(line.startsWith('*') || line.startsWith('//') || line.startsWith('/*'));
};

/** literal -> occurrence count over the whole unit (quoted, any quote) and identifier word -> count */
function statsFor(u) {
  if (u._stats) return u._stats;
  const t = unitText(u);
  const lit = new Map(), word = new Map();
  for (const m of t.matchAll(/(['"])([A-Za-z][A-Za-z ]{2,40})\1/g)) lit.set(m[2], (lit.get(m[2]) || 0) + 1);
  for (const m of t.matchAll(/[A-Za-z_$][\w$]*/g)) word.set(m[0], (word.get(m[0]) || 0) + 1);
  u._stats = { lit, word, text: t };
  return u._stats;
}

/** Find in module m the first match (scanning from a seeded offset) of a spec; spec returns {index, len, repl} or null */
function pick(u, rnd, finder) {
  const n = u.mods.length;
  const start = rnd(n);
  for (let k = 0; k < n; k++) {
    const mi = (start + k) % n;
    const m = u.mods[mi];
    if (mi === 0 && u.pre === '' && n > 1 && false) continue;
    const [a, b] = bodyRange(m);
    const res = finder(m, a, b, rnd, u);
    if (res) return { mi, ...res };
  }
  return null;
}
const rand = (rnd, lo, hi) => lo + rnd(hi - lo + 1);

/** Each edit class returns a NEW unit (mods array copied) and a description, or throws if none applicable. */
export const EDITS = {
  E1: { name: 'numeric literal', apply(u, rnd, tag) {
    const re = /(?<=[=(,:<>+*\/ ]|return )(\d{2,4})(?=[;,) ])/g;
    const hit = pick(u, rnd, (m, a, b, r) => {
      const c = [...m.slice(a, b).matchAll(re)].filter((x) => isCodeLine(m, a + x.index));
      if (!c.length) return null;
      const x = c[r(c.length)];
      const old = x[1];
      return { index: a + x.index, len: old.length, repl: String(Number(old) + 7 > 9999 ? Number(old) - 7 : Number(old) + 7), what: `${old} -> literal` };
    });
    return splice(u, hit);
  } },
  E2: { name: 'string, same length, reworded (random rank)', apply(u, rnd) { return strEdit(u, rnd, (s) => [...s].reverse().join('') === s ? s.toUpperCase() : [...s].reverse().join('')); } },
  E2t: { name: 'string, same length, one char tweaked (typo fix)', apply(u, rnd) { return strEdit(u, rnd, (s) => { const i = s.length >> 1; const c = s[i] === 'q' ? 'z' : 'q'; return s.slice(0, i) + c + s.slice(i + 1); }); } },
  E3: { name: 'string, longer, reworded (prefix added)', apply(u, rnd) { return strEdit(u, rnd, (s) => 'New ' + s); } },
  E3t: { name: 'string, longer, suffix appended', apply(u, rnd) { return strEdit(u, rnd, (s) => s + ' edited copy'); } },
  E4: { name: 'new string in existing fn', apply(u, rnd, tag) {
    const hit = pick(u, rnd, (m, a, b, r) => {
      const c = [...m.slice(a, b).matchAll(/\bfunction\s*[\w$]*\s*\([^)]*\)\s*\{\n/g)].filter((x) => isCodeLine(m, a + x.index));
      if (!c.length) return null;
      const x = c[r(c.length)];
      const ind = ' '.repeat(2);
      return { index: a + x.index + x[0].length, len: 0, repl: `${ind}if (this === 4242) { return 'ota-new-string-${tag}'; }\n`, what: 'insert string in fn' };
    });
    return splice(u, hit);
  } },
  E5: { name: 'new function, appended (new module at end)', apply(u, rnd, tag) {
    const mods = u.mods.slice();
    mods.push(wrapModule(newFn(tag), 99000000 + tag));
    return { unit: { ...u, mods, _stats: undefined }, what: `append new __d module #${tag}`, module: 'end' };
  } },
  E5b: { name: 'new function, end of a random existing module', apply(u, rnd, tag) {
    const hit = pick(u, rnd, (m, a, b) => ({ index: b, len: 0, repl: '\n' + newFn(tag), what: 'fn at end of module' }));
    return splice(u, hit);
  } },
  E6: { name: 'new function, start of a random module', apply(u, rnd, tag) {
    const hit = pick(u, rnd, (m, a, b) => {
      let idx = a;
      const d = /^\s*(['"])use strict\1;?\n/.exec(m.slice(a, a + 80));
      if (d) idx += d[0].length;
      return { index: idx, len: 0, repl: newFn(tag) + '\n', what: 'fn at start of module' };
    });
    return splice(u, hit);
  } },
  E7: { name: 'remove a string', apply(u, rnd) {
    const st = statsFor(u);
    const hit = pick(u, rnd, (m, a, b, r) => {
      const c = [...m.slice(a, b).matchAll(STR_RE)].filter((x) => isCodeLine(m, a + x.index) && st.lit.get(x[2]) === 1 && wordUnique(st, x[2]) && !BADSTR.has(x[2]) && !/require\($/.test(m.slice(Math.max(0, a + x.index - 8), a + x.index)));
      if (!c.length) return null;
      const x = c[r(c.length)];
      return { index: a + x.index, len: x[0].length, repl: "''", what: `remove "${x[2]}"` };
    });
    return splice(u, hit);
  } },
  E8: { name: 'rename object property', apply(u, rnd) {
    const st = statsFor(u);
    const hit = pick(u, rnd, (m, a, b, r) => {
      const c = [...m.slice(a, b).matchAll(/\.([A-Za-z_$][\w$]{5,14})\b/g)].filter((x) => isCodeLine(m, a + x.index) && st.word.get(x[1]) === 1);
      if (!c.length) return null;
      const x = c[r(c.length)];
      return { index: a + x.index + 1, len: x[1].length, repl: x[1] + 'Q', what: `rename .${x[1]}` };
    });
    return splice(u, hit);
  } },
};
export const EDIT_ORDER = ['E1', 'E2', 'E2t', 'E3', 'E3t', 'E4', 'E5', 'E5b', 'E6', 'E7', 'E8'];

function newFn(tag) {
  return `function otaNewFn${tag}(a, b) {\n  var label = 'ota-feature-${tag}';\n  if (a && b) { return label + ':' + a.length + ':' + b.length; }\n  return [a, b, 'row-${tag}'].join(',');\n}\nmodule.exports.otaNewFn${tag} = otaNewFn${tag};\n`;
}
function strEdit(u, rnd, mut) {
  const st = statsFor(u);
  const hit = pick(u, rnd, (m, a, b, r) => {
    const c = [...m.slice(a, b).matchAll(STR_RE)].filter((x) => isCodeLine(m, a + x.index) && st.lit.get(x[2]) === 1 && wordUnique(st, x[2]) && !BADSTR.has(x[2]) && !/require\($/.test(m.slice(Math.max(0, a + x.index - 8), a + x.index)));
    if (!c.length) return null;
    const x = c[r(c.length)];
    const q = x[1];
    const ns = mut(x[2]);
    if (st.lit.has(ns)) return null;
    return { index: a + x.index, len: x[0].length, repl: q + ns + q, what: `"${x[2]}" -> "${ns}"` };
  });
  return splice(u, hit);
}
function splice(u, hit) {
  if (!hit) return null;
  const mods = u.mods.slice();
  const m = mods[hit.mi];
  mods[hit.mi] = m.slice(0, hit.index) + hit.repl + m.slice(hit.index + hit.len);
  return { unit: { ...u, mods, _stats: undefined }, what: hit.what, module: hit.mi };
}

/** Apply edit class `k` with position seed `seed`. Returns {unit, what} or null. */
export function applyEdit(u, k, seed) {
  const rnd = lcg(seed * 7919 + k.length * 31 + k.charCodeAt(k.length - 1));
  return EDITS[k].apply(u, rnd, seed);
}

// ---------------------------------------------------------------- stats
export const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
export const kb = (n) => (n / 1024).toFixed(n < 10240 ? 2 : 1);
export const pct = (a, b) => ((100 * a) / b).toFixed(1);

// ---------------------------------------------------------------- HBC regions
/** Parse the section layout of a v96 .hbc (BytecodeFileFormat.h / BytecodeStream.cpp order); returns [{name,start,end}] covering the file. */
export function hbcRegions(b) {
  const u32 = (o) => b.readUInt32LE(o);
  const H = { functionCount: u32(40), stringKindCount: u32(44), identifierCount: u32(48), stringCount: u32(52), overflowStringCount: u32(56), stringStorageSize: u32(60),
    bigIntCount: u32(64), bigIntStorageSize: u32(68), regExpCount: u32(72), regExpStorageSize: u32(76), arrayBufferSize: u32(80), objKeyBufferSize: u32(84), objValueBufferSize: u32(88),
    cjsModuleCount: u32(96), functionSourceCount: u32(100), debugInfoOffset: u32(104), options: b[108] };
  const regs = [];
  let o = 128;
  const al = () => { o = (o + 3) & ~3; };
  const add = (name, size) => { al(); regs.push({ name, start: o, end: o + size }); o += size; };
  regs.push({ name: 'header', start: 0, end: 128 });
  add('funcHeaders', H.functionCount * 16);
  add('stringKinds', H.stringKindCount * 4);
  add('identHashes', H.identifierCount * 4);
  add('smallStrTable', H.stringCount * 4);
  add('overflowStrTable', H.overflowStringCount * 8);
  add('stringStorage', H.stringStorageSize);
  add('arrayBuffer', H.arrayBufferSize);
  add('objKeyBuffer', H.objKeyBufferSize);
  add('objValBuffer', H.objValueBufferSize);
  add('bigintTable', H.bigIntCount * 8);
  add('bigintStorage', H.bigIntStorageSize);
  add('regexpTable', H.regExpCount * 8);
  add('regexpStorage', H.regExpStorageSize);
  // cjs table + function source table (usually empty for plain __d scripts)
  add('cjs+fnSource', H.cjsModuleCount * 8 + H.functionSourceCount * 8);
  // function bodies (+ per-function info: overflow headers, exception tables) run from here to debugInfoOffset
  al();
  const dbg = H.debugInfoOffset;
  regs.push({ name: 'fnBodies+info', start: o, end: dbg });
  regs.push({ name: 'debugInfo', start: dbg, end: b.length - 20 });
  regs.push({ name: 'footerSha1', start: b.length - 20, end: b.length });
  return { regions: regs.filter((r) => r.end > r.start), H };
}

/** n distinct (module, what) edits of class k: [{unit, what, seed}] */
export function pickEdits(u, k, n = 3) {
  const out = [], seen = new Set();
  for (let seed = 1; seed <= 80 && out.length < n; seed++) {
    const e = applyEdit(u, k, seed);
    if (!e) break;
    const key = e.module + '|' + e.what;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, seed });
  }
  return out;
}
export const REC = ['-O', '-emit-binary', '-g0'];
/** write base hbc to the scratch dir and return its path (for -base-bytecode=) */
export function stash(buf, name) {
  const f = path.join(WORK, 'tmp', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  return f;
}
export function loadUnit(sz, hostJs) {
  return sz === 'host' ? unitFromMetroBundle(hostJs || path.join(WORK, 'hostb/js/host.js')) : makeLibraryUnit(Number(sz), 7);
}
