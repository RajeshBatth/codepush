// Host entry. Boot order matters: init() runs ONCE per VM here, before any unit can open.
import { init, getSession, getUnreadCount, TravelplexEntry } from '@travelplex/core';

const initResult = init();

// The "app": the harness drives this instead of a real RN renderer.
globalThis.__app = {
  initResult,
  init,
  session: getSession(),
  getUnreadCount,
  listUnits: () => ['travelplex'],
  openUnit: async (name, props) => {
    if (name !== 'travelplex') throw new Error('unknown unit ' + name);
    return (await TravelplexEntry(props)).text;
  },
  open: (props, onState) => TravelplexEntry(props, onState),
};
