// Static checks beyond the direction rules: cycles (C1), dynamic/unanalyzable references (C3), registerComponent (C4).
// Config lives in units.config.json -> "checks" (see README "Checks").
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';

const SEV3 = ['error', 'warn', 'off'];
export const DEFAULT_CHECKS = Object.freeze({
  cycles: 'error',
  cycleBaseline: null,
  singleImportSite: 'warn',
  dynamicRequire: 'error',
  requireRegisterComponent: false,
  hostExports: 'error',
  assets: 'error',
  nativeModules: 'error',
  publicPackages: Object.freeze([]),
  publicApiSnapshot: Object.freeze({}),
  publicApiStrict: false,
});

/** Validate + normalize the `checks` object of units.config.json (unknown keys / bad values are config errors). */
export function parseChecks(raw) {
  const c = { ...DEFAULT_CHECKS, ...(raw ?? {}) };
  for (const k of Object.keys(c)) if (!(k in DEFAULT_CHECKS)) throw new Error(`units.config.json checks: unknown key "${k}" (known: ${Object.keys(DEFAULT_CHECKS).join(', ')})`);
  for (const k of ['cycles', 'singleImportSite', 'dynamicRequire', 'hostExports', 'assets', 'nativeModules']) {
    if (!SEV3.includes(c[k])) throw new Error(`units.config.json checks.${k} must be one of ${SEV3.join('|')}, got ${JSON.stringify(c[k])}`);
  }
  if (typeof c.requireRegisterComponent !== 'boolean') throw new Error('units.config.json checks.requireRegisterComponent must be a boolean');
  if (c.cycleBaseline != null && typeof c.cycleBaseline !== 'string') throw new Error('units.config.json checks.cycleBaseline must be a path string');
  if (!Array.isArray(c.publicPackages) || c.publicPackages.some((x) => typeof x !== 'string')) throw new Error('units.config.json checks.publicPackages must be an array of package names');
  if (c.publicApiSnapshot == null || typeof c.publicApiSnapshot !== 'object' || Array.isArray(c.publicApiSnapshot) || Object.values(c.publicApiSnapshot).some((x) => typeof x !== 'string')) throw new Error('units.config.json checks.publicApiSnapshot must be an object {"<package>": "<snapshot path relative to the project>"}');
  for (const k of Object.keys(c.publicApiSnapshot)) if (!c.publicPackages.includes(k)) throw new Error(`units.config.json checks.publicApiSnapshot: "${k}" is not listed in checks.publicPackages`);
  if (typeof c.publicApiStrict !== 'boolean') throw new Error('units.config.json checks.publicApiStrict must be a boolean');
  return c;
}

/** Load the baseline file: { cycles: { owner: [ {signature, modules} | "signature" ] } } -> Map(owner -> {sigs:Set, sets:Set}) */
export function loadCycleBaseline(file) {
  const out = new Map();
  if (!file) return out;
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [owner, list] of Object.entries(j.cycles ?? j)) {
    const sigs = new Set();
    const sets = new Set();
    for (const e of list) {
      if (typeof e === 'string') sigs.add(e);
      else {
        if (e.signature) sigs.add(e.signature);
        if (e.modules) sets.add([...e.modules].sort().join('\n'));
      }
    }
    out.set(owner, { sigs, sets });
  }
  return out;
}

export const signatureOf = (keys) => createHash('sha256').update([...keys].sort().join('\n')).digest('hex');

/** Iterative Tarjan. nodes: array of ids, succ(id) -> iterable of ids (only nodes of the set are followed). Returns SCCs (arrays). */
export function tarjan(nodes, succ) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let idx = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [{ v: root, it: null }];
    while (work.length) {
      const f = work[work.length - 1];
      const v = f.v;
      if (f.it === null) {
        index.set(v, idx); low.set(v, idx); idx++;
        stack.push(v); onStack.add(v);
        f.it = succ(v)[Symbol.iterator]();
      }
      let pushed = false;
      for (let n = f.it.next(); !n.done; n = f.it.next()) {
        const w = n.value;
        if (!index.has(w)) { work.push({ v: w, it: null }); pushed = true; break; }
        if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      }
      if (pushed) continue;
      if (low.get(v) === index.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
        sccs.push(comp);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
    }
  }
  return sccs;
}

/** Shortest cycle through `start` inside `members` (BFS). Returns [start, ..., start] or null. */
function shortestCycleThrough(start, members, succ) {
  const prev = new Map([[start, null]]);
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    for (const w of succ(v)) {
      if (!members.has(w)) continue;
      if (w === start) return rebuild(start, v, prev);
      if (!prev.has(w)) { prev.set(w, v); q.push(w); }
    }
  }
  return null;
}
function rebuild(start, last, prev) {
  const p = [];
  for (let x = last; x !== null; x = prev.get(x)) p.push(x);
  p.reverse(); // start ... last
  p.push(start);
  return p;
}

/** Human cycle path, a -> b -> c -> a, the shortest one found (tries every member for small SCCs). */
export function shortestCycle(members, succ, keyOf) {
  const set = new Set(members);
  const starts = members.length <= 200 ? [...members].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)) : [[...members].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))[0]];
  let best = null;
  for (const s of starts) {
    const c = shortestCycleThrough(s, set, succ);
    if (c && (!best || c.length < best.length)) best = c;
  }
  return best;
}

/**
 * Cycles of one node set. `staticSucc`/`allSucc` follow only edges inside `nodes`.
 * Returns [{signature, modules:[keys sorted], path:[keys], async: boolean}]; `async` = the cycle exists only with import() edges.
 */
export function findCycles(nodes, staticSucc, allSucc, keyOf) {
  const nodeSet = new Set(nodes);
  const restrict = (f) => (v) => f(v).filter((w) => nodeSet.has(w));
  const sS = restrict(staticSucc);
  const sA = restrict(allSucc);
  const isCyclic = (c, succ) => c.length > 1 || succ(c[0]).includes(c[0]);
  const out = [];
  const staticSigs = new Set();
  const add = (c, succ, async) => {
    const modules = c.map(keyOf).sort();
    const signature = signatureOf(modules);
    const p = shortestCycle(c, succ, keyOf).map(keyOf);
    out.push({ signature, modules, path: p, async });
    return signature;
  };
  for (const c of tarjan(nodes, sS)) if (isCyclic(c, sS)) staticSigs.add(add(c, sS, false));
  for (const c of tarjan(nodes, sA)) {
    if (!isCyclic(c, sA)) continue;
    if (staticSigs.has(signatureOf(c.map(keyOf)))) continue;
    add(c, sA, true);
  }
  return out.sort((a, b) => (a.signature < b.signature ? -1 : 1));
}

// ---- C3: require.context (Metro does not reject it unless enabled; without the flag it is a runtime TypeError) ----------------
const SCRIPT_RE = /\.(?:[cm]?jsx?|tsx?)$/;
/** Babel plugin set close to what RN's preset parses: flow (+jsx) for js, typescript for ts. */
export function parseSource(code, file) {
  const ts = /\.tsx?$/.test(file);
  const attempts = ts ? [['typescript', 'jsx']] : [['flow', 'jsx'], ['typescript', 'jsx']];
  let err;
  for (const plugins of attempts) {
    try { return parse(code, { sourceType: 'unambiguous', plugins, errorRecovery: true, allowReturnOutsideFunction: true }); } catch (e) { err = e; }
  }
  throw err;
}
export function walk(node, visit) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    if (visit(n) === false) continue; // a visitor may return false to skip the subtree
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments' || k === 'extra') continue;
      const c = n[k];
      if (Array.isArray(c)) for (let i = c.length - 1; i >= 0; i--) stack.push(c[i]);
      else if (c && typeof c === 'object') stack.push(c);
    }
  }
}

/** [{line, text}] of `require.context(...)` calls in a source file; throws on a parse error. */
export function findRequireContext(code, file) {
  if (!/require\s*\.\s*context\s*\(/.test(code)) return [];
  const out = [];
  walk(parseSource(code, file).program, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier' &&
      n.callee.object.name === 'require' && n.callee.property.name === 'context') out.push({ line: n.loc.start.line });
  });
  return out;
}

/** Occurrences of Metro's runtime-throwing placeholder for a non-literal require() in already transformed output. */
export function findDynamicRequirePlaceholders(outputCode) {
  const out = [];
  const re = /Dynamic require defined at line [^]{0,160}?\}\)?\((\d+)\)/g;
  let m;
  while ((m = re.exec(outputCode))) out.push({ line: Number(m[1]) });
  if (!out.length && outputCode.includes('Dynamic require defined at line')) out.push({ line: null });
  return out;
}

// ---- C4: AppRegistry.registerComponent('<unitName>', ...) in the unit entry --------------------------------------------------
/** Returns null if fine, else a message. */
export function checkRegisterComponent(entryFile, unitName) {
  const code = fs.readFileSync(entryFile, 'utf8');
  let ast;
  try { ast = parseSource(code, entryFile); } catch (e) { return `cannot parse entry for the registerComponent check: ${e.message}`; }
  const calls = [];
  walk(ast.program, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier' &&
      n.callee.object.name === 'AppRegistry' && n.callee.property.name === 'registerComponent') calls.push(n);
  });
  if (!calls.length) return `entry never calls AppRegistry.registerComponent('${unitName}', ...)`;
  const names = calls.map((c) => {
    const a = c.arguments[0];
    return a && (a.type === 'StringLiteral' || (a.type === 'TemplateLiteral' && a.expressions.length === 0)) ? (a.value ?? a.quasis[0].value.cooked) : null;
  });
  if (names.includes(unitName)) return null;
  if (names.every((n) => n === null)) return `AppRegistry.registerComponent in the entry has a non-literal name; it must be the literal '${unitName}'`;
  return `entry registers ${names.filter((n) => n !== null).map((n) => `'${n}'`).join(', ')} but the unit is named '${unitName}'; the registered component name must equal the unit name`;
}
