#!/usr/bin/env node
// Writes <version>/<unit>.json (the pin) into a checkout of the ota-deployments repo and prints the next commands.
// Script only: no automation, no network. Usage:
//   node tools/ota-propose.mjs <unit> <version> --monorepo <path> --deployments <path> [--ticket TLX-1244] [--title "fix crash"]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: f, positionals: [unit, version] } = parseArgs({
  allowPositionals: true,
  options: { monorepo: { type: 'string' }, deployments: { type: 'string' }, ticket: { type: 'string' }, title: { type: 'string' } },
});
const die = (m) => { console.error(`error: ${m}\nusage: ota-propose.mjs <unit> <version> --monorepo <path> --deployments <path> [--ticket KEY] [--title TEXT]`); process.exit(1); };
if (!unit || !/^[a-z][a-z0-9-]*$/.test(unit)) die('unit missing or invalid');
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) die('version must look like 11.9.0');
if (!f.monorepo || !f.deployments) die('--monorepo and --deployments are required');

const branch = `ota/${unit}/${version}`;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let sha;
try { sha = git(f.monorepo, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`); }
catch { try { sha = git(f.monorepo, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`); } catch { die(`branch ${branch} not found in ${f.monorepo} (fetch it first)`); } }
if (!/^[0-9a-f]{40}$/.test(sha)) die(`unexpected sha: ${sha}`);

const dir = join(f.deployments, version);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${unit}.json`), JSON.stringify({ branch, sha }, null, 2) + '\n');

const title = `${f.ticket ? f.ticket + ': ' : ''}${f.title ?? `OTA ${unit} ${version}`}`;
console.log(`wrote ${version}/${unit}.json -> ${branch} @ ${sha}\n\nNext (in ${f.deployments}):\n  git checkout -b ota-${unit}-${version}-${sha.slice(0, 7)}\n  git add ${version}/${unit}.json && git commit -m ${JSON.stringify(title)}\n  gh pr create --title ${JSON.stringify(title)} --body "Pin ${branch} @ ${sha}"`);
