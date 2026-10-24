// Child-process probe for `ota-build doctor`: loads the project's Metro config exactly like a Metro run would, with
// OTA_UNITS_BUILD=1, and prints ONE line `OTA_DOCTOR_PROBE {json}`. Runs in its own process so a broken or slow config
// cannot affect the doctor and nothing it requires leaks into it.
import { createRequire } from 'node:module';
import path from 'node:path';

const [project, configFile] = process.argv.slice(2);
process.env.OTA_UNITS_BUILD = '1';
const out = { loaded: false };
try {
  const file = path.resolve(project, configFile);
  let cfg = createRequire(file)(file);
  if (typeof cfg === 'function') cfg = cfg({});
  cfg = await cfg;
  out.loaded = true;
  out.customSerializer = typeof cfg?.serializer?.customSerializer === 'function';
  out.createModuleIdFactory = typeof cfg?.serializer?.createModuleIdFactory === 'function';
  const bl = cfg?.resolver?.blockList;
  const list = Array.isArray(bl) ? bl : bl ? [bl] : [];
  const blocked = (rel) => list.some((r) => r instanceof RegExp && r.test(path.join(project, rel)));
  out.blocked = {
    'ios/Pods': blocked('ios/Pods/x/y.js'),
    'ios/build': blocked('ios/build/x/y.js'),
    'android/app/build': blocked('android/app/build/x/y.js'),
    'android/build': blocked('android/build/x/y.js'),
    'android/.gradle': blocked('android/.gradle/x/y.js'),
  };
  out.watchFolders = Array.isArray(cfg?.watchFolders) ? cfg.watchFolders : [];
} catch (e) {
  out.error = String((e && e.message) || e).split('\n')[0];
}
console.log('OTA_DOCTOR_PROBE ' + JSON.stringify(out));
