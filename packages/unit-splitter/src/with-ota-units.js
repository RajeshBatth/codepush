// `withOtaUnits(metroConfig, { units, projectRoot })`: the piece an app puts in its metro.config.js.
//
//   const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
//   const {withOtaUnits} = require('unit-splitter/with-ota-units');   // CJS require() of this ESM file (Node >= 22.12)
//   module.exports = withOtaUnits(mergeConfig(getDefaultConfig(__dirname), {}), {units: require('./units.config.json').units, projectRoot: __dirname});
//
// It is INERT unless the splitter's build() (or OTA_UNITS_BUILD=1) enables it, so `react-native start` and the
// normal Gradle/Xcode bundle keep working with the same metro.config.js. When enabled it installs
//   * serializer.createModuleIdFactory = deterministic path-hash ids (48 bit, collision-checked), and
//   * serializer.customSerializer      = the splitting serializer (host.js + units/<name>.js via a side channel).
// State shared with build() lives in `ctx` (module-level: build() and the config file load the same module instance).
import { createIdFactory } from './ids.js';
import { resolveUnits, readUnitsConfig } from './config.js';
import { parseChecks } from './checks.js';
import { makeSplitSerializer } from './split.js';
import { assertSupportedMetro } from './metro-compat.js';

export const ctx = { enabled: false, sink: null, base: null, approach: 'serializer', bits: null, ids: null, units: null, projectRoot: null, checks: null };

export function resetCtx(patch = {}) {
  Object.assign(ctx, { enabled: false, sink: null, base: null, approach: 'serializer', bits: null, ids: null, units: null, projectRoot: null, checks: null }, patch);
}

/**
 * @param metroConfig a Metro config OBJECT (any shape, even partial such as `{}` or `{resolver: {}}`), or a Promise of one,
 *   or a function `(defaults) => config` (all three forms Metro accepts from metro.config.js).
 * We only ever set `serializer.createModuleIdFactory` and `serializer.customSerializer`; the rest is passed through untouched.
 * Metro's own `mergeConfig(base, extra)` is NOT used for that: it dereferences `base.transformer.babelTransformerPath`,
 * `base.resolver.dependencyExtractor`, ... and crashes on a partial base, while Metro merges the final config over its
 * defaults anyway (loadConfig / our loadProjectConfig), so a partial config is fine here.
 */
export function withOtaUnits(metroConfig, { units, projectRoot, bits = 48, enabled, checks } = {}) {
  if (!projectRoot) throw new Error('withOtaUnits: projectRoot is required (pass __dirname of metro.config.js)');
  if (!Array.isArray(units)) {
    throw new Error('withOtaUnits: `units` is required and must be the array of unit definitions; fix: withOtaUnits(config, { units: require(\'./units.config.json\').units, projectRoot: __dirname })');
  }
  if (metroConfig == null || (typeof metroConfig !== 'object' && typeof metroConfig !== 'function')) {
    throw new Error(`withOtaUnits: the first argument must be the Metro config (object, Promise or function); got ${metroConfig === null ? 'null' : typeof metroConfig}. Fix: withOtaUnits(mergeConfig(getDefaultConfig(__dirname), {...}), {...})`);
  }
  const opts = { units, projectRoot, bits, enabled, checks };
  if (typeof metroConfig === 'function') return async (...args) => withOtaUnits(await metroConfig(...args), opts);
  if (typeof metroConfig.then === 'function') return metroConfig.then((c) => withOtaUnits(c, opts));
  const active = enabled ?? (ctx.enabled || process.env.OTA_UNITS_BUILD === '1');
  if (!active) return metroConfig;
  assertSupportedMetro(projectRoot); // version gate on the PROJECT's Metro (locates it, loads nothing)
  const resolved = resolveUnits(units, projectRoot);
  const ids = createIdFactory(projectRoot, { bits: ctx.bits ?? bits });
  ctx.ids = ids;
  ctx.units = resolved;
  ctx.projectRoot = projectRoot;
  ctx.sink ??= {};
  const customSerializer = (...args) =>
    makeSplitSerializer({ projectRoot, units: resolved, base: ctx.base, sink: ctx.sink, approach: ctx.approach, checks: ctx.checks ?? parseChecks(checks ?? readUnitsConfig(projectRoot).checks) })(...args);
  return { ...metroConfig, serializer: { ...metroConfig.serializer, createModuleIdFactory: ids.factory, customSerializer } };
}
