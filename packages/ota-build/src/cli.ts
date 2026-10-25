#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bundle, parseDeltaMode, verifyRepro } from './bundle.ts';
import { archiveBase, verifyArchive } from './archive.ts';
import { createPatches } from './patch.ts';
import { baseInfo, deployArgs } from './handoff.ts';
import { formatReport, runDoctor } from './doctor.ts';
import { assertPlatform } from './hbc.ts';
import { fetchTools, toolStatus } from './tools.ts';
import { BuildError, setPathOverrides, toJson, workDir } from './util.ts';
import { parsePinKey } from './pins.ts';

const USAGE = `ota-build <command> [flags]   (node src/cli.ts <command>)

  fetch-tools [--force] [--platform osx|linux64|win64]     get hermesc (RN 0.78.3, sha256-pinned per OS; default = this host) into the tools dir; show hdiffz_tool/ota_apply paths
  bundle --project DIR --platform android|ios --out DIR [--source-sha X] [--app-version V] [--base-build DIR]
         [--delta auto|on|off] [--hermesc PATH] [--allow-unpinned-hermesc]
         with --base-build the files are compiled by \`hermesc -base-bytecode=<base>.hbc\` (delta mode: patches ~30x smaller); needs the base .hbc bytes
  verify-repro --project DIR --platform P [--work DIR] [--base-build DIR] [--delta M]   bundle twice into different dirs; require byte-identical output
  patch --base DIR --new DIR --out DIR [--overwrite] [--force-full] [--report-plain] [--hdiffz PATH] [--ota-apply PATH] [--hermesc PATH]
  archive-base --build DIR --out DIR              copy exactly what a later delta build needs from the base release build (+ archive-manifest.json)
  archive-base --verify DIR [--base-json FILE]    check an archive (and, with --base-json, its hashes against base.json)
  base-info --android DIR --ios DIR [--release-tag T] [--toolchain-image I] [--app-version V] [--out FILE]
  doctor --project DIR [--platform android|ios] [--json] [--deep] [--delta auto|on|off]   readiness check (PASS/WARN/FAIL per check; exit 1 on any FAIL)
  deploy-args --report FILE --report FILE --unit U --version V --pr N [--json] [--out FILE]

Global flags: --tools-dir DIR (hermesc cache), --work-dir DIR (scratch)
Locations resolve flag > env > default: OTA_TOOLS_DIR (<repo>/.tools), OTA_WORK_DIR (<repo>/.work), OTA_HERMESC, OTA_HDIFFZ (alias OTA_HDIFFZ_TOOL), OTA_APPLY (native/build-ota-tools/*). doctor shows where each came from.
Exit codes: 0 ok, 1 failure (message on stderr), 2 usage.`;

const { values: f, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: 'boolean' }, project: { type: 'string' }, platform: { type: 'string' }, out: { type: 'string' },
    'source-sha': { type: 'string' }, 'app-version': { type: 'string' }, 'base-build': { type: 'string' }, delta: { type: 'string' }, 'report-plain': { type: 'boolean' }, build: { type: 'string' }, verify: { type: 'string' }, 'base-json': { type: 'string' },
    hermesc: { type: 'string' }, 'allow-unpinned-hermesc': { type: 'boolean' }, work: { type: 'string' },
    base: { type: 'string' }, new: { type: 'string' }, overwrite: { type: 'boolean' }, 'force-full': { type: 'boolean' },
    hdiffz: { type: 'string' }, 'ota-apply': { type: 'string' }, 'tools-dir': { type: 'string' }, 'work-dir': { type: 'string' },
    android: { type: 'string' }, ios: { type: 'string' }, 'release-tag': { type: 'string' }, 'toolchain-image': { type: 'string' },
    report: { type: 'string', multiple: true }, unit: { type: 'string' }, version: { type: 'string' }, pr: { type: 'string' }, json: { type: 'boolean' }, deep: { type: 'boolean' },
  },
});
const need = <T>(v: T | undefined, name: string): T => {
  if (v === undefined || v === '') throw new BuildError('USAGE', `missing --${name}`);
  return v;
};
function emit(text: string, out?: string): void {
  if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, text); }
  else process.stdout.write(text);
}

async function main(): Promise<number> {
  const cmd = positionals[0];
  setPathOverrides({ toolsDir: f['tools-dir'], workDir: f['work-dir'] });
  switch (cmd) {
    case 'fetch-tools': {
      const h = fetchTools({ force: f.force, platform: f.platform ? parsePinKey(f.platform) : undefined });
      console.log(`hermesc ${h.path}\n  sha256 ${h.sha256} (pinned: ${h.pinned}, pin ${h.pinKey})\n  RN ${h.rn}, HBC bytecode version ${h.hbcVersion}, .hermesversion ${h.hermesVersionFile}`);
      for (const t of toolStatus().filter((x) => x.name !== 'hermesc')) console.log(`${t.name}: ${t.ok ? `${t.path} (${t.sha256})` : `MISSING - ${t.detail}`}`);
      return 0;
    }
    case 'bundle': {
      const r = await bundle({
        project: need(f.project, 'project'), platform: need(f.platform, 'platform') as 'android' | 'ios', out: need(f.out, 'out'),
        sourceSha: f['source-sha'], appVersion: f['app-version'], baseBuild: f['base-build'], delta: parseDeltaMode(f.delta), hermescPath: f.hermesc,
        allowUnpinnedHermesc: f['allow-unpinned-hermesc'],
      });
      console.log(`bundled ${r.build.platform} -> ${r.outDir}${r.build.delta?.enabled ? ' (hermesc delta mode against the base build)' : ''}`);
      console.log(`  host.hbc  ${r.build.host.hash.slice(0, 19)}  ${r.build.host.size} B (zstd ${r.build.host.zstdSize})`);
      for (const e of Object.values(r.build.units)) console.log(`  ${e.file}  ${e.hash.slice(0, 19)}  ${e.size} B (zstd ${e.zstdSize})`);
      return 0;
    }
    case 'verify-repro': {
      const work = f.work ?? join(workDir().path, `verify-repro-${process.pid}`);
      const r = await verifyRepro({
        project: need(f.project, 'project'), platform: need(f.platform, 'platform') as 'android' | 'ios', workDir: work,
        hermescPath: f.hermesc, allowUnpinnedHermesc: f['allow-unpinned-hermesc'], sourceSha: f['source-sha'], appVersion: f['app-version'],
        baseBuild: f['base-build'], delta: parseDeltaMode(f.delta),
      });
      if (!r.ok) {
        console.error(`NOT REPRODUCIBLE (${r.differences.length} differences; outputs kept in ${work}):\n  ${r.differences.join('\n  ')}`);
        return 1;
      }
      console.log(`REPRODUCIBLE: ${r.files} files byte-identical across two builds in different directories; build.json ${r.buildJsonHash}`);
      return 0;
    }
    case 'patch': {
      const r = createPatches({
        base: need(f.base, 'base'), new: need(f.new, 'new'), out: need(f.out, 'out'), overwrite: f.overwrite, forceFull: f['force-full'],
        hdiffzPath: f.hdiffz, otaApplyPath: f['ota-apply'], reportPlain: f['report-plain'], hermescPath: f.hermesc,
        allowUnpinnedHermesc: f['allow-unpinned-hermesc'],
      });
      console.log(`${r.platform}: hostChanged=${r.hostChanged} changedUnits=[${r.changedUnits}] items=${r.items.length} deltaMode=${r.deltaMode}`);
      for (const i of r.items) {
        const plain = i.plainEquivalentSize !== undefined ? `; plain-equivalent ${i.plainEquivalentSize} B, delta/plain ${i.deltaOverPlain}` : '';
        console.log(`  ${i.unit}: ${i.updateType} ${i.patchSize} B (${(i.ratioOfZstdFull * 100).toFixed(1)}% of zstd full ${i.newZstdSize} B) -> ${i.patchFile} [round trip OK]${plain}`);
      }
      return 0;
    }
    case 'archive-base': {
      if (f.verify) {
        const r = verifyArchive({ dir: f.verify, baseJson: f['base-json'] });
        console.log(`archive OK: ${r.platform}, ${r.files} files${f['base-json'] ? ', hashes match base.json' : ' (pass --base-json to compare with base.json)'}`);
        return 0;
      }
      const m = archiveBase({ build: need(f.build, 'build'), out: need(f.out, 'out') });
      console.log(`archived ${m.platform} base build -> ${resolve(f.out!)}: ${Object.keys(m.files).length} files + archive-manifest.json`);
      return 0;
    }
    case 'base-info': {
      const b = baseInfo({
        android: need(f.android, 'android'), ios: need(f.ios, 'ios'), releaseTag: f['release-tag'], toolchainImage: f['toolchain-image'], appVersion: f['app-version'],
      });
      emit(toJson(b), f.out);
      return 0;
    }
    case 'deploy-args': {
      const d = deployArgs({ reports: f.report ?? [], unit: need(f.unit, 'unit'), version: need(f.version, 'version'), pr: Number(need(f.pr, 'pr')) });
      emit(f.json ? toJson(d) : d.command + '\n', f.out);
      return 0;
    }
    case 'doctor': {
      if (f.platform !== undefined) assertPlatform(f.platform);
      const r = await runDoctor({ project: need(f.project, 'project'), platform: f.platform as 'android' | 'ios' | undefined, deep: f.deep, delta: parseDeltaMode(f.delta) });
      process.stdout.write(f.json ? toJson(r) : formatReport(r));
      return r.ok ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

main().then((c) => process.exit(c), (e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(e instanceof BuildError && e.code === 'USAGE' ? 2 : 1);
});
