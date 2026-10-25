// DESIGN.md 7.8 step 1: Metro splitter -> host.js + units/*.js -> hermesc (reproducible recipe) -> *.hbc + build.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-ignore: plain-JS package, imported by relative path (no build step)
import { build as splitterBuild } from '../../unit-splitter/src/build.js';
// @ts-ignore: plain-JS package
import { describeMetro } from '../../unit-splitter/src/metro-compat.js';
import { resolveHermesc, hermescSupportsBaseBytecode, HERMES_FLAGS, RN_VERSION, type HermescInfo } from './tools.ts';
import {
  BuildError, hashFile, isEmptyDir, listFiles, readJson, rmrf, run, sha256Of, stagingDirFor, toJson, zstdSize,
} from './util.ts';
import type { Platform } from './types.ts';
import { assertPlatform, validateHbc } from './hbc.ts';

/** Name every file gets while hermesc reads it. With -g0 the name is not embedded anyway; fixed as defense in depth. */
export const HERMES_INPUT_NAME = 'bundle.js';
export const HERMES_ARGS = ['-O', '-emit-binary', '-g0'] as const;
/** Fixed relative name the base bytecode gets while hermesc reads it (the base path never reaches hermesc). */
export const HERMES_BASE_NAME = 'base.hbc';

/** auto = delta whenever a base build is given; on = delta or fail loudly; off = always plain. */
export type DeltaMode = 'auto' | 'on' | 'off';
export const DELTA_MODES: readonly DeltaMode[] = ['auto', 'on', 'off'];
export function parseDeltaMode(s: string | undefined): DeltaMode {
  if (s === undefined) return 'auto';
  if ((DELTA_MODES as readonly string[]).includes(s)) return s as DeltaMode;
  throw new BuildError('USAGE', `--delta must be auto, on or off (got ${s})`);
}

export interface BuildFileEntry { file: string; hash: string; size: number; zstdSize: number }
/** Hermes delta compile record. `files` is keyed like BuildJson file paths ("host.hbc", "units/<u>.hbc"). */
export interface DeltaInfo {
  enabled: boolean;
  /** sha256 of the base build's build.json (null when not a delta build) */
  baseBuild: string | null;
  files: Record<string, { baseHbc?: string; js: string }>;
}
export interface BuildJson {
  schema: 1;
  platform: Platform;
  appVersion: string | null;
  sourceSha: string | null;
  toolchain: { rn: string; metro: string; hermescSha256: string; hbcVersion: number; hermescFlags: string };
  host: BuildFileEntry;
  units: Record<string, BuildFileEntry & { entryModuleId: number }>;
  ids: { file: string; hash: string };
  unitsMap: { file: string; hash: string };
  /** absent in builds made before delta mode existed */
  delta?: DeltaInfo;
}

export interface BundleOptions {
  project: string;
  platform: Platform;
  out: string;
  sourceSha?: string | null;
  appVersion?: string | null;
  /** an earlier build dir: enables the splitter's patch-mode rules 3/4 against its units.json/ids.json */
  baseBuild?: string | null;
  /** see DeltaMode; default auto */
  delta?: DeltaMode;
  hermescPath?: string;
  allowUnpinnedHermesc?: boolean;
}

/** Version of the Metro that WILL run for this project: the project's own, else the splitter's fallback copy. */
function metroVersion(project: string): string {
  return (describeMetro(project) as { version: string }).version;
}

/**
 * Compile one JS file with the reproducible recipe: cwd = a work dir holding only `bundle.js` (and, in delta mode, a copy of the
 * base bytecode named `base.hbc`), relative names, -g0. `baseHbc` (path) switches on `-base-bytecode=base.hbc`.
 */
export function compileHbc(h: HermescInfo, jsFile: string, workRoot: string, outFile: string, label: string, baseHbc?: string | null): void {
  const wd = join(workRoot, `hermes-${label}`);
  mkdirSync(wd, { recursive: true });
  copyFileSync(jsFile, join(wd, HERMES_INPUT_NAME));
  const args: string[] = [...HERMES_ARGS];
  if (baseHbc) {
    if (!existsSync(baseHbc)) throw new BuildError('DELTA_BASE_MISSING', `delta base bytecode for ${label} is missing: ${baseHbc}`);
    validateHbc(readFileSync(baseHbc), h.hbcVersion, `delta base for ${label}`);
    copyFileSync(baseHbc, join(wd, HERMES_BASE_NAME));
    args.push(`-base-bytecode=${HERMES_BASE_NAME}`);
  }
  const r = run(h.path, [...args, '-out', 'out.hbc', HERMES_INPUT_NAME], { cwd: wd, timeoutMs: 300_000 });
  if (r.timedOut) throw new BuildError('HERMESC_TIMEOUT', `hermesc timed out on ${label}`);
  if (r.status !== 0) throw new BuildError('HERMESC_FAILED', `hermesc failed (exit ${r.status}) on ${label}${baseHbc ? ' (delta mode)' : ''}:\n${r.stderr || r.stdout}`);
  renameSync(join(wd, 'out.hbc'), outFile);
  rmrf(wd);
}

/** The delta-mode decision for one bundle() call: null = plain. Throws on every `on` problem and on an unusable base build. */
export function planDelta(o: { baseBuild?: string | null; delta?: DeltaMode; platform: Platform }, h: HermescInfo):
  { baseDir: string; baseB: BuildJson; baseBuildHash: string } | null {
  const mode = o.delta ?? 'auto';
  if (mode === 'off') return null;
  if (!o.baseBuild) {
    if (mode === 'on') throw new BuildError('DELTA_NO_BASE', '--delta on needs --base-build <embedded base build dir>');
    return null; // the base release itself is always plain
  }
  const baseDir = resolve(o.baseBuild);
  if (!hermescSupportsBaseBytecode(h.path)) {
    throw new BuildError('DELTA_UNSUPPORTED', `hermesc at ${h.path} does not support -base-bytecode (see \`hermesc -help\`); use the pinned RN ${RN_VERSION} hermesc (fetch-tools) or pass --delta off`);
  }
  const pre = loadBuild(baseDir);
  for (const f of [pre.host.file, ...Object.values(pre.units).map((u) => u.file)]) {
    if (!existsSync(join(baseDir, f))) {
      throw new BuildError('DELTA_BASE_MISSING', `${join(baseDir, f)} is missing: delta compile needs the base .hbc BYTES (host.hbc, units/*.hbc, build.json, ids.json, units.json), not just hashes. Restore the archived base release files (ota-build archive-base) or pass --delta off`);
    }
  }
  const baseB = verifyBuildDir(baseDir);
  if (baseB.delta?.enabled) {
    throw new BuildError('DELTA_BASE_IS_DELTA', `${baseDir} is itself a delta build; the delta base must always be the EMBEDDED base bundle, never a previous patch build`);
  }
  if (baseB.platform !== o.platform) throw new BuildError('PLATFORM_MISMATCH', `base build is ${baseB.platform}, bundling ${o.platform}`);
  if (baseB.toolchain.hermescSha256 !== h.sha256 || baseB.toolchain.hbcVersion !== h.hbcVersion) {
    throw new BuildError('TOOLCHAIN_MISMATCH', `base build was made with hermesc ${baseB.toolchain.hermescSha256} (HBC v${baseB.toolchain.hbcVersion}), this is ${h.sha256} (HBC v${h.hbcVersion}); a delta base must come from the same hermesc`);
  }
  return { baseDir, baseB, baseBuildHash: hashFile(join(baseDir, 'build.json')) };
}

function entryOf(file: string, rel: string, hbcVersion: number): BuildFileEntry {
  const data = readFileSync(file);
  validateHbc(data, hbcVersion, rel);
  return { file: rel, hash: sha256Of(data), size: data.length, zstdSize: zstdSize(data) };
}

export async function bundle(o: BundleOptions): Promise<{ outDir: string; build: BuildJson }> {
  assertPlatform(o.platform);
  const project = resolve(o.project);
  const out = resolve(o.out);
  if (!existsSync(join(project, 'units.config.json'))) throw new BuildError('NO_PROJECT', `${project} has no units.config.json`);
  // The splitter wipes its output dir and we replace `out`: only allow an empty/new dir or a previous build of ours.
  if (existsSync(out) && !isEmptyDir(out) && !existsSync(join(out, 'build.json'))) {
    throw new BuildError('OUT_NOT_EMPTY', `${out} exists, is not empty and is not a previous build (no build.json); refusing to delete it`);
  }
  const h = resolveHermesc({ path: o.hermescPath, allowUnpinned: o.allowUnpinnedHermesc });
  const stage = stagingDirFor(out);
  try {
    // 0. delta decision first: every `on` problem / unusable base fails before the slow steps
    const baseDir = o.baseBuild ? resolve(o.baseBuild) : null;
    const delta = planDelta({ baseBuild: baseDir, delta: o.delta, platform: o.platform }, h);
    // 1. Metro splitter into <stage>/js
    const js = join(stage, 'js');
    await splitterBuild({ projectRoot: project, outDir: js, base: baseDir, platform: o.platform });
    const unitsJson = readJson<{ units: Record<string, { file: string; entryId: number }> }>(join(js, 'units.json'));
    const unitNames = Object.keys(unitsJson.units).sort();

    // 2. hermesc each file; hbc and metadata go to the top of the build dir
    const work = join(stage, '.hermes-work');
    mkdirSync(join(stage, 'units'), { recursive: true });
    const deltaFiles: DeltaInfo['files'] = {};
    const compileOne = (rel: string, jsFile: string, outFile: string, label: string): void => {
      const jsHash = hashFile(jsFile);
      if (!delta) { compileHbc(h, jsFile, work, outFile, label); deltaFiles[rel] = { js: jsHash }; return; }
      const be = rel === 'host.hbc' ? delta.baseB.host : delta.baseB.units[label.replace(/^unit-/, '')];
      if (!be) throw new BuildError('DELTA_BASE_MISSING', `${rel}: the base build has no such file (new unit?); delta needs a base for every file (use --delta off)`);
      const baseHbc = join(delta.baseDir, be.file);
      if (!existsSync(baseHbc)) {
        throw new BuildError('DELTA_BASE_MISSING', `${baseHbc} is missing: delta compile needs the base .hbc BYTES (host.hbc, units/*.hbc), not just hashes. Restore the archived base release files (ota-build archive-base) or pass --delta off`);
      }
      const baseHbcHash = hashFile(baseHbc); // verifyBuildDir already proved it equals be.hash
      const baseJs = delta.baseB.delta?.files[rel]?.js;
      if (baseJs !== undefined && baseJs === jsHash) copyFileSync(baseHbc, outFile); // unchanged source: byte-identical to the embedded file, guaranteed
      else compileHbc(h, jsFile, work, outFile, label, baseHbc);
      deltaFiles[rel] = { baseHbc: baseHbcHash, js: jsHash };
    };
    compileOne('host.hbc', join(js, 'host.js'), join(stage, 'host.hbc'), 'host');
    for (const u of unitNames) compileOne(`units/${u}.hbc`, join(js, unitsJson.units[u].file), join(stage, 'units', `${u}.hbc`), `unit-${u}`);
    rmrf(work);
    copyFileSync(join(js, 'ids.json'), join(stage, 'ids.json'));
    copyFileSync(join(js, 'units.json'), join(stage, 'units.json'));

    // 3. build.json (validates magic + version of every .hbc)
    const build: BuildJson = {
      schema: 1,
      platform: o.platform,
      appVersion: o.appVersion ?? null,
      sourceSha: o.sourceSha ?? null,
      toolchain: { rn: RN_VERSION, metro: metroVersion(project), hermescSha256: h.sha256, hbcVersion: h.hbcVersion, hermescFlags: HERMES_FLAGS },
      host: entryOf(join(stage, 'host.hbc'), 'host.hbc', h.hbcVersion),
      units: Object.fromEntries(unitNames.map((u) => [u, {
        ...entryOf(join(stage, 'units', `${u}.hbc`), `units/${u}.hbc`, h.hbcVersion),
        entryModuleId: unitsJson.units[u].entryId,
      }])),
      ids: { file: 'ids.json', hash: hashFile(join(stage, 'ids.json')) },
      unitsMap: { file: 'units.json', hash: hashFile(join(stage, 'units.json')) },
      delta: { enabled: !!delta, baseBuild: delta ? delta.baseBuildHash : null, files: deltaFiles },
    };
    writeFileSync(join(stage, 'build.json'), toJson(build));

    // 4. publish atomically
    if (existsSync(out)) rmrf(out);
    renameSync(stage, out);
    return { outDir: out, build };
  } catch (e) {
    rmrf(stage);
    throw e;
  }
}

export function loadBuild(dir: string): BuildJson {
  const b = readJson<BuildJson>(join(resolve(dir), 'build.json'));
  if (b.schema !== 1) throw new BuildError('BAD_BUILD', `${dir}/build.json: unsupported schema ${b.schema}`);
  return b;
}

/** Re-hash every referenced file of a build dir; a build dir that was modified after bundling is rejected. */
export function verifyBuildDir(dir: string): BuildJson {
  const root = resolve(dir);
  const b = loadBuild(root);
  const check = (rel: string, hash: string) => {
    const p = join(root, rel);
    if (!existsSync(p)) throw new BuildError('BAD_BUILD', `${root}: ${rel} is missing`);
    const got = hashFile(p);
    if (got !== hash) throw new BuildError('BAD_BUILD', `${root}: ${rel} hash ${got} differs from build.json (${hash}); build dir was modified`);
  };
  check(b.host.file, b.host.hash);
  for (const [, u] of Object.entries(b.units)) check(u.file, u.hash);
  check(b.ids.file, b.ids.hash);
  check(b.unitsMap.file, b.unitsMap.hash);
  if (b.delta) {
    const want = [b.host.file, ...Object.values(b.units).map((u) => u.file)].sort().join();
    if (Object.keys(b.delta.files).sort().join() !== want) throw new BuildError('BAD_BUILD', `${root}: delta.files does not list exactly host + units`);
    if (b.delta.enabled !== (b.delta.baseBuild !== null) || (b.delta.enabled && Object.values(b.delta.files).some((x) => !x.baseHbc))) {
      throw new BuildError('BAD_BUILD', `${root}: inconsistent delta record (enabled, baseBuild, baseHbc)`);
    }
  }
  return b;
}

/** Reproducibility gate: two bundles from the same source into different absolute dirs must be byte-identical. */
export async function verifyRepro(o: Omit<BundleOptions, 'out'> & { workDir: string }): Promise<{ ok: boolean; differences: string[]; files: number; buildJsonHash: string }> {
  const a = join(resolve(o.workDir), 'repro-a', 'nested-one');
  const b = join(resolve(o.workDir), 'repro-b-with-a-longer-path', 'x', 'nested-two');
  rmrf(join(resolve(o.workDir), 'repro-a'));
  rmrf(join(resolve(o.workDir), 'repro-b-with-a-longer-path'));
  const { out: _o, workDir: _w, ...rest } = o as BundleOptions & { workDir: string };
  await bundle({ ...rest, out: a });
  await bundle({ ...rest, out: b });
  const fa = listFiles(a);
  const fb = listFiles(b);
  const differences: string[] = [];
  for (const f of fa) if (!fb.includes(f)) differences.push(`only in run A: ${f}`);
  for (const f of fb) if (!fa.includes(f)) differences.push(`only in run B: ${f}`);
  for (const f of fa.filter((x) => fb.includes(x))) {
    const ha = hashFile(join(a, f));
    const hb = hashFile(join(b, f));
    if (ha !== hb) differences.push(`${f}: ${ha.slice(0, 19)}... != ${hb.slice(0, 19)}...`);
  }
  const bj = (d: string) => sha256Of(readFileSync(join(d, 'build.json')));
  if (bj(a) !== bj(b) && !differences.some((d) => d.startsWith('build.json'))) differences.push('build.json hash differs');
  const ok = differences.length === 0;
  const buildJsonHash = bj(a);
  if (ok) { rmrf(join(resolve(o.workDir), 'repro-a')); rmrf(join(resolve(o.workDir), 'repro-b-with-a-longer-path')); }
  return { ok, differences, files: fa.length, buildJsonHash };
}
