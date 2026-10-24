#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { build, generateCycleBaseline, generateApiSnapshots } from './build.js';
import { VerificationError } from './analyze.js';

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    project: { type: 'string' },
    out: { type: 'string' },
    approach: { type: 'string', default: 'serializer' },
    base: { type: 'string' },
    bits: { type: 'string', default: '48' },
    platform: { type: 'string', default: 'ios' },
    entry: { type: 'string' },
    file: { type: 'string' },
    write: { type: 'boolean', default: false },
  },
});
if ((cmd !== 'build' && cmd !== 'cycle-baseline' && cmd !== 'api-snapshot') || !values.project) {
  console.error('usage: cli.js build --project <dir> [--out <dir>] [--approach serializer|postprocess] [--base <base dist>] [--bits 48] [--platform ios|android] [--entry src/host/index.js]\n' +
    '       cli.js cycle-baseline --project <dir> [--platform ios|android] [--file <baseline.json>]   (prints/writes the current cycles as a baseline for checks.cycleBaseline)\n' +
    '       cli.js api-snapshot --project <dir> [--platform ios|android] [--write]   (prints the runtime export surface of checks.publicPackages; --write stores it at checks.publicApiSnapshot[pkg])');
  process.exit(2);
}
const projectRoot = path.resolve(values.project);
try {
  if (cmd === 'cycle-baseline') {
    const b = await generateCycleBaseline({ projectRoot, platform: values.platform, entry: values.entry, bits: Number(values.bits) });
    const text = JSON.stringify(b, null, 2) + '\n';
    if (values.file) { fs.writeFileSync(path.resolve(values.file), text); console.error(`wrote ${values.file}`); } else process.stdout.write(text);
    process.exit(0);
  }
  if (cmd === 'api-snapshot') {
    const { snapshots, written } = await generateApiSnapshots({ projectRoot, write: values.write, platform: values.platform, entry: values.entry, bits: Number(values.bits) });
    process.stdout.write(JSON.stringify(snapshots, null, 2) + '\n');
    for (const f of written) console.error(`wrote ${f}`);
    process.exit(0);
  }
  const r = await build({
    projectRoot,
    outDir: path.resolve(values.out ?? path.join(projectRoot, 'dist')),
    approach: values.approach,
    base: values.base ? path.resolve(values.base) : null,
    bits: Number(values.bits),
    platform: values.platform,
    entry: values.entry,
  });
  console.log(`built (${r.approach}) -> ${r.outDir}`);
  for (const [f, h] of Object.entries(r.files)) console.log(`  ${h.slice(0, 12)}  ${f}`);
  for (const [rule, c] of Object.entries(r.checks)) console.log(`check ${rule}: severity=${c.severity} findings=${c.count}${c.thirdPartyHostCycles != null ? ` (third-party host cycles, info: ${c.thirdPartyHostCycles})` : ''}${c.thirdPartyModules?.length ? ` (third-party dynamic requires, info: ${c.thirdPartyModules.length} module(s))` : ''}`);
  for (const w of r.warnings) console.warn(`warning [${w.rule}] ${w.message}`);
} catch (e) {
  if (e instanceof VerificationError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
