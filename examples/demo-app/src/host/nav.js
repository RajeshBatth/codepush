// Host navigation registry: units are registered lazily, never imported statically.
const registry = new Map();

export function registerUnit(name, lazy) {
  registry.set(name, lazy);
}

export function listUnits() {
  return [...registry.keys()].sort();
}

export async function openUnit(name, props) {
  const lazy = registry.get(name);
  if (!lazy) throw new Error('unknown unit ' + name);
  const unit = await lazy.load();
  return unit.render(props);
}
