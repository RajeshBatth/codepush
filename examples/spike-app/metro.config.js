const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
// The splitter is an ESM package in the monorepo; require(esm) works on Node >= 22.12.
const {withOtaUnits} = require('../../packages/unit-splitter/src/with-ota-units.js');
const exclusionList = require('metro-config/src/defaults/exclusionList');
const unitsConfig = require('./units.config.json');

/**
 * Metro configuration: RN's defaults + our unit splitting. withOtaUnits is inert unless the unit-splitter /
 * ota-build drives the build (OTA_UNITS_BUILD=1), so `react-native start` and Gradle/Xcode bundling are unchanged.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // Native build outputs / spike assets / scratch dirs live inside the project root; keep Metro's crawler out of them
    // (Pods contains dangling symlinks that make the crawler print ENOENT warnings).
    blockList: exclusionList([
      /\/android\/(app\/build|build|\.gradle|\.cxx)\/.*/,
      /\/ios\/(Pods|build)\/.*/,
      /\/\.spike-assets\/.*/,
    ]),
  },
};

module.exports = withOtaUnits(mergeConfig(getDefaultConfig(__dirname), config), {
  units: unitsConfig.units,
  projectRoot: path.resolve(__dirname),
});
