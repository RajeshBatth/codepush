// Host-owned singleton store shared by all units (the reason units must NOT bundle their own copy).
const state = {};
let loads = 0;

export const store = {
  get: (k) => state[k],
  set: (k, v) => {
    state[k] = v;
  },
  noteUnitEvaluated: (name) => {
    loads += 1;
    state['unitEval:' + name] = (state['unitEval:' + name] || 0) + 1;
  },
  evalCount: (name) => state['unitEval:' + name] || 0,
  totalLoads: () => loads,
};
