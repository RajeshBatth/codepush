// `archive-base`: the files a LATER delta build (hermesc -base-bytecode) needs from the base release build.
// The artifact store keeps only hashes in base.json; the base release job must archive these next to it (planned ota-cli port extension).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { verifyBuildDir, type BuildJson } from './bundle.ts';
import { BuildError, hashFile, isEmptyDir, readJson, toJson } from './util.ts';
import type { BaseInfo } from './types.ts';

export const ARCHIVE_MANIFEST = 'archive-manifest.json';
export interface ArchiveManifest {
  schema: 1;
  platform: string;
  appVersion: string | null;
  /** sha256 of the archived build.json */
  buildJson: string;
  /** every archived file (relative path) -> sha256 */
  files: Record<string, string>;
  /** sha256 of the JS each .hbc was compiled from (from build.json; lets a delta build copy unchanged files) */
  js: Record<string, string>;
}

/** Paths (relative) a delta build needs: all .hbc files plus the build metadata verifyBuildDir/the splitter read. */
const archiveFiles = (b: BuildJson): string[] =>
  [b.host.file, ...Object.values(b.units).map((u) => u.file), b.ids.file, b.unitsMap.file, 'build.json'];

export function archiveBase(o: { build: string; out: string }): ArchiveManifest {
  const src = resolve(o.build);
  const out = resolve(o.out);
  const b = verifyBuildDir(src);
  if (b.delta?.enabled) throw new BuildError('DELTA_BASE_IS_DELTA', `${src} is a delta build; only the embedded base release build may be archived as a delta base`);
  if (existsSync(out) && !isEmptyDir(out) && !existsSync(join(out, ARCHIVE_MANIFEST))) {
    throw new BuildError('OUT_NOT_EMPTY', `${out} exists, is not empty and is not a previous base archive; refusing to write into it`);
  }
  const files: Record<string, string> = {};
  for (const rel of archiveFiles(b).sort()) {
    const dst = join(out, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(src, rel), dst);
    files[rel] = hashFile(dst);
  }
  const m: ArchiveManifest = {
    schema: 1,
    platform: b.platform,
    appVersion: b.appVersion,
    buildJson: files['build.json'],
    files,
    js: Object.fromEntries(Object.entries(b.delta?.files ?? {}).map(([k, v]) => [k, v.js])),
  };
  writeFileSync(join(out, ARCHIVE_MANIFEST), toJson(m));
  verifyArchive({ dir: out });
  return m;
}

/**
 * Check an archive directory: manifest hashes, the build.json self-consistency (verifyBuildDir), and, with `baseJson`
 * (the BaseInfo that `ota-cli init` stored), that host/unit hashes and the hermesc identity equal what shipped in the app.
 */
export function verifyArchive(o: { dir: string; baseJson?: string }): { platform: string; files: number } {
  const dir = resolve(o.dir);
  if (!existsSync(join(dir, ARCHIVE_MANIFEST))) throw new BuildError('BAD_ARCHIVE', `${dir}: no ${ARCHIVE_MANIFEST}`);
  const m = readJson<ArchiveManifest>(join(dir, ARCHIVE_MANIFEST));
  if (m.schema !== 1) throw new BuildError('BAD_ARCHIVE', `${dir}: unsupported manifest schema ${m.schema}`);
  for (const [rel, hash] of Object.entries(m.files)) {
    if (!existsSync(join(dir, rel))) throw new BuildError('BAD_ARCHIVE', `${dir}: ${rel} is missing`);
    const got = hashFile(join(dir, rel));
    if (got !== hash) throw new BuildError('BAD_ARCHIVE', `${dir}: ${rel} is ${got}, manifest says ${hash}`);
  }
  const b = verifyBuildDir(dir);
  if (hashFile(join(dir, 'build.json')) !== m.buildJson) throw new BuildError('BAD_ARCHIVE', `${dir}: build.json differs from the manifest`);
  for (const rel of archiveFiles(b)) if (!(rel in m.files)) throw new BuildError('BAD_ARCHIVE', `${dir}: ${rel} is not listed in the manifest`);
  if (b.delta?.enabled) throw new BuildError('DELTA_BASE_IS_DELTA', `${dir} holds a delta build; the archive must be the embedded base`);
  if (o.baseJson) {
    const base = readJson<BaseInfo>(resolve(o.baseJson));
    const p = b.platform;
    const bad: string[] = [];
    if (base.host[p] !== b.host.hash) bad.push(`host ${b.host.hash} != base.json ${base.host[p]}`);
    const names = Object.keys(b.units).sort();
    if (names.join() !== Object.keys(base.units).sort().join()) bad.push(`unit set [${names}] != base.json [${Object.keys(base.units).sort()}]`);
    for (const u of names) if (base.units[u] && base.units[u][p] !== b.units[u].hash) bad.push(`${u} ${b.units[u].hash} != base.json ${base.units[u][p]}`);
    if (base.hbc.hermescSha256 !== b.toolchain.hermescSha256) bad.push(`hermescSha256 ${b.toolchain.hermescSha256} != base.json ${base.hbc.hermescSha256}`);
    if (base.hbc.bytecodeVersion !== b.toolchain.hbcVersion) bad.push(`bytecodeVersion ${b.toolchain.hbcVersion} != base.json ${base.hbc.bytecodeVersion}`);
    if (base.appVersion !== b.appVersion && b.appVersion !== null) bad.push(`appVersion ${b.appVersion} != base.json ${base.appVersion}`);
    if (bad.length) throw new BuildError('ARCHIVE_MISMATCH', `${dir} does not match base.json (${p}): ${bad.join('; ')}`);
  }
  return { platform: b.platform, files: Object.keys(m.files).length };
}
