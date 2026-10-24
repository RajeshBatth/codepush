// Ownership partition + direction-rule verification on the Metro graph (DESIGN.md section 4).
import fs from 'node:fs';
import path from 'node:path';
import { ownerOf } from './config.js';
import { pathKey } from './ids.js';
import { checkHostApi } from './public-api.js';
import {
  DEFAULT_CHECKS, loadCycleBaseline, findCycles, tarjan, findRequireContext, findDynamicRequirePlaceholders, checkRegisterComponent,
} from './checks.js';

export class VerificationError extends Error {
  constructor(violations, warnings = []) {
    super(
      `unit-splitter: ${violations.length} rule violation(s):\n` +
        violations.map((v) => `  [${v.rule}] ${v.message}`).join('\n') +
        (warnings.length ? `\n${warnings.length} warning(s):\n` + warnings.map((v) => `  [${v.rule}] ${v.message}`).join('\n') : ''),
    );
    this.name = 'VerificationError';
    this.violations = violations;
    this.warnings = warnings;
  }
}

const pkgCache = new Map();
/** {name, version, dir} of the npm package containing absPath, or null (not in node_modules). */
export function packageOf(absPath) {
  if (!absPath.includes(`${path.sep}node_modules${path.sep}`)) return null;
  let dir = path.dirname(absPath);
  while (dir !== path.dirname(dir)) {
    if (pkgCache.has(dir)) return pkgCache.get(dir);
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (j.name) {
          const r = { name: j.name, version: j.version, dir, json: j };
          pkgCache.set(dir, r);
          return r;
        }
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** Heuristic "pure JS" test (rule 4/5): no native code folders, podspec, codegen config. */
export function nativeEvidence(pkg) {
  const ev = [];
  for (const d of ['ios', 'android']) if (fs.existsSync(path.join(pkg.dir, d))) ev.push(`${d}/ directory`);
  if (fs.readdirSync(pkg.dir).some((f) => f.endsWith('.podspec'))) ev.push('podspec');
  if (pkg.json.codegenConfig) ev.push('codegenConfig');
  if (pkg.json['react-native']?.android || pkg.json['react-native']?.ios) ev.push('react-native platform config');
  return ev;
}

/**
 * @param graph Metro graph; @param preModules polyfills etc. (always host)
 * @param opts { projectRoot, units, base?, checks? } base = parsed units.json of the base build (patch mode);
 *   checks = normalized `checks` of units.config.json (see checks.js parseChecks)
 * @returns { owner: Map<absPath, ownerName>, violations (errors), warnings, newPackages: Map<unit, Set<pkgName>>,
 *            cycles: {owner: [{signature, modules, path, async}]}, checks: summary rule -> {severity, count, ...} }
 */
export function analyze(graph, preModules, { projectRoot, units, base = null, checks = DEFAULT_CHECKS }) {
  const violations = [];
  const warnings = [];
  const v = (rule, message) => violations.push({ rule, message });
  const w = (rule, message) => warnings.push({ rule, message });
  /** report under a configurable severity ('error' | 'warn' | 'off') */
  const report = (sev, rule, message) => (sev === 'error' ? v(rule, message) : sev === 'warn' ? w(rule, message) : undefined);
  const key = (p) => pathKey(p, projectRoot);
  const unitByName = new Map(units.map((u) => [u.name, u]));
  const mods = graph.dependencies;
  const baseKeys = new Set(base ? base.host.moduleKeys : []);

  const owner = new Map();
  for (const p of mods.keys()) owner.set(p, ownerOf(p, units));
  for (const m of preModules) owner.set(m.path, 'host');

  // Patch mode: a package that the base host does not contain and that is reached from a unit is
  // "new". If pure JS it is bundled INTO that unit (rule 4); otherwise it is a violation (rule 5).
  const newPackages = new Map();
  if (base) {
    const queue = [...mods.keys()].filter((p) => owner.get(p) !== 'host');
    while (queue.length) {
      const p = queue.pop();
      const unitName = owner.get(p);
      for (const dep of mods.get(p).dependencies.values()) {
        const t = dep.absolutePath;
        if (!t || owner.get(t) !== 'host') continue;
        const pkg = packageOf(t);
        if (!pkg || base.host.packages[pkg.name] !== undefined) continue;
        const ev = nativeEvidence(pkg);
        if (ev.length) {
          v('native-package', `unit ${unitName} imports new package ${pkg.name}@${pkg.version} which looks native (${ev.join(', ')}); not allowed OTA`);
          continue;
        }
        owner.set(t, unitName); // claimed by the unit; its own deps are explored next
        if (!newPackages.has(unitName)) newPackages.set(unitName, new Set());
        newPackages.get(unitName).add(`${pkg.name}@${pkg.version}`);
        queue.push(t);
      }
    }
    // A new package claimed by one unit but also needed by another unit is a duplicate (tier 3 #11):
    // it cannot live in two files under one id, so refuse.
    const seen = new Map();
    for (const [u, set] of newPackages) for (const p of set) {
      if (seen.has(p) && seen.get(p) !== u) v('new-package-in-multiple-units', `new package ${p} is imported by units ${seen.get(p)} and ${u}; add it to the host`);
      seen.set(p, u);
    }
  }

  const importSites = new Map(); // unit -> [`file (import('spec'))`] : host import() sites of the unit's entry
  for (const [p, mod] of mods) {
    const o = owner.get(p);
    for (const dep of mod.dependencies.values()) {
      const t = dep.absolutePath;
      if (!t) continue;
      const tOwner = owner.get(t);
      const asyncType = dep.data.data.asyncType;
      const isAsync = asyncType === 'async';
      const where = `${key(p)} -> ${key(t)}`;
      if (o !== 'host' && tOwner !== 'host' && o !== tOwner) {
        v('unit-to-unit', `unit ${o} imports unit ${tOwner} (${where}${asyncType ? ', via import()' : ''}); units may only import their own modules or the host, and only the host may import a unit (through lazyUnit)`);
      } else if (o === 'host' && tOwner !== 'host') {
        if (!isAsync) {
          v('host-to-unit-static', `host ${asyncType ? `loads unit ${tOwner} through ${asyncType} require` : `statically imports unit ${tOwner} (import, require() or re-export)`} (${where}); reach units only via lazyUnit(name, () => import(...))`);
        } else if (t !== unitByName.get(tOwner).entry) {
          v('host-imports-non-entry', `host import() targets ${key(t)} which is not the entry of unit ${tOwner} (${where})`);
        } else {
          checkLazyUnitName(p, dep.data.name, tOwner, units, v, key);
          if (!importSites.has(tOwner)) importSites.set(tOwner, []);
          importSites.get(tOwner).push(`${key(p)} import('${dep.data.name}')`);
        }
      } else if (o !== 'host' && tOwner === 'host' && base) {
        // Rule 3/4: everything leaving the unit must exist in the base host at the same package@version.
        const pkg = packageOf(t);
        const have = pkg && base.host.packages[pkg.name];
        if (pkg && have !== undefined && have !== pkg.version) {
          v('package-version-mismatch', `unit ${o} imports ${pkg.name}@${pkg.version} but the base host has ${pkg.name}@${have} (${where}); upgrading shared libs goes through the train/host lane`);
        } else if (!baseKeys.has(key(t))) {
          v('missing-in-base-host', `unit ${o} imports ${key(t)} which does not exist in the base host (${where})`);
        }
      }
    }
  }

  const summary = {};
  const count = (rule, sev, extra = {}) => { summary[rule] = { severity: sev, count: 0, ...extra }; return summary[rule]; };

  // ---- C2: one import site per unit entry ------------------------------------------------------------------------------
  const sis = count('single-import-site', checks.singleImportSite);
  for (const [u, sites] of [...importSites].sort()) {
    const uniqSites = [...new Set(sites)].sort();
    if (uniqSites.length > 1) {
      sis.count++;
      report(checks.singleImportSite, 'multiple-import-sites', `unit ${u} entry is imported from ${uniqSites.length} sites: ${uniqSites.join('; ')}; keep exactly one lazyUnit site per unit`);
    }
  }

  // ---- C1: cycles ---------------------------------------------------------------------------------------------------------
  const cycles = {};
  const keyOfMod = (p) => key(p);
  const isThirdParty = (p) => owner.get(p) === 'host' && key(p).startsWith('node_modules/');
  const staticSucc = (p) => {
    const out = [];
    for (const d of mods.get(p).dependencies.values()) if (d.absolutePath && mods.has(d.absolutePath) && d.data.data.asyncType == null) out.push(d.absolutePath);
    return out;
  };
  const allSucc = (p) => {
    const out = [];
    for (const d of mods.get(p).dependencies.values()) if (d.absolutePath && mods.has(d.absolutePath) && d.data.data.asyncType !== 'weak') out.push(d.absolutePath);
    return out;
  };
  const byOwner = new Map();
  for (const p of mods.keys()) {
    const o = owner.get(p);
    if (isThirdParty(p)) continue;
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o).push(p);
  }
  for (const o of ['host', ...units.map((u) => u.name)]) {
    const nodes = (byOwner.get(o) ?? []).sort();
    cycles[o] = findCycles(nodes, staticSucc, allSucc, keyOfMod);
  }
  // information only: cycles among third-party host modules (RN internals); never enforced
  const tp = [...mods.keys()].filter(isThirdParty);
  const tpSet = new Set(tp);
  const tpSucc = (p) => staticSucc(p).filter((x) => tpSet.has(x));
  const thirdPartyHostCycles = tarjan(tp, tpSucc).filter((c) => c.length > 1 || tpSucc(c[0]).includes(c[0])).length;

  // Cycles that cross owners can only be closed by the intended lazyUnit boundary (host -> unit entry via import(), unit -> host
  // static): every other cross-owner edge is a direction-rule error. They are by design: counted for information, never warned.
  const fp = [...mods.keys()];
  const fullSucc = (p) => allSucc(p);
  const lazyUnitBoundaryCycles = tarjan(fp, fullSucc).filter((c) => (c.length > 1 || fullSucc(c[0]).includes(c[0])) && new Set(c.map((p) => owner.get(p))).size > 1).length;

  const cyc = count('cycles', checks.cycles, { total: 0, baselined: 0, asyncOnly: 0, thirdPartyHostCycles, lazyUnitBoundaryCycles });
  const baseline = loadCycleBaseline(checks.cycleBaseline ? path.resolve(projectRoot, checks.cycleBaseline) : null);
  const baseCycles = base?.cycles ?? null;
  if (base && !baseCycles && checks.cycles !== 'off') w('cycles-base-missing', 'base build has no `cycles` record in units.json; comparing against the baseline file (checks.cycleBaseline) only' + (checks.cycleBaseline ? '' : ' (none configured: every cycle counts as new)'));
  const known = (o, c) => {
    const b = baseline.get(o);
    if (b && (b.sigs.has(c.signature) || b.sets.has(c.modules.join('\n')))) return true;
    return !!baseCycles?.[o]?.some((x) => x.signature === c.signature);
  };
  const owners = ['host', ...units.map((u) => u.name)];
  for (const o of owners) {
    for (const c of cycles[o]) {
      cyc.total++;
      const label = o === 'host' ? 'first-party host code' : `unit ${o}`;
      const chain = c.path.join(' -> ');
      if (c.async) {
        cyc.asyncOnly++;
        if (checks.cycles !== 'off') w('cycle-async', `cycle in ${label} through an import() edge (informational): ${chain} [${c.signature.slice(0, 12)}]`);
      } else if (known(o, c)) {
        cyc.baselined++;
      } else {
        cyc.count++;
        const policy = base && baseCycles ? 'new compared to the base build' : base ? 'not in the baseline file' : 'not in the baseline (checks.cycleBaseline)';
        report(checks.cycles, 'cycle', `dependency cycle in ${label}: ${chain} (${c.modules.length} module(s), signature ${c.signature.slice(0, 12)}; ${policy}). Break the cycle, or accept it with \`cli.js cycle-baseline\` + checks.cycleBaseline`);
      }
    }
  }

  // ---- C3: dynamic / unanalyzable references ------------------------------------------------------------------------------
  // Metro itself rejects a non-literal require()/import() in first-party code at transform time (translated in build.js);
  // third-party code gets a runtime-throwing placeholder instead. We scan code that must be analyzable: first-party host code,
  // unit code and packages claimed into a unit. Third-party host packages are only counted.
  const dyn = count('dynamic-require', checks.dynamicRequire, { thirdPartyModules: [] });
  const dynFindings = [];
  for (const [p, mod] of mods) {
    const k = key(p);
    const o = owner.get(p);
    const scanned = o !== 'host' || !k.startsWith('node_modules/');
    const out = mod.output.find((x) => x.type.startsWith('js/'));
    const code = out?.data?.code ?? '';
    const placeholders = code.includes('Dynamic require defined') ? findDynamicRequirePlaceholders(code) : [];
    if (!scanned) {
      if (placeholders.length) dyn.thirdPartyModules.push(k);
      continue;
    }
    for (const ph of placeholders) dynFindings.push(`${o === 'host' ? 'host' : `unit ${o}`}: ${k}${ph.line ? `:${ph.line}` : ''} has a non-literal require(); Metro turns it into a runtime error`);
    if (/\.(?:[cm]?jsx?|tsx?)$/.test(p)) {
      let src = null;
      try { src = fs.readFileSync(p, 'utf8'); } catch {}
      if (src != null && /require\s*\.\s*context\s*\(/.test(src)) {
        let found = [];
        try { found = findRequireContext(src, p); } catch (e) { w('unparsed-source', `${k}: cannot parse for the dynamic-require scan (${e.message.split('\n')[0]})`); }
        for (const f of found) dynFindings.push(`${o === 'host' ? 'host' : `unit ${o}`}: ${k}:${f.line} uses require.context(), whose module set is not statically declared`);
        if (!found.length && [...mod.dependencies.values()].some((d) => d.data.data.contextParams)) dynFindings.push(`${o === 'host' ? 'host' : `unit ${o}`}: ${k} uses require.context()`);
      }
    }
  }
  dyn.thirdPartyModules.sort();
  for (const m of dynFindings.sort()) { dyn.count++; report(checks.dynamicRequire, 'dynamic-require', m); }

  // ---- C4: unit entry registers its component under the unit name -------------------------------------------------------------
  if (checks.requireRegisterComponent) {
    const rc = count('register-component', 'error');
    for (const u of units) {
      const msg = checkRegisterComponent(u.entry, u.name);
      if (msg) { rc.count++; v('register-component', `unit ${u.name} (${key(u.entry)}): ${msg}`); }
    }
  }

  // ---- C5: host API used by units (host-export-missing), public packages (deep imports, API snapshot) -----------------------
  const { publicApi } = checkHostApi({ mods, owner, units, projectRoot, checks, key, v, w, report, count });

  // De-dup (a module can be reported via several keys).
  const uniqBy = (list) => [...new Map(list.map((x) => [x.rule + x.message, x])).values()];
  return { owner, violations: uniqBy(violations), warnings: uniqBy(warnings), newPackages, cycles, checks: summary, publicApi };
}

/** `lazyUnit('cabs', () => import('../units/cabs/entry'))`: the name must match the unit that owns the target. */
function checkLazyUnitName(hostFile, specifier, ownerUnit, units, v, key) {
  const src = fs.readFileSync(hostFile, 'utf8');
  const re = /lazyUnit\(\s*['"]([\w-]+)['"]\s*,\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    // the import() specifier is compared as written (relative or bare package specifier): it is what Metro resolved to the entry
    if (m[2] === specifier && m[1] !== ownerUnit) {
      v('lazyUnit-name-mismatch', `${key(hostFile)}: lazyUnit('${m[1]}') imports '${specifier}' which belongs to unit ${ownerUnit}`);
    }
  }
}
