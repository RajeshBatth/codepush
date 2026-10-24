// Host helper: the ONLY sanctioned way for the host to reach a unit.
// `loader` is `() => import('../units/<name>/entry')`. Metro compiles that import()
// into asyncRequire(id, paths) -> global.__loadBundleAsync('<name>') (see unit-splitter).
// Returns a React.lazy-style handle: load() is memoised so concurrent first uses share
// one load (and one evaluation of the unit).
export function lazyUnit(name, loader) {
  let promise = null;
  return {
    name,
    load() {
      if (!promise) {
        promise = loader().then(
          (mod) => (mod && mod.default) || mod,
          (err) => {
            promise = null; // allow retry after a failed load
            throw err;
          },
        );
      }
      return promise;
    },
  };
}
