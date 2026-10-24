// Deterministic module ids: a hash of the project-relative module path.
import { createHash } from 'node:crypto';
import path from 'node:path';

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Stable "path key" of a module. Inside the project it is the project-relative path.
 * Outside the project root (e.g. metro-runtime resolved from the splitter's own
 * node_modules, or a hoisted monorepo node_modules) the absolute location is machine
 * specific, so we key by the part after the LAST "/node_modules/" instead.
 * Metro's virtual modules ("__prelude__") are keyed as-is.
 */
const aliasRoots = []; // [{dir, key}]: real dirs of package-root units outside the project (set by config.resolveUnits)
export function registerAliasRoot(dir, key) {
  if (!aliasRoots.some((a) => a.dir === dir)) aliasRoots.push({ dir, key });
}

export function pathKey(absPath, projectRoot) {
  if (!path.isAbsolute(absPath)) return absPath;
  const rel = path.relative(projectRoot, absPath);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  const i = absPath.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  for (const a of aliasRoots) {
    const r = path.relative(a.dir, absPath);
    if (!r.startsWith('..') && !path.isAbsolute(r) && (i < 0 || r === '' || !r.includes('node_modules'))) return a.key + (r ? '/' + toPosix(r) : '');
  }
  if (i >= 0) return 'node_modules/' + toPosix(absPath.slice(i + '/node_modules/'.length));
  throw new Error(`module outside project root and not in node_modules: ${absPath}`);
}

/** bits: 48 => 12 hex chars. Ids are plain JS numbers (safe up to 52 bits). */
export function hashId(key, bits = 48) {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, Math.ceil(bits / 4));
  return Number.parseInt(hex, 16);
}

/**
 * Metro `serializer.createModuleIdFactory` implementation with a build-time collision check.
 * Returns { factory, idToKey } where idToKey is filled as ids get handed out.
 */
export function createIdFactory(projectRoot, { bits = 48 } = {}) {
  const idToKey = new Map();
  const keyToId = new Map();
  const createModuleId = (absPath) => {
    const key = pathKey(absPath, projectRoot);
    let id = keyToId.get(key);
    if (id === undefined) {
      id = hashId(key, bits);
      const other = idToKey.get(id);
      if (other !== undefined && other !== key) {
        throw new Error(`module id collision (${bits}-bit): ${id} for "${key}" and "${other}"`);
      }
      keyToId.set(key, id);
      idToKey.set(id, key);
    }
    return id;
  };
  return { factory: () => createModuleId, createModuleId, idToKey, keyToId };
}
