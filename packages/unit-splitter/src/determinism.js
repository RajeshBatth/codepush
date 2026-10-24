// Determinism check: build the same project in two copies at DIFFERENT absolute paths (different depth
// and name), with different TZ/LANG/cwd/time, and compare every output file byte for byte.
// (tools/repro_check.py does the same for a git repo; this variant needs no git.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashDir } from './build.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

export function checkDeterminism({ project, approach = 'serializer' }) {
  const roots = [
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'det-a-'))),
    path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'det-bb-'))), 'deeper', 'workspace-xyz'),
  ];
  const envs = [{ TZ: 'UTC', LANG: 'C' }, { TZ: 'Asia/Kolkata', LANG: 'en_IN.UTF-8' }];
  const runs = roots.map((root, i) => {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(project, root, { recursive: true, filter: (s) => !s.startsWith(path.join(project, 'dist')) });
    if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // different mtimes/clock
    const r = spawnSync(process.execPath, [CLI, 'build', '--project', root, '--out', path.join(root, 'dist'), '--approach', approach], {
      cwd: i === 0 ? root : os.tmpdir(),
      env: { ...process.env, ...envs[i] },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`build ${i} failed:\n${r.stdout}\n${r.stderr}`);
    const files = hashDir(path.join(root, 'dist'));
    const leaks = Object.keys(files).filter((f) => fs.readFileSync(path.join(root, 'dist', f), 'utf8').includes(root));
    return { root, files, leaks };
  });
  const names = [...new Set(runs.flatMap((r) => Object.keys(r.files)))].sort();
  const diffs = names.filter((n) => runs[0].files[n] !== runs[1].files[n]);
  const leaks = runs.flatMap((r) => r.leaks.map((f) => `${f} contains ${r.root}`));
  for (const r of runs) fs.rmSync(r.root.includes('workspace-xyz') ? path.dirname(path.dirname(r.root)) : r.root, { recursive: true, force: true });
  return { identical: diffs.length === 0 && leaks.length === 0, files: names, diffs, leaks, roots };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const project = path.resolve(process.argv[2] ?? new URL('../../../examples/demo-app', import.meta.url).pathname);
  let ok = true;
  for (const approach of ['serializer', 'postprocess']) {
    const r = checkDeterminism({ project, approach });
    console.log(`[${approach}] ${r.identical ? 'REPRODUCIBLE' : 'NOT REPRODUCIBLE'}: ${r.files.length} files; roots ${r.roots.join(' | ')}`);
    if (r.diffs.length) console.log('  differs:', r.diffs.join(', '));
    if (r.leaks.length) console.log('  absolute path leaks:', r.leaks.join('; '));
    ok &&= r.identical;
  }
  process.exit(ok ? 0 : 1);
}
