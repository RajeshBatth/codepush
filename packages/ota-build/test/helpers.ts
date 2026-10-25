import { cpSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, childEnv, rmrf, workDir } from '../src/util.ts';
import { toolStatus } from '../src/tools.ts';

export const DEMO_APP = join(REPO_ROOT, 'examples/demo-app');
export const BUILD_CLI = join(REPO_ROOT, 'packages/ota-build/src/cli.ts');
export const OTA_CLI = join(REPO_ROOT, 'packages/ota-cli/src/cli.ts');

/** undefined when every external tool is present, else a human-readable reason to skip the test. */
export function missingTools(): string | undefined {
  const missing = toolStatus().filter((t) => !t.ok);
  if (!missing.length) return undefined;
  return `external toolchain missing (${missing.map((m) => m.name).join(', ')}); run \`node packages/ota-build/src/cli.ts fetch-tools\` and build native/build-ota-tools (see packages/ota-build/README.md). First problem: ${missing[0].detail.split('\n')[0]}`;
}

export function workRoot(tag: string): string {
  const d = join(workDir().path, `${tag}-${process.pid}`);
  rmrf(d);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Copy the demo app (src + node_modules + config) so tests never edit it in place. */
export function copyDemo(dest: string): string {
  mkdirSync(dest, { recursive: true });
  for (const f of ['src', 'node_modules', 'units.config.json', 'package.json']) cpSync(join(DEMO_APP, f), join(dest, f), { recursive: true });
  return dest;
}
export const append = (file: string, text: string): void => appendFileSync(file, text);

export function runNode(script: string, args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: childEnv(extraEnv), timeout: 600_000, killSignal: 'SIGKILL' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
export { readFileSync, writeFileSync };

export function runBin(bin: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(bin, args, { encoding: 'utf8', env: childEnv(), timeout: 120_000, killSignal: 'SIGKILL' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
export const TWO_PACKAGE_APP = join(REPO_ROOT, 'examples/two-package-app');
