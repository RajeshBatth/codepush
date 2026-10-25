// Shared helpers for the spike scripts (prepare-spike-assets.mjs, measure.mjs). Node >= 24 (runs ota-build's TS directly).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(APP, '../..');
export const WORK = path.join(REPO, '.work');
export const { bundle } = await import(path.join(REPO, 'packages/ota-build/src/bundle.ts'));
export const { compileHbc } = await import(path.join(REPO, 'packages/ota-build/src/bundle.ts'));
export const { resolveHermesc } = await import(path.join(REPO, 'packages/ota-build/src/tools.ts'));
export const { createPatches } = await import(path.join(REPO, 'packages/ota-build/src/patch.ts'));
export const { hashId } = await import(path.join(REPO, 'packages/unit-splitter/src/ids.js'));

export const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');
export const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
export const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

/**
 * Apply text edits to source files IN PLACE, run fn(), and ALWAYS restore the originals (finally + signal handlers).
 * edits: [[relPath, (text) => newText]]. Paths are relative to `root` (default: the app; node_modules paths work too).
 */
export async function withEdits(edits, fn, root = APP) {
  const saved = edits.map(([rel]) => [path.join(root, rel), fs.readFileSync(path.join(root, rel))]);
  const restore = () => { for (const [f, buf] of saved) fs.writeFileSync(f, buf); };
  const onSig = () => { restore(); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  try {
    for (const [rel, f] of edits) {
      const file = path.join(root, rel);
      const before = fs.readFileSync(file, 'utf8');
      const after = f(before);
      if (after === before) throw new Error(`edit of ${rel} changed nothing`);
      fs.writeFileSync(file, after);
    }
    return await fn();
  } finally {
    restore();
    process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
  }
}

export const swap = (from, to) => (t) => { if (!t.includes(from)) throw new Error(`"${from}" not found`); return t.replace(from, to); };
