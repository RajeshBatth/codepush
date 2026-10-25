// Tier 1 rule 5 (native-module scan, v1): which native modules / native views does JS code reference, statically?
// The inventory of a build is recorded in units.json (`nativeRefs`); a patch build is compared with the BASE build's inventory
// (everything the base JS references must exist in the binary, because the base works). See README "Native-module scan".
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parseSource, walk } from './checks.js';

const SCRIPT_RE = /\.(?:[cm]?jsx?|tsx?)$/;
/** cheap text prefilter: only files mentioning one of these are parsed */
const PREFILTER = /NativeModules|TurboModuleRegistry|requireNativeComponent|codegenNativeComponent|getViewManagerConfig|hasViewManagerConfig|NativeComponentRegistry/;

const VIEW_FNS = new Set(['requireNativeComponent', 'codegenNativeComponent']);

/** name of the callee/member as a plain string: `X` or `a.X` -> 'X'; else null */
const tail = (n) => (n?.type === 'Identifier' ? n.name : (n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression') && !n.computed && n.property.type === 'Identifier' ? n.property.name : null);
const unwrap = (n) => {
  while (n && (n.type === 'TSNonNullExpression' || n.type === 'TypeCastExpression' || n.type === 'TSAsExpression' || n.type === 'ParenthesizedExpression' || n.type === 'AsExpression')) n = n.expression;
  if (n && n.type === 'LogicalExpression') return unwrap(n.left); // `NativeModules.Foo || {}`
  return n;
};
const literal = (a) => (a?.type === 'StringLiteral' ? a.value : a?.type === 'TemplateLiteral' && a.expressions.length === 0 ? a.quasis[0].value.cooked : null);
const isMember = (n) => n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression');
const isCall = (n) => n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression');
/** property name of a member: `.x` or `['x']`; undefined = computed non-literal */
const propName = (m) => (!m.computed ? (m.property.type === 'Identifier' ? m.property.name : undefined) : literal(m.property) ?? undefined);

/**
 * If `expr` denotes a native module / view reference return { name, kind } (name null = dynamic), else null.
 *   NativeModules.X / NativeModules['X'] / NativeModules[x]      -> module
 *   TurboModuleRegistry.get('X') / getEnforcing('X') / get(x)   -> turbo
 *   requireNativeComponent('X') / codegenNativeComponent('X') / NativeComponentRegistry.get('X', ...) -> view
 *   UIManager.getViewManagerConfig('X') / hasViewManagerConfig('X') -> view
 */
function refOf(expr) {
  expr = unwrap(expr);
  if (isMember(expr)) {
    if (tail(expr.object) === 'NativeModules') return { kind: 'module', name: propName(expr) ?? null };
    return null;
  }
  if (isCall(expr)) {
    const callee = unwrap(expr.callee);
    const fn = tail(callee);
    const obj = isMember(callee) ? tail(callee.object) : null;
    const arg = literal(expr.arguments[0]);
    if (obj === 'TurboModuleRegistry' && (fn === 'get' || fn === 'getEnforcing')) return { kind: 'turbo', name: arg };
    if (VIEW_FNS.has(fn) && (obj === null || isMember(callee))) return { kind: 'view', name: arg };
    if (obj === 'NativeComponentRegistry' && fn === 'get') return { kind: 'view', name: arg };
    if (obj === 'UIManager' && (fn === 'getViewManagerConfig' || fn === 'hasViewManagerConfig')) return { kind: 'view', name: arg };
  }
  return null;
}

const cache = new Map(); // sha1(code) -> result (content-addressed: valid across files and builds)

/**
 * @returns {{ refs: {name, kind, methods: string[]}[], dynamic: {kind, line}[] } | null} null = could not be parsed.
 * `methods` = member names accessed directly on the module (`NativeModules.Foo.bar`, `getEnforcing('Foo').bar`, or through a
 * local alias `const Foo = NativeModules.Foo; Foo.bar` / `const {Foo} = NativeModules`, matched by identifier name per file).
 */
export function scanNativeRefs(code, file) {
  if (!PREFILTER.test(code)) return { refs: [], dynamic: [] };
  const h = createHash('sha1').update(code).digest('hex');
  if (cache.has(h)) return cache.get(h);
  let result;
  try {
    const ast = parseSource(code, file);
    const refs = new Map(); // `${kind}\0${name}` -> {name, kind, methods:Set}
    const dynamic = [];
    const bindings = new Map(); // local identifier -> ref entry
    const idMembers = []; // [objectIdentifierName, property]
    const add = (r, line) => {
      if (r.name == null) { dynamic.push({ kind: r.kind, line }); return null; }
      const k = `${r.kind}\0${r.name}`;
      if (!refs.has(k)) refs.set(k, { name: r.name, kind: r.kind, methods: new Set() });
      return refs.get(k);
    };
    walk(ast.program, (n) => {
      if (isMember(n)) {
        const inner = refOf(n.object);
        const p = propName(n);
        if (inner && inner.name != null && p != null) add(inner, n.loc?.start.line)?.methods.add(p);
        else if (n.object.type === 'Identifier' && p != null) idMembers.push([n.object.name, p]);
      }
      if (isMember(n) || isCall(n)) {
        const r = refOf(n);
        if (r) add(r, n.loc?.start.line); // a computed non-literal `NativeModules[x]` / `get(x)` is recorded as dynamic
      }
      if (n.type === 'VariableDeclarator' && n.init) {
        const init = unwrap(n.init);
        if (n.id.type === 'Identifier') {
          const ref = refOf(init);
          if (ref && ref.name != null) bindings.set(n.id.name, add(ref));
        } else if (n.id.type === 'ObjectPattern' && tail(init) === 'NativeModules') {
          for (const prop of n.id.properties) {
            if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
            const key = prop.computed ? literal(prop.key) : prop.key.type === 'Identifier' ? prop.key.name : literal(prop.key);
            if (key == null) { dynamic.push({ kind: 'module', line: n.loc?.start.line }); continue; }
            const entry = add({ kind: 'module', name: key });
            const local = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
            if (local.type === 'Identifier') bindings.set(local.name, entry);
          }
        }
      }
    });
    for (const [id, prop] of idMembers) bindings.get(id)?.methods.add(prop);
    result = {
      refs: [...refs.values()].map((r) => ({ ...r, methods: [...r.methods].sort() })).sort((a, b) => (a.name + a.kind < b.name + b.kind ? -1 : 1)),
      dynamic,
    };
  } catch {
    result = null;
  }
  cache.set(h, result);
  return result;
}

/**
 * Scan every script module of the graph. @param mods Map<absPath, module>; @param ownerOf (absPath) => owner name
 * @returns { inventory: {name: {owners[], methods[], kinds[]}}, byOwner: Map<owner, Map<name, {kinds:Set, methods:Set, files:Set}>>,
 *            dynamic: [{owner, file, kind, line}], unparsed: [{owner, file}] }   (file = absolute path)
 */
export function scanGraph(mods, ownerOf) {
  const byOwner = new Map();
  const dynamic = [];
  const unparsed = [];
  const inv = new Map();
  for (const p of mods.keys()) {
    if (!SCRIPT_RE.test(p)) continue;
    let code;
    try { code = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const r = scanNativeRefs(code, p);
    const o = ownerOf(p);
    if (r === null) { unparsed.push({ owner: o, file: p }); continue; }
    for (const d of r.dynamic) dynamic.push({ owner: o, file: p, ...d });
    for (const ref of r.refs) {
      if (!byOwner.has(o)) byOwner.set(o, new Map());
      const m = byOwner.get(o);
      if (!m.has(ref.name)) m.set(ref.name, { kinds: new Set(), methods: new Set(), files: new Set() });
      const e = m.get(ref.name);
      e.kinds.add(ref.kind);
      e.files.add(p);
      ref.methods.forEach((x) => e.methods.add(x));
      if (!inv.has(ref.name)) inv.set(ref.name, { owners: new Set(), methods: new Set(), kinds: new Set() });
      const g = inv.get(ref.name);
      g.owners.add(o);
      g.kinds.add(ref.kind);
      ref.methods.forEach((x) => g.methods.add(x));
    }
  }
  const inventory = Object.fromEntries([...inv].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, g]) => [n, { owners: [...g.owners].sort(), methods: [...g.methods].sort(), kinds: [...g.kinds].sort() }]));
  return { inventory, byOwner, dynamic, unparsed };
}
