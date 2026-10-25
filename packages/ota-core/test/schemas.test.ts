// Validates REAL generated artifacts (schemas/fixtures/*.json, produced by scripts/gen-schema-fixtures.mjs from the actual
// pipeline) against the hand-written JSON Schemas in schemas/, plus negative cases and type/schema drift checks.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv/dist/2020.js';
import {
  validateManifest, validateUnitsConfig, validatePin, verifyAuditChain, auditHash,
  type AuditRecord, type BaseInfo, type Entry, type MainBundle, type Manifest, type Pin, type SizeLimit, type UnitConfig,
  type UnitManifest, type UnitsConfig,
} from '../src/index.ts';
// @ts-ignore: plain-JS package without types, imported by relative path (no build step)
import { DEFAULT_CHECKS, parseChecks } from '../../unit-splitter/src/checks.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMAS = join(ROOT, 'schemas');
const FIXTURES = join(SCHEMAS, 'fixtures');
const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const fixture = (n: string): any => readJson(join(FIXTURES, n));
const clone = <T>(v: T): T => structuredClone(v);

// ajv ships CJS; under NodeNext the default import is the class at runtime but typed as the module.
const Ajv2020: new (o: object) => any = (AjvModule as any).default ?? (AjvModule as any);
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });

/** schema name -> fixture files that must validate against it */
const SCHEMA_FIXTURES: Record<string, string[]> = {
  manifest: ['manifest.json'],
  base: ['base.json'],
  audit: ['audit.json', 'audit.init.json'],
  pin: ['pin.json'],
  'ota-units-governance': ['ota-units-governance.json'],
  'units.config': ['units.config.json'],
  'units.output': ['units.output.json'],
  build: ['build.json', 'build.base.json'],
  'patch-report': ['patch-report.json'],
};
const schemaFiles = readdirSync(SCHEMAS).filter((f) => f.endsWith('.schema.json')).sort();
const schemaJson: Record<string, any> = {};
for (const f of schemaFiles) {
  const j = readJson(join(SCHEMAS, f));
  schemaJson[f.replace(/\.schema\.json$/, '')] = j;
  ajv.addSchema(j, j.$id);
}
const validator = (name: string) => ajv.getSchema(schemaJson[name].$id)!;
const errorsOf = (name: string, data: unknown): string => {
  const v = validator(name);
  return v(data) ? '' : (v.errors as any[]).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
};

describe('schemas: structure', () => {
  test('every expected schema file exists and nothing unexpected is there', () => {
    assert.deepEqual(Object.keys(schemaJson).sort(), Object.keys(SCHEMA_FIXTURES).sort());
  });

  for (const [name, s] of Object.entries(schemaJson)) {
    test(`${name}: draft 2020-12, $id, title, description; every property documented`, () => {
      assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.match(s.$id, new RegExp(`/${name.replace('.', '\\.')}\\.schema\\.json$`));
      assert.ok(s.title && s.description, 'title and description required');
      const missing: string[] = [];
      const resolve = (node: any): any => (node.$ref ? { ...resolveRef(s, node.$ref), ...node } : node);
      const walk = (node: any, path: string): void => {
        if (!node || typeof node !== 'object') return;
        for (const [k, p] of Object.entries<any>(node.properties ?? {})) {
          if (!resolve(p).description) missing.push(`${path}/${k}`);
          walk(resolve(p), `${path}/${k}`);
        }
        for (const key of ['items', 'additionalProperties']) if (typeof node[key] === 'object') walk(resolve(node[key]), `${path}/${key}`);
        for (const [k, d] of Object.entries<any>(node.$defs ?? {})) walk(d, `${path}/$defs/${k}`);
        for (const sub of node.allOf ?? []) walk(sub, path);
      };
      walk(s, '');
      assert.deepEqual(missing, [], `properties without description: ${missing.join(', ')}`);
    });
  }
});

function resolveRef(root: any, ref: string): any {
  assert.ok(ref.startsWith('#/'), `only local refs: ${ref}`);
  return ref.slice(2).split('/').reduce((n, k) => n[k], root);
}

describe('schemas: real artifacts validate', () => {
  for (const [name, files] of Object.entries(SCHEMA_FIXTURES)) {
    for (const f of files) {
      test(`${f} matches ${name}.schema.json`, () => assert.equal(errorsOf(name, fixture(f)), ''));
    }
  }

  test('fixtures also pass the runtime validators of the code that consumes them', () => {
    assert.deepEqual(validateManifest(fixture('manifest.json')), []);
    assert.deepEqual(validateUnitsConfig(fixture('ota-units-governance.json')), []);
    assert.deepEqual(validatePin(fixture('pin.json'), 'cabs', '11.9.0'), []);
    // splitter's own config parser accepts the fixture's `checks`; the init record starts the audit chain
    assert.doesNotThrow(() => parseChecks(fixture('units.config.json').checks));
    const [init, rollout] = [fixture('audit.init.json'), fixture('audit.json')];
    assert.equal(init.previousVersion, null);
    assert.equal(init.prevAuditHash, null);
    assert.equal(rollout.previousVersion, 2);
    assert.ok(verifyAuditChain([init]).length === 0 && typeof auditHash(init) === 'string');
  });

  test('other real inputs validate: conformance-vector manifest and the examples/*/units.config.json', () => {
    assert.equal(errorsOf('manifest', readJson(join(ROOT, 'packages/ota-core/vectors/select.json')).manifest), '');
    for (const ex of ['demo-app', 'spike-app', 'two-package-app']) {
      assert.equal(errorsOf('units.config', readJson(join(ROOT, 'examples', ex, 'units.config.json'))), '', ex);
    }
  });

  test('cross-artifact consistency a schema cannot express (documented gaps)', () => {
    const m = fixture('manifest.json');
    const base = fixture('base.json');
    const out = fixture('units.output.json');
    const build = fixture('build.json');
    const rep = fixture('patch-report.json');
    // unit names agree across the splitter output, build.json and base.json
    assert.deepEqual(Object.keys(out.units).sort(), Object.keys(build.units).sort());
    assert.deepEqual(Object.keys(base.units).sort(), Object.keys(build.units).sort());
    // manifest baseHash == embedded hash from base.json (android fixture)
    for (const u of m.units) assert.equal(u.baseHash, base.units[u.unitName][m.platform]);
    // delta record: the patch build is delta-compiled, the base build is not; both list exactly host + units
    assert.equal(build.delta.enabled, true);
    assert.equal(fixture('build.base.json').delta.enabled, false);
    assert.equal(rep.deltaMode, build.delta.enabled);
    for (const b of [build, fixture('build.base.json')]) {
      assert.deepEqual(Object.keys(b.delta.files).sort(), ['host.hbc', ...Object.values<any>(b.units).map((u) => u.file)].sort());
    }
    // patch-report is consistent with itself
    assert.equal(rep.hostChanged, rep.items.some((i: any) => i.unit === 'host'));
    assert.deepEqual(rep.changedUnits, rep.items.filter((i: any) => i.unit !== 'host').map((i: any) => i.unit));
  });
});

type Mut = [description: string, fixtureFile: string, mutate: (d: any) => void];
const NEGATIVE: Record<string, Mut[]> = {
  manifest: [
    ['missing required ttlSec', 'manifest.json', (d) => { delete d.ttlSec; }],
    ['missing mainBundle', 'manifest.json', (d) => { delete d.mainBundle; }],
    ['version is a string', 'manifest.json', (d) => { d.version = '2'; }],
    ['version 0', 'manifest.json', (d) => { d.version = 0; }],
    ['ttlSec above 86400', 'manifest.json', (d) => { d.ttlSec = 86401; }],
    ['schema 2', 'manifest.json', (d) => { d.schema = 2; }],
    ['unknown top-level property', 'manifest.json', (d) => { d.extra = 1; }],
    ['unknown entry property', 'manifest.json', (d) => { d.units[0].entries[0].extra = 1; }],
    ['bad platform enum', 'manifest.json', (d) => { d.platform = 'web'; }],
    ['bad updateType enum', 'manifest.json', (d) => { d.units[0].entries[0].updateType = 'diff'; }],
    ['unit baseHash without sha256: prefix', 'manifest.json', (d) => { d.units[0].baseHash = d.units[0].baseHash.slice(7); }],
    ['entry hash uppercase hex', 'manifest.json', (d) => { d.units[0].entries[0].hash = d.units[0].entries[0].hash.toUpperCase().replace('SHA256', 'sha256'); }],
    ['entry hash too short', 'manifest.json', (d) => { d.units[0].entries[0].hash = 'sha256:abc'; }],
    ['range with one element', 'manifest.json', (d) => { d.units[0].entries[0].range = [0.1]; }],
    ['range end above 1', 'manifest.json', (d) => { d.units[0].entries[0].range = [0, 1.5]; }],
    ['range with three elements', 'manifest.json', (d) => { d.units[0].entries[0].range = [0, 0.1, 0.2]; }],
    ['entry size 0', 'manifest.json', (d) => { d.units[0].entries[0].size = 0; }],
    ['entries not an array', 'manifest.json', (d) => { d.mainBundle.entries = {}; }],
  ],
  base: [
    ['missing sizes', 'base.json', (d) => { delete d.sizes; }],
    ['missing hbc.hermescSha256', 'base.json', (d) => { delete d.hbc.hermescSha256; }],
    ['unit missing ios hash', 'base.json', (d) => { delete d.units.cabs.ios; }],
    ['host hash malformed', 'base.json', (d) => { d.host.android = 'sha256:zz'; }],
    ['bytecodeVersion is a string', 'base.json', (d) => { d.hbc.bytecodeVersion = '96'; }],
    ['negative size', 'base.json', (d) => { d.sizes.host.ios = -1; }],
    ['retired is a string', 'base.json', (d) => { d.retired = 'yes'; }],
    ['unknown property', 'base.json', (d) => { d.extra = true; }],
  ],
  audit: [
    ['missing approver key', 'audit.json', (d) => { delete d.approver; }],
    ['bad command enum', 'audit.json', (d) => { d.command = 'nuke'; }],
    ['ts is not an ISO UTC timestamp', 'audit.json', (d) => { d.ts = 'yesterday'; }],
    ['prevAuditHash malformed', 'audit.json', (d) => { d.prevAuditHash = 'abc'; }],
    ['stateVersion 0', 'audit.json', (d) => { d.stateVersion = 0; }],
    ['pr is a string', 'audit.json', (d) => { d.pr = '42'; }],
    ['params is an array', 'audit.json', (d) => { d.params = []; }],
    ['breakGlass is a string', 'audit.json', (d) => { d.breakGlass = 'false'; }],
    ['unknown property', 'audit.json', (d) => { d.signature = 'x'; }],
    ['init record with empty requester', 'audit.init.json', (d) => { d.requester = ''; }],
  ],
  pin: [
    ['missing sha', 'pin.json', (d) => { delete d.sha; }],
    ['short sha', 'pin.json', (d) => { d.sha = 'bbbb'; }],
    ['uppercase sha', 'pin.json', (d) => { d.sha = 'B'.repeat(40); }],
    ['branch not ota/<unit>/<version>', 'pin.json', (d) => { d.branch = 'main'; }],
    ['unknown property', 'pin.json', (d) => { d.tag = 'v1'; }],
  ],
  'ota-units-governance': [
    ['missing superAdminTeam', 'ota-units-governance.json', (d) => { delete d.superAdminTeam; }],
    ['host unit not declared', 'ota-units-governance.json', (d) => { delete d.units.host; }],
    ['empty acceptableTicketStatuses', 'ota-units-governance.json', (d) => { d.acceptableTicketStatuses = []; }],
    ['lowercase Jira key', 'ota-units-governance.json', (d) => { d.units.cabs.jiraProjects = ['cab']; }],
    ['duplicate Jira key inside a unit', 'ota-units-governance.json', (d) => { d.units.cabs.jiraProjects = ['CAB', 'CAB']; }],
    ['empty jiraProjects', 'ota-units-governance.json', (d) => { d.units.bus.jiraProjects = []; }],
    ['uppercase unit name', 'ota-units-governance.json', (d) => { d.units.Cabs = d.units.cabs; }],
    ['ratio 0', 'ota-units-governance.json', (d) => { d.defaultSoftLimit = { ratio: 0 }; }],
    ['bytes is a string', 'ota-units-governance.json', (d) => { d.defaultHardLimit = { bytes: '5' }; }],
    ['enforceJira is a string', 'ota-units-governance.json', (d) => { d.enforceJira = 'no'; }],
    ['unknown unit property', 'ota-units-governance.json', (d) => { d.units.cabs.owner = 'x'; }],
  ],
  'units.config': [
    ['checks.cycles bad severity', 'units.config.json', (d) => { d.checks.cycles = 'fatal'; }],
    ['checks.dynamicRequire bad severity', 'units.config.json', (d) => { d.checks.dynamicRequire = true; }],
    ['unknown checks key', 'units.config.json', (d) => { d.checks.cycle = 'error'; }],
    ['publicApiStrict not boolean', 'units.config.json', (d) => { d.checks.publicApiStrict = 'yes'; }],
    ['requireRegisterComponent not boolean', 'units.config.json', (d) => { d.checks.requireRegisterComponent = 'true'; }],
    ['publicPackages not an array', 'units.config.json', (d) => { d.checks.publicPackages = '@a/b'; }],
    ['publicApiSnapshot value not a string', 'units.config.json', (d) => { d.checks.publicApiSnapshot = { '@a/b': 1 }; }],
    ['cycleBaseline is a number', 'units.config.json', (d) => { d.checks.cycleBaseline = 3; }],
    ['unit missing entry', 'units.config.json', (d) => { delete d.units[0].entry; }],
    ['unit with no roots', 'units.config.json', (d) => { d.units[0].roots = []; }],
    ['unit named host', 'units.config.json', (d) => { d.units[0].name = 'host'; }],
    ['unit name with uppercase', 'units.config.json', (d) => { d.units[0].name = 'Cabs'; }],
    ['unknown unit property', 'units.config.json', (d) => { d.units[0].lazy = true; }],
    ['unknown top-level property', 'units.config.json', (d) => { d.bundler = 'webpack'; }],
    ['missing units', 'units.config.json', (d) => { delete d.units; }],
  ],
  'units.output': [
    ['format 2', 'units.output.json', (d) => { d.format = 2; }],
    ['missing publicApi', 'units.output.json', (d) => { delete d.publicApi; }],
    ['platform enum', 'units.output.json', (d) => { d.platform = 'web'; }],
    ['host.file not host.js', 'units.output.json', (d) => { d.host.file = 'main.js'; }],
    ['moduleIds contain a string', 'units.output.json', (d) => { d.host.moduleIds.push('12'); }],
    ['unit file outside units/', 'units.output.json', (d) => { d.units.cabs.file = 'cabs.js'; }],
    ['unit missing entryPath', 'units.output.json', (d) => { delete d.units.cabs.entryPath; }],
    ['check summary with bad severity', 'units.output.json', (d) => { d.checks.cycles = { severity: 'fatal', count: 0 }; }],
    ['check summary without count', 'units.output.json', (d) => { d.checks.cycles = { severity: 'error' }; }],
    ['warning without rule', 'units.output.json', (d) => { d.warnings.push({ message: 'x' }); }],
    ['unknown property', 'units.output.json', (d) => { d.extra = 1; }],
  ],
  build: [
    ['schema 2', 'build.json', (d) => { d.schema = 2; }],
    ['missing toolchain.hbcVersion', 'build.json', (d) => { delete d.toolchain.hbcVersion; }],
    ['host hash without prefix', 'build.json', (d) => { d.host.hash = d.host.hash.slice(7); }],
    ['unit without entryModuleId', 'build.json', (d) => { delete d.units.cabs.entryModuleId; }],
    ['host with entryModuleId (unknown)', 'build.json', (d) => { d.host.entryModuleId = 1; }],
    ['appVersion is a number', 'build.json', (d) => { d.appVersion = 11; }],
    ['negative size', 'build.json', (d) => { d.host.size = -5; }],
    ['unitsMap.hash malformed', 'build.json', (d) => { d.unitsMap.hash = 'sha256:1'; }],
    ['platform enum', 'build.json', (d) => { d.platform = 'macos'; }],
    ['unknown property', 'build.json', (d) => { d.builtAt = 'now'; }],
    ['delta without enabled', 'build.json', (d) => { delete d.delta.enabled; }],
    ['delta.baseBuild malformed', 'build.json', (d) => { d.delta.baseBuild = 'abc'; }],
    ['delta file without js hash', 'build.json', (d) => { delete d.delta.files['host.hbc'].js; }],
    ['delta file baseHbc malformed', 'build.json', (d) => { d.delta.files['host.hbc'].baseHbc = 'sha256:1'; }],
    ['delta file unknown property', 'build.json', (d) => { d.delta.files['host.hbc'].extra = 1; }],
    ['delta enabled is a string', 'build.base.json', (d) => { d.delta.enabled = 'false'; }],
  ],
  'patch-report': [
    ['missing algo', 'patch-report.json', (d) => { delete d.algo; }],
    ['bad item updateType', 'patch-report.json', (d) => { d.items[0].updateType = 'diff'; }],
    ['item without builtHash', 'patch-report.json', (d) => { delete d.items[0].builtHash; }],
    ['hostChanged is a string', 'patch-report.json', (d) => { d.hostChanged = 'false'; }],
    ['tools hash malformed', 'patch-report.json', (d) => { d.tools.ota_apply = 'abc'; }],
    ['base hash without prefix', 'patch-report.json', (d) => { d.base = d.base.slice(7); }],
    ['changedUnits contains a number', 'patch-report.json', (d) => { d.changedUnits = [1]; }],
    ['unknown item property', 'patch-report.json', (d) => { d.items[0].extra = 1; }],
    ['missing deltaMode', 'patch-report.json', (d) => { delete d.deltaMode; }],
    ['deltaMode is a string', 'patch-report.json', (d) => { d.deltaMode = 'true'; }],
    ['plainEquivalentSize negative', 'patch-report.json', (d) => { d.items[0].plainEquivalentSize = -1; }],
    ['deltaOverPlain is a string', 'patch-report.json', (d) => { d.items[0].deltaOverPlain = '0.1'; }],
    ['schema 2', 'patch-report.json', (d) => { d.schema = 2; }],
  ],
};

describe('schemas: negative cases are rejected', () => {
  test('every schema has negative cases', () => assert.deepEqual(Object.keys(NEGATIVE).sort(), Object.keys(SCHEMA_FIXTURES).sort()));
  for (const [name, cases] of Object.entries(NEGATIVE)) {
    for (const [what, file, mutate] of cases) {
      test(`${name}: rejects ${what}`, () => {
        const d = clone(fixture(file));
        assert.equal(errorsOf(name, d), '', 'unmutated fixture must be valid');
        mutate(d);
        assert.notEqual(errorsOf(name, d), '', 'mutated document must be invalid');
      });
    }
  }
});

describe('schemas vs TypeScript types: no drift', () => {
  /** keys of `sample` must equal the schema's `properties`; required must equal keys minus the declared optional ones */
  function sameKeys(sample: object, node: any, optional: string[], label: string): void {
    const props = Object.keys(node.properties ?? {}).filter((k) => k !== '$schema').sort();
    const keys = Object.keys(sample).sort();
    assert.deepEqual(props, keys, `${label}: schema properties differ from the TypeScript type's keys`);
    assert.deepEqual([...(node.required ?? [])].sort(), keys.filter((k) => !optional.includes(k)), `${label}: schema required differs from the TypeScript type's required keys`);
  }
  const at = (name: string, ...path: string[]): any => {
    let n = schemaJson[name];
    const r = (x: any) => (x.$ref ? resolveRef(schemaJson[name], x.$ref) : x);
    n = r(n);
    for (const p of path) n = r(p === '[]' ? n.items : p === '{}' ? n.additionalProperties : n.properties[p]);
    return n;
  };
  // Typed samples: `satisfies Required<T>` makes tsc fail when a key is added to / removed from the interface without updating here.
  const h = 'sha256:' + '0'.repeat(64);
  const entry = { id: 'cabs-pr1', patchUrl: 'u', hash: h, size: 1, updateType: 'patch', range: [0, 1], requiresHost: null } satisfies Required<Entry> as Required<Entry>;
  const mainBundle = { baseHash: h, entries: [] } satisfies Required<MainBundle>;
  const unitManifest = { unitName: 'cabs', baseHash: h, entries: [] } satisfies Required<UnitManifest>;
  const manifest = { schema: 1, platform: 'android', appVersion: '1.0.0', patchAlgoVer: 'v1', version: 1, ttlSec: 1, mainBundle, units: [] } satisfies Required<Manifest>;
  const per = { android: h, ios: h };
  const base = {
    appVersion: 'a', releaseTag: 't', toolchainImage: 'i', patchAlgoVer: 'v1', hbc: { bytecodeVersion: 96, hermescSha256: h },
    host: per, units: {}, sizes: { host: { android: 1, ios: 1 }, units: {} }, retired: false,
  } satisfies Required<BaseInfo>;
  const audit = {
    stateVersion: 1, previousVersion: null, prevAuditHash: null, command: 'init', unit: null, patchId: null, params: {}, requester: 'r',
    approver: null, breakGlass: false, ticket: null, pr: null, sourceSha: null, jobUrl: null, ts: 't',
  } satisfies Required<AuditRecord>;
  const sizeLimit = { bytes: 1, ratio: 1 } satisfies Required<SizeLimit>;
  const unitConfig = { ownerTeam: 't', jiraProjects: ['A'], softLimit: sizeLimit, hardLimit: sizeLimit } satisfies Required<UnitConfig>;
  const units = {
    superAdminTeam: 't', enforceJira: true, acceptableTicketStatuses: [], defaultSoftLimit: sizeLimit, defaultHardLimit: sizeLimit, units: { host: unitConfig },
  } satisfies Required<UnitsConfig>;
  const pin = { branch: 'b', sha: 's' } satisfies Required<Pin>;

  test('manifest.schema.json == Manifest / MainBundle / UnitManifest / Entry', () => {
    sameKeys(manifest, at('manifest'), [], 'Manifest');
    sameKeys(mainBundle, at('manifest', 'mainBundle'), [], 'MainBundle');
    sameKeys(unitManifest, at('manifest', 'units', '[]'), [], 'UnitManifest');
    sameKeys(entry, at('manifest', 'mainBundle', 'entries', '[]'), ['range', 'requiresHost'], 'Entry');
  });
  test('base.schema.json == BaseInfo', () => {
    sameKeys(base, at('base'), ['retired'], 'BaseInfo');
    sameKeys(base.hbc, at('base', 'hbc'), [], 'BaseInfo.hbc');
    sameKeys(base.sizes, at('base', 'sizes'), [], 'BaseInfo.sizes');
  });
  test('audit.schema.json == AuditRecord', () => sameKeys(audit, at('audit'), ['breakGlass'], 'AuditRecord'));
  test('ota-units-governance.schema.json == UnitsConfig / UnitConfig / SizeLimit', () => {
    sameKeys(units, at('ota-units-governance'), ['enforceJira'], 'UnitsConfig');
    sameKeys(unitConfig, at('ota-units-governance', 'units', '{}'), ['softLimit', 'hardLimit'], 'UnitConfig');
    assert.deepEqual(Object.keys(at('ota-units-governance', 'defaultSoftLimit').properties).sort(), Object.keys(sizeLimit).sort());
  });
  test('pin.schema.json == Pin', () => sameKeys(pin, at('pin'), [], 'Pin'));

  test('enums match the code: platforms, update types, commands', () => {
    assert.deepEqual(at('manifest', 'platform').enum, ['android', 'ios']);
    assert.deepEqual(at('manifest', 'mainBundle', 'entries', '[]', 'updateType').enum, ['patch', 'full']);
    assert.deepEqual(at('audit', 'command').enum, ['init', 'deploy', 'rollout', 'halt', 'restore']);
  });

  test('units.config checks keys, severities and defaults match unit-splitter DEFAULT_CHECKS', () => {
    const checks = schemaJson['units.config'].$defs.checks;
    assert.deepEqual(Object.keys(checks.properties).sort(), Object.keys(DEFAULT_CHECKS).sort());
    for (const [k, v] of Object.entries<any>(DEFAULT_CHECKS)) assert.deepEqual(checks.properties[k].default, v, `default of checks.${k}`);
    assert.deepEqual(schemaJson['units.config'].$defs.severity.enum.sort(), ['error', 'off', 'warn']);
  });

  test('build / patch-report / units.output / base / audit / manifest: schema properties == keys of the real generated artifact', () => {
    const top = (name: string, f: string, optional: string[] = []) => {
      const s = at(name);
      const d = fixture(f);
      assert.deepEqual(Object.keys(s.properties).filter((k) => !optional.includes(k) || k in d).sort(), Object.keys(d).sort(), `${name}: top-level keys`);
      assert.deepEqual([...s.required].sort(), Object.keys(d).filter((k) => !optional.includes(k)).sort(), `${name}: required`);
    };
    top('build', 'build.json', ['delta']);
    top('patch-report', 'patch-report.json');
    top('units.output', 'units.output.json');
    top('manifest', 'manifest.json');
    top('base', 'base.json', ['retired']);
    top('audit', 'audit.json', ['breakGlass']);
    const rep = fixture('patch-report.json');
    assert.deepEqual(Object.keys(at('patch-report', 'items', '[]').properties).sort(), Object.keys(rep.items[0]).sort());
    assert.deepEqual(Object.keys(at('patch-report', 'algo').properties).sort(), Object.keys(rep.algo).sort());
    assert.deepEqual(Object.keys(at('build', 'delta').properties).sort(), Object.keys(fixture('build.json').delta).sort());
    assert.deepEqual([...at('build', 'delta').required].sort(), Object.keys(fixture('build.json').delta).sort());
    assert.deepEqual(Object.keys(at('build', 'delta', 'files').additionalProperties.properties).sort(), Object.keys(fixture('build.json').delta.files['host.hbc']).sort());
    assert.deepEqual(Object.keys(at('build', 'toolchain').properties).sort(), Object.keys(fixture('build.json').toolchain).sort());
  });
});
