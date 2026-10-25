// DESIGN.md 7.8 step 2: HDiffPatch single compressed diff (zstd) per changed file + mandatory round trip through otacore::applyPatch.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileHbc, verifyBuildDir, type BuildFileEntry, type BuildJson } from './bundle.ts';
import { resolveHdiffz, resolveHermesc, resolveOtaApply, type ToolInfo } from './tools.ts';
import { BuildError, hashFile, readJson, rmrf, run, sha256Of, stagingDirFor, toJson } from './util.ts';
import type { Platform, UpdateType } from './types.ts';

/** `patchAlgoVer` v1: HDiffPatch "single compressed diff", zstd. These parameters are part of the algo version: changing one needs a new version. */
export const PATCH_ALGO = {
  patchAlgoVer: 'v1',
  format: 'HDiffPatch single compressed diff (create_single_compressed_diff)',
  compressor: 'zstd',
  zstdLevel: 19,
  minMatchScore: 4,
  patchStepMemSize: 262144, // HDiffPatch kDefaultPatchStepMemSize (1024*256), not overridable from the tool
} as const;
/** emit `full` (diff against an empty old file) if patchSize > FULL_THRESHOLD x zstdSize(new). */
export const FULL_THRESHOLD = 0.6;

export interface PatchItem {
  unit: string;
  patchFile: string;
  patchSize: number;
  updateType: UpdateType;
  builtHash: string;
  baseHash: string;
  ratioOfZstdFull: number;
  /** size of the delta patch even when `full` was chosen (for information) */
  deltaPatchSize: number;
  newZstdSize: number;
  /** only with --report-plain: size of the delta patch the same JS would have cost compiled WITHOUT -base-bytecode */
  plainEquivalentSize?: number;
  /** only with --report-plain: deltaPatchSize / plainEquivalentSize (< 1 means the delta compile helped) */
  deltaOverPlain?: number;
}
export interface PatchReport {
  schema: 1;
  platform: Platform;
  appVersion: string | null;
  base: string;
  new: string;
  baseSourceSha: string | null;
  newSourceSha: string | null;
  /** true if the NEW build was compiled with hermesc -base-bytecode against the (embedded) base */
  deltaMode: boolean;
  hostChanged: boolean;
  changedUnits: string[];
  idsChanged: boolean;
  items: PatchItem[];
  toolchain: BuildJson['toolchain'];
  algo: typeof PATCH_ALGO & { fullThreshold: number };
  tools: { hdiffz_tool: string; ota_apply: string };
}

export interface RoundTrip { ok: boolean; status: string; code: number; detail: string }

/** Apply `patchFile` to `oldFile` ('-' = empty) with ota_apply into a scratch file and compare with `expectedHash`. Output file is deleted. */
export function roundTrip(applyTool: ToolInfo, oldFile: string | '-', patchFile: string, expectedHash: string, scratchDir: string): RoundTrip {
  mkdirSync(scratchDir, { recursive: true });
  const out = join(scratchDir, `rt-${process.pid}-${Math.random().toString(36).slice(2)}.out`);
  try {
    const r = run(applyTool.path, [oldFile, patchFile, out, expectedHash], { timeoutMs: 120_000 });
    let parsed: { ok?: boolean; status?: string; code?: number } = {};
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}'); } catch { /* handled below */ }
    if (r.timedOut) return { ok: false, status: 'Timeout', code: -1, detail: 'ota_apply timed out' };
    if (r.status !== 0 || parsed.ok !== true) {
      return { ok: false, status: parsed.status ?? 'Unknown', code: r.status ?? -1, detail: (r.stdout + r.stderr).trim() };
    }
    // belt and braces: ota_apply already compared the hash; recompute it from the bytes it wrote
    if (!existsSync(out)) return { ok: false, status: 'NoOutput', code: 0, detail: 'ota_apply reported ok but wrote no file' };
    const got = hashFile(out);
    if (got !== expectedHash) return { ok: false, status: 'HashMismatch', code: 3, detail: `result ${got} != expected ${expectedHash}` };
    return { ok: true, status: 'Ok', code: 0, detail: '' };
  } finally {
    rmrf(out);
    rmrf(`${out}.tmp`);
  }
}

function diffTo(hdiffz: ToolInfo, oldFile: string, newFile: string, outFile: string): void {
  const r = run(hdiffz.path, [
    '-c', PATCH_ALGO.compressor, '-l', String(PATCH_ALGO.zstdLevel), '-m', String(PATCH_ALGO.minMatchScore), oldFile, newFile, outFile,
  ], { timeoutMs: 600_000 });
  if (r.status !== 0 || r.timedOut || !existsSync(outFile)) {
    rmrf(outFile);
    throw new BuildError('DIFF_FAILED', `hdiffz_tool failed (exit ${r.status}${r.timedOut ? ', timeout' : ''}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  }
}

function sameToolchain(a: BuildJson['toolchain'], b: BuildJson['toolchain']): string[] {
  return (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} vs ${b[k]}`);
}

export interface PatchOptions {
  base: string;
  new: string;
  out: string;
  /** replace an existing patch-report.json and *.hdiff files in `out` */
  overwrite?: boolean;
  /** emit `full` for every changed file (used when platforms must agree on the update type) */
  forceFull?: boolean;
  /** tests/experiments only; the pipeline constant is FULL_THRESHOLD */
  fullThreshold?: number;
  hdiffzPath?: string;
  otaApplyPath?: string;
  /** monitoring: also compile each changed file plainly and record the plain patch size (needs <new>/js and hermesc) */
  reportPlain?: boolean;
  hermescPath?: string;
  allowUnpinnedHermesc?: boolean;
}

export function createPatches(o: PatchOptions): PatchReport {
  const baseDir = resolve(o.base);
  const newDir = resolve(o.new);
  const out = resolve(o.out);
  const threshold = o.fullThreshold ?? FULL_THRESHOLD;
  const baseB = verifyBuildDir(baseDir);
  const newB = verifyBuildDir(newDir);

  if (baseB.platform !== newB.platform) throw new BuildError('PLATFORM_MISMATCH', `platform mismatch: base ${baseB.platform}, new ${newB.platform}`);
  const tcDiff = sameToolchain(baseB.toolchain, newB.toolchain);
  if (tcDiff.length) throw new BuildError('TOOLCHAIN_MISMATCH', `toolchain mismatch between base and new build (${tcDiff.join('; ')}): patches are only valid for bytes produced by the same toolchain`);
  if (baseB.appVersion !== newB.appVersion) throw new BuildError('APPVERSION_MISMATCH', `appVersion mismatch: base ${baseB.appVersion}, new ${newB.appVersion}`);
  const bu = Object.keys(baseB.units).sort();
  const nu = Object.keys(newB.units).sort();
  if (bu.join() !== nu.join()) throw new BuildError('UNIT_SET_MISMATCH', `unit sets differ: base [${bu}] new [${nu}] (added/removed units are not patchable)`);
  // same module id must mean the same module in both builds (the new unit resolves host modules through the base's ids)
  const baseIds = readJson<Record<string, string>>(join(baseDir, 'ids.json'));
  const newIds = readJson<Record<string, string>>(join(newDir, 'ids.json'));
  for (const [id, p] of Object.entries(baseIds)) {
    if (id in newIds && newIds[id] !== p) throw new BuildError('IDS_CONFLICT', `module id ${id} maps to ${p} in base but ${newIds[id]} in new build`);
  }
  for (const [u, e] of Object.entries(baseB.units)) {
    if (newB.units[u].entryModuleId !== e.entryModuleId) throw new BuildError('IDS_CONFLICT', `unit ${u}: entryModuleId changed (${e.entryModuleId} -> ${newB.units[u].entryModuleId})`);
  }

  // a delta build is only meaningful against the base it was compiled from
  if (newB.delta?.enabled) {
    const baseBuildHash = hashFile(join(baseDir, 'build.json'));
    if (newB.delta.baseBuild !== baseBuildHash) {
      throw new BuildError('DELTA_BASE_MISMATCH', `the new build was delta-compiled against base build.json ${newB.delta.baseBuild}, but --base is ${baseBuildHash}`);
    }
    if (baseB.delta?.enabled) throw new BuildError('DELTA_BASE_IS_DELTA', 'the base of a patch must be the embedded base build, not a delta build');
  }
  const deltaMode = !!newB.delta?.enabled;
  const plainHermesc = o.reportPlain && deltaMode ? resolveHermesc({ path: o.hermescPath, allowUnpinned: o.allowUnpinnedHermesc }) : null;
  if (plainHermesc && plainHermesc.sha256 !== newB.toolchain.hermescSha256) {
    throw new BuildError('TOOLCHAIN_MISMATCH', `--report-plain: hermesc ${plainHermesc.sha256} is not the one that built ${newDir}`);
  }

  const hdiffz = resolveHdiffz(o.hdiffzPath);
  const apply = resolveOtaApply(o.otaApplyPath);

  if (existsSync(out)) {
    const stale = readdirSync(out).filter((f) => f === 'patch-report.json' || f.endsWith('.hdiff'));
    if (stale.length && !o.overwrite) throw new BuildError('OUT_EXISTS', `${out} already contains ${stale.join(', ')}; use --overwrite`);
  }

  const stage = stagingDirFor(out);
  try {
    const scratch = join(stage, '.scratch');
    mkdirSync(scratch);
    const emptyOld = join(scratch, 'empty.bin');
    writeFileSync(emptyOld, '');

    const candidates: { unit: string; b: BuildFileEntry; n: BuildFileEntry }[] = [{ unit: 'host', b: baseB.host, n: newB.host }];
    for (const u of nu) candidates.push({ unit: u, b: baseB.units[u], n: newB.units[u] });
    const items: PatchItem[] = [];
    const staged: { name: string }[] = [];
    for (const { unit, b, n } of candidates) {
      if (b.hash === n.hash) continue;
      const baseFile = join(baseDir, b.file);
      const newFile = join(newDir, n.file);
      const stem = `${unit}.${baseB.platform}.${b.hash.slice(7, 19)}-${n.hash.slice(7, 19)}`;
      const deltaTmp = join(scratch, `${stem}.delta`);
      diffTo(hdiffz, baseFile, newFile, deltaTmp);
      const deltaSize = statSync(deltaTmp).size;
      let plainEquivalentSize: number | undefined;
      if (o.reportPlain) {
        if (!plainHermesc) plainEquivalentSize = deltaSize; // a plain build: the plain-equivalent is the patch itself
        else {
          const jsRel = unit === 'host' ? 'host.js' : readJson<{ units: Record<string, { file: string }> }>(join(newDir, 'units.json')).units[unit].file;
          const jsFile = join(newDir, 'js', jsRel);
          if (!existsSync(jsFile)) throw new BuildError('NO_JS', `--report-plain needs ${jsFile} (the splitter output kept in the new build dir)`);
          if (hashFile(jsFile) !== newB.delta!.files[n.file].js) throw new BuildError('BAD_BUILD', `${jsFile} does not match the js hash recorded in build.json`);
          const plainHbc = join(scratch, `${stem}.plain.hbc`);
          compileHbc(plainHermesc, jsFile, join(scratch, 'plain-work'), plainHbc, `plain-${unit}`);
          const plainDiff = join(scratch, `${stem}.plain.delta`);
          diffTo(hdiffz, baseFile, plainHbc, plainDiff);
          plainEquivalentSize = statSync(plainDiff).size;
          rmrf(plainHbc); rmrf(plainDiff);
        }
      }
      let updateType: UpdateType = 'patch';
      let chosen = deltaTmp;
      let chosenSize = deltaSize;
      if (o.forceFull || deltaSize > threshold * n.zstdSize) {
        const fullTmp = join(scratch, `${stem}.full`);
        diffTo(hdiffz, emptyOld, newFile, fullTmp);
        updateType = 'full';
        chosen = fullTmp;
        chosenSize = statSync(fullTmp).size;
      }
      // mandatory round trip with the code the app ships; never emit a patch that does not reproduce the new hash
      const rt = roundTrip(apply, updateType === 'full' ? '-' : baseFile, chosen, n.hash, scratch);
      if (!rt.ok) throw new BuildError('ROUNDTRIP_FAILED', `round trip failed for ${unit} (${updateType}): ${rt.status}: ${rt.detail}`);
      const patchName = `${stem}.${updateType === 'full' ? 'full' : 'delta'}.hdiff`;
      renameSync(chosen, join(stage, patchName));
      staged.push({ name: patchName });
      items.push({
        unit, patchFile: patchName, patchSize: chosenSize, updateType, builtHash: n.hash, baseHash: b.hash,
        ratioOfZstdFull: Number((chosenSize / n.zstdSize).toFixed(4)), deltaPatchSize: deltaSize, newZstdSize: n.zstdSize,
        ...(plainEquivalentSize !== undefined ? { plainEquivalentSize, deltaOverPlain: Number((deltaSize / Math.max(plainEquivalentSize, 1)).toFixed(4)) } : {}),
      });
    }
    rmrf(scratch);

    const report: PatchReport = {
      schema: 1,
      platform: newB.platform,
      appVersion: newB.appVersion,
      base: sha256Of(readFileSync(join(baseDir, 'build.json'))),
      new: sha256Of(readFileSync(join(newDir, 'build.json'))),
      baseSourceSha: baseB.sourceSha,
      newSourceSha: newB.sourceSha,
      deltaMode,
      hostChanged: items.some((i) => i.unit === 'host'),
      changedUnits: items.filter((i) => i.unit !== 'host').map((i) => i.unit),
      idsChanged: baseB.ids.hash !== newB.ids.hash,
      items,
      toolchain: newB.toolchain,
      algo: { ...PATCH_ALGO, fullThreshold: threshold },
      tools: { hdiffz_tool: hdiffz.sha256, ota_apply: apply.sha256 },
    };
    writeFileSync(join(stage, 'patch-report.json'), toJson(report));

    // publish: patches first, report last (a report never references a missing file)
    mkdirSync(out, { recursive: true });
    if (o.overwrite) for (const f of readdirSync(out)) if (f === 'patch-report.json' || f.endsWith('.hdiff')) unlinkSync(join(out, f));
    for (const s of staged) renameSync(join(stage, s.name), join(out, s.name));
    renameSync(join(stage, 'patch-report.json'), join(out, 'patch-report.json'));
    return report;
  } finally {
    rmrf(stage);
  }
}
