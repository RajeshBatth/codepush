#!/usr/bin/env node
// What does the final string-ID order look like? (evidence for the ID-assignment analysis in STRING_TABLE.md)
//   node st_idorder.mjs [--size=300000|host]
import * as L from './st_lib.mjs';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));
const u = L.loadUnit(args.size || '300000', args.host);
const t = L.dumpBytecode(L.unitText(u));
const S = [...t.matchAll(/^([si])(\d+)\[(ASCII|UTF-16), (\d+)\.\.(\d+)\](?: #[0-9A-F]+)?: (.*)$/gm)].map((m) => ({ id: +m[2], ident: m[1] === 'i', off: +m[4], s: m[6] }));
const runs = []; for (const x of S) { const last = runs[runs.length - 1]; if (last && last.ident === x.ident) last.n++; else runs.push({ ident: x.ident, n: 1, from: x.id }); }
console.log(`strings ${S.length}; kind runs (from the "String Kind Entry" table): ${runs.map((r) => `${r.ident ? 'identifier' : 'string'} x${r.n} from id ${r.from}`).join(', ')}`);
const idents = S.filter((x) => x.ident), plain = S.filter((x) => !x.ident);
console.log(`first 12 identifier ids: ${idents.slice(0, 12).map((x) => x.id + ':' + x.s).join('  ')}`);
console.log(`first 8 plain-string ids: ${plain.slice(0, 8).map((x) => x.id + ':' + JSON.stringify(x.s.slice(0, 18))).join('  ')}`);
const asc = (a) => { let n = 0; for (let i = 1; i < a.length; i++) if (a[i - 1].s <= a[i].s) n++; return (100 * n / (a.length - 1)).toFixed(1); };
console.log(`adjacent pairs in ascending alphabetical order: plain strings ${asc(plain)}%, identifiers (ids >= 256) ${asc(idents.filter((x) => x.id >= 256))}%  (50% = random, 100% = sorted)`);
let mono = 0; for (let i = 1; i < S.length; i++) if (S[i].off >= S[i - 1].off) mono++;
console.log(`adjacent ids with increasing storage offset: ${(100 * mono / (S.length - 1)).toFixed(1)}% (the final id order follows packed-storage order, not first use)`);
// how far does a new string move other ids? insert one string alphabetically in the middle and recompile
