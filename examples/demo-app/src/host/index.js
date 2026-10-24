import { lazyUnit } from './lazyUnit';
import { registerUnit, listUnits, openUnit } from './nav';
import { formatMoney } from './shared/format';
import { store } from './shared/store';
import { platformLabel } from './shared/platform-label';

// host -> unit edges are ONLY these dynamic imports.
registerUnit('cabs', lazyUnit('cabs', () => import('../units/cabs/entry')));
registerUnit('bus', lazyUnit('bus', () => import('../units/bus/entry')));
registerUnit('travelplex', lazyUnit('travelplex', () => import('../units/travelplex/entry')));

// The "app": the harness drives this instead of a real RN renderer.
globalThis.__app = { listUnits, openUnit, formatMoney, store, platformLabel };
