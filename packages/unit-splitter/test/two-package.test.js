// Two-package LoB layout (examples/two-package-app): PUBLIC host-owned @travelplex/core + PRIVATE unit @travelplex/ui.
// Covers host-export-missing/unknown, public-deep-import, the public API snapshot, the lazyUnit-boundary cycle and the runtime
// behaviour (init once at host boot, shared singleton state, unit patch changes only the unit artifact).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/build.js';
import { diffAgainstBase } from '../src/diff.js';
import { createRuntime } from '../harness/harness.js';
import { createExportAnalyzer } from '../src/exports.js';
import { copyTwoPackage, TWO_PKG, edit, write, tmp, expectViolation } from './helpers.js';

const CORE = 'node_modules/@travelplex/core';
const UI = 'node_modules/@travelplex/ui';
const temps = [];
const mk = () => { const p = copyTwoPackage(); temps.push(p); return p; };
const out = () => { const o = tmp('tpo-'); temps.push(o); return o; };
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

let baseCache;
async function base() {
  baseCache ??= await build({ projectRoot: TWO_PKG, outDir: out() });
  return baseCache;
}
async function expectRule(rule, projectRoot, opts = {}) {
  let err;
  try { await build({ projectRoot, outDir: out(), ...opts }); } catch (e) { err = e; }
  assert.ok(err, `expected a ${rule} violation, but the build passed`);
  assert.equal(err.name, 'VerificationError', err.stack);
  assert.ok(err.violations.some((v) => v.rule === rule), `expected ${rule}, got: ${err.message}`);
  return err;
}

test('positive build: unit = @travelplex/ui, host owns @travelplex/core (incl. internal/), public API recorded, no warnings', async () => {
  const b = await base();
  const ids = JSON.parse(fs.readFileSync(path.join(b.outDir, 'ids.json'), 'utf8'));
  const keys = (list) => list.map((id) => ids[id]);
  assert.deepEqual(keys(b.unitsJson.units.travelplex.moduleIds).sort(), [`${UI}/entry.js`, `${UI}/screens/Home.js`, `${UI}/screens/Inbox.js`]);
  const hostKeys = keys(b.unitsJson.host.moduleIds);
  for (const f of ['index', 'init', 'session', 'shell', 'config', 'internal/secret']) assert.ok(hostKeys.includes(`${CORE}/${f}.js`), f);
  assert.equal(b.unitsJson.units.travelplex.entryPath, `${UI}/entry.js`);
  assert.deepEqual(b.unitsJson.publicApi['@travelplex/core'].exports, ['TravelplexEntry', 'getConfig', 'getSession', 'getUnreadCount', 'init', 'markRead', 'onEvent']);
  assert.equal(b.unitsJson.publicApi['@travelplex/core'].default, false);
  assert.deepEqual(b.warnings, []);
  assert.equal(b.checks['host-exports'].count, 0);
  assert.equal(b.checks['host-exports'].unknown, 0);
  assert.equal(b.checks['public-deep-import'].count, 0);
});

test('lazyUnit-boundary cycle (core shell import()s the unit, unit imports core) produces NO cycle-async warning', async () => {
  const b = await base();
  assert.ok(b.checks.cycles.lazyUnitBoundaryCycles >= 1, 'the by-design cross-owner cycle is counted for information');
  assert.equal(b.checks.cycles.asyncOnly, 0);
  assert.ok(!b.warnings.some((w) => w.rule === 'cycle-async'));
});

test('other async cycles (inside the unit) still warn', async () => {
  const p = mk();
  write(p, `${UI}/screens/A.js`, "export const a = () => import('./B');\n");
  write(p, `${UI}/screens/B.js`, "import { a } from './A';\nexport const b = () => a;\n");
  edit(p, `${UI}/entry.js`, (s) => "import './screens/A';\n" + s);
  const r = await build({ projectRoot: p, outDir: out() });
  assert.ok(r.warnings.some((w) => w.rule === 'cycle-async' && /A\.js/.test(w.message)), JSON.stringify(r.warnings));
});

test('runtime: init() runs exactly once per VM at host BOOT, before any unit opens; the unit shares the host singleton', async () => {
  const b = await base();
  const rt = createRuntime({ distDir: b.outDir });
  const LOG = ['init:start', 'ws:open', 'config:fetch'];
  assert.deepEqual(Array.from(rt.ctx.__tlxLog), LOG, 'init ran at boot');
  assert.deepEqual(rt.loadCalls, [], 'no unit has been loaded yet');
  assert.equal(rt.ctx.__registered, undefined, 'unit entry has not run');
  assert.equal(rt.app().initResult.ok, true);

  const home = await rt.openUnit('travelplex', {});
  assert.match(home, /^Travelplex home \| session sess-\d+ \(connecting\) \| unread 3$/);
  assert.deepEqual(rt.loadCalls, ['travelplex']);
  assert.deepEqual(Array.from(rt.ctx.__registered), ['travelplex']);
  assert.deepEqual(Array.from(rt.ctx.__tlxLog), LOG, 'opening the unit did not re-run init');

  // same singleton: identity, and a write from the unit is visible in the host
  const view = await rt.app().open({});
  assert.equal(view.state, 'ready');
  assert.equal(view.unit.session, rt.app().session, 'unit sees the SAME session object as the host');
  assert.equal(rt.app().getUnreadCount(), 3);
  assert.equal(await rt.openUnit('travelplex', { screen: 'inbox' }), 'Inbox: 3 unread, now 0');
  assert.equal(rt.app().getUnreadCount(), 0, 'markRead() in the unit changed the host-visible state');
  assert.deepEqual(Array.from(rt.ctx.__tlxLog), LOG, 'still exactly one init');
});

test('runtime: init() is idempotent and never throws (failed init -> shell shows the error state)', async () => {
  const b = await base();
  const rt = createRuntime({ distDir: b.outDir });
  assert.equal(rt.app().initResult.ok, true);
  assert.equal(JSON.stringify(rt.app().init()), '{"ok":true,"again":true}', 'a second init() is a no-op');
  assert.deepEqual(Array.from(rt.ctx.__tlxLog), ['init:start', 'ws:open', 'config:fetch']);
  // failing init variant: host calls init({fail:true})
  const p = mk();
  edit(p, 'src/host/index.js', (s) => s.replace('const initResult = init();', 'const initResult = init({ fail: true });'));
  const o = out();
  await build({ projectRoot: p, outDir: o });
  const rt2 = createRuntime({ distDir: o }); // must not throw at boot
  assert.equal(rt2.app().initResult.ok, false);
  assert.deepEqual(Array.from(rt2.ctx.__tlxLog), ['init:start', 'init:error']);
  const states = [];
  const view = await rt2.app().open({}, (s) => states.push(s.state));
  assert.deepEqual(states, ['loading', 'error']);
  assert.match(view.text, /unavailable: init failed on purpose/);
  assert.deepEqual(rt2.loadCalls, [], 'the unit is not even loaded after a failed init');
});

test('a unit patch (UI string in @travelplex/ui) changes ONLY the travelplex unit artifact; host is byte-identical', async () => {
  const b = await base();
  const p = mk();
  edit(p, `${UI}/screens/Home.js`, (s) => s.replace("' home | session '", "' HOME v2 | session '"));
  const o = out();
  const r = await build({ projectRoot: p, outDir: o, base: b.outDir });
  assert.deepEqual(diffAgainstBase(b.outDir, o), { changedUnits: ['travelplex'], hostChanged: false, addedUnits: [], removedUnits: [] });
  assert.deepEqual(r.warnings, []);
  const rt = createRuntime({ distDir: b.outDir, patchDir: o });
  assert.match(await rt.openUnit('travelplex', {}), /HOME v2/);
  assert.deepEqual(Array.from(rt.ctx.__tlxLog), ['init:start', 'ws:open', 'config:fetch']);
});

test('negative: unit imports a name core does not export -> host-export-missing (BASE and PATCH mode)', async () => {
  const p = mk();
  edit(p, `${UI}/screens/Home.js`, (s) => s.replace('getUnreadCount }', 'getUnreadCount, notThere }'));
  const e1 = await expectRule('host-export-missing', p);
  assert.match(e1.message, /notThere/);
  assert.match(e1.message, /Home\.js:1/);
  const b = await base();
  await expectRule('host-export-missing', p, { base: b.outDir });
  // 'warn' downgrades, 'off' disables
  edit(p, 'units.config.json', (s) => s.replace('"checks": {', '"checks": { "hostExports": "warn",'));
  const r = await build({ projectRoot: p, outDir: out() });
  assert.ok(r.warnings.some((w) => w.rule === 'host-export-missing'));
});

test('negative: default import / namespace member access of a missing export is caught too', async () => {
  const p = mk();
  write(p, `${UI}/screens/Ns.js`, "import * as core from '@travelplex/core';\nimport core2 from '@travelplex/core';\nexport const x = [core.getConfig, core.missingFn, core2];\n");
  edit(p, `${UI}/entry.js`, (s) => "import './screens/Ns';\n" + s);
  const e = await expectRule('host-export-missing', p);
  assert.match(e.message, /missingFn/);
  assert.match(e.message, /\{ default \}/);
  assert.ok(!/getConfig \}/.test(e.message.split('\n').filter((l) => /Ns\.js/.test(l)).join('\n')), 'existing names are fine');
});

test('negative: unit deep-imports @travelplex/core/internal/secret -> public-deep-import', async () => {
  const p = mk();
  edit(p, `${UI}/screens/Home.js`, (s) => "import { SECRET } from '@travelplex/core/internal/secret';\n" + s + 'export const leak = SECRET;\n');
  const e = await expectRule('public-deep-import', p);
  assert.match(e.message, /internal\/secret/);
});

test('package.json "exports" opens exactly the listed files to units', async () => {
  const p = mk();
  edit(p, `${CORE}/package.json`, (s) => s.replace('"main": "index.js"', '"main": "index.js", "exports": { ".": "./index.js", "./shell": "./shell.js" }'));
  edit(p, `${UI}/screens/Home.js`, (s) => "import { travelplexUnit } from '@travelplex/core/shell';\n" + s + 'export const u = travelplexUnit;\n');
  // shell is exposed, so this passes the deep-import rule (note: unit -> host shell -> unit is the lazyUnit cycle)
  const r = await build({ projectRoot: p, outDir: out() });
  assert.equal(r.checks['public-deep-import'].count, 0);
  edit(p, `${UI}/screens/Home.js`, (s) => "import { SECRET } from '@travelplex/core/internal/secret';\nexport const s = SECRET;\n" + s);
  await expectRule('public-deep-import', p);
});

test('a public package must be host-owned: listing the unit package is a config error', async () => {
  const p = mk();
  edit(p, 'units.config.json', (s) => s.replace('"publicPackages": ["@travelplex/core"]', '"publicPackages": ["@travelplex/core", "@travelplex/ui"]'));
  const e = await expectRule('public-package-not-host', p);
  assert.match(e.message, /HOST-owned/);
});

test('public API snapshot: a removed export is public-api-breaking (BASE and PATCH mode)', async () => {
  const p = mk();
  edit(p, `${CORE}/index.js`, (s) => s.replace('getSession, getUnreadCount, markRead, onEvent', 'getSession, getUnreadCount, markRead'));
  edit(p, `${UI}/screens/Inbox.js`, (s) => s.replace(', onEvent', '').replace(/    onEvent\('unread', \(\) => \{\}\);\n/, '')); // unit no longer uses it
  const e = await expectRule('public-api-breaking', p);
  assert.match(e.message, /'onEvent'/);
  assert.ok(!e.violations.some((v) => v.rule === 'host-export-missing'));
  await expectRule('public-api-breaking', p, { base: (await base()).outDir });
});

test('public API snapshot: a renamed export is a removal (breaking) plus an addition', async () => {
  const p = mk();
  edit(p, `${CORE}/index.js`, (s) => s.replace('markRead,', 'markRead as markAllRead,'));
  const e = await expectRule('public-api-breaking', p);
  assert.match(e.message, /'markRead'/);
});

test('public API snapshot: an added export is a public-api-changed WARNING (error with checks.publicApiStrict)', async () => {
  const p = mk();
  edit(p, `${CORE}/index.js`, (s) => s + "export const newThing = 1;\n");
  const r = await build({ projectRoot: p, outDir: out() });
  const w = r.warnings.filter((x) => x.rule === 'public-api-changed');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /'newThing'/);
  assert.match(w[0].message, /api-snapshot --project <dir> --write/);
  assert.ok(r.unitsJson.publicApi['@travelplex/core'].exports.includes('newThing'));
  edit(p, 'units.config.json', (s) => s.replace('"checks": {', '"checks": { "publicApiStrict": true,'));
  await expectRule('public-api-changed', p);
});

test('public API snapshot: missing snapshot file is an error pointing at the CLI', async () => {
  const p = mk();
  fs.rmSync(path.join(p, 'api'), { recursive: true });
  const e = await expectRule('public-api-snapshot-missing', p);
  assert.match(e.message, /api-snapshot/);
});

test('negative: core statically importing the unit -> host-to-unit-static', async () => {
  const p = mk();
  edit(p, `${CORE}/index.js`, (s) => "import ui from '@travelplex/ui';\nexport const uiRef = ui;\n" + s);
  await expectRule('host-to-unit-static', p);
});

test('CJS-compiled core (Babel output: defineProperty getters + wildcard re-export) is analyzed correctly', async () => {
  const p = mk();
  write(p, `${CORE}/index.js`, `"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
var _exportNames = { init: true, getConfig: true, TravelplexEntry: true };
Object.defineProperty(exports, "init", { enumerable: true, get: function () { return _init.init; } });
Object.defineProperty(exports, "getConfig", { enumerable: true, get: function () { return _config.getConfig; } });
Object.defineProperty(exports, "TravelplexEntry", { enumerable: true, get: function () { return _shell.TravelplexEntry; } });
var _init = require("./init");
var _config = require("./config");
var _session = require("./session");
Object.keys(_session).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _session[key]) return;
  Object.defineProperty(exports, key, { enumerable: true, get: function () { return _session[key]; } });
});
var _shell = require("./shell");
`);
  const r = await build({ projectRoot: p, outDir: out() });
  const api = r.unitsJson.publicApi['@travelplex/core'];
  // the wildcard re-exports every export of session.js: session, emit (new) + getSession/getUnreadCount/markRead/onEvent (known)
  assert.deepEqual(api.exports, ['TravelplexEntry', 'emit', 'getConfig', 'getSession', 'getUnreadCount', 'init', 'markRead', 'onEvent', 'session']);
  const w = r.warnings.filter((x) => x.rule === 'public-api-changed');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /'emit', 'session'/);
  assert.ok(!r.warnings.some((x) => x.rule === 'host-export-unknown'));
  // still catches a missing name against the CJS entry
  edit(p, `${UI}/screens/Home.js`, (s) => s.replace('getUnreadCount }', 'getUnreadCount, nope }'));
  await expectRule('host-export-missing', p);
});

test('opaque core entry: host-export-unknown WARNING for the unit imports; with a snapshot it is an error explaining how to fix', async () => {
  const p = mk();
  write(p, `${CORE}/factory.js`, "const { init } = require('./init');\nmodule.exports = () => ({ init });\n");
  write(p, `${CORE}/index.js`, "require('./shell'); // keeps the lazyUnit boundary in the graph\nconst make = require('./factory');\nmodule.exports = make();\n");
  const e = await expectRule('public-api-opaque', p);
  assert.match(e.message, /statically analyzable/);
  assert.match(e.message, /exports\.x =/);
  assert.ok(!e.violations.some((v) => v.rule === 'host-export-missing'), 'unknown exports must not fail host-export-missing');
  // without a snapshot configured the opaque entry only warns (the build would not run, but the analysis is what we test)
  edit(p, 'units.config.json', (s) => s.replace(/,\s*"publicApiSnapshot": \{[^}]*\}/, ''));
  const r = await build({ projectRoot: p, outDir: out() });
  const unk = r.warnings.filter((x) => x.rule === 'host-export-unknown');
  assert.equal(unk.length, 1);
  assert.match(unk[0].message, new RegExp(`${CORE}/index\\.js`));
  assert.match(unk[0].message, /Home\.js:1/);
  assert.equal(r.checks['host-exports'].unknown, 1);
  assert.equal(r.checks['host-exports'].count, 0);
});

// ---- the analyzer on its own ----
function analyzerFor(files) {
  const dir = tmp('exp-');
  temps.push(dir);
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  const resolve = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(from), spec);
    for (const x of ['', '.js', '.json', '/index.js']) if (fs.existsSync(base + x) && fs.statSync(base + x).isFile()) return base + x;
    return null;
  };
  const a = createExportAnalyzer({ resolve });
  return (f) => { const r = a.analyze(path.join(dir, f)); return { names: [...r.names].sort(), hasDefault: r.hasDefault, esModule: r.esModule, opaque: r.opaque }; };
}

test('export analyzer: ESM forms, export * (cycle-safe), type-only exports ignored', () => {
  const an = analyzerFor({
    'a.js': "export const x = 1, { y, z: [w] } = o;\nexport function f() {}\nexport class C {}\nconst q = 1;\nexport { q as renamed, q };\nexport { d as dd } from './b';\nexport * from './b';\nexport * as ns from './b';\nexport default function () {}\nexport type T = number;\nexport type { U } from './b';\n",
    'b.js': "export const bb = 1;\nexport const d = 2;\nexport * from './c';\nexport default 1;\n",
    'c.js': "export * from './b';\nexport const cc = 1;\n",
    't.ts': "export interface I {}\nexport type X = 1;\nexport enum E { A }\nexport const v: number = 1;\nexport declare const nope: number;\n",
  });
  const a = an('a.js');
  assert.deepEqual(a.names, ['C', 'bb', 'cc', 'd', 'dd', 'f', 'ns', 'q', 'renamed', 'w', 'x', 'y']);
  assert.equal(a.hasDefault, true);
  assert.equal(a.opaque, null);
  assert.deepEqual(an('b.js').names, ['bb', 'cc', 'd'], 'export * cycle b -> c -> b terminates; default is not re-exported');
  assert.deepEqual(an('t.ts').names, ['E', 'v']);
  assert.equal(an('t.ts').hasDefault, false);
});

test('export analyzer: CJS forms (exports.x, chained void 0, module.exports literal with getters, alias, defineProperty, assign, tsc __exportStar)', () => {
  const an = analyzerFor({
    'cjs1.js': "Object.defineProperty(exports, '__esModule', { value: true });\nexports.a = exports.b = void 0;\nexports.default = function () {};\nexports['c'] = 1;\nmodule.exports.d = 2;\nObject.defineProperty(exports, 'e', { enumerable: true, get() { return 1; } });\nObject.defineProperties(exports, { f: { value: 1 } });\nexports.a = 1;\n",
    'cjs2.js': "const impl = { m: 1, n() {}, get o() { return 1; }, 'p-q': 2 };\nmodule.exports = impl;\n",
    'cjs3.js': "module.exports = { ...require('./cjs2'), z: 1 };\n",
    'cjs4.js': "if (process.env.NODE_ENV === 'production') { module.exports = require('./cjs2'); } else { module.exports = require('./missing-in-graph'); }\n",
    'cjs5.js': "Object.assign(exports, { k: 1 }, require('./cjs2'));\n",
    'cjs6.js': "Object.defineProperty(exports, '__esModule', { value: true });\ntslib_1.__exportStar(require('./cjs2'), exports);\nexports.own = void 0;\n",
    'data.json': '{"alpha":1,"beta":2}',
    'cjs7.js': "module.exports = require('./data.json');\n",
    'iife.js': "(function () { 'use strict'; exports.React = 1; exports.useState = function () {}; })();\n",
  });
  const c1 = an('cjs1.js');
  assert.deepEqual(c1.names, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(c1.esModule, true);
  assert.equal(c1.hasDefault, true);
  assert.deepEqual(an('cjs2.js').names, ['m', 'n', 'o', 'p-q']);
  assert.equal(an('cjs2.js').hasDefault, true, 'non-__esModule CJS: default import = module.exports');
  assert.equal(an('cjs2.js').esModule, false);
  assert.deepEqual(an('cjs3.js').names, ['m', 'n', 'o', 'p-q', 'z']);
  assert.deepEqual(an('cjs4.js').names, ['m', 'n', 'o', 'p-q'], 'a require that is not in the graph (dead branch) is ignored when another alias resolves');
  assert.equal(an('cjs4.js').opaque, null);
  assert.deepEqual(an('cjs5.js').names, ['k', 'm', 'n', 'o', 'p-q']);
  assert.deepEqual(an('cjs6.js').names, ['m', 'n', 'o', 'own', 'p-q']);
  assert.deepEqual(an('cjs7.js').names, ['alpha', 'beta']);
  assert.deepEqual(an('iife.js').names, ['React', 'useState']);
});

test('export analyzer: opaque cases', () => {
  const an = analyzerFor({
    'o1.js': "module.exports = factory();\n",
    'o2.js': "module.exports = function () {};\n",
    'o3.js': "const k = 'x';\nexports[k] = 1;\nexports.ok = 1;\n",
    'o4.js': "export * from './nowhere';\n",
    'o5.js': "module.exports = { ...other };\n",
    'o6.js': "module.exports = require('./o1');\n",
    'o7.js': "this is not javascript (((\n",
    'o8.js': "Object.defineProperty(exports, name, {});\n",
  });
  for (const f of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8']) assert.ok(an(f + '.js').opaque, f);
  assert.deepEqual(an('o3.js').names, ['ok'], 'partial knowledge is kept');
});
