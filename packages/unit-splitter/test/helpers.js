import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/build.js';

export const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/demo-app');

export const TWO_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/two-package-app');

export function tmp(prefix = 'us-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Copy the demo app (sources + node_modules, no dist) so a test can mutate it. */
export function copyProject(dest = tmp('proj-')) {
  fs.cpSync(DEMO, dest, { recursive: true, filter: (s) => !s.startsWith(path.join(DEMO, 'dist')) });
  return dest;
}

/** Copy examples/two-package-app (sources + node_modules, no dist) so a test can mutate it. */
export function copyTwoPackage(dest = tmp('tp-')) {
  fs.cpSync(TWO_PKG, dest, { recursive: true, filter: (s) => !s.startsWith(path.join(TWO_PKG, 'dist')) });
  return dest;
}

export const edit = (root, rel, fn) => {
  const f = path.join(root, rel);
  fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8')));
};
export const write = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

let baseCache;
/** Base build of the unmodified demo app (once per test file/process). */
export async function baseBuild() {
  if (!baseCache) {
    const out = tmp('base-');
    const r = await build({ projectRoot: DEMO, outDir: out });
    baseCache = { dir: out, ...r };
  }
  return baseCache;
}

export async function expectViolation(t, assert, projectRoot, rule, opts = {}) {
  const out = tmp('out-');
  await assert.rejects(
    build({ projectRoot, outDir: out, ...opts }),
    (e) => {
      assert.equal(e.name, 'VerificationError', e.stack);
      assert.ok(e.violations.some((v) => v.rule === rule), `expected rule ${rule}, got: ${e.message}`);
      return true;
    },
  );
}
