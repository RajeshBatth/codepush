#!/usr/bin/env node
// The owner's original data point: string-literal edit in HOST app code (spike-app src/host/marker.js: 'embedded' -> 'patched'),
// plain vs -base-bytecode.     node st_spike_real.mjs [host.js]   (host.js = Metro host bundle of examples/spike-app, see STRING_TABLE.md)
import fs from 'node:fs';
import path from 'node:path';
import * as L from './st_lib.mjs';
const hostJs = process.argv[2] || path.join(L.WORK, 'hostb/js/host.js');
const js0 = fs.readFileSync(hostJs, 'utf8');
const base = L.compile(js0); const bf = L.stash(base, 'spike-base.hbc');
console.log('| edit (real app code) | plain diff | delta diff | full |\n|---|---:|---:|---:|');
for (const [name, from, to] of [["'embedded' -> 'patched' (shorter)", "'embedded'", "'patched'"], ["'embedded' -> 'embedXXX' (same length)", "'embedded'", "'embedXXX'"], ["'embedded' -> 'embedded-v2' (longer)", "'embedded'", "'embedded-v2'"]]) {
  if (!js0.includes(from)) throw new Error('marker not found');
  const js1 = js0.replace(from, to);
  console.log(`| ${name} | ${L.diffSize(base, L.compile(js1))} | ${L.diffSize(base, L.compile(js1, L.REC, ['-base-bytecode=' + bf]))} | ${L.fullSize(L.compile(js1))} |`);
}
