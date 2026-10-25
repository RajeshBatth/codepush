#!/usr/bin/env node
// Regenerates schemas/fixtures/*.json by running the REAL pipeline once on examples/demo-app:
//   ota-build bundle (android+ios) x2 (second one in hermesc delta mode) -> patch --report-plain -> base-info -> ota-cli init/deploy/rollout.
// Work happens under <repo>/.work/schema-fixtures (deleted at the end unless --keep). Needs the external tools
// (`scripts/fetch-tools.sh`, native/build-ota-tools). Run via: npm run schemas:fixtures   (or: node scripts/gen-schema-fixtures.mjs)
// Determinism: fixed source shas, fixed clock for ota-cli. Not deterministic across machines: `tools.*` / hermesc hashes in
// patch-report.json (hashes of locally built binaries); the schema tests never compare those values.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'schemas', 'fixtures');
const W = join(ROOT, '.work', 'schema-fixtures');
const BUILD_CLI = join(ROOT, 'packages/ota-build/src/cli.ts');
const OTA_CLI = join(ROOT, 'packages/ota-cli/src/cli.ts');
const FIXED_DATE = join(ROOT, 'scripts/lib/fixed-date.mjs');
const APP_VERSION = '11.9.0';
const SHA_BASE = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);
const keep = process.argv.includes('--keep');

function node(script, args, { fixedClock = false } = {}) {
  const argv = [...(fixedClock ? ['--import', FIXED_DATE] : []), script, ...args];
  console.log(`$ node ${argv.map((a) => a.replace(ROOT + '/', '')).join(' ')}`);
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 900_000, killSignal: 'SIGKILL', cwd: ROOT });
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    throw new Error(`command failed (exit ${r.status}): ${script} ${args[0]}`);
  }
  return r.stdout;
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeFixture = (name, value) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value, null, 2)).replace(/\n*$/, '\n');
  writeFileSync(join(OUT, name), text);
  console.log(`  wrote schemas/fixtures/${name}`);
};
const copyDemo = (dest) => {
  mkdirSync(dest, { recursive: true });
  for (const f of ['src', 'node_modules', 'units.config.json', 'package.json']) cpSync(join(ROOT, 'examples/demo-app', f), join(dest, f), { recursive: true });
  return dest;
};

rmSync(W, { recursive: true, force: true });
mkdirSync(W, { recursive: true });
mkdirSync(OUT, { recursive: true });
try {
  // 1. base app with a fully spelled-out units.config.json (every `checks` key at its default)
  const appBase = copyDemo(join(W, 'app-base'));
  const unitsConfig = {
    $schema: '../units.config.schema.json',
    entry: 'src/host/index.js',
    units: readJson(join(appBase, 'units.config.json')).units,
    checks: {
      cycles: 'error', cycleBaseline: null, singleImportSite: 'warn', dynamicRequire: 'error', requireRegisterComponent: false,
      hostExports: 'error', assets: 'error', nativeModules: 'error', publicPackages: [], publicApiSnapshot: {}, publicApiStrict: false,
    },
  };
  writeFileSync(join(appBase, 'units.config.json'), JSON.stringify(unitsConfig, null, 2));
  // 2. new app: one cabs change
  const appNew = copyDemo(join(W, 'app-cabs'));
  writeFileSync(join(appNew, 'units.config.json'), JSON.stringify(unitsConfig, null, 2));
  appendFileSync(join(appNew, 'src/units/cabs/fare.js'), `\nexport function surge(km) {\n  return getConfig('rates.cab.base') * 1.5 + getConfig('rates.cab.perKm') * km;\n}\n`);

  const PLATFORMS = ['android', 'ios'];
  for (const p of PLATFORMS) {
    node(BUILD_CLI, ['bundle', '--project', appBase, '--platform', p, '--out', join(W, `base-${p}`), '--app-version', APP_VERSION, '--source-sha', SHA_BASE]);
    node(BUILD_CLI, ['bundle', '--project', appNew, '--platform', p, '--out', join(W, `cabs-${p}`), '--app-version', APP_VERSION, '--source-sha', SHA_NEW, '--base-build', join(W, `base-${p}`)]);
    node(BUILD_CLI, ['patch', '--base', join(W, `base-${p}`), '--new', join(W, `cabs-${p}`), '--out', join(W, `patch-${p}`), '--report-plain']);
  }

  // 3. state: base-info -> init -> deploy -> rollout 10%
  const cfg = join(W, 'cfg');
  mkdirSync(cfg, { recursive: true });
  const governance = {
    $schema: '../ota-units-governance.schema.json',
    superAdminTeam: 'ota-super-admin',
    enforceJira: false,
    acceptableTicketStatuses: ['In Progress'],
    defaultSoftLimit: { bytes: 100000 },
    defaultHardLimit: { bytes: 500000, ratio: 0.5 },
    units: {
      host: { ownerTeam: 'ota-super-admin', jiraProjects: ['COM'] },
      cabs: { ownerTeam: 'ota-cabs', jiraProjects: ['CAB'], softLimit: { ratio: 0.2 } },
      bus: { ownerTeam: 'ota-bus', jiraProjects: ['BUS'] },
      travelplex: { ownerTeam: 'ota-travelplex', jiraProjects: ['TLX'] },
    },
  };
  writeFileSync(join(cfg, 'units.json'), JSON.stringify(governance, null, 2));
  writeFileSync(join(cfg, 'teams.json'), JSON.stringify({ 'ota-cabs': ['alice'], 'ota-super-admin': ['sam'] }));
  const keys = join(W, 'keys');
  node(OTA_CLI, ['keygen', '--out', keys]);
  const common = ['--store', join(W, 'store'), '--cdn', join(W, 'cdn'), '--units', join(cfg, 'units.json'), '--teams', join(cfg, 'teams.json'),
    '--key', join(keys, 'private.pem'), '--pub', join(keys, 'public.pem')];
  const baseJson = join(cfg, 'base.json');
  node(BUILD_CLI, ['base-info', '--android', join(W, 'base-android'), '--ios', join(W, 'base-ios'), '--release-tag', `release/${APP_VERSION}`, '--toolchain-image', 'img@sha256:' + '1'.repeat(64), '--out', baseJson]);
  node(OTA_CLI, ['init', ...common, '--base', baseJson, '--requester', 'release-bot'], { fixedClock: true });
  const da = JSON.parse(node(BUILD_CLI, ['deploy-args', '--json', '--report', join(W, 'patch-android/patch-report.json'), '--report', join(W, 'patch-ios/patch-report.json'), '--unit', 'cabs', '--version', APP_VERSION, '--pr', '42']));
  const who = ['--requester', 'dev', '--approver', 'alice', '--ticket', 'CAB-1', '--sha', SHA_NEW, '--job-url', 'https://ci.example.com/job/ota-deploy/7'];
  node(OTA_CLI, ['deploy', ...common, ...da.flags.flat(), ...who], { fixedClock: true });
  node(OTA_CLI, ['rollout', ...common, '--version', APP_VERSION, '--unit', 'cabs', '--pr', '42', '--percent', '10', ...who], { fixedClock: true });
  node(OTA_CLI, ['verify', ...common, '--version', APP_VERSION]);

  // 4. collect
  console.log('collecting fixtures:');
  writeFixture('units.config.json', unitsConfig);
  writeFixture('units.output.json', readFileSync(join(W, 'base-android/units.json'), 'utf8'));
  // build.json = the PATCH build (hermesc delta mode, delta.enabled true); build.base.json = the base release build (delta.enabled false)
  writeFixture('build.json', readFileSync(join(W, 'cabs-android/build.json'), 'utf8'));
  writeFixture('build.base.json', readFileSync(join(W, 'base-android/build.json'), 'utf8'));
  writeFixture('patch-report.json', readFileSync(join(W, 'patch-android/patch-report.json'), 'utf8'));
  writeFixture('base.json', readFileSync(baseJson, 'utf8'));
  writeFixture('manifest.json', readFileSync(join(W, 'cdn/android', APP_VERSION, 'manifest.json'), 'utf8').replace(/^(.*)$/s, (s) => JSON.stringify(JSON.parse(s), null, 2)));
  const stateDir = (n) => join(W, 'store/ota-state', APP_VERSION, `v${n}`);
  writeFixture('audit.json', readFileSync(join(stateDir(3), 'audit.json'), 'utf8'));
  writeFixture('audit.init.json', readFileSync(join(stateDir(1), 'audit.json'), 'utf8'));
  writeFixture('ota-units-governance.json', governance);
  writeFixture('pin.json', { $schema: '../pin.schema.json', branch: `ota/cabs/${APP_VERSION}`, sha: SHA_NEW });
  console.log('done.');
} finally {
  if (!keep) rmSync(W, { recursive: true, force: true });
}
