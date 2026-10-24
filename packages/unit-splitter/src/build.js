// Orchestrates: load config -> one Metro run -> verify -> split -> write dist/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadUnitsConfig, readUnitsConfig, packageRootDirs, resolveMetroConfigFile } from './config.js';
import { parseChecks } from './checks.js';
import { ctx, resetCtx } from './with-ota-units.js';
import { runMetro } from './metro-run.js';
import { makeSplitSerializer, splitSerializedBundle } from './split.js';
import { packageOf, VerificationError } from './analyze.js';
import { pathKey } from './ids.js';
import { initMetro } from './metro-compat.js';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Load a previous build's dist/ as the "base" for patch builds (rules 3/4). */
export function loadBase(baseDir) {
  const u = JSON.parse(fs.readFileSync(path.join(baseDir, 'units.json'), 'utf8'));
  const ids = JSON.parse(fs.readFileSync(path.join(baseDir, 'ids.json'), 'utf8'));
  return { ...u, host: { ...u.host, moduleKeys: u.host.moduleIds.map((id) => ids[id]) } };
}

/**
 * @param approach 'serializer' (a, default) | 'postprocess' (c)
 * @param base     dist dir of the base build => patch mode (package@version + presence checks)
 * @returns { outDir, files: {relpath: sha256}, unitsJson }
 * Throws VerificationError on direction-rule violations.
 */
export async function build({ projectRoot, outDir, approach = 'serializer', base = null, bits = 48, minify = false, platform = 'ios', entry = undefined, transformProfile = null, forceChecks = null }) {
  projectRoot = fs.realpathSync(projectRoot);
  initMetro(projectRoot); // fail fast (clear message) on an unsupported Metro, before any analysis
  const units = loadUnitsConfig(projectRoot);
  const baseInfo = base ? loadBase(base) : null;
  const cfg = readUnitsConfig(projectRoot);
  const checks = parseChecks({ ...(cfg.checks ?? {}), ...(forceChecks ?? {}) });
  const extraWatchFolders = packageRootDirs(units);
  // The app's own metro.config.js (which calls withOtaUnits) is used when units.config.json names it ("metroConfig": "<file>") OR,
  // by default, when <project>/metro.config.js exists (auto-detect; "metroConfig": false opts out). Otherwise the splitter assembles
  // the Metro config itself (demo-app path).
  const { file: projectConfig } = resolveMetroConfigFile(projectRoot, cfg);
  let sink = {};
  let ids;
  if (projectConfig) {
    resetCtx({ enabled: true, sink, base: baseInfo, approach, bits, checks });
    try {
      ({ ids } = await runMetroTranslated({ projectRoot, platform, entry: entry ?? cfg.entry ?? 'src/host/index.js', bits, minify, projectConfig, transformProfile, extraWatchFolders }));
    } finally {
      resetCtx();
    }
  } else {
    ({ ids } = await runMetroTranslated({
      projectRoot,
      platform,
      extraWatchFolders,
      entry: entry ?? cfg.entry ?? 'src/host/index.js',
      bits,
      minify,
      transformProfile,
      customSerializer: makeSplitSerializer({ projectRoot, units, base: baseInfo, sink, approach, checks }),
    }));
  }
  const { owner, graph, preModules, warnings = [], cycles = {}, checks: checksSummary = {}, publicApi = {} } = sink.analysis;
  const keyOf = (p) => pathKey(p, projectRoot);

  // id -> owner, id -> path
  const idsJson = {};
  const ownerById = new Map();
  const pkgsByOwner = new Map();
  for (const p of [...graph.dependencies.keys(), ...preModules.map((m) => m.path)]) {
    const id = ids.createModuleId(p);
    idsJson[id] = keyOf(p);
    const o = owner.get(p);
    ownerById.set(id, o);
    const pkg = packageOf(p);
    if (pkg) {
      if (!pkgsByOwner.has(o)) pkgsByOwner.set(o, {});
      pkgsByOwner.get(o)[pkg.name] = pkg.version;
    }
  }

  // Asset modules (images) are ordinary modules in the graph, owned by path like any other. The asset FILES are not in any
  // bundle: they must exist in the binary (android res/drawable-*, ios bundle). Listed here so a build can see which ones a unit needs.
  const assetsByOwner = new Map();
  for (const [p, m] of graph.dependencies) {
    if (!m.output.some((o) => o.type === 'js/module/asset')) continue;
    const o = owner.get(p);
    if (!assetsByOwner.has(o)) assetsByOwner.set(o, []);
    assetsByOwner.get(o).push({ path: keyOf(p), sha256: sha256(fs.readFileSync(p)) });
  }
  const assetsOf = (name) => (assetsByOwner.get(name) ?? []).sort((a, b) => (a.path < b.path ? -1 : 1));

  const entryIdToUnit = new Map(units.map((u) => [ids.createModuleId(u.entry), u.name]));
  let result;
  if (approach === 'serializer') result = sink.result;
  else if (approach === 'postprocess') {
    result = splitSerializedBundle(sink.stock, { ownerById: (id) => ownerById.get(id), entryIdToUnit, unitNames: units.map((u) => u.name) });
  } else throw new Error('unknown approach ' + approach);

  const sortedIds = (name) => [...ownerById].filter(([, o]) => o === name).map(([id]) => id).sort((a, b) => a - b);
  const sortObj = (o) => Object.fromEntries(Object.entries(o ?? {}).sort());
  const sortedWarnings = [...warnings].sort((a, b) => (a.rule + a.message < b.rule + b.message ? -1 : 1));
  const unitsJson = {
    format: 1,
    platform,
    idBits: bits,
    host: { file: 'host.js', moduleIds: sortedIds('host'), packages: sortObj(pkgsByOwner.get('host')), assets: assetsOf('host') },
    // `paths[entryId] === unitName` is what the host's compiled import() passes to asyncRequire.
    paths: Object.fromEntries([...entryIdToUnit].sort((a, b) => a[0] - b[0]).map(([id, n]) => [id, n])),
    units: Object.fromEntries(units.map((u) => [u.name, {
      file: `units/${u.name}.js`,
      entryId: ids.createModuleId(u.entry),
      entryPath: keyOf(u.entry),
      moduleIds: sortedIds(u.name),
      // new pure-JS packages bundled into the unit (patch mode only) + packages seen in it
      packages: sortObj(pkgsByOwner.get(u.name)),
      assets: assetsOf(u.name),
    }])),
    // cycles per owner (first-party host + each unit): the "base" a later patch build is compared against (checks.cycles ratchet)
    cycles: Object.fromEntries(Object.entries(cycles).map(([o, l]) => [o, l.map(({ signature, modules, async }) => ({ signature, modules, ...(async ? { async: true } : {}) }))])),
    warnings: sortedWarnings,
    checks: checksSummary,
    // runtime export surface of each public (host-owned) package at this build; compared with the API snapshot file
    publicApi: Object.fromEntries(Object.entries(publicApi).sort()),
  };

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'units'), { recursive: true });
  const write = (rel, content) => fs.writeFileSync(path.join(outDir, rel), content);
  write('host.js', result.host);
  for (const u of units) write(`units/${u.name}.js`, result.units[u.name]);
  write('ids.json', JSON.stringify(Object.fromEntries(Object.entries(idsJson).sort((a, b) => a[0] - b[0])), null, 1) + '\n');
  write('units.json', JSON.stringify(unitsJson, null, 1) + '\n');
  const files = hashDir(outDir);
  return { outDir, files, unitsJson, approach, cycles: unitsJson.cycles, warnings: sortedWarnings, checks: checksSummary };
}

/**
 * Metro rejects a non-literal require()/import() in first-party code while transforming (InvalidRequireCallError, "Invalid call at
 * line N: require(x)"). Translate that into our rule format so it shows up like every other verification failure.
 */
async function runMetroTranslated(opts) {
  try {
    return await runMetro(opts);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const m = /(?:^|\s)([^\s:]+\.[cm]?[jt]sx?):\s*Invalid call at line (\d+): ([^\n]*)/.exec(msg);
    if (m) {
      const file = path.isAbsolute(m[1]) ? pathKey(m[1], opts.projectRoot) : m[1];
      throw new VerificationError([{
        rule: 'dynamic-require',
        message: `${file}:${m[2]}: ${m[3]} is not statically analyzable (Metro rejects a non-literal require()/import() in first-party code at transform time); use a string-literal specifier`,
      }]);
    }
    throw e;
  }
}

/**
 * Print-able baseline of the current cycles (first-party host + units) for `checks.cycleBaseline`. Runs a full build with cycle
 * enforcement off into a throw-away directory.
 */
export async function generateCycleBaseline({ projectRoot, ...opts }) {
  projectRoot = fs.realpathSync(projectRoot);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyc-'));
  try {
    const r = await build({ ...opts, projectRoot, outDir: tmp, base: null, forceChecks: { cycles: 'off' } });
    const out = {};
    for (const [o, l] of Object.entries(r.cycles)) if (l.some((c) => !c.async)) out[o] = l.filter((c) => !c.async).map(({ signature, modules }) => ({ signature, modules }));
    return { cycles: out };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Current public API snapshots ({pkg: {package, entry, default, exports[]}}) of `checks.publicPackages`, from a full build into a
 * throw-away directory (snapshot comparison and host-export checks off). `write: true` writes each one to the path configured in
 * `checks.publicApiSnapshot[pkg]`. Returns { snapshots, written: [paths] }.
 */
export async function generateApiSnapshots({ projectRoot, write = false, ...opts }) {
  projectRoot = fs.realpathSync(projectRoot);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
  try {
    const r = await build({ ...opts, projectRoot, outDir: tmp, base: null, forceChecks: { publicApiSnapshot: {}, hostExports: 'off' } });
    const snapshots = {};
    for (const [name, { version, ...snap }] of Object.entries(r.unitsJson.publicApi)) snapshots[name] = snap;
    const configured = parseChecks(readUnitsConfig(projectRoot).checks).publicApiSnapshot;
    const written = [];
    if (write) {
      for (const [name, snap] of Object.entries(snapshots)) {
        if (!configured[name]) throw new Error(`no snapshot path configured for ${name}: add it to checks.publicApiSnapshot in units.config.json`);
        if (snap.opaque) throw new Error(`public API of ${name} is not statically analyzable (${snap.opaque}); refusing to write a snapshot`);
        const f = path.resolve(projectRoot, configured[name]);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(snap, null, 2) + '\n');
        written.push(f);
      }
    }
    return { snapshots, written };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function hashDir(dir) {
  const out = {};
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}
