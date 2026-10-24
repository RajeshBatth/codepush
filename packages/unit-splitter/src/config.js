import fs from 'node:fs';
import path from 'node:path';
import { registerAliasRoot } from './ids.js';

/** Read units.config.json and resolve roots/entries to absolute paths. Roots must be disjoint (rule 8). */
export function readUnitsConfig(projectRoot) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'units.config.json'), 'utf8'));
}

/** Files auto-detected for `metroConfig` (in this order) when units.config.json does not say. */
export const METRO_CONFIG_CANDIDATES = ['metro.config.js', 'metro.config.cjs'];

/**
 * The app's Metro config file the splitter will load, as a project-relative path, or null (= the splitter assembles its own
 * config, "demo mode"). `"metroConfig": "<file>"` names it; ABSENT = auto-detect <project>/metro.config.js (.cjs);
 * `"metroConfig": false` (or null) = never use the app's config. Returns { file, source: 'units.config.json'|'auto-detected'|'disabled'|'none' }.
 */
export function resolveMetroConfigFile(projectRoot, cfg = readUnitsConfig(projectRoot)) {
  if (typeof cfg.metroConfig === 'string') return { file: cfg.metroConfig, source: 'units.config.json' };
  if (cfg.metroConfig === false || cfg.metroConfig === null) return { file: null, source: 'disabled' };
  const found = METRO_CONFIG_CANDIDATES.find((f) => fs.existsSync(path.join(projectRoot, f)));
  return found ? { file: found, source: 'auto-detected' } : { file: null, source: 'none' };
}

export function loadUnitsConfig(projectRoot) {
  return resolveUnits(readUnitsConfig(projectRoot).units, projectRoot);
}

const PKG_NAME = /^(?:@[\w.-]+\/)?[\w.-]+$/;

/**
 * Find an installed npm package by name from projectRoot (node_modules lookup upwards, like Node). Returns
 * { name, dir (realpath, what Metro reports for module paths), linkDir (the node_modules/<name> path) } or null.
 */
export function findPackage(name, projectRoot) {
  for (let d = projectRoot; ; d = path.dirname(d)) {
    const linkDir = path.join(d, 'node_modules', name);
    if (fs.existsSync(path.join(linkDir, 'package.json'))) return { name, dir: fs.realpathSync(linkDir), linkDir };
    if (d === path.dirname(d)) return null;
  }
}

/**
 * A unit root is a DIRECTORY (project-relative) or an npm PACKAGE NAME (e.g. "@lob/cabs", optionally written "package:@lob/cabs").
 * A string that is not an existing directory but names an installed package is a package root.
 * Directories and package dirs are realpath'd: Metro reports symlink-resolved module paths, so ownership must be decided on
 * real paths or a linked unit would silently fall into the host.
 */
function resolveRoot(r, projectRoot, unitName) {
  const explicitPkg = r.startsWith('package:');
  const raw = explicitPkg ? r.slice('package:'.length) : r;
  const asDir = path.join(projectRoot, raw);
  if (!explicitPkg && fs.existsSync(asDir)) return { kind: 'dir', dir: fs.realpathSync(asDir) };
  if (PKG_NAME.test(raw)) {
    const pkg = findPackage(raw, projectRoot);
    if (pkg) return { kind: 'package', name: raw, dir: pkg.dir, linkDir: pkg.linkDir };
    throw new Error(`unit ${unitName}: root "${r}" is neither a directory of the project nor an installed package (node_modules/${raw} not found)`);
  }
  return { kind: 'dir', dir: asDir }; // keeps the old error path (entry not under roots / does not exist)
}

const EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.json'];
/** file or directory-with-index probing, like Metro's resolver (no platform extensions: entries are single files). */
function probeFile(base) {
  for (const x of EXTS) {
    const f = base + x;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  for (const x of EXTS.slice(1)) {
    const f = path.join(base, 'index' + x);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** The package's main file, using Metro's default resolverMainFields order: react-native, browser (string form), main. */
export function packageMain(pkgDir) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  for (const field of ['react-native', 'browser', 'main']) {
    if (typeof pj[field] === 'string') {
      const f = probeFile(path.join(pkgDir, pj[field]));
      if (f) return f;
    }
  }
  return probeFile(path.join(pkgDir, 'index'));
}

/**
 * entry: project-relative path, "<package>/<file>", or a BARE PACKAGE NAME for a package root (the package's main file,
 * i.e. what `import('@lob/x')` resolves to). Returns the real path Metro will report.
 */
function resolveEntry(e, roots, projectRoot) {
  const asPath = path.join(projectRoot, e);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return fs.realpathSync(asPath);
  for (const r of roots) {
    if (r.kind !== 'package') continue;
    if (e === r.name) {
      const main = packageMain(r.dir);
      if (main) return fs.realpathSync(main);
    } else if (e.startsWith(r.name + '/')) {
      const f = probeFile(path.join(r.dir, e.slice(r.name.length + 1)));
      if (f) return fs.realpathSync(f);
    }
  }
  return asPath;
}

/** units: [{name, roots: [rel|pkg], entry: rel}] -> absolute, validated. */
export function resolveUnits(rawUnits, projectRoot) {
  const units = rawUnits.map((u) => {
    const rootInfo = u.roots.map((r) => resolveRoot(r, projectRoot, u.name));
    return {
      name: u.name,
      roots: rootInfo.map((r) => r.dir),
      rootInfo,
      entry: resolveEntry(u.entry, rootInfo, projectRoot),
    };
  });
  const names = new Set();
  for (const u of units) {
    if (names.has(u.name)) throw new Error(`duplicate unit name ${u.name}`);
    names.add(u.name);
    if (!fs.existsSync(u.entry)) throw new Error(`unit ${u.name}: entry ${u.entry} does not exist`);
    if (!u.roots.some((r) => isUnder(u.entry, r))) throw new Error(`unit ${u.name}: entry is not under its roots`);
    // Package roots outside the project and outside any node_modules get a stable, machine-independent key.
    for (const r of u.rootInfo) if (r.kind === 'package') registerAliasRoot(r.dir, `node_modules/${r.name}`);
  }
  for (const a of units) for (const b of units) {
    if (a !== b && a.roots.some((ra) => b.roots.some((rb) => isUnder(ra, rb)))) {
      throw new Error(`unit roots not disjoint: ${a.name} and ${b.name}`);
    }
  }
  return units;
}

/** Real directories of package roots (Metro must watch them when they live outside the project root). */
export function packageRootDirs(units) {
  return units.flatMap((u) => u.rootInfo.filter((r) => r.kind === 'package').map((r) => r.dir));
}

export function isUnder(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Ownership by path/package: unit iff under a declared root (a directory, or the real directory of a declared package,
 * which covers symlinked workspace packages AND real copies in node_modules); everything else is host.
 * A package root does not own that package's own nested node_modules (its third-party deps stay host).
 */
export function ownerOf(absPath, units) {
  for (const u of units) {
    for (let i = 0; i < u.roots.length; i++) {
      const r = u.roots[i];
      if (!isUnder(absPath, r)) continue;
      if (u.rootInfo?.[i]?.kind === 'package' && path.relative(r, absPath).split(path.sep).includes('node_modules')) continue;
      return u.name;
    }
  }
  return 'host';
}
