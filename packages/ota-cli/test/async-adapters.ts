// Wraps any port implementation so every METHOD returns a Promise that settles after a small random delay (0-5 ms).
// Used to prove the job and the conformance suites do not depend on adapters being synchronous.
export function asyncify<T extends object>(target: T, maxDelayMs = 5): T {
  return new Proxy(target, {
    get(t, key) {
      const v = Reflect.get(t, key, t);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              resolve((v as (...a: unknown[]) => unknown).apply(t, args));
            } catch (e) {
              reject(e);
            }
          }, Math.floor(Math.random() * (maxDelayMs + 1)));
        });
    },
  });
}
