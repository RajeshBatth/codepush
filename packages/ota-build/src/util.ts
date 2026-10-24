import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export class BuildError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
  }
}

/** <repo> (packages/ota-build/src -> three levels up). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_TOOLS_DIR = join(REPO_ROOT, '.tools');
export const DEFAULT_WORK_DIR = join(REPO_ROOT, '.work');
export const DEFAULT_NATIVE_BUILD_DIR = join(REPO_ROOT, 'native', 'build-ota-tools');

// ---- configurable locations: explicit flag > environment variable > repo-relative default ----------------
export interface Origin { kind: 'flag' | 'env' | 'default'; name?: string }
export interface Located { path: string; origin: Origin }
export const describeOrigin = (o: Origin): string => (o.kind === 'default' ? 'default' : `${o.kind} ${o.name}`);

/** Pure picker (env injectable for tests). `envNames` are tried in order (first = canonical, later = legacy aliases). */
export function pickPath(spec: { flag?: string | undefined; flagName?: string; envNames?: string[]; dflt: string }, env: Record<string, string | undefined> = process.env): Located {
  if (spec.flag) return { path: resolve(spec.flag), origin: { kind: 'flag', name: spec.flagName } };
  for (const n of spec.envNames ?? []) if (env[n]) return { path: resolve(env[n]!), origin: { kind: 'env', name: n } };
  return { path: spec.dflt, origin: { kind: 'default' } };
}

/** Flags given on the command line (set once by cli.ts) so library code deep in the call tree sees them. */
const overrides: { toolsDir?: string; workDir?: string } = {};
export function setPathOverrides(o: { toolsDir?: string | undefined; workDir?: string | undefined }): void {
  overrides.toolsDir = o.toolsDir;
  overrides.workDir = o.workDir;
}
/** hermesc cache root: `--tools-dir` > `OTA_TOOLS_DIR` > `<repo>/.tools`. */
export const toolsDir = (flag?: string): Located => pickPath({ flag: flag ?? overrides.toolsDir, flagName: '--tools-dir', envNames: ['OTA_TOOLS_DIR'], dflt: DEFAULT_TOOLS_DIR });
/** scratch/work root: `--work-dir` > `OTA_WORK_DIR` > `<repo>/.work`. */
export const workDir = (flag?: string): Located => pickPath({ flag: flag ?? overrides.workDir, flagName: '--work-dir', envNames: ['OTA_WORK_DIR'], dflt: DEFAULT_WORK_DIR });

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export const sha256Of = (data: Uint8Array | string): string => `sha256:${sha256Hex(data)}`;
export const hashFile = (p: string): string => sha256Of(readFileSync(p));

/** zstd level used for the "zstdSize" figures (what shipping the file in full would cost). Deterministic (single thread). */
export const ZSTD_SIZE_LEVEL = 19;
export function zstdSize(data: Uint8Array): number {
  const params = { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_SIZE_LEVEL };
  return zlib.zstdCompressSync(data, { params }).length;
}

/** Canonical output for JSON files we write: 2-space indent, trailing newline, insertion order (callers build objects in a fixed order). */
export const toJson = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
export const readJson = <T>(p: string): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch (e) {
    throw new BuildError('BAD_JSON', `cannot read JSON ${p}: ${(e as Error).message}`);
  }
};

/** Environment for child processes: minimal and fixed, so tool behaviour does not depend on the caller's shell. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.platform === 'win32' ? dirname(process.execPath) : `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`, LANG: 'C', LC_ALL: 'C', TZ: 'UTC', ...extra };
}

export interface RunResult { status: number | null; stdout: string; stderr: string; timedOut: boolean }
/** spawnSync without a shell; a timeout kills the child (SIGKILL) so nothing can hang. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, env: opts.env ?? childEnv(), encoding: 'utf8', timeout: opts.timeoutMs ?? 300_000,
    killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, shell: false,
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  if (r.error && !timedOut) throw new BuildError('SPAWN', `cannot run ${cmd}: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut };
}

/** Recursively list files (relative, '/'-separated, sorted by code unit order: locale independent). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

export function isEmptyDir(p: string): boolean {
  return statSync(p).isDirectory() && readdirSync(p).length === 0;
}

/** Make a fresh sibling staging directory (same filesystem as `target`, so the final rename is atomic). */
export function stagingDirFor(target: string): string {
  const stage = `${target}.stage-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(stage);
  return stage;
}

export function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}
