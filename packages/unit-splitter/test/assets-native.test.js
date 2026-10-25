// Tier 1 asset rule (asset-not-in-base, asset-path-changed) and native-module scan (native-module-new, native-method-new,
// native-module-dynamic), base and patch mode. Negative fixtures are copies of examples/demo-app (+ the real RN graph in spike-app).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { build } from '../src/build.js';
import { parseChecks, DEFAULT_CHECKS } from '../src/checks.js';
import { scanNativeRefs } from '../src/native-refs.js';
import { androidResourceOf, iosPathOf, parseRegisteredAsset } from '../src/assets.js';
import { copyProject, edit, write, tmp } from './helpers.js';

const temps = [];
const mk = () => { const p = copyProject(); temps.push(p); prep(p); return p; };
const out = () => { const o = tmp('an-'); temps.push(o); return o; };
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

// valid 1x1 RGB PNG whose colour (hence bytes + sha256) depends on `n` (Metro reads the image size)
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
};
const PNG = (n) => {
  const h = createHash('sha256').update(String(n)).digest();
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, h[0], h[1], h[2]]))), chunk('IEND', Buffer.alloc(0))]);
};
const setChecks = (p, checks) => edit(p, 'units.config.json', (s) => JSON.stringify({ ...JSON.parse(s), checks }, null, 2));
const writeBin = (root, rel, buf) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), buf); };

/** the BASE project: bus owns an image (1x + @2x); the host references a native module + view + turbo module */
function prep(p) {
  // demo-app has no react-native: give Metro's default assetRegistryPath something to resolve
  write(p, 'node_modules/react-native/package.json', '{"name":"react-native","version":"0.0.0-stub","main":"index.js"}');
  write(p, 'node_modules/react-native/index.js', 'module.exports = {};\n');
  write(p, 'node_modules/react-native/Libraries/Image/AssetRegistry.js', 'module.exports = { registerAsset: (a) => a };\n');
  writeBin(p, 'src/units/bus/assets/icon.png', PNG(1));
  writeBin(p, 'src/units/bus/assets/icon@2x.png', PNG(2));
  edit(p, 'src/units/bus/seats.js', (s) => "export const icon = require('./assets/icon.png');\n" + s);
  write(p, 'src/host/rn-stub.js', 'export const NativeModules = {};\nexport const TurboModuleRegistry = { get: () => null, getEnforcing: () => null };\nexport const requireNativeComponent = () => null;\n');
  write(p, 'src/host/native.js', [
    "import { NativeModules, TurboModuleRegistry, requireNativeComponent } from './rn-stub';",
    'export const a = NativeModules.Existing.start();',
    'export const b = TurboModuleRegistry.getEnforcing("ExistingTurbo");',
    'export const c = requireNativeComponent("ExistingView");',
    '',
  ].join('\n'));
  edit(p, 'src/host/index.js', (s) => "import './native';\n" + s);
}
let baseCache;
async function base() {
  if (!baseCache) { const p = mk(); baseCache = { dir: out(), r: null }; baseCache.r = await build({ projectRoot: p, outDir: baseCache.dir }); }
  return baseCache;
}
async function patch(p, opts = {}) {
  return build({ projectRoot: p, outDir: out(), base: (await base()).dir, ...opts });
}
async function failing(p, opts = {}) {
  try { await patch(p, opts); } catch (e) { return e; }
  assert.fail('build unexpectedly passed');
}
const rules = (e) => e.violations.map((v) => v.rule);

// ------------------------------------------------------------------------------------------------ parseChecks
test('checks.assets / checks.nativeModules: defaults are error, bad values are config errors', () => {
  assert.equal(DEFAULT_CHECKS.assets, 'error');
  assert.equal(DEFAULT_CHECKS.nativeModules, 'error');
  assert.equal(parseChecks({ assets: 'warn', nativeModules: 'off' }).nativeModules, 'off');
  assert.throws(() => parseChecks({ assets: 'nope' }), /checks\.assets must be one of/);
  assert.throws(() => parseChecks({ nativeModules: true }), /checks\.nativeModules must be one of/);
});

// ------------------------------------------------------------------------------------------------ assets
test('assets (base build): units.json records path, sha256, registered location/name, native names and every scale variant', async () => {
  const { r } = await base();
  const [a] = r.unitsJson.units.bus.assets;
  assert.equal(a.path, 'src/units/bus/assets/icon.png');
  assert.equal(a.name, 'icon');
  assert.equal(a.type, 'png');
  assert.equal(a.httpServerLocation, '/assets/src/units/bus/assets');
  assert.deepEqual(a.scales, [1, 2]);
  assert.deepEqual(a.variants.map((v) => [v.scale, v.path]), [[1, 'src/units/bus/assets/icon.png'], [2, 'src/units/bus/assets/icon@2x.png']]);
  assert.equal(a.androidResource, 'src_units_bus_assets_icon');
  assert.equal(a.iosPath, 'assets/src/units/bus/assets/icon.png');
  assert.equal(r.checks.assets.count, 0);
  assert.equal(r.checks.assets.total, 1);
});

test('assets (patch): a unit change that does not touch the asset passes; removing an asset passes; a base build is never checked', async () => {
  const p = mk();
  edit(p, 'src/units/bus/seats.js', (s) => s + '\nexport const touched = 1;\n');
  const r = await patch(p);
  assert.equal(r.checks.assets.count, 0);
  assert.deepEqual(r.warnings.filter((x) => x.rule.startsWith('asset')), []);
  const q = mk();
  fs.rmSync(path.join(q, 'src/units/bus/assets'), { recursive: true });
  edit(q, 'src/units/bus/seats.js', (s) => s.replace("export const icon = require('./assets/icon.png');\n", ''));
  await patch(q);
  // base mode: a new asset is fine
  const b = mk();
  writeBin(b, 'src/units/bus/assets/brand-new.png', PNG(9));
  edit(b, 'src/units/bus/seats.js', (s) => s + "\nexport const n = require('./assets/brand-new.png');\n");
  const r2 = await build({ projectRoot: b, outDir: out() });
  assert.equal(r2.unitsJson.units.bus.assets.length, 2);
});

test('asset-not-in-base: a NEW image in a unit fails and names the unit and path', async () => {
  const p = mk();
  writeBin(p, 'src/units/bus/assets/brand-new.png', PNG(9));
  edit(p, 'src/units/bus/seats.js', (s) => s + "\nexport const n = require('./assets/brand-new.png');\n");
  const e = await failing(p);
  assert.deepEqual(rules(e), ['asset-not-in-base']);
  assert.match(e.violations[0].message, /unit bus: asset src\/units\/bus\/assets\/brand-new\.png is new/);
});

test('asset-not-in-base: an EDITED image fails ("changed"); so does an added / edited @2x variant', async () => {
  const p = mk();
  writeBin(p, 'src/units/bus/assets/icon.png', PNG('edited'));
  const e = await failing(p);
  assert.deepEqual(rules(e), ['asset-not-in-base']);
  assert.match(e.violations[0].message, /asset src\/units\/bus\/assets\/icon\.png is changed: sha256/);
  const q = mk();
  writeBin(q, 'src/units/bus/assets/icon@2x.png', PNG('edited2x'));
  const e2 = await failing(q);
  assert.match(e2.violations[0].message, /icon\.png is changed: scale variants differ|icon\.png is changed: sha256/);
  const z = mk();
  writeBin(z, 'src/units/bus/assets/icon@3x.png', PNG(3));
  const e3 = await failing(z);
  assert.match(e3.violations[0].message, /scale variants differ/);
});

test('asset-path-changed: the same bytes at another path (Android drawable name derives from the path) fails', async () => {
  const p = mk();
  fs.mkdirSync(path.join(p, 'src/units/bus/img'));
  fs.renameSync(path.join(p, 'src/units/bus/assets/icon.png'), path.join(p, 'src/units/bus/img/icon.png'));
  fs.renameSync(path.join(p, 'src/units/bus/assets/icon@2x.png'), path.join(p, 'src/units/bus/img/icon@2x.png'));
  edit(p, 'src/units/bus/seats.js', (s) => s.replace('./assets/icon.png', './img/icon.png'));
  const e = await failing(p);
  assert.deepEqual(rules(e), ['asset-path-changed']);
  assert.match(e.violations[0].message, /src\/units\/bus\/img\/icon\.png has the same bytes as base asset src\/units\/bus\/assets\/icon\.png/);
  assert.match(e.violations[0].message, /src_units_bus_assets_icon .* src_units_bus_img_icon/);
});

test('checks.assets: warn reports as warnings, off skips', async () => {
  const p = mk();
  writeBin(p, 'src/units/bus/assets/icon.png', PNG('edited'));
  setChecks(p, { assets: 'warn' });
  const r = await patch(p);
  assert.ok(r.warnings.some((w) => w.rule === 'asset-not-in-base'));
  assert.equal(r.checks.assets.severity, 'warn');
  setChecks(p, { assets: 'off' });
  const r2 = await patch(p);
  assert.ok(!r2.warnings.some((w) => w.rule.startsWith('asset')));
});

test('assets: native names mirror the RN bundling step', () => {
  const reg = { httpServerLocation: '/assets/src/My Dir/img', name: 'Bus-Icon_2', type: 'png' };
  assert.equal(androidResourceOf(reg), 'src_mydir_img_busicon_2');
  assert.equal(iosPathOf(reg), 'assets/src/My Dir/img/Bus-Icon_2.png');
  assert.equal(parseRegisteredAsset('x.registerAsset({\n "name": "a",\n "scales": [1,2]\n });').scales.length, 2);
  assert.equal(parseRegisteredAsset('nothing'), null);
});

// ------------------------------------------------------------------------------------------------ native scan (unit level)
const scan = (code) => scanNativeRefs(code, 'x.js');
const names = (r) => r.refs.map((x) => `${x.kind}:${x.name}`).sort();

test('native scan: every reference form', () => {
  const r = scan(`// @flow
    import {NativeModules, TurboModuleRegistry, requireNativeComponent, UIManager, NativeEventEmitter} from 'react-native';
    import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';
    const a = NativeModules.A; a.run(); a.stop();
    const b = NativeModules['B'].go();
    const {C, D: renamed} = NativeModules; C.one(); renamed.two();
    const t1 = TurboModuleRegistry.get('T1'); const t2 = TurboModuleRegistry.getEnforcing<Spec>('T2').direct();
    const V1 = requireNativeComponent('V1'); const V2 = codegenNativeComponent<Props>('V2');
    const cfg = UIManager.getViewManagerConfig('V3');
    const em = new NativeEventEmitter(NativeModules.E);
    export const x = RN.NativeModules.F.m;
  `);
  assert.deepEqual(names(r), ['module:A', 'module:B', 'module:C', 'module:D', 'module:E', 'module:F', 'turbo:T1', 'turbo:T2', 'view:V1', 'view:V2', 'view:V3']);
  const m = (n) => r.refs.find((x) => x.name === n).methods;
  assert.deepEqual(m('A'), ['run', 'stop']);
  assert.deepEqual(m('B'), ['go']);
  assert.deepEqual(m('C'), ['one']);
  assert.deepEqual(m('D'), ['two']);
  assert.deepEqual(m('T2'), ['direct']);
  assert.deepEqual(m('F'), ['m']);
  assert.deepEqual(r.dynamic, []);
});

test('native scan: non-literal names are dynamic; unrelated code and files without markers are ignored; TypeScript parses', () => {
  const r = scan(`const n = f(); NativeModules[n]; TurboModuleRegistry.get(n); requireNativeComponent(n); const {[k]: z} = NativeModules;`);
  assert.deepEqual(r.refs, []);
  assert.deepEqual(r.dynamic.map((d) => d.kind), ['module', 'turbo', 'view', 'module']);
  assert.deepEqual(scan('export const x = 1;'), { refs: [], dynamic: [] });
  assert.deepEqual(names(scanNativeRefs('const m = NativeModules.Q as any; export default m!;', 'x.ts')), ['module:Q']);
  assert.equal(scanNativeRefs('NativeModules.X = (((;', 'x.js'), null);
});

// ------------------------------------------------------------------------------------------------ native scan (builds)
test('nativeRefs (base build): host + unit references recorded with owners, kinds, methods', async () => {
  const { r } = await base();
  assert.deepEqual(r.unitsJson.nativeRefs.Existing, { owners: ['host'], methods: ['start'], kinds: ['module'] });
  assert.deepEqual(r.unitsJson.nativeRefs.ExistingTurbo.kinds, ['turbo']);
  assert.deepEqual(r.unitsJson.nativeRefs.ExistingView.kinds, ['view']);
  assert.equal(r.checks['native-modules'].modules, 3);
});

test('native (patch): unit code changes without new native references pass with no warnings', async () => {
  const p = mk();
  edit(p, 'src/units/cabs/fare.js', (s) => s + '\nexport const bump = 1;\n');
  const r = await patch(p);
  assert.equal(r.checks['native-modules'].count, 0);
  assert.deepEqual(r.warnings, []);
});

test('native (patch): a unit may use a native module/view the base JS already references (incl. known methods)', async () => {
  const p = mk();
  write(p, 'src/units/cabs/native-ok.js', "import {NativeModules, requireNativeComponent} from '../../host/rn-stub';\nexport const s = NativeModules.Existing.start;\nexport const V = requireNativeComponent('ExistingView');\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import './native-ok';\n" + s);
  const r = await patch(p);
  assert.deepEqual(r.warnings, []);
});

test('native-module-new: a unit referencing a native module / turbo module / view the base never references fails', async () => {
  const p = mk();
  write(p, 'src/units/cabs/native-new.js', [
    "import {NativeModules, TurboModuleRegistry, requireNativeComponent} from '../../host/rn-stub';",
    'export const a = NativeModules.BrandNewThing.go();',
    "export const b = TurboModuleRegistry.get('NewTurbo');",
    "export const c = requireNativeComponent('NewView');",
    '',
  ].join('\n'));
  edit(p, 'src/units/cabs/fare.js', (s) => "import './native-new';\n" + s);
  const e = await failing(p);
  assert.deepEqual(rules(e), ['native-module-new', 'native-module-new', 'native-module-new']);
  assert.match(e.message, /unit cabs references native module "BrandNewThing" \(src\/units\/cabs\/native-new\.js\)/);
  assert.match(e.message, /native turbo "NewTurbo"/);
  assert.match(e.message, /native view "NewView"/);
});

test('native-module-new: the same reference in a HOST file is not checked in a patch build; in a base build nothing is checked', async () => {
  const p = mk();
  edit(p, 'src/host/native.js', (s) => s + "export const h = NativeModules.HostOnlyNew.x;\n");
  const r = await patch(p);
  assert.equal(r.checks['native-modules'].count, 0);
  assert.ok(r.unitsJson.nativeRefs.HostOnlyNew);
  const q = mk();
  write(q, 'src/units/cabs/n.js', "import {NativeModules} from '../../host/rn-stub';\nexport const a = NativeModules.BrandNewThing;\n");
  edit(q, 'src/units/cabs/fare.js', (s) => "import './n';\n" + s);
  const rb = await build({ projectRoot: q, outDir: out() });
  assert.deepEqual(rb.unitsJson.nativeRefs.BrandNewThing.owners, ['cabs']);
});

test('checks.nativeModules: warn turns native-module-new into a warning, off skips the check', async () => {
  const p = mk();
  write(p, 'src/units/cabs/n.js', "import {NativeModules} from '../../host/rn-stub';\nexport const a = NativeModules.BrandNewThing;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import './n';\n" + s);
  setChecks(p, { nativeModules: 'warn' });
  const r = await patch(p);
  assert.ok(r.warnings.some((w) => w.rule === 'native-module-new'));
  setChecks(p, { nativeModules: 'off' });
  const r2 = await patch(p);
  assert.deepEqual(r2.warnings, []);
});

test('native-method-new: a direct method access the base never made is a warning, never an error', async () => {
  const p = mk();
  write(p, 'src/units/cabs/m.js', "import {NativeModules} from '../../host/rn-stub';\nconst {Existing} = NativeModules;\nexport const a = NativeModules.Existing.start; export const b = Existing.brandNewMethod;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import './m';\n" + s);
  const r = await patch(p);
  const w = r.warnings.filter((x) => x.rule === 'native-method-new');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /unit cabs calls Existing\.brandNewMethod/);
  assert.ok(!w[0].message.includes('Existing.start'));
});

test('native-module-dynamic: a non-literal native module name in a unit is a warning', async () => {
  const p = mk();
  write(p, 'src/units/cabs/d.js', "import {TurboModuleRegistry} from '../../host/rn-stub';\nconst name = String(Math.random());\nexport const t = TurboModuleRegistry.get(name);\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import './d';\n" + s);
  const r = await patch(p);
  const w = r.warnings.filter((x) => x.rule === 'native-module-dynamic');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /unit cabs: src\/units\/cabs\/d\.js:3 looks up a native turbo with a non-literal name/);
});

test('native-refs-base-missing: a base without nativeRefs only warns once and skips the checks', async () => {
  const b = await base();
  const old = out();
  fs.cpSync(b.dir, old, { recursive: true });
  const uj = JSON.parse(fs.readFileSync(path.join(old, 'units.json'), 'utf8'));
  delete uj.nativeRefs;
  fs.writeFileSync(path.join(old, 'units.json'), JSON.stringify(uj));
  const p = mk();
  write(p, 'src/units/cabs/n.js', "import {NativeModules} from '../../host/rn-stub';\nexport const a = NativeModules.BrandNewThing;\n");
  edit(p, 'src/units/cabs/fare.js', (s) => "import './n';\n" + s);
  const r = await build({ projectRoot: p, outDir: out(), base: old });
  assert.deepEqual(r.warnings.map((w) => w.rule), ['native-refs-base-missing']);
});

