// One Metro build of the project, with our id factory and a pluggable serializer.
import fs from 'node:fs';
import path from 'node:path';
import { initMetro, Metro, baseConfig, mergeConfig, toolchainWatchFolders, rnBabelTransformerPath, loadProjectConfig, buildOnServer } from './metro-compat.js';
import { createIdFactory } from './ids.js';
import { ctx } from './with-ota-units.js';

/**
 * Two modes. Demo mode (default): we assemble the whole Metro config. Project-config mode (`projectConfig` = path of
 * the app's metro.config.js, which calls withOtaUnits): the app's config is loaded as-is; we only add run-time
 * settings (no cache, no watchman, quiet reporter) and read ids/units from `ctx`.
 */
export async function runMetro({ projectRoot, entry = 'src/host/index.js', platform = 'ios', customSerializer, bits = 48, minify = false, projectConfig = null, transformProfile = null, extraWatchFolders = [] }) {
  if (platform !== 'ios' && platform !== 'android') throw new Error(`unsupported platform: ${platform}`);
  projectRoot = fs.realpathSync(projectRoot); // macOS /var -> /private/var
  initMetro(projectRoot);
  if (projectConfig) {
    const loaded = await loadProjectConfig(projectRoot, projectConfig);
    if (!ctx.ids) throw new Error(`${projectConfig} did not call withOtaUnits (or it is disabled): no id factory. Fix: wrap its exported config with withOtaUnits(config, { units, projectRoot: __dirname }) - or, if this app's metro.config.js is not meant for the splitter, set \"metroConfig\": false in units.config.json (metro.config.js is auto-detected otherwise)`);
    const config = mergeConfig(loaded, {
      projectRoot,
      // Metro's defaults (require.js polyfill) may resolve from the splitter's own metro-runtime copy: watch it.
      watchFolders: [...new Set([projectRoot, ...(loaded.watchFolders ?? []), ...toolchainWatchFolders, ...extraWatchFolders])],
      resetCache: true,
      cacheStores: [],
      watcher: { watchman: { deferStates: [] }, healthCheck: { enabled: false } },
      resolver: { useWatchman: false },
      reporter: { update() {} },
    });
    const result = await buildOnServer(config, { entry, platform, minify, transformProfile });
    return { result, ids: ctx.ids, projectRoot };
  }
  const ids = createIdFactory(projectRoot, { bits });
  const base = await baseConfig(projectRoot);
  const config = mergeConfig(base, {
    projectRoot,
    // Metro resolves its own require.js polyfill from the splitter's node_modules (outside the
    // demo project), so that dir must be watched or Metro cannot SHA-1 it.
    watchFolders: [...new Set([projectRoot, ...toolchainWatchFolders, ...extraWatchFolders])],
    resetCache: true,
    cacheStores: [], // never reuse a cache: reproducibility, and temp copies must not share state
    watcher: { watchman: { deferStates: [] }, healthCheck: { enabled: false } },
    // metro-runtime (resolved from the splitter's node_modules) is transformed with babel-plugin-transform-runtime like
    // any RN module, so it requires @babel/runtime; resolve that from the APP's node_modules, as in a real RN project.
    resolver: { useWatchman: false, nodeModulesPaths: [path.join(projectRoot, 'node_modules')] },
    transformer: { babelTransformerPath: rnBabelTransformerPath },
    serializer: {
      createModuleIdFactory: ids.factory,
      customSerializer,
    },
    reporter: { update() {} },
  });
  // Use Metro's own `reporter` quiet; runBuild returns {code, map}.
  const result = await Metro.runBuild(config, {
    entry,
    platform,
    dev: false,
    minify,
    sourceMap: false,  });
  return { result, ids, projectRoot };
}
