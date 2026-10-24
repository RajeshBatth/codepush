// THE ONLY module that touches Metro internals. Everything else imports from here.
//
// Supported: Metro 0.81.x (primary; React Native 0.78) and 0.87.x (kept working because it is cheap).
// Anything else fails fast with a MetroCompatError instead of producing subtly wrong bundles.
// The Metro that runs is the PROJECT's (resolved from the project root); the splitter's own copy is only a fallback (see locateMetro).
//
// What differs between the two (see README "Findings"):
//   * deep-import prefix: 0.81 `metro/src/<x>` (0.81.x also has `metro/private/<x>`, but older 0.81.0
//     exports maps are not guaranteed to), 0.87 `metro/private/<x>` (no `metro/src/*` export any more).
//   * `wrapModule`'s async-path support: 0.87 has `unstable_getAsyncDependencyPath(dep)`; 0.81 only knows
//     `includeAsyncPaths` + `sourceUrl` and writes "/path.bundle?..." URLs. On 0.81 we therefore build the
//     `__d` params ourselves with metro-transform-plugins' (public) addParamsToDefineCall.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const requireFromHere = createRequire(import.meta.url);

export class MetroCompatError extends Error {
  constructor(message) {
    super(`unit-splitter: ${message}`);
    this.name = 'MetroCompatError';
  }
}

export const SUPPORTED = ['0.81', '0.87'];

// ---- WHICH Metro runs ----------------------------------------------------------------------------------
// The splitter must run the PROJECT's Metro (the app's metro.config.js, its transformer and resolver are written against
// it, and RN pins it). `metro`, `metro-config` and `metro-runtime` are therefore peerDependencies of this package and are
// looked up FROM THE PROJECT ROOT first (node resolution upwards from <project>/package.json, so a hoisted monorepo
// root works). Only if the project has no `metro` at all (this repo's demo apps) the splitter's own copy is used, and
// `describeMetro()` / `ota-build doctor` say so.
const PKGS = ['metro', 'metro-config', 'metro-runtime'];
const lineOf = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? `${m[1]}.${m[2]}` : null;
};
const readVersion = (pkgPath) => JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

/** Resolve `<name>/package.json` the way Node would from `basePath` (a file path used as the lookup anchor); null if absent. */
function tryResolve(basePath, name) {
  try {
    return createRequire(basePath).resolve(`${name}/package.json`);
  } catch {
    return null;
  }
}

/**
 * Pure location logic (loads nothing): where would each of metro / metro-config / metro-runtime come from for this project?
 * @returns {{ source: 'project'|'fallback', projectRoot, packages: Record<string, {version, pkgPath, base, from: 'project'|'fallback'|'metro'}> }}
 *   `base` = the anchor file to createRequire() from when loading that package; `from` says where it was found:
 *   'project' (resolved from the project root), 'fallback' (the splitter's own copy), 'metro' (a dependency of the chosen metro).
 * @param opts.fallbackBase override the splitter anchor (tests)
 */
export function locateMetro(projectRoot, opts = {}) {
  const projectBase = path.join(path.resolve(projectRoot), 'package.json');
  const fallbackBase = opts.fallbackBase ?? fileURLToPath(import.meta.url);
  const out = {};
  // "from the project": the project root first, then where the project's react-native / @react-native/metro-config live
  // (a strict layout such as pnpm only exposes Metro to them, not to the root).
  const anchors = [projectBase];
  for (const via of ['react-native', '@react-native/metro-config']) {
    const p = tryResolve(projectBase, via);
    if (p) anchors.push(p);
  }
  let metroPath = null;
  let metroBase = null;
  let source = 'project';
  for (const a of anchors) {
    metroPath = tryResolve(a, 'metro');
    if (metroPath) { metroBase = a; break; }
  }
  if (!metroPath) {
    metroPath = tryResolve(fallbackBase, 'metro');
    source = 'fallback';
    metroBase = fallbackBase;
    if (!metroPath) {
      throw new MetroCompatError(
        `cannot resolve \`metro\` from the project (${projectRoot}) nor from the splitter package; install the project's dependencies (npm install) ` +
          '- the splitter uses the Metro of the app it builds (react-native 0.78 brings metro 0.81.x)',
      );
    }
  }
  out.metro = { version: readVersion(metroPath), pkgPath: metroPath, base: metroBase, from: source };
  for (const name of ['metro-config', 'metro-runtime']) {
    // project first (even when `metro` itself fell back), then next to the chosen metro (its own dependency), then the splitter
    let p = null;
    let base = null;
    let from = 'project';
    for (const a of anchors) {
      p = tryResolve(a, name);
      if (p) { base = a; break; }
    }
    if (!p) { p = tryResolve(metroPath, name); base = metroPath; from = 'metro'; }
    if (!p) { p = tryResolve(fallbackBase, name); base = fallbackBase; from = 'fallback'; }
    if (!p) throw new MetroCompatError(`cannot resolve \`${name}\` (a dependency of metro ${out.metro.version}); reinstall the project's dependencies`);
    out[name] = { version: readVersion(p), pkgPath: p, base, from };
  }
  return { source, projectRoot: path.resolve(projectRoot), packages: out };
}

/** The version gate. Applies to the Metro that was actually located (not to the splitter's own copy). Throws MetroCompatError. */
export function checkMetroVersions(located) {
  const { metro } = located.packages;
  const where = located.source === 'project' ? `the project's Metro (${metro.pkgPath})` : `the splitter's fallback Metro (${metro.pkgPath}; the project has none)`;
  const line = lineOf(metro.version);
  if (!SUPPORTED.includes(line)) {
    throw new MetroCompatError(
      `unsupported Metro ${metro.version} (${where}); supported lines: ${SUPPORTED.map((s) => s + '.x').join(', ')} (primary: 0.81.x, React Native 0.78). ` +
        'Metro internals (serializer helpers, wrapModule) change between minor versions, so each line is verified by the test suite before it is added here. ' +
        'Fix: align the app to React Native 0.78 (Metro 0.81.x), or extend src/metro-compat.js and its test matrix first.',
    );
  }
  for (const name of ['metro-config', 'metro-runtime']) {
    const pkg = located.packages[name];
    if (pkg.version !== metro.version) {
      throw new MetroCompatError(`metro ${metro.version} and ${name} ${pkg.version} differ (${pkg.pkgPath}); pin metro, metro-config and metro-runtime to the same exact version in the project`);
    }
  }
  return line;
}

// ---- lazy, project-anchored initialisation ---------------------------------------------------------------
// Everything below that touches Metro is populated by initMetro(projectRoot) (called by build(), runMetro() and withOtaUnits()).
// ES live bindings: importers see the values after init. Calling initMetro again for the SAME Metro is a no-op; a project
// that resolves to a DIFFERENT Metro install in the same process is an error (one process = one project).
let state = null;
let metroRequire = null; // resolves metro's own dependencies exactly as metro does
let deepPrefix = null;
let processModules087 = null;
let metroConfigMod = null;

export let metroVersion = null;
export let metroLine = null;
export let metroSource = null; // 'project' | 'fallback'
export let metroConfigVersion = null;
export let Metro = null;
export let getMetroDefaultConfig = null;
export let mergeConfig = null;
export let toolchainWatchFolders = [];
export let baseJSBundle = null;
export let bundleToString = null;
export let getAppendScripts = null;

/** Which Metro will run / is running, for diagnostics (`ota-build doctor`, logs). Does not load Metro. */
export function describeMetro(projectRoot) {
  const located = locateMetro(projectRoot);
  return {
    source: located.source,
    version: located.packages.metro.version,
    path: path.dirname(located.packages.metro.pkgPath),
    packages: Object.fromEntries(PKGS.map((n) => [n, { version: located.packages[n].version, from: located.packages[n].from, path: path.dirname(located.packages[n].pkgPath) }])),
  };
}

/** The version gate for the Metro that would run for `projectRoot`, without loading it. Throws MetroCompatError. */
export function assertSupportedMetro(projectRoot) {
  return checkMetroVersions(locateMetro(projectRoot));
}

export function initMetro(projectRoot) {
  const located = locateMetro(projectRoot);
  if (state) {
    if (state.packages.metro.pkgPath !== located.packages.metro.pkgPath) {
      throw new MetroCompatError(
        `Metro was already loaded from ${state.packages.metro.pkgPath} (project ${state.projectRoot}); project ${located.projectRoot} resolves another Metro (${located.packages.metro.pkgPath}). ` +
          'One process can drive one Metro install: run each project in its own process.',
      );
    }
    return state;
  }
  const line = checkMetroVersions(located);
  const { metro, 'metro-config': mc, 'metro-runtime': mr } = located.packages;
  const load = (pkg, spec) => createRequire(pkg.base)(spec);
  const metroLoad = (spec) => load(metro, spec);
  metroRequire = createRequire(metro.pkgPath);
  deepPrefix = line === '0.81' ? 'metro/src/' : 'metro/private/';
  const deep = (rel) => {
    const m = metroLoad(deepPrefix + rel);
    return m && m.__esModule && m.default ? m.default : m;
  };
  metroVersion = metro.version;
  metroLine = line;
  metroSource = located.source;
  metroConfigVersion = mc.version;
  Metro = metroLoad('metro');
  metroConfigMod = load(mc, 'metro-config');
  getMetroDefaultConfig = metroConfigMod.getDefaultConfig;
  mergeConfig = metroConfigMod.mergeConfig;
  // Dirs read by Metro that may live outside the project root (the splitter's fallback node_modules; a hoisted root) must be in
  // watchFolders: metro-runtime (require.js; as seen from the project AND as seen from metro-config, which resolves the polyfill)
  // and @react-native/js-polyfills (when RN's config is used).
  const dirs = new Set([path.dirname(mr.pkgPath)]);
  const viaConfig = tryResolve(mc.pkgPath, 'metro-runtime');
  if (viaConfig) dirs.add(path.dirname(viaConfig));
  for (const anchor of [path.join(located.projectRoot, 'package.json'), fileURLToPath(import.meta.url)]) {
    const jp = tryResolve(anchor, '@react-native/js-polyfills');
    if (jp) { dirs.add(path.dirname(jp)); break; }
  }
  toolchainWatchFolders = [...dirs];
  baseJSBundle = deep('DeltaBundler/Serializers/baseJSBundle');
  bundleToString = deep('lib/bundleToString');
  getAppendScripts = deep('lib/getAppendScripts');
  processModules087 = line === '0.87' ? deep('DeltaBundler/Serializers/helpers/processModules') : null;
  const anchors = (located.source === 'project' ? [path.join(located.projectRoot, 'package.json')] : []).concat(fileURLToPath(import.meta.url));
  for (const a of anchors) {
    try { rnBabelTransformerPath = createRequire(a).resolve('@react-native/metro-babel-transformer'); break; } catch { /* next */ }
  }
  state = located;
  return state;
}

const ready = () => {
  if (!state) throw new MetroCompatError('Metro is not initialised: call initMetro(projectRoot) first (build() and withOtaUnits() do)');
};

// ---- wrapModules: [[module, "__d(...)"]] with `paths` for async dependencies --------------------------
// `asyncPathOf(dependency) -> string|null` supplies the unit name for an `import()` of a unit entry.

function wrapOwn(modules, { createModuleId, asyncPathOf }) {
  const { addParamsToDefineCall } = metroRequire('metro-transform-plugins');
  const out = [];
  for (const module of modules) {
    const js = module.output.filter(({ type }) => type.startsWith('js/'));
    if (js.length === 0) continue; // not a JS module (assets are already JS in a real build)
    if (js.length !== 1) throw new MetroCompatError(`${module.path} has ${js.length} JS outputs, expected 1`);
    const output = js[0];
    if (output.type.startsWith('js/script')) {
      out.push([module, output.data.code]);
      continue;
    }
    const paths = {};
    let hasPaths = false;
    const depMap = Array.from(module.dependencies.values()).map((dep) => {
      const id = createModuleId(dep.absolutePath);
      if (dep.data.data.asyncType != null) {
        const p = asyncPathOf(dep);
        if (p != null) {
          hasPaths = true;
          paths[id] = p;
        }
      }
      return id;
    });
    const params = [createModuleId(module.path), hasPaths ? { ...depMap, paths } : depMap];
    out.push([module, addParamsToDefineCall(output.data.code, ...params)]);
  }
  return out;
}

/**
 * @param serializerOptions the `options` object Metro passes to a customSerializer
 * @returns Array<[module, code]>; `paths` added to every module whose async dep has asyncPathOf(dep) != null
 */
export function wrapModules(modules, serializerOptions, asyncPathOf) {
  ready();
  const { createModuleId } = serializerOptions;
  if (metroLine === '0.81') return wrapOwn(modules, { createModuleId, asyncPathOf });
  return processModules087(modules, {
    createModuleId,
    dev: false,
    includeAsyncPaths: true,
    projectRoot: serializerOptions.projectRoot,
    serverRoot: serializerOptions.serverRoot,
    sourceUrl: undefined,
    dependencyMapReservedName: serializerOptions.dependencyMapReservedName,
    unstable_inlineDependencyMap: serializerOptions.unstable_inlineDependencyMap,
    unstable_getAsyncDependencyPath: asyncPathOf,
  });
}

// ---- config ---------------------------------------------------------------------------------------
/**
 * Base Metro config. On 0.81 this is `@react-native/metro-config` (the RN 0.78 defaults), with the two
 * settings that need react-native itself neutralised. On other lines: plain metro-config defaults.
 */
export function baseConfig(projectRoot) {
  ready();
  if (metroLine === '0.81') {
    let rn;
    try {
      rn = createRequire(state.packages.metro.from === 'project' ? path.join(state.projectRoot, 'package.json') : fileURLToPath(import.meta.url))('@react-native/metro-config');
    } catch {
      rn = null;
    }
    if (rn) {
      return mergeConfig(rn.getDefaultConfig(projectRoot), {
        serializer: {
          // RN: [require.resolve('react-native/Libraries/Core/InitializeCore')]; throws without react-native installed.
          getModulesRunBeforeMainModule: () => [],
        },
      });
    }
  }
  return metroConfigMod.getDefaultConfig(projectRoot);
}

/** The transform RN uses (RN's metro-babel-transformer -> @react-native/babel-preset when the app has no babel config). */
export let rnBabelTransformerPath = null;

/**
 * Load an app's own metro.config.js (RN style: mergeConfig(getDefaultConfig(...))) and complete it with Metro's defaults.
 * metro-config's `loadConfig` is not used: its cosmiconfig explorer is module-level and caches the file, so a second
 * build in the same process would not re-run the config (withOtaUnits keeps per-build state).
 */
export async function loadProjectConfig(projectRoot, configFile) {
  ready();
  const file = path.resolve(projectRoot, configFile);
  delete requireFromHere.cache[requireFromHere.resolve(file)];
  const user = requireFromHere(file);
  const defaults = await metroConfigMod.getDefaultConfig(projectRoot);
  return mergeConfig(defaults, typeof user === 'function' ? await user(defaults) : await user);
}

/**
 * Metro.runBuild has no `unstable_transformProfile`; the RN CLI's own `bundle` command goes through runMetro + server.build,
 * so we do the same (output module `metro/src/shared/output/bundle` = Server.build with bundleType 'bundle').
 */
export async function buildOnServer(config, { entry, platform, minify, transformProfile }) {
  ready();
  const server = await Metro.runMetro(config, { watch: false });
  try {
    const Server = createRequire(state.packages.metro.base)(deepPrefix + 'Server');
    return await server.build({
      ...Server.DEFAULT_BUNDLE_OPTIONS,
      dev: false,
      entryFile: entry,
      inlineSourceMap: false,
      minify,
      platform,
      sourceMapUrl: undefined,
      createModuleIdFactory: config.serializer.createModuleIdFactory,
      ...(transformProfile ? { unstable_transformProfile: transformProfile } : {}),
      bundleType: 'bundle',
    });
  } finally {
    await server.end();
  }
}
