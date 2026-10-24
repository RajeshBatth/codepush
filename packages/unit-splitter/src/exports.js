// Static export-name analyzer (Babel AST) + import collector, used by host-export-missing and the public API snapshot.
//
// analyzer = createExportAnalyzer({ resolve(fromFile, specifier) -> absolute path | null })
// analyzer.analyze(file) -> { names: Set<string> (runtime export names WITHOUT 'default'), hasDefault, esModule, opaque: string|null }
//
// Supported: ESM (`export const/let/var/function/class/enum`, `export {a as b}`, `export {a} from`, `export * from` (followed through
// `resolve`, cycle-safe), `export * as ns from`, `export default`; type-only exports are ignored) and CJS as Babel/tsc ship it
// (`exports.x =`, `exports.a = exports.b = void 0`, `module.exports.x =`, `Object.defineProperty(exports, 'x', ...)`,
// `Object.defineProperties/assign(exports, ...)`, `module.exports = {...}` incl. getters, `module.exports = require('./x')` (alias),
// `module.exports = ident` (object literal / require var), `exports.default`, `__esModule`, the
// `Object.keys(_x).forEach(... defineProperty(exports, key ...))` wildcard pattern, tsc `__exportStar(require(..), exports)`).
// Opaque (opaque != null, names are the part we know): `module.exports = fn()/function/class/unknown ident`, object spread of a non-require,
// computed export names, `export =`, unparsable files, non-script/non-JSON targets, unresolvable `export *`.
import fs from 'node:fs';
import { parseSource, walk } from './checks.js';

export const SCRIPT_EXT = /\.(?:[cm]?jsx?|tsx?)$/;

const isId = (n, name) => n && n.type === 'Identifier' && (name == null || n.name === name);
const strOf = (n) => (n && n.type === 'StringLiteral' ? n.value : n && n.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : null);
const isModuleExports = (n) => n && n.type === 'MemberExpression' && !n.computed && isId(n.object, 'module') && isId(n.property, 'exports');
const isExportsRoot = (n) => isId(n, 'exports') || isModuleExports(n);
const propName = (m) => (m.computed ? strOf(m.property) : m.property.type === 'Identifier' ? m.property.name : strOf(m.property));
const requireSpec = (n) => (n && n.type === 'CallExpression' && isId(n.callee, 'require') && n.arguments.length === 1 ? strOf(n.arguments[0]) : null);

/** first literal require('x') anywhere inside an expression (covers `_interopRequireWildcard(require('x'))`) */
function findRequire(n, depth = 0) {
  if (!n || typeof n.type !== 'string' || depth > 6) return null;
  const s = requireSpec(n);
  if (s != null) return s;
  if (n.type === 'CallExpression') for (const a of n.arguments) { const r = findRequire(a, depth + 1); if (r) return r; }
  if (n.type === 'MemberExpression') return findRequire(n.object, depth + 1);
  return null;
}

function patternNames(p, out) {
  if (!p) return;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') for (const x of p.properties) patternNames(x.type === 'RestElement' ? x.argument : x.value, out);
  else if (p.type === 'ArrayPattern') for (const x of p.elements) patternNames(x, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
}

export function createExportAnalyzer({ resolve, readFile = (f) => fs.readFileSync(f, 'utf8') }) {
  const memo = new Map();
  const inProgress = new Set();

  function analyze(file) {
    if (memo.has(file)) return memo.get(file);
    if (inProgress.has(file)) return { names: new Set(), hasDefault: false, esModule: false, opaque: null, cyclic: true };
    inProgress.add(file);
    let r;
    try { r = analyzeFile(file); } catch (e) { r = { names: new Set(), hasDefault: false, esModule: false, opaque: `analyzer error: ${e.message}` }; }
    inProgress.delete(file);
    memo.set(file, r);
    return r;
  }

  function analyzeFile(file) {
    if (/\.json$/.test(file)) {
      try {
        const j = JSON.parse(readFile(file));
        return j && typeof j === 'object' && !Array.isArray(j) ? { names: new Set(Object.keys(j)), hasDefault: true, esModule: false, opaque: null } : { names: new Set(), hasDefault: true, esModule: false, opaque: 'JSON module is not an object' };
      } catch (e) { return { names: new Set(), hasDefault: true, esModule: false, opaque: 'unparsable JSON' }; }
    }
    if (!SCRIPT_EXT.test(file)) return { names: new Set(), hasDefault: true, esModule: false, opaque: 'not a script module (asset?)' };
    let ast;
    try { ast = parseSource(readFile(file), file); } catch (e) { return { names: new Set(), hasDefault: false, esModule: false, opaque: `cannot parse (${String(e.message).split('\n')[0]})` }; }

    const names = new Set();
    const reasons = [];
    let hasDefault = false;
    let esModule = false; // strict default semantics (ESM syntax or __esModule)
    let aliasResolved = 0;
    let aliasUnresolved = 0;
    const opaque = (why) => reasons.push(why);
    const add = (n) => {
      if (n === 'default') { hasDefault = true; return; }
      if (n === '__esModule') { esModule = true; return; }
      names.add(n);
    };
    const merge = (target, { star = false } = {}) => {
      for (const n of target.names) names.add(n);
      if (!star && target.esModule) { esModule = true; if (target.hasDefault) hasDefault = true; }
      if (target.opaque) opaque(target.opaque);
    };
    /** merge the exports of module `spec` as seen from this file; returns false when it is not in the graph */
    const mergeSpec = (spec, opts) => {
      const t = resolve(file, spec);
      if (!t) return false;
      merge(analyze(t), opts);
      return true;
    };

    // ---- ESM (top level only) ----
    for (const st of ast.program.body) {
      if (st.type === 'ExportNamedDeclaration') {
        if (st.exportKind === 'type' || st.exportKind === 'typeof') continue;
        esModule = true;
        const d = st.declaration;
        if (d) {
          if (d.declare) continue;
          if (d.type === 'VariableDeclaration') { const out = []; for (const x of d.declarations) patternNames(x.id, out); out.forEach(add); }
          else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration' || d.type === 'TSEnumDeclaration' || d.type === 'TSModuleDeclaration') && d.id) { if (d.id.type === 'Identifier') add(d.id.name); }
          // TS interface / type alias, Flow type / opaque type / interface: no runtime export
        }
        for (const sp of st.specifiers ?? []) {
          if (sp.exportKind === 'type') continue;
          const e = sp.exported;
          add(e.type === 'Identifier' ? e.name : e.value);
        }
      } else if (st.type === 'ExportDefaultDeclaration') {
        esModule = true;
        if (st.declaration && (st.declaration.type === 'TSInterfaceDeclaration')) continue;
        hasDefault = true;
      } else if (st.type === 'ExportAllDeclaration') {
        if (st.exportKind === 'type') continue;
        esModule = true;
        if (!mergeSpec(st.source.value, { star: true })) opaque(`export * from '${st.source.value}' is not in the module graph`);
      } else if (st.type === 'TSExportAssignment') {
        opaque('`export =` (TypeScript export assignment)');
      }
    }

    // ---- CJS (whole AST: Babel output may nest exports in IIFEs / if-blocks) ----
    const requireVars = new Map(); // local -> spec   (var _x = require('./x'))
    const objVars = new Map(); // local -> ObjectExpression
    walk(ast.program, (n) => {
      if (n.type === 'VariableDeclarator' && isId(n.id) && n.init) {
        const spec = findRequire(n.init);
        if (spec != null) requireVars.set(n.id.name, spec);
        else if (n.init.type === 'ObjectExpression') objVars.set(n.id.name, n.init);
      }
    });

    const aliasSpec = (spec, opts) => { if (mergeSpec(spec, opts)) aliasResolved++; else aliasUnresolved++; };
    const objectNames = (o) => {
      for (const p of o.properties) {
        if (p.type === 'SpreadElement') {
          const spec = requireSpec(p.argument) ?? (isId(p.argument) ? requireVars.get(p.argument.name) : null);
          if (spec != null) aliasSpec(spec, { star: true }); else opaque('object spread in module.exports');
        } else {
          const k = p.computed ? strOf(p.key) : p.key.type === 'Identifier' ? p.key.name : strOf(p.key) ?? (p.key.type === 'NumericLiteral' ? String(p.key.value) : null);
          if (k == null) opaque('computed key in module.exports object');
          else add(k);
        }
      }
    };
    const wholeValue = (right) => {
      if (!right) return;
      if (right.type === 'AssignmentExpression') return; // chain: the inner assignment is handled on its own
      if (right.type === 'ObjectExpression') return objectNames(right);
      if (right.type === 'UnaryExpression' && right.operator === 'void') return;
      const spec = requireSpec(right);
      if (spec != null) return aliasSpec(spec, {});
      if (isId(right)) {
        if (objVars.has(right.name)) return objectNames(objVars.get(right.name));
        if (requireVars.has(right.name)) return aliasSpec(requireVars.get(right.name), {});
      }
      opaque(`module.exports = ${right.type === 'Identifier' ? right.name : right.type} (not an object literal / require alias)`);
    };
    const exportTargetName = (left) => {
      // exports.x / module.exports.x / exports['x'] -> 'x' ; computed non literal -> undefined ; else null
      if (left.type !== 'MemberExpression' || !isExportsRoot(left.object)) return null;
      const k = propName(left);
      return k == null ? undefined : k;
    };

    walk(ast.program, (n) => {
      if (n.type === 'AssignmentExpression' && n.operator === '=') {
        if (isExportsRoot(n.left)) { if (isModuleExports(n.left)) wholeValue(n.right); return; }
        const k = exportTargetName(n.left);
        if (k === undefined) opaque('computed export name `exports[expr] =`');
        else if (k !== null) add(k);
      } else if (n.type === 'CallExpression') {
        const c = n.callee;
        if (c.type === 'MemberExpression' && !c.computed && isId(c.object, 'Object')) {
          const fn = c.property.name;
          if (fn === 'defineProperty' && isExportsRoot(n.arguments[0])) {
            const k = strOf(n.arguments[1]);
            if (k == null) opaque('Object.defineProperty(exports, <non-literal>)'); else add(k);
          } else if (fn === 'defineProperties' && isExportsRoot(n.arguments[0])) {
            const o = n.arguments[1];
            if (o && o.type === 'ObjectExpression') objectNames(o); else opaque('Object.defineProperties(exports, <non-literal>)');
          } else if (fn === 'assign' && isExportsRoot(n.arguments[0])) {
            for (const a of n.arguments.slice(1)) {
              if (a.type === 'ObjectExpression') objectNames(a);
              else { const spec = requireSpec(a) ?? (isId(a) ? requireVars.get(a.name) : null); if (spec != null) aliasSpec(spec, { star: true }); else opaque('Object.assign(exports, <non-literal>)'); }
            }
          }
        }
        // Object.keys(_x).forEach(function (key) { ... Object.defineProperty(exports, key, ...) })  (Babel wildcard re-export)
        if (c.type === 'MemberExpression' && !c.computed && isId(c.property, 'forEach') && c.object.type === 'CallExpression' &&
          c.object.callee.type === 'MemberExpression' && isId(c.object.callee.object, 'Object') && isId(c.object.callee.property, 'keys')) {
          let usesExports = false;
          walk(n.arguments[0] ?? {}, (x) => { if (isId(x, 'exports')) usesExports = true; });
          if (usesExports) {
            const a = c.object.arguments[0];
            const spec = requireSpec(a) ?? (isId(a) ? requireVars.get(a.name) : findRequire(a));
            if (spec != null) {
              const t = resolve(file, spec);
              if (t) { aliasResolved++; merge(analyze(t), { star: true }); } else aliasUnresolved++;
            } else opaque('wildcard re-export of an unresolvable value');
            return false; // handled: do not treat exports[key] inside as a computed export
          }
        }
        // tsc: __exportStar(require('./x'), exports) / tslib.__exportStar / __export(m)
        const cname = isId(c) ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : null;
        if ((cname === '__exportStar' || cname === '__export') && (n.arguments.length === 1 || isExportsRoot(n.arguments[1]))) {
          const a = n.arguments[0];
          const spec = requireSpec(a) ?? (isId(a) ? requireVars.get(a.name) : findRequire(a));
          if (spec != null) aliasSpec(spec, { star: true }); else opaque('__exportStar of an unresolvable value');
        }
      }
      return undefined;
    });

    if (aliasUnresolved > 0 && aliasResolved === 0 && reasons.length === 0 && names.size === 0) opaque('re-exported module is not in the module graph');
    return { names, hasDefault: esModule ? hasDefault : true, esModule, opaque: reasons.length ? [...new Set(reasons)].join('; ') : null };
  }

  return { analyze };
}

/**
 * Names a module imports from other modules, for the host-export-missing check.
 * Returns [{ spec, line, named: [{name, line}], default: line|null, ns: [{name, line}] (member accesses of `import * as ns`) }]
 * Type-only imports are skipped. `require('x')` destructuring / `require('x').name` count as named (never 'default').
 */
export function collectImports(code, file) {
  const ast = parseSource(code, file);
  const bySpec = new Map();
  const slot = (spec, line) => {
    if (!bySpec.has(spec)) bySpec.set(spec, { spec, line, named: [], default: null, ns: [] });
    return bySpec.get(spec);
  };
  const nsLocals = new Map(); // local ns identifier -> record
  for (const st of ast.program.body) {
    if (st.type === 'ImportDeclaration') {
      if (st.importKind === 'type' || st.importKind === 'typeof') continue;
      const rec = slot(st.source.value, st.loc.start.line);
      for (const sp of st.specifiers) {
        if (sp.importKind === 'type' || sp.importKind === 'typeof') continue;
        if (sp.type === 'ImportSpecifier') {
          const name = sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value;
          if (name === 'default') rec.default ??= sp.loc.start.line; else rec.named.push({ name, line: sp.loc.start.line });
        } else if (sp.type === 'ImportDefaultSpecifier') rec.default ??= sp.loc.start.line;
        else if (sp.type === 'ImportNamespaceSpecifier') nsLocals.set(sp.local.name, rec);
      }
    } else if ((st.type === 'ExportNamedDeclaration' && st.source) && st.exportKind !== 'type') {
      const rec = slot(st.source.value, st.loc.start.line);
      for (const sp of st.specifiers) {
        if (sp.type !== 'ExportSpecifier' || sp.exportKind === 'type') continue;
        const name = sp.local.type === 'Identifier' ? sp.local.name : sp.local.value;
        if (name === 'default') rec.default ??= sp.loc.start.line; else rec.named.push({ name, line: sp.loc.start.line });
      }
    }
  }
  const hasRequire = /\brequire\s*\(/.test(code);
  if (nsLocals.size || hasRequire) {
    walk(ast.program, (n) => {
      if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && nsLocals.has(n.object.name) && n.property.type === 'Identifier') {
        nsLocals.get(n.object.name).ns.push({ name: n.property.name, line: n.loc.start.line });
      } else if (hasRequire && n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier' && requireSpec(n.object) != null && n.property.name !== 'default') {
        slot(requireSpec(n.object), n.loc.start.line).named.push({ name: n.property.name, line: n.loc.start.line });
      } else if (hasRequire && n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && requireSpec(n.init) != null) {
        const rec = slot(requireSpec(n.init), n.loc.start.line);
        for (const p of n.id.properties) {
          if (p.type === 'ObjectProperty' && !p.computed) {
            const k = p.key.type === 'Identifier' ? p.key.name : strOf(p.key);
            if (k != null && k !== 'default') rec.named.push({ name: k, line: p.loc.start.line });
          }
        }
      }
    });
  }
  return [...bySpec.values()];
}
