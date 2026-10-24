// Host-API checks: what a unit may import from the host (host-export-missing / host-export-unknown), the public-package rules
// (public-deep-import, host ownership) and the public API snapshot (public-api-breaking / public-api-changed / public-api-opaque).
import fs from 'node:fs';
import path from 'node:path';
import { createExportAnalyzer, collectImports, SCRIPT_EXT } from './exports.js';
import { findPackage, packageMain, isUnder } from './config.js';

const stripPlatform = (f) => f.replace(/\.(?:ios|android|native|web)(\.[cm]?[jt]sx?)$/, '$1');

/** Files of a package that its package.json exposes: main fields + every target in `exports` (patterns kept as prefix/suffix). */
export function exposedFiles(pkgDir, pj, entry) {
  const files = new Set(entry ? [entry] : []);
  const patterns = [];
  const addRel = (rel) => {
    if (typeof rel !== 'string') return;
    const clean = rel.replace(/^\.\//, '');
    if (clean.includes('*')) { const [prefix, suffix] = clean.split('*'); patterns.push({ prefix, suffix: suffix ?? '' }); return; }
    const abs = path.join(pkgDir, clean);
    for (const f of [abs, abs + '.js', path.join(abs, 'index.js')]) {
      if (fs.existsSync(f) && fs.statSync(f).isFile()) { try { files.add(fs.realpathSync(f)); } catch { files.add(f); } }
    }
  };
  for (const field of ['react-native', 'browser', 'main', 'module']) addRel(pj[field]);
  const visit = (x) => {
    if (typeof x === 'string') addRel(x);
    else if (Array.isArray(x)) x.forEach(visit);
    else if (x && typeof x === 'object') Object.values(x).forEach(visit);
  };
  visit(pj.exports);
  const isExposed = (abs) => {
    if (files.has(abs)) return true;
    const rel = stripPlatform(path.relative(pkgDir, abs).split(path.sep).join('/'));
    for (const f of files) if (stripPlatform(f) === stripPlatform(abs)) return true;
    return patterns.some((p) => rel.startsWith(stripPlatform(p.prefix)) && rel.endsWith(p.suffix) && rel.length >= p.prefix.length + p.suffix.length);
  };
  return { files, patterns, isExposed };
}

/** Render a public API snapshot from an analyzer result. */
export function snapshotOf(name, version, entryKey, res) {
  return {
    package: name,
    entry: entryKey,
    default: !!(res.esModule && res.hasDefault),
    exports: [...res.names].sort(),
    ...(res.opaque ? { opaque: res.opaque } : {}),
  };
}

/**
 * @returns {{ publicApi: {pkg: {...snapshot, version}}, analyzer }}
 */
export function checkHostApi({ mods, owner, units, projectRoot, checks, key, v, w, report, count }) {
  const specMaps = new Map();
  const specMap = (from) => {
    if (!specMaps.has(from)) {
      const m = new Map();
      for (const d of mods.get(from)?.dependencies.values() ?? []) {
        if (!d.absolutePath) continue;
        if (!m.has(d.data.name) || d.data.data.asyncType == null) m.set(d.data.name, d.absolutePath);
      }
      specMaps.set(from, m);
    }
    return specMaps.get(from);
  };
  const analyzer = createExportAnalyzer({ resolve: (from, spec) => specMap(from).get(spec) ?? null });
  const unitModules = [...mods.keys()].filter((p) => owner.get(p) !== 'host');
  const label = (p) => `unit ${owner.get(p)}: ${key(p)}`;

  // ---- host-export-missing / host-export-unknown ----------------------------------------------------------------------------
  const he = count('host-exports', checks.hostExports, { unknown: 0 });
  if (checks.hostExports !== 'off') {
    const unknownByTarget = new Map(); // target key -> {reason, sites:Set}
    for (const p of unitModules) {
      if (!SCRIPT_EXT.test(p)) continue;
      let imports;
      try { imports = collectImports(fs.readFileSync(p, 'utf8'), p); } catch (e) { w('unparsed-source', `${key(p)}: cannot parse for the host-export check (${String(e.message).split('\n')[0]})`); continue; }
      const specs = specMap(p);
      for (const imp of imports) {
        const t = specs.get(imp.spec);
        if (!t || owner.get(t) !== 'host') continue;
        if (!/\.(?:[cm]?jsx?|tsx?|json)$/.test(t)) continue; // assets: only a default import exists
        const res = analyzer.analyze(t);
        const wanted = [...imp.named.map((x) => ({ ...x })), ...imp.ns];
        if (imp.default != null) wanted.push({ name: 'default', line: imp.default });
        const exportsList = () => { const l = [...res.names].sort(); return (res.hasDefault && res.esModule ? ['default', ...l] : l).slice(0, 15).join(', ') + (res.names.size > 15 ? ', ...' : ''); };
        for (const x of wanted) {
          const present = x.name === 'default' ? res.hasDefault : res.names.has(x.name);
          if (present) continue;
          const site = `${key(p)}:${x.line}`;
          if (res.opaque) {
            if (!unknownByTarget.has(key(t))) unknownByTarget.set(key(t), { reason: res.opaque, sites: new Set() });
            unknownByTarget.get(key(t)).sites.add(site);
          } else {
            he.count++;
            report(checks.hostExports, 'host-export-missing', `${label(p)}:${x.line} imports { ${x.name} } from '${imp.spec}' (${key(t)}), which does not export it. Exports of that module: ${exportsList() || '(none)'}. A unit can only use host API that already shipped in the binary`);
          }
        }
      }
    }
    for (const [t, { reason, sites }] of [...unknownByTarget].sort()) {
      he.unknown++;
      const list = [...sites].sort();
      w('host-export-unknown', `exports of ${t} cannot be determined statically (${reason}); ${list.length} imported name(s) from units were not verified, e.g. ${list.slice(0, 3).join(', ')}${list.length > 3 ? `, +${list.length - 3} more` : ''}`);
    }
  }

  // ---- public packages ------------------------------------------------------------------------------------------------------
  const pubSummary = count('public-api', 'error', { packages: checks.publicPackages.length });
  const deep = count('public-deep-import', 'error');
  const publicApi = {};
  for (const name of checks.publicPackages) {
    const pkg = findPackage(name, projectRoot);
    if (!pkg) { v('public-package-missing', `checks.publicPackages lists ${name}, but node_modules/${name} is not installed`); continue; }
    const pj = JSON.parse(fs.readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'));
    // must be HOST-owned: it ships in the binary and is patched only by the host lane
    let overlap = false;
    for (const u of units) for (const r of u.roots) {
      if (isUnder(pkg.dir, r) || isUnder(r, pkg.dir)) { overlap = true; v('public-package-not-host', `public package ${name} overlaps the root of unit ${u.name} (${key(r)}): a public package is HOST-owned (ships in the binary, patched only via the host lane) and must not be inside a unit root`); }
    }
    const entry = packageMain(pkg.dir) && fs.realpathSync(packageMain(pkg.dir));
    if (!entry || !mods.has(entry)) {
      if (!overlap) v('public-package-missing', `public package ${name} has no entry in the bundle graph: the host must import it (host entry calls its init())`);
      continue;
    }
    if (!overlap && owner.get(entry) !== 'host') v('public-package-not-host', `public package ${name} entry ${key(entry)} is owned by unit ${owner.get(entry)}`);

    // deep-import rule: units reach a public package only through its entry / package.json exports
    const exposed = exposedFiles(pkg.dir, pj, entry);
    for (const p of unitModules) {
      for (const d of mods.get(p).dependencies.values()) {
        const t = d.absolutePath;
        if (!t || !isUnder(t, pkg.dir) || owner.get(t) !== 'host') continue;
        if (d.data.name === name || exposed.isExposed(t)) continue;
        deep.count++;
        v('public-deep-import', `${label(p)} imports '${d.data.name}' (${key(t)}), an internal file of public package ${name}; import only '${name}' or a path listed in its package.json "exports"`);
      }
    }

    // current public surface (recorded in units.json at every build)
    const res = analyzer.analyze(entry);
    const snap = snapshotOf(name, pj.version, path.relative(pkg.dir, entry).split(path.sep).join('/'), res);
    publicApi[name] = { version: pj.version, ...snap };

    const snapPath = checks.publicApiSnapshot[name];
    if (snapPath == null) continue;
    if (res.opaque) {
      pubSummary.count++;
      v('public-api-opaque', `entry of public package ${name} (${snap.entry}) is not statically analyzable (${res.opaque}), so its API snapshot cannot be verified. Make it analyzable: plain ES \`export\` / \`export * from\` of analyzable modules, or Babel-compiled CJS using \`exports.x =\`, \`Object.defineProperty(exports, 'x', ...)\`, a literal \`module.exports = {...}\` or the Babel wildcard re-export`);
      continue;
    }
    const file = path.resolve(projectRoot, snapPath);
    let old;
    try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      pubSummary.count++;
      v('public-api-snapshot-missing', `API snapshot ${snapPath} for ${name} is missing or unreadable (${e.code ?? e.message}); create it with: cli.js api-snapshot --project <dir> --write`);
      continue;
    }
    const oldNames = new Set(old.exports ?? []);
    const cur = new Set(snap.exports);
    const removed = [...oldNames].filter((n) => !cur.has(n)).sort();
    const added = [...cur].filter((n) => !oldNames.has(n)).sort();
    if (old.default && !snap.default) removed.push('default');
    if (!old.default && snap.default) added.push('default');
    if (removed.length) {
      pubSummary.count++;
      v('public-api-breaking', `public API of ${name} lost ${removed.map((n) => `'${n}'`).join(', ')} compared to ${snapPath}. Units patched OTA call these names in the already shipped binary: restore them (a rename is a removal; keep the old name), or ship the change through the train with a new snapshot`);
    }
    if (added.length) {
      pubSummary.count++;
      const msg = `public API of ${name} gained ${added.map((n) => `'${n}'`).join(', ')} compared to ${snapPath}; review it (public API is a long-lived promise) and update the snapshot: cli.js api-snapshot --project <dir> --write`;
      if (checks.publicApiStrict) v('public-api-changed', msg); else w('public-api-changed', msg);
    }
  }
  return { publicApi };
}
