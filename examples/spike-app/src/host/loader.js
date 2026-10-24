import {NativeModules, TurboModuleRegistry} from 'react-native';

// NativeOtaUnits is optional: only present when the native spike module is registered.
const mod =
  (TurboModuleRegistry && TurboModuleRegistry.get('NativeOtaUnits')) ||
  NativeModules.NativeOtaUnits ||
  null;

if (mod && typeof mod.load === 'function') {
  // In dev builds RN installs its own __loadBundleAsync (setUpDeveloperTools) during InitializeCore;
  // this module runs after it and replaces it. In release RN defines none.
  globalThis.__loadBundleAsync = name => mod.load(name);
}

/**
 * Entry-point helper for the native loader. Metro's `__r` runs a module inside
 * `guardedLoadModule`, which on an exception calls `ErrorUtils.reportFatalError` (RN: fatal ->
 * crash in release) and does NOT rethrow, so native could neither catch nor report the failure.
 * With ErrorUtils hidden for the duration of the call the exception propagates to the caller.
 */
globalThis.__otaRequire = function __otaRequire(id) {
  const eu = globalThis.ErrorUtils;
  globalThis.ErrorUtils = undefined;
  try {
    return globalThis.__r(id);
  } finally {
    globalThis.ErrorUtils = eu;
  }
};
