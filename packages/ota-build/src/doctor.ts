// `ota-build doctor`: readiness check for adopting the OTA tooling in a real React Native project.
// Every check yields PASS / WARN / FAIL (or MANUAL when it cannot be automated) with a one-line remedy. FAIL means the
// pipeline will refuse or produce wrong output; WARN means it works but something deserves a look.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRepro } from './bundle.ts';
import { RN_VERSION, hermescSupportsBaseBytecode, resolveHdiffz, resolveHermesc, resolveOtaApply, type HermescInfo } from './tools.ts';
import { HERMESC_PIN_TABLE, PIN_KEYS, pinKeyForHost } from './pins.ts';
import { childEnv, describeOrigin, hashFile, rmrf, run, toolsDir, workDir } from './util.ts';
import type { Platform } from './types.ts';
// @ts-ignore: plain-JS package, imported by relative path (no build step)
import { loadUnitsConfig, resolveMetroConfigFile } from '../../unit-splitter/src/config.js';
// @ts-ignore: plain-JS package
import { describeMetro } from '../../unit-splitter/src/metro-compat.js';

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'MANUAL';
export interface Check { id: string; title: string; status: Status; detail: string; remedy?: string }
export interface DoctorOptions { project: string; platform?: Platform; deep?: boolean; /** `off` = delta compile not needed (default auto: patch builds use it) */ delta?: 'auto' | 'on' | 'off' }
export interface DoctorReport { project: string; platform: Platform | 'both'; checks: Check[]; ok: boolean }

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, 'doctor-probe.mjs');
const SPLITTER_METRO_PKG = resolve(HERE, '../../unit-splitter/node_modules/metro/package.json');
/** Metro lines the splitter's internals adapter supports (keep in sync with unit-splitter/src/metro-compat.js SUPPORTED). */
const SUPPORTED_METRO_LINES = ['0.81', '0.87'];

const readJsonLoose = <T>(p: string): T | null => {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
};
const parseVer = (v: string): [number, number, number] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const line = (v: string): string | null => { const p = parseVer(v); return p ? `${p[0]}.${p[1]}` : null; };
const firstLine = (e: unknown): string => String((e as Error).message ?? e).split('\n')[0];

/** Resolve `<pkg>/package.json` the way Node would from the project; falls back to resolving from RN's own dependencies. */
function findPackageJson(project: string, name: string): { version: string; from: string } | null {
  const bases = [join(project, 'package.json')];
  for (const via of ['react-native', '@react-native/metro-config']) {
    try { bases.push(createRequire(join(project, 'package.json')).resolve(`${via}/package.json`)); } catch { /* not installed */ }
  }
  for (const base of bases) {
    try {
      const p = createRequire(base).resolve(`${name}/package.json`);
      const v = readJsonLoose<{ version: string }>(p)?.version;
      if (v) return { version: v, from: p };
    } catch { /* try next */ }
  }
  return null;
}

export async function runDoctor(o: DoctorOptions): Promise<DoctorReport> {
  const project = resolve(o.project);
  const platforms: Platform[] = o.platform ? [o.platform] : ['android', 'ios'];
  const checks: Check[] = [];
  const add = (id: string, title: string, status: Status, detail: string, remedy?: string) => checks.push({ id, title, status, detail, remedy });

  // 1. Node
  const nv = parseVer(process.versions.node)!;
  if (nv[0] < 22 || (nv[0] === 22 && nv[1] < 12)) add('node', 'Node >= 22.12 (require(esm))', 'FAIL', `Node ${process.versions.node}`, 'install Node >= 22.12 (24 recommended: ota-build runs TypeScript by type stripping)');
  else if (nv[0] < 24) add('node', 'Node >= 22.12 (require(esm))', 'WARN', `Node ${process.versions.node}: require(esm) works, but ota-build/ota-cli declare node >= 24`, 'use Node 24 (native type stripping without flags)');
  else add('node', 'Node >= 22.12 (require(esm))', 'PASS', `Node ${process.versions.node}`);

  // 2. project + package.json
  const pkg = existsSync(join(project, 'package.json')) ? readJsonLoose<Record<string, unknown>>(join(project, 'package.json')) : null;
  if (!existsSync(project)) {
    add('project', 'project directory', 'FAIL', `${project} does not exist`, 'pass --project <dir of the app (where package.json lives)>');
    return finish();
  }
  if (!pkg) add('project', 'package.json', 'FAIL', `${join(project, 'package.json')} missing or not valid JSON`, 'point --project at the app root (the directory with package.json and units.config.json)');
  else add('project', 'package.json', 'PASS', `${(pkg.name as string) ?? '(unnamed)'}`);

  // 3. react-native version
  const rn = findPackageJson(project, 'react-native');
  if (!rn) add('react-native', 'react-native version', 'WARN', 'react-native is not resolvable from the project', 'expected only for the demo fixtures; a real app needs react-native 0.78.x installed (npm install)');
  else if (line(rn.version) !== line(RN_VERSION)) add('react-native', 'react-native version', 'WARN', `${rn.version} (the pinned toolchain targets ${RN_VERSION})`, `hermesc is pinned for RN ${RN_VERSION}; for ${rn.version} add its hermesc sha256 to HERMESC_PINS in tools.ts and re-verify the splitter on Metro for that RN`);
  else if (rn.version !== RN_VERSION) add('react-native', 'react-native version', 'WARN', `${rn.version} (pin is ${RN_VERSION}; same 0.78 line)`, 'confirm hermesc sha256 is unchanged (see the hermesc check)');
  else add('react-native', 'react-native version', 'PASS', rn.version);

  // 4. metro / metro-config
  let splitterMetro: string | null = null;
  splitterMetro = readJsonLoose<{ version: string }>(SPLITTER_METRO_PKG)?.version ?? null;
  const metro = findPackageJson(project, 'metro');
  const metroCfg = findPackageJson(project, 'metro-config');
  if (!metro) add('metro', 'metro version (from the project)', 'WARN', 'metro is not resolvable from the project', `the splitter falls back to its own copy ${splitterMetro ?? '(not installed: npm install in packages/unit-splitter)'}; a real app should have metro 0.81.x via react-native`);
  else {
    const l = line(metro.version);
    if (!l || !SUPPORTED_METRO_LINES.includes(l)) add('metro', 'metro version (from the project)', 'FAIL', `${metro.version} (${metro.from}); the splitter's Metro-internals adapter supports ${SUPPORTED_METRO_LINES.map((x) => x + '.x').join(', ')} only`, 'align the project to RN 0.78 (Metro 0.81.x) or extend unit-splitter/src/metro-compat.js and its test matrix first');
    else if (splitterMetro && l !== line(splitterMetro)) add('metro', 'metro version (from the project)', 'WARN', `project ${metro.version} vs ${splitterMetro} (the version the splitter's test suite is verified against; different line, but supported): the PROJECT's Metro runs`, 'run the splitter test matrix (scripts/metro-matrix.sh) for this line before trusting it');
    else if (splitterMetro && metro.version !== splitterMetro) add('metro', 'metro version (from the project)', 'WARN', `project ${metro.version} vs ${splitterMetro} (the version the splitter's test suite is verified against; same line, different patch): the PROJECT's Metro runs`, 'fine in practice; pin the project\'s Metro in its lockfile to keep builds reproducible');
    else add('metro', 'metro version (from the project)', 'PASS', `${metro.version} (splitter ${splitterMetro ?? 'n/a'})`);
    if (metroCfg && metroCfg.version !== metro.version) add('metro-config', 'metro-config matches metro', 'WARN', `metro-config ${metroCfg.version} != metro ${metro.version}`, 'make metro and metro-config the same version');
    else if (!metroCfg) add('metro-config', 'metro-config matches metro', 'WARN', 'metro-config not resolvable from the project', 'install @react-native/metro-config (brings metro-config)');
    else add('metro-config', 'metro-config matches metro', 'PASS', metroCfg.version);
  }

  // 4b. the Metro that WILL run (the project's, else the splitter's fallback copy) and whether the version gate accepts it
  try {
    const d = describeMetro(project) as { source: 'project' | 'fallback'; version: string; path: string; packages: Record<string, { version: string; from: string; path: string }> };
    const l = line(d.version);
    const parts = Object.entries(d.packages).map(([n, x]) => `${n} ${x.version} (${x.from === 'project' ? "project's" : x.from === 'metro' ? "next to metro" : "splitter's"})`).join(', ');
    if (!l || !SUPPORTED_METRO_LINES.includes(l)) add('metro-runs', 'Metro that will run', 'FAIL', `${d.source === 'project' ? "the project's" : "the splitter's fallback"} metro ${d.version} at ${d.path}: unsupported line (supported: ${SUPPORTED_METRO_LINES.map((x) => x + '.x').join(', ')})`, 'align the project to RN 0.78 (Metro 0.81.x)');
    else if (Object.values(d.packages).some((x) => x.version !== d.version)) add('metro-runs', 'Metro that will run', 'FAIL', `metro, metro-config and metro-runtime differ (${parts}); the splitter refuses to run`, 'pin metro, metro-config and metro-runtime to one exact version in the project');
    else if (d.source === 'fallback') add('metro-runs', 'Metro that will run', 'WARN', `the splitter's FALLBACK copy metro ${d.version} at ${d.path}: the project has no metro of its own (${parts})`, 'a real app resolves metro from its own node_modules (react-native brings it); install the project dependencies');
    else add('metro-runs', 'Metro that will run', 'PASS', `the PROJECT's metro ${d.version} at ${d.path} (${parts})`);
  } catch (e) { add('metro-runs', 'Metro that will run', 'FAIL', firstLine(e), 'install the project dependencies (npm install)'); }

  // 5. units.config.json
  const ucPath = join(project, 'units.config.json');
  let cfg: { entry?: string; metroConfig?: string; units?: { name: string; roots: string[]; entry: string }[] } | null = null;
  if (!existsSync(ucPath)) add('units-config', 'units.config.json present and valid', 'FAIL', `${ucPath} not found`, 'create units.config.json: {"units":[{"name":"cabs","roots":["src/units/cabs"],"entry":"src/units/cabs/entry.js"}]}');
  else {
    cfg = readJsonLoose(ucPath);
    const shapeOk = cfg && Array.isArray(cfg.units) && cfg.units.every((u) => typeof u?.name === 'string' && Array.isArray(u.roots) && u.roots.every((r) => typeof r === 'string') && typeof u.entry === 'string');
    if (!shapeOk) add('units-config', 'units.config.json present and valid', 'FAIL', 'not valid JSON, or "units" is not an array of {name, roots: string[], entry: string}', 'fix units.config.json (see unit-splitter README)');
    else add('units-config', 'units.config.json present and valid', 'PASS', `${cfg!.units!.length} unit(s): ${cfg!.units!.map((u) => u.name).join(', ')}`);
    if (shapeOk) {
      try {
        const resolved = loadUnitsConfig(project) as { name: string }[];
        add('units-resolve', 'unit roots exist, entries exist, roots disjoint', 'PASS', `${resolved.length} unit(s) resolve`);
      } catch (e) {
        add('units-resolve', 'unit roots exist, entries exist, roots disjoint', 'FAIL', firstLine(e), 'fix the root/entry named in the message (roots are project-relative dirs or installed package names; run npm install for package roots)');
      }
      const hostEntry = cfg!.entry ?? 'src/host/index.js';
      if (existsSync(join(project, hostEntry))) add('host-entry', 'host entry file', 'PASS', hostEntry);
      else add('host-entry', 'host entry file', 'FAIL', `${hostEntry} does not exist`, 'set "entry" in units.config.json to the app\'s JS entry (the file Metro bundles as host.js); the splitter default is src/host/index.js');
    }
  }

  // 6. metro.config.js + withOtaUnits wiring
  // same rule as the splitter's build(): "metroConfig" names it; absent = auto-detect <project>/metro.config.js; false = never use it
  const mc = cfg ? (resolveMetroConfigFile(project, cfg) as { file: string | null; source: string }) : { file: null, source: 'none' };
  const metroFile = mc.file ?? (mc.source === 'disabled' && existsSync(join(project, 'metro.config.js')) ? 'metro.config.js' : null);
  if (!metroFile) add('metro-config-wired', 'metro.config.js wires withOtaUnits', 'WARN', 'no metro.config.js (and none named by "metroConfig" in units.config.json): the splitter assembles its own Metro config (demo mode)', 'in a real app: add withOtaUnits to metro.config.js (auto-detected; or name it with "metroConfig" in units.config.json)');
  else if (!existsSync(join(project, metroFile))) add('metro-config-wired', 'metro.config.js wires withOtaUnits', 'FAIL', `units.config.json names metroConfig "${metroFile}" but it does not exist`, 'fix the "metroConfig" path');
  else {
    const r = run(process.execPath, [PROBE, project, metroFile], { cwd: project, env: childEnv({ OTA_UNITS_BUILD: '1' }), timeoutMs: 60_000 });
    const lineOut = r.stdout.split('\n').find((l) => l.startsWith('OTA_DOCTOR_PROBE '));
    const probe = lineOut ? (JSON.parse(lineOut.slice('OTA_DOCTOR_PROBE '.length)) as { loaded: boolean; error?: string; customSerializer?: boolean; createModuleIdFactory?: boolean; blocked?: Record<string, boolean> }) : null;
    if (r.timedOut) add('metro-config-wired', 'metro.config.js wires withOtaUnits', 'FAIL', `loading ${metroFile} timed out after 60 s`, 'the config must load without side effects such as starting servers');
    else if (!probe || !probe.loaded) add('metro-config-wired', 'metro.config.js wires withOtaUnits', 'FAIL', `${metroFile} does not load: ${probe?.error ?? (r.stderr.split('\n')[0] || 'no probe output')}`, 'fix the config (needs Node >= 22.12 for require() of the ESM splitter; check relative paths to unit-splitter/with-ota-units.js)');
    else if (!probe.customSerializer || !probe.createModuleIdFactory) add('metro-config-wired', 'metro.config.js wires withOtaUnits', 'FAIL', `loaded with OTA_UNITS_BUILD=1 but serializer.customSerializer=${!!probe.customSerializer}, createModuleIdFactory=${!!probe.createModuleIdFactory}`, 'wrap the exported config: module.exports = withOtaUnits(mergeConfig(getDefaultConfig(__dirname), {...}), {units, projectRoot: __dirname})');
    else add('metro-config-wired', 'metro.config.js wires withOtaUnits', 'PASS', `${metroFile}: customSerializer and createModuleIdFactory set`);
    if (mc.source === 'disabled' && existsSync(join(project, 'metro.config.js'))) add('metro-config-used', 'splitter actually uses metro.config.js', 'WARN', 'metro.config.js exists but units.config.json has "metroConfig": false: the splitter ignores it and uses its own config', 'remove "metroConfig": false (metro.config.js is auto-detected)');
    else if (mc.source === 'auto-detected') add('metro-config-used', 'splitter actually uses metro.config.js', 'PASS', `${metroFile} is auto-detected (no "metroConfig" key needed)`);

    // Metro crawl sanity (blockList for native build dirs)
    const nativeDirs: [string, string][] = [['ios/Pods', 'ios/Pods'], ['ios/build', 'ios/build'], ['android/app/build', 'android/app/build'], ['android/build', 'android/build'], ['android/.gradle', 'android/.gradle']];
    const exposed = probe?.loaded ? nativeDirs.filter(([rel]) => existsSync(join(project, rel)) && probe.blocked && probe.blocked[rel] === false).map(([rel]) => rel) : [];
    const dangling = danglingSymlinks(join(project, 'ios/Pods'));
    if (!probe?.loaded) add('metro-crawl', 'Metro will not crawl native build dirs', 'MANUAL', 'config did not load; cannot inspect resolver.blockList', 'once the config loads, re-run doctor');
    else if (exposed.length || (dangling.length && probe.blocked && !probe.blocked['ios/Pods'])) {
      add('metro-crawl', 'Metro will not crawl native build dirs', 'WARN', `resolver.blockList does not exclude: ${exposed.join(', ') || 'ios/Pods'}${dangling.length ? `; ${dangling.length} dangling symlink(s) under ios/Pods (e.g. ${dangling[0]})` : ''}`, 'add to resolver.blockList: /\\/ios\\/(Pods|build)\\/.*/, /\\/android\\/(app\\/build|build|\\.gradle|\\.cxx)\\/.*/ (see examples/spike-app/metro.config.js)');
    } else add('metro-crawl', 'Metro will not crawl native build dirs', 'PASS', 'native build dirs are blocked or absent');
  }

  // 7. node_modules must be a real directory
  try {
    const nm = join(project, 'node_modules');
    if (!existsSync(nm)) add('node-modules', 'node_modules is a real directory', 'WARN', 'no node_modules in the project', 'run npm install (a hoisted monorepo root node_modules is fine, but then the packages resolve above the project)');
    else if (lstatSync(nm).isSymbolicLink()) add('node-modules', 'node_modules is a real directory', 'FAIL', `node_modules is a symlink to ${realpathSync(nm)}: Metro's crawler/watcher does not follow it`, 'replace the symlink with a real install (or use workspaces/watchFolders instead of linking the whole node_modules)');
    else add('node-modules', 'node_modules is a real directory', 'PASS', 'real directory');
  } catch (e) { add('node-modules', 'node_modules is a real directory', 'WARN', firstLine(e)); }

  // 8. Hermes enabled
  const hermesProblems: string[] = [];
  const hermesFacts: string[] = [];
  if (platforms.includes('android')) {
    const gp = join(project, 'android/gradle.properties');
    if (existsSync(gp)) {
      const m = /^\s*hermesEnabled\s*=\s*(\w+)/m.exec(readFileSync(gp, 'utf8'));
      if (m && m[1] !== 'true') hermesProblems.push(`android/gradle.properties hermesEnabled=${m[1]}`);
      else hermesFacts.push(m ? 'android hermesEnabled=true' : 'android: hermesEnabled unset (RN default true)');
    }
  }
  if (platforms.includes('ios')) {
    const pf = join(project, 'ios/Podfile');
    if (existsSync(pf)) {
      const txt = readFileSync(pf, 'utf8');
      const m = /hermes_enabled\s*(?:=>|:|=)\s*(true|false)/.exec(txt);
      if (m && m[1] === 'false') hermesProblems.push('ios/Podfile hermes_enabled => false');
      else if (/USE_HERMES\s*(?:=|'\]\s*=)\s*['"]?0/.test(txt)) hermesProblems.push('ios/Podfile sets USE_HERMES=0');
      else hermesFacts.push(m ? 'ios hermes_enabled=true' : 'ios: hermes_enabled unset (RN default true)');
    }
  }
  if (hermesProblems.length) add('hermes-engine', 'Hermes is the JS engine', 'FAIL', hermesProblems.join('; '), 'enable Hermes: the OTA pipeline ships .hbc bytecode only');
  else if (!hermesFacts.length) add('hermes-engine', 'Hermes is the JS engine', 'MANUAL', 'no android/gradle.properties or ios/Podfile in the project', 'verify manually that both apps run Hermes (hermesEnabled=true / hermes_enabled => true)');
  else add('hermes-engine', 'Hermes is the JS engine', 'PASS', hermesFacts.join('; '));

  // 9. hermesc: pinned binary (selected by this host's OS/arch) vs the project's own react-native copy
  let pinned: HermescInfo | null = null;
  let pinnedErr: string | null = null;
  try { pinned = resolveHermesc({ allowUnpinned: true }); } catch (e) { pinnedErr = firstLine(e); }
  const hostKey = pinKeyForHost();
  const pin = hostKey ? HERMESC_PIN_TABLE[hostKey] : null;
  const projHermesc = pin ? join(project, 'node_modules/react-native/sdks/hermesc', pin.dir, pin.binary) : null;
  const projSha = projHermesc && existsSync(projHermesc) ? hashFile(projHermesc) : null;
  const pinsTxt = PIN_KEYS.map((k) => `${k}=${HERMESC_PIN_TABLE[k].nodePlatform}/${HERMESC_PIN_TABLE[k].arches.join('+')}`).join(', ');
  if (!pin) add('hermesc', 'pinned hermesc matches the project\'s React Native', 'FAIL', `no hermesc pin for ${process.platform}/${process.arch} (pins: ${pinsTxt})`, 'add a pin for this OS/arch to src/pins.ts (sha256 of node_modules/react-native/sdks/hermesc/<dir>/<binary>)');
  else if (!pinned) add('hermesc', 'pinned hermesc matches the project\'s React Native', 'FAIL', pinnedErr!, 'run: node packages/ota-build/src/cli.ts fetch-tools (or set OTA_HERMESC / OTA_TOOLS_DIR)');
  else {
    const facts = `${pin.key} pin; using ${pinned.path} (${pinned.origin ? describeOrigin(pinned.origin) : 'default'}) ${pinned.sha256.slice(0, 19)}... (RN ${pinned.rn}, HBC v${pinned.hbcVersion}${pinned.pinned ? '' : ', NOT the pinned sha'})${projSha ? `; project ${projSha.slice(0, 19)}...` : '; project has no hermesc'}`;
    if (!pinned.pinned) add('hermesc', 'pinned hermesc matches the project\'s React Native', 'FAIL', facts, 'run fetch-tools --force; the binary on disk is not the pinned one');
    else if (projSha && projSha !== pinned.sha256) add('hermesc', 'pinned hermesc matches the project\'s React Native', 'FAIL', `${facts}: DIFFERENT binaries, bytecode may differ from what the app ships`, `the app was built with another RN: update RN_VERSION and the pin table in src/pins.ts to the project's hermesc and re-run fetch-tools (an OTA bytecode must match the embedded Hermes exactly)`);
    else if (!projSha) add('hermesc', 'pinned hermesc matches the project\'s React Native', 'WARN', `${facts}: cannot compare`, 'install react-native in the project to cross-check, or confirm manually that the shipped app uses this hermesc build');
    else add('hermesc', 'pinned hermesc matches the project\'s React Native', 'PASS', `${facts}: identical`);
  }

  // 9b. hermesc delta mode (-base-bytecode): patch builds compile against the embedded base, ~30x smaller host patches
  {
    const title = 'hermesc supports -base-bytecode (delta compile)';
    const mode = o.delta ?? 'auto';
    if (!pinned) add('hermesc-delta', title, 'WARN', 'cannot check: no usable hermesc (see the hermesc check)', 'fix the hermesc check first');
    else if (hermescSupportsBaseBytecode(pinned.path)) add('hermesc-delta', title, 'PASS', `${pinned.path}: \`hermesc -help\` lists -base-bytecode`);
    else if (mode === 'off') add('hermesc-delta', title, 'WARN', `${pinned.path} has no -base-bytecode; --delta off, patches are built plain (host patches ~30x larger)`, 'use the pinned RN hermesc (fetch-tools) to enable delta compile');
    else add('hermesc-delta', title, 'FAIL', `${pinned.path}: \`hermesc -help\` does not list -base-bytecode, but patch builds use delta compile (--delta ${mode})`, `use the pinned RN ${RN_VERSION} hermesc (run: node packages/ota-build/src/cli.ts fetch-tools --force; do not point OTA_HERMESC at an older/stripped build) or run patch builds with --delta off (patches get ~30x larger for string edits)`);
  }

  // 10. native tools + tools/work dirs, with where each location came from
  for (const [id, name, f] of [['hdiffz', 'hdiffz_tool', resolveHdiffz], ['ota-apply', 'ota_apply', resolveOtaApply]] as const) {
    try { const t = f(); add(id, `${name} found`, 'PASS', `${t.path} (${t.sha256.slice(0, 19)}...; ${t.origin ? describeOrigin(t.origin) : 'default'})`); }
    catch (e) { add(id, `${name} found`, 'FAIL', firstLine(e), `build native tools (README Setup step 1) or set ${id === 'hdiffz' ? 'OTA_HDIFFZ (or --hdiffz)' : 'OTA_APPLY (or --ota-apply)'}`); }
  }
  const td = toolsDir();
  const hermescOverride = !!process.env.OTA_HERMESC;
  if (existsSync(td.path)) add('tools-dir', 'tools directory (hermesc cache)', 'PASS', `${td.path} (${describeOrigin(td.origin)})`);
  else add('tools-dir', 'tools directory (hermesc cache)', hermescOverride ? 'PASS' : 'FAIL', hermescOverride ? `absent (${td.path}), but OTA_HERMESC=${process.env.OTA_HERMESC}` : `${td.path} missing (${describeOrigin(td.origin)})`, 'run: node packages/ota-build/src/cli.ts fetch-tools (or set OTA_TOOLS_DIR / OTA_HERMESC)');
  const wd = workDir();
  add('work-dir', 'work directory', 'PASS', `${wd.path} (${describeOrigin(wd.origin)})${existsSync(wd.path) ? '' : '; created on demand'}`);

  // 11. things a script cannot judge
  add('native-modules', 'native module / host changes are reviewed', 'MANUAL', 'Tier-1 rule 5 (NativeModules scan) is not automated', 'review PRs that add native modules or change host exports; they cannot ship OTA');
  add('toolchain-image', 'CI toolchain image is pinned', 'MANUAL', 'base-info records toolchainImage "local-unpinned" unless --toolchain-image is passed', 'pass --toolchain-image <registry/img@sha256:...> in the base release job and run the same image for verify/deploy');

  // 12. deep: bundle + verify-repro
  if (o.deep) {
    const platform = o.platform ?? 'android';
    if (checks.some((c) => c.status === 'FAIL')) add('deep-repro', `bundle + verify-repro (${platform})`, 'WARN', 'skipped: fix the FAIL checks first', 'rerun with --deep once everything else passes');
    else {
      const work = join(workDir().path, `doctor-${process.pid}`);
      const t0 = Date.now();
      try {
        const r = await verifyRepro({ project, platform, workDir: work });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.ok) add('deep-repro', `bundle + verify-repro (${platform})`, 'PASS', `2 builds in ${secs} s (~${(Number(secs) / 2).toFixed(1)} s each), ${r.files} files byte-identical, build.json ${r.buildJsonHash.slice(0, 19)}...`);
        else add('deep-repro', `bundle + verify-repro (${platform})`, 'FAIL', `NOT reproducible after ${secs} s: ${r.differences.slice(0, 3).join('; ')}`, 'find the nondeterminism (absolute paths, env-dependent babel/Metro config, timestamps); outputs kept in ' + work);
      } catch (e) {
        add('deep-repro', `bundle + verify-repro (${platform})`, 'FAIL', firstLine(e), 'run `ota-build bundle` on its own to see the full error');
      } finally {
        if (checks.find((c) => c.id === 'deep-repro')?.status === 'PASS') rmrf(work);
      }
    }
  }
  return finish();

  function finish(): DoctorReport {
    return { project, platform: o.platform ?? 'both', checks, ok: !checks.some((c) => c.status === 'FAIL') };
  }
}

/** Dangling symlinks under `dir` (bounded walk: never follows links, stops after 20000 entries). */
export function danglingSymlinks(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  let seen = 0;
  const walk = (d: string) => {
    if (seen > 20_000) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      seen++;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) { if (!existsSync(p)) out.push(p.slice(dir.length + 1)); }
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

export function formatReport(r: DoctorReport): string {
  const lines = [`ota-build doctor: ${r.project} (platform: ${r.platform})`];
  for (const c of r.checks) {
    lines.push(`${c.status.padEnd(6)} ${c.title}: ${c.detail}`);
    if (c.status !== 'PASS' && c.remedy) lines.push(`       fix: ${c.remedy}`);
  }
  const n = (s: Status) => r.checks.filter((c) => c.status === s).length;
  lines.push(`${n('PASS')} pass, ${n('WARN')} warn, ${n('FAIL')} fail, ${n('MANUAL')} manual -> ${r.ok ? 'READY' : 'NOT READY'}`);
  return lines.join('\n') + '\n';
}
