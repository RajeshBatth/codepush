import get from 'lodash.get';

// Shared app config; units read it via host-owned `getConfig` (lodash.get lives in the host).
const CONFIG = { rates: { cab: { perKm: 12, base: 50 }, bus: { perSeat: 400 } }, locale: 'en-IN' };

export function getConfig(path, fallback) {
  return get(CONFIG, path, fallback);
}
