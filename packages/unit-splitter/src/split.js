// Two ways to turn ONE Metro graph into host.js + units/<name>.js.
//   (a) serializer: a customSerializer receives the whole graph and emits all files itself.
//   (c) post-process: take Metro's stock single-file bundle and cut it at `__d(...)` statements.
import { parse } from '@babel/parser';
import { analyze, VerificationError } from './analyze.js';
import { baseJSBundle, bundleToString, getAppendScripts as appendScripts, wrapModules } from './metro-compat.js';

/**
 * Approach (a): customSerializer. Metro hands us (entryPoint, preModules, graph, options) for the
 * WHOLE graph; we write nothing ourselves, we stash the strings on `sink` and return the host code.
 */
export function makeSplitSerializer({ projectRoot, units, base, sink, approach = 'serializer', checks }) {
  return async (entryPoint, preModules, graph, options) => {
    const { owner, violations, warnings, newPackages, cycles, checks: checksSummary, publicApi, assets, nativeRefs } = analyze(graph, preModules, { projectRoot, units, base, checks });
    if (violations.length) throw new VerificationError(violations, warnings);

    const { createModuleId } = options;
    for (const m of graph.dependencies.values()) createModuleId(m.path); // register ids (collision check)
    for (const m of preModules) createModuleId(m.path);
    sink.analysis = { owner, newPackages, graph, preModules, warnings, cycles, checks: checksSummary, publicApi, assets, nativeRefs };

    if (approach === 'postprocess') {
      // (c): stock single-file bundle; split happens later from the id->path map.
      sink.stock = bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code;
      return { code: sink.stock, map: '{}' };
    }

    // `paths` is NOT emitted by Metro for non-lazy builds, so map each unit-entry dependency to its unit name ourselves.
    const entryToUnit = new Map(units.map((u) => [u.entry, u.name]));
    const asyncPathOf = (dep) => entryToUnit.get(dep.absolutePath) ?? null;
    const processModules = (mods) => wrapModules(mods, options, asyncPathOf);
    const sorted = [...graph.dependencies.values()].sort((a, b) => createModuleId(a.path) - createModuleId(b.path));

    const pre = processModules(preModules).map(([, c]) => c).join('\n');
    const post = processModules(
      appendScripts(entryPoint, [...preModules, ...sorted], {
        createModuleId,
        getRunModuleStatement: options.getRunModuleStatement,
        globalPrefix: options.globalPrefix,
        runBeforeMainModule: options.runBeforeMainModule,
        runModule: options.runModule,
        shouldAddToIgnoreList: options.shouldAddToIgnoreList,
      }),
    ).map(([, c]) => c).join('\n');

    const defsByOwner = new Map();
    for (const [mod, code] of processModules(sorted)) {
      const o = owner.get(mod.path);
      if (!defsByOwner.has(o)) defsByOwner.set(o, []);
      defsByOwner.get(o).push(code);
    }
    const r = (sink.result = { host: '', units: {} });
    r.host = (pre.length ? pre + '\n' : '') + (defsByOwner.get('host') ?? []).map((c) => c + '\n').join('') + post;
    for (const u of units) r.units[u.name] = (defsByOwner.get(u.name) ?? []).map((c) => c + '\n').join('');
    return { code: r.host, map: '{}' };
  };
}

/**
 * Approach (c): split a stock serialized bundle. Needs only the id->path map (ids.json) and the
 * unit config. The bundle is parsed and cut at top-level `__d(...)` statements; module ownership
 * is looked up by id. Host modules whose dependency array contains a unit-entry id get the
 * `{...deps, paths:{id:"unit"}}` form (the stock serializer omitted `paths`).
 */
export function splitSerializedBundle(code, { ownerById, entryIdToUnit, unitNames }) {
  const ast = parse(code, { sourceType: 'script' });
  const defs = []; // {id, start, end}
  for (const st of ast.program.body) {
    const e = st.expression;
    if (st.type === 'ExpressionStatement' && e.type === 'CallExpression' && e.callee.name === '__d') {
      defs.push({ id: e.arguments[1].value, start: st.start, end: st.end, args: e.arguments });
    }
  }
  const pre = code.slice(0, defs[0].start);
  const post = code.slice(defs[defs.length - 1].end).replace(/^\n/, '');
  const hostDefs = [];
  const unitDefs = Object.fromEntries(unitNames.map((n) => [n, []]));
  for (const d of defs) {
    let text = code.slice(d.start, d.end);
    const o = ownerById(d.id);
    if (o === 'host') {
      const deps = d.args[2];
      if (deps && deps.type === 'ArrayExpression' && deps.elements.some((el) => el && entryIdToUnit.has(el.value))) {
        const obj = {};
        const paths = {};
        deps.elements.forEach((el, i) => {
          obj[i] = el.type === 'NullLiteral' ? null : el.value;
          if (el.type !== 'NullLiteral' && entryIdToUnit.has(el.value)) paths[el.value] = entryIdToUnit.get(el.value);
        });
        text = text.slice(0, deps.start - d.start) + JSON.stringify({ ...obj, paths }) + text.slice(deps.end - d.start);
      }
      hostDefs.push(text);
    } else {
      unitDefs[o].push(text);
    }
  }
  return {
    host: pre + hostDefs.map((c) => c + '\n').join('') + post,
    units: Object.fromEntries(unitNames.map((n) => [n, unitDefs[n].map((c) => c + '\n').join('')])),
  };
}
