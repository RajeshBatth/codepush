// base-info (BaseInfo for `ota-cli init`) and deploy-args (flags for `ota-cli deploy`).
import { dirname, join, resolve } from 'node:path';
import { verifyBuildDir } from './bundle.ts';
import { PATCH_ALGO, type PatchReport } from './patch.ts';
import { BuildError, readJson } from './util.ts';
import { PLATFORMS, type BaseInfo, type Platform } from './types.ts';

export interface BaseInfoOptions {
  android: string;
  ios: string;
  releaseTag?: string;
  toolchainImage?: string;
  appVersion?: string;
}

export function baseInfo(o: BaseInfoOptions): BaseInfo {
  const b = { android: verifyBuildDir(o.android), ios: verifyBuildDir(o.ios) };
  for (const p of PLATFORMS) if (b[p].platform !== p) throw new BuildError('PLATFORM_MISMATCH', `${p} build dir contains a ${b[p].platform} build`);
  const a = b.android;
  const i = b.ios;
  const tc = a.toolchain;
  for (const k of Object.keys(tc) as (keyof typeof tc)[]) {
    if (tc[k] !== i.toolchain[k]) throw new BuildError('TOOLCHAIN_MISMATCH', `android/ios toolchain differs in ${k}: ${tc[k]} vs ${i.toolchain[k]}`);
  }
  const appVersion = o.appVersion ?? a.appVersion;
  if (!appVersion) throw new BuildError('NO_APP_VERSION', 'appVersion unknown: bundle with --app-version or pass --app-version');
  if (a.appVersion && i.appVersion && a.appVersion !== i.appVersion) throw new BuildError('APPVERSION_MISMATCH', `android ${a.appVersion} vs ios ${i.appVersion}`);
  if (o.appVersion && ((a.appVersion && a.appVersion !== o.appVersion) || (i.appVersion && i.appVersion !== o.appVersion))) {
    throw new BuildError('APPVERSION_MISMATCH', `--app-version ${o.appVersion} disagrees with the builds (${a.appVersion}/${i.appVersion})`);
  }
  const names = Object.keys(a.units).sort();
  if (names.join() !== Object.keys(i.units).sort().join()) throw new BuildError('UNIT_SET_MISMATCH', 'android and ios builds declare different units');
  const per = <T>(f: (x: typeof a) => T): Record<Platform, T> => ({ android: f(a), ios: f(i) });
  return {
    appVersion,
    releaseTag: o.releaseTag ?? `v${appVersion}`,
    toolchainImage: o.toolchainImage ?? 'local-unpinned',
    patchAlgoVer: PATCH_ALGO.patchAlgoVer,
    hbc: { bytecodeVersion: tc.hbcVersion, hermescSha256: tc.hermescSha256 },
    host: per((x) => x.host.hash),
    units: Object.fromEntries(names.map((u) => [u, per((x) => x.units[u].hash)])),
    sizes: {
      host: per((x) => x.host.zstdSize),
      units: Object.fromEntries(names.map((u) => [u, per((x) => x.units[u].zstdSize)])),
    },
  };
}

export interface DeployArgs {
  unit: string;
  version: string;
  pr: number;
  /** platforms the change affects (a platform whose bytes are unchanged is omitted) */
  platforms: Platform[];
  updateTypes: Partial<Record<Platform, 'patch' | 'full'>>;
  /** flag -> value, in a fixed order */
  flags: [string, string][];
  /** the same, as one shell-quoted string (without requester/approver/ticket, which the Jenkins job supplies) */
  command: string;
  warnings: string[];
}

const shq = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function deployArgs(o: { reports: string[]; unit: string; version: string; pr: number }): DeployArgs {
  if (o.reports.length !== 2) throw new BuildError('BAD_ARG', 'deploy-args needs exactly two reports (android and ios)');
  const byPlatform: Partial<Record<Platform, { report: PatchReport; dir: string }>> = {};
  for (const r of o.reports) {
    const path = resolve(r);
    const report = readJson<PatchReport>(path);
    if (report.schema !== 1 || !(PLATFORMS as readonly string[]).includes(report.platform)) throw new BuildError('BAD_REPORT', `${path}: not a patch-report.json`);
    if (byPlatform[report.platform]) throw new BuildError('BAD_ARG', `two reports for ${report.platform}`);
    byPlatform[report.platform] = { report, dir: dirname(path) };
  }
  if (!byPlatform.android || !byPlatform.ios) throw new BuildError('BAD_ARG', 'need one android and one ios patch-report.json');
  const warnings: string[] = [];
  const picked: Partial<Record<Platform, { item: PatchReport['items'][number]; dir: string }>> = {};
  for (const p of PLATFORMS) {
    const { report, dir } = byPlatform[p]!;
    if (report.appVersion !== byPlatform.android.report.appVersion) throw new BuildError('APPVERSION_MISMATCH', 'reports are for different app versions');
    // Tier 1 rule 2: exactly one unit's artifact differs; the host only differs for the host unit.
    if (o.unit === 'host') {
      if (report.changedUnits.length) throw new BuildError('RULE_ONE_UNIT', `${p}: host patch must not change units (changed: ${report.changedUnits})`);
    } else {
      if (report.hostChanged) throw new BuildError('RULE_ONE_UNIT', `${p}: host changed; a unit PR may not change the host`);
      if (report.changedUnits.some((u) => u !== o.unit)) {
        throw new BuildError('RULE_ONE_UNIT', `${p}: expected only [${o.unit}] to change, got [${report.changedUnits}]`);
      }
    }
    const item = report.items.find((x) => x.unit === o.unit);
    if (!item) {
      // A change in e.g. an `.android.js` file leaves the other platform's bytes untouched: deploy only where it differs.
      warnings.push(`${p}: ${o.unit} is unchanged on ${p}; deploying to the other platform only`);
      continue;
    }
    picked[p] = { item, dir };
  }
  const affected = PLATFORMS.filter((p) => picked[p]);
  if (affected.length === 0) throw new BuildError('NOTHING_TO_DEPLOY', `${o.unit} is unchanged on both platforms: nothing to deploy`);
  const flags: [string, string][] = [['--version', o.version], ['--unit', o.unit], ['--pr', String(o.pr)]];
  for (const p of affected) {
    const x = picked[p]!;
    flags.push([`--patch-${p}`, join(x.dir, x.item.patchFile)], [`--built-${p}`, x.item.builtHash], [`--update-type-${p}`, x.item.updateType]);
  }
  const updateTypes = Object.fromEntries(affected.map((p) => [p, picked[p]!.item.updateType])) as Partial<Record<Platform, 'patch' | 'full'>>;
  return { unit: o.unit, version: o.version, pr: o.pr, platforms: affected, updateTypes, flags, command: flags.map(([k, v]) => `${k} ${shq(v)}`).join(' '), warnings };
}
