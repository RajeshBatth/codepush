// Node `vm` stand-in for the app runtime: Hermes (a JS context), the host bundle, and the native
// NativeOtaUnits loader behind global.__loadBundleAsync.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from '@babel/parser';

/**
 * Unit invariant (DESIGN 5.6): a unit file contains ONLY top-level `__d(...)` statements.
 * Stand-in for "Hermes rejects a bad/corrupt .hbc before running it": anything that does not parse,
 * or contains anything but __d registrations, is rejected BEFORE evaluation, so nothing registers.
 */
export function validateUnitSource(code) {
  let ast;
  try {
    ast = parse(code, { sourceType: 'script' });
  } catch (e) {
    throw new Error('unit does not parse: ' + e.message);
  }
  for (const st of ast.program.body) {
    const ok = st.type === 'ExpressionStatement' && st.expression.type === 'CallExpression' && st.expression.callee.name === '__d';
    if (!ok) throw new Error(`unit contains a top-level ${st.type} that is not a __d(...) registration`);
  }
  if (!ast.program.body.length) throw new Error('unit is empty');
}

/**
 * @param distDir  base build (embedded host + embedded units)
 * @param patchDir optional dir with units/<name>.js "downloaded patch" files; tried before the embedded unit
 * @param dedupe   native-side single-flight per unit name (the real loader must do this)
 */
export function createRuntime({ distDir, patchDir = null, dedupe = true } = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, queueMicrotask });
  const events = []; // loader decisions: {unit, source, status, reason?}
  const loadCalls = []; // every __loadBundleAsync(name) call
  const registered = []; // every __d(factory, id, ...) call after boot, in order
  const fileEvals = []; // unit files actually evaluated (source + name)

  vm.runInContext(fs.readFileSync(path.join(distDir, 'host.js'), 'utf8'), ctx, { filename: 'host.js' });

  const originalDefine = ctx.__d;
  ctx.__d = (...args) => {
    registered.push(args[1]);
    return originalDefine(...args);
  };

  const inflight = new Map();
  const sources = () => [...(patchDir ? [['patch', path.join(patchDir, 'units')]] : []), ['embedded', path.join(distDir, 'units')]];

  async function loadOnce(name) {
    const errors = [];
    for (const [source, dir] of sources()) {
      const file = path.join(dir, name + '.js');
      try {
        const code = await fs.promises.readFile(file, 'utf8');
        validateUnitSource(code); // may throw: nothing has registered yet
        new vm.Script(code, { filename: `unit://${name}` }).runInContext(ctx);
        fileEvals.push({ unit: name, source });
        events.push({ unit: name, source, status: 'ok' });
        return;
      } catch (e) {
        events.push({ unit: name, source, status: 'rejected', reason: e.message });
        errors.push(`${source}: ${e.message}`);
      }
    }
    throw new Error(`unit ${name} failed to load: ${errors.join('; ')}`);
  }

  ctx.__loadBundleAsync = (name) => {
    loadCalls.push(name);
    if (!dedupe) return loadOnce(name);
    if (!inflight.has(name)) {
      const p = loadOnce(name);
      inflight.set(name, p);
      p.catch(() => inflight.delete(name)); // allow retry after failure
    }
    return inflight.get(name);
  };

  return {
    ctx,
    events,
    loadCalls,
    registered,
    fileEvals,
    app: () => ctx.__app,
    openUnit: (name, props) => ctx.__app.openUnit(name, props),
    /** Evaluate a unit file directly in this context (bypasses validation: to probe Metro's define()). */
    evalUnitFile: (file) => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(ctx),
    evalCount: (name) => ctx.__app.store.evalCount(name),
  };
}
