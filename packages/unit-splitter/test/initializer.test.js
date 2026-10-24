// Realistic package unit: `@travelplex/react-native` is an npm package whose public entry pulls in INITIALIZER modules that
// have import-time side effects (open a websocket, fetch config). Shows where those effects run in the OTA flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/build.js';
import { createRuntime } from '../harness/harness.js';
import { copyProject, edit, tmp } from './helpers.js';

const write = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

/** demo-app copy where unit `travelplex` is the package @travelplex/react-native (bare-package entry = its `main`). */
function travelplexPackageProject({ initializerThrows = false } = {}) {
  const p = copyProject();
  fs.rmSync(path.join(p, 'src/units/travelplex'), { recursive: true });
  const pkg = path.join(p, 'node_modules/@travelplex/react-native');
  write(pkg, 'package.json', JSON.stringify({ name: '@travelplex/react-native', version: '3.2.0', main: 'lib/index.js' }));
  // public entry: imports the initializers, exports the component descriptor
  write(pkg, 'lib/index.js', "import './init';\nimport { sessionState } from './socket';\nexport default { name: 'travelplex', render: ({ days }) => 'Travelplex pkg: ' + days + ' days, ws=' + sessionState() };\n");
  // initializer modules: import-time side effects, recorded in a global log (stand-in for real network calls)
  write(pkg, 'lib/init.js', `import { openSocket } from './socket';\nimport { fetchConfig } from './config';\n${initializerThrows ? "throw new Error('travelplex init failed');\n" : ''}(globalThis.__tlxLog ||= []).push('init:start');\nopenSocket();\nfetchConfig();\n`);
  write(pkg, 'lib/socket.js', "let state = 'closed';\nexport const openSocket = () => { state = 'connecting'; (globalThis.__tlxLog ||= []).push('ws:open'); };\nexport const sessionState = () => state;\n");
  write(pkg, 'lib/config.js', "export const fetchConfig = () => { (globalThis.__tlxLog ||= []).push('config:fetch'); };\n");
  edit(p, 'units.config.json', (s) => s.replace(/\{ "name": "travelplex"[^}]*\}/, '{ "name": "travelplex", "roots": ["@travelplex/react-native"], "entry": "@travelplex/react-native" }'));
  edit(p, 'src/host/index.js', (s) => s.replace("import('../units/travelplex/entry')", "import('@travelplex/react-native')"));
  return p;
}

test('bare package entry resolves to the package main; initializer modules belong to the unit, not the host', async () => {
  const p = travelplexPackageProject();
  const out = tmp('out-');
  const r = await build({ projectRoot: p, outDir: out });
  const ids = JSON.parse(fs.readFileSync(path.join(out, 'ids.json'), 'utf8'));
  const keys = r.unitsJson.units.travelplex.moduleIds.map((id) => ids[id]).sort();
  assert.deepEqual(keys, ['node_modules/@travelplex/react-native/lib/config.js', 'node_modules/@travelplex/react-native/lib/index.js', 'node_modules/@travelplex/react-native/lib/init.js', 'node_modules/@travelplex/react-native/lib/socket.js']);
  assert.equal(r.unitsJson.units.travelplex.entryPath, 'node_modules/@travelplex/react-native/lib/index.js');
  assert.ok(!r.unitsJson.host.moduleIds.some((id) => ids[id].includes('travelplex')), 'nothing of the package in the host');
});

test('import-time initializers run when the unit ENTRY is required: not at host boot, not at evaluate, exactly once per VM', async () => {
  const p = travelplexPackageProject();
  const out = tmp('out-');
  await build({ projectRoot: p, outDir: out });
  const rt = createRuntime({ distDir: out });
  const log = () => Array.from(rt.ctx.__tlxLog ?? []);
  assert.deepEqual(log(), [], 'booting the host runs no initializer');
  const text = await rt.openUnit('travelplex', { days: 3 });
  assert.deepEqual(log(), ['init:start', 'ws:open', 'config:fetch'], 'initializers ran during the entry require, in import order');
  assert.equal(text, 'Travelplex pkg: 3 days, ws=connecting');
  await rt.openUnit('travelplex', { days: 5 });
  assert.deepEqual(log(), ['init:start', 'ws:open', 'config:fetch'], 'a unit is evaluated and its entry required once per VM: initializers do not re-run');
});

test('an initializer that throws at import time makes the load fail (the loader sees RequireError, not a crash)', async () => {
  const p = travelplexPackageProject({ initializerThrows: true });
  const out = tmp('out-');
  await build({ projectRoot: p, outDir: out });
  const rt = createRuntime({ distDir: out });
  await assert.rejects(rt.openUnit('travelplex', { days: 3 }), /travelplex init failed/);
  assert.deepEqual(Array.from(rt.ctx.__tlxLog ?? []), [], 'it threw before any side effect');
});
