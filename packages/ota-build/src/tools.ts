// External toolchain: hermesc (from the react-native npm tarball, pinned by sha256 PER PLATFORM, see pins.ts), hdiffz_tool and ota_apply (native/).
// Locations: explicit flag > environment variable > repo-relative default (util.ts `pickPath`); every result says where it came from.
import { copyFileSync, chmodSync, existsSync, mkdirSync as mk, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BuildError, DEFAULT_NATIVE_BUILD_DIR, childEnv, describeOrigin, hashFile, pickPath, rmrf, run, toJson, toolsDir, workDir,
  type Origin,
} from './util.ts';
import {
  EXPECTED_HBC_VERSION, HERMESC_PINS, HERMES_COMMIT, HERMESC_PIN_TABLE, PIN_KEYS, RN_VERSION, pinKeyForHost, type HermescPin, type PinKey,
} from './pins.ts';

export { EXPECTED_HBC_VERSION, HERMESC_PINS, HERMES_COMMIT, RN_VERSION, HERMESC_PIN_TABLE, pinKeyForHost };
export const HERMES_FLAGS = '-O -emit-binary -g0';

export interface ToolInfo { path: string; sha256: string; origin?: Origin }
export interface HermescInfo extends ToolInfo { rn: string; hbcVersion: number; pinned: boolean; hermesVersionFile: string | null; pinKey: PinKey | null }

/** Where the fetched hermesc of `key` lives: `<tools dir>/hermesc-rn<RN>` for the host platform, `...-<key>` for a cross fetch. */
export const hermescDir = (key: PinKey | null = pinKeyForHost()): string =>
  join(toolsDir().path, `hermesc-rn${RN_VERSION}${key && key !== pinKeyForHost() ? `-${key}` : ''}`);
const isExec = (p: string): boolean => {
  try {
    const st = statSync(p);
    return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0);
  } catch { return false; }
};
const tarBin = (): string => (existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar');

/** npm sits next to node (nvm layout); the shell's `npm` may be a lazy function, so never rely on PATH alone. */
function npmBin(): string {
  const beside = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (existsSync(beside)) return beside;
  return 'npm';
}

export function parseHbcVersion(versionOutput: string): number | null {
  const m = /HBC bytecode version:\s*(\d+)/i.exec(versionOutput);
  return m ? Number(m[1]) : null;
}

/**
 * Download react-native@RN_VERSION with `npm pack` into a fresh dir, extract ONLY the hermesc binary (+ the pinned companion files)
 * and .hermesversion (the tarball is untrusted), verify the pinned sha256 of EVERY extracted file BEFORE running anything, then,
 * only when the pin is for THIS machine, run `hermesc -version`. `platform` fetches another OS's pin (hash-verified, never executed).
 */
export function fetchTools(opts: { force?: boolean; platform?: PinKey } = {}): HermescInfo {
  const host = pinKeyForHost();
  const key = opts.platform ?? host;
  if (!key) throw new BuildError('UNSUPPORTED_PLATFORM', `no pinned hermesc for ${process.platform}/${process.arch} (pins: ${PIN_KEYS.map((k) => `${k}=${HERMESC_PIN_TABLE[k].nodePlatform}/${HERMESC_PIN_TABLE[k].arches.join('+')}`).join(', ')}); pass --platform osx|linux64|win64 to fetch one anyway, or add a pin in src/pins.ts`);
  const pin: HermescPin = HERMESC_PIN_TABLE[key];
  const executable = key === host;
  const dest = hermescDir(key);
  if (!opts.force && existsSync(join(dest, 'tool.json'))) {
    try { return resolveHermesc({ path: join(dest, pin.binary), pinKey: key, execute: executable }); } catch { /* fall through and re-fetch */ }
  }
  const dl = join(workDir().path, `fetch-rn-${process.pid}`);
  const dlTar = join(dl, 'tarball');
  const dlOut = join(dl, 'extract');
  rmrf(dl);
  mk(dlTar, { recursive: true });
  mk(dlOut, { recursive: true });
  try {
    const pack = run(npmBin(), ['pack', `react-native@${RN_VERSION}`, '--pack-destination', dlTar, '--silent'], { cwd: dlTar, timeoutMs: 600_000 });
    if (pack.status !== 0) throw new BuildError('FETCH', `npm pack react-native@${RN_VERSION} failed: ${pack.stderr.trim() || pack.stdout.trim()}`);
    const tgz = join(dlTar, `react-native-${RN_VERSION}.tgz`);
    if (!existsSync(tgz)) throw new BuildError('FETCH', `expected ${tgz} after npm pack`);
    const prefix = `package/sdks/hermesc/${pin.dir}`;
    const files: Record<string, string> = { [pin.binary]: pin.sha256, ...pin.companions };
    const members = [...Object.keys(files).map((f) => `${prefix}/${f}`), 'package/sdks/.hermesversion'];
    const tar = run(tarBin(), ['xzf', tgz, '-C', dlOut, ...members], { cwd: dlTar, env: childEnv() });
    if (tar.status !== 0) throw new BuildError('FETCH', `tar extraction failed: ${tar.stderr.trim()}`);
    for (const [f, want] of Object.entries(files)) {
      const got = hashFile(join(dlOut, prefix, f));
      if (got !== want) throw new BuildError('HERMESC_SHA', `${f} (${key}) sha256 mismatch: got ${got}, pinned ${want}; NOT running it`);
    }
    const extracted = join(dlOut, prefix, pin.binary);
    chmodSync(extracted, 0o755);
    let hbc: number = EXPECTED_HBC_VERSION;
    if (executable) {
      const ver = run(extracted, ['-version'], { cwd: dlOut, timeoutMs: 30_000 });
      const got = parseHbcVersion(ver.stdout + ver.stderr);
      if (got !== EXPECTED_HBC_VERSION) throw new BuildError('HBC_VERSION', `hermesc reports bytecode version ${got}, expected ${EXPECTED_HBC_VERSION}`);
      hbc = got;
    }
    rmrf(dest);
    mk(dest, { recursive: true });
    for (const f of Object.keys(files)) {
      const tmpBin = join(dest, `${f}.tmp`);
      copyFileSync(join(dlOut, prefix, f), tmpBin);
      chmodSync(tmpBin, 0o755);
      renameSync(tmpBin, join(dest, f));
    }
    copyFileSync(join(dlOut, 'package/sdks/.hermesversion'), join(dest, 'hermesversion'));
    writeFileSync(join(dest, 'tool.json'), toJson({ rn: RN_VERSION, pin: key, platform: pin.nodePlatform, hermescSha256: pin.sha256, hermesCommit: HERMES_COMMIT, hbcVersion: hbc, verifiedByExecution: executable }));
  } finally {
    rmrf(dl);
  }
  return resolveHermesc({ path: join(dest, pin.binary), pinKey: key, execute: executable });
}

/**
 * Find hermesc: explicit path (`--hermesc`) > `OTA_HERMESC` > `<tools dir>/hermesc-rn<RN>/` (tools dir: `--tools-dir` > `OTA_TOOLS_DIR` > `<repo>/.tools`).
 * The sha256 is always computed; pinned = equals the pin of THIS host (process.platform/arch, see pins.ts).
 * `pinKey`/`execute` are for cross-platform fetches (hash check only).
 */
export function resolveHermesc(o: { path?: string; allowUnpinned?: boolean; pinKey?: PinKey; execute?: boolean }): HermescInfo {
  const key = o.pinKey ?? pinKeyForHost();
  const pin = key ? HERMESC_PIN_TABLE[key] : undefined;
  const where = o.path
    ? pickPath({ flag: o.path, flagName: '--hermesc', dflt: '' })
    : pickPath({ envNames: ['OTA_HERMESC'], dflt: join(hermescDir(key), pin?.binary ?? 'hermesc') });
  const path = where.path;
  const origin: Origin = !o.path && where.origin.kind === 'default' && toolsDir().origin.kind !== 'default' ? toolsDir().origin : where.origin;
  if (!isExec(path)) throw new BuildError('NO_HERMESC', `hermesc not found at ${path} (from ${describeOrigin(origin)}); run: node src/cli.ts fetch-tools (or set OTA_HERMESC / OTA_TOOLS_DIR)`);
  const sha = hashFile(path);
  const pinned = !!pin && sha === pin.sha256;
  if (!pinned && !o.allowUnpinned) {
    throw new BuildError('HERMESC_SHA', `hermesc at ${path} has sha256 ${sha}, which is not the pinned ${pin?.sha256 ?? `(no pin for ${process.platform}/${process.arch})`}; refusing (use --allow-unpinned-hermesc only for experiments)`);
  }
  let hbc: number | null = EXPECTED_HBC_VERSION;
  if (o.execute !== false) {
    const ver = run(path, ['-version'], { cwd: dirname(path), timeoutMs: 30_000 });
    hbc = parseHbcVersion(ver.stdout + ver.stderr);
    if (hbc === null) throw new BuildError('HBC_VERSION', `cannot read the bytecode version from \`${path} -version\``);
  }
  let hv: string | null = null;
  const hvPath = join(dirname(path), 'hermesversion');
  if (existsSync(hvPath)) hv = readFileSync(hvPath, 'utf8').trim();
  return { path, sha256: sha, rn: RN_VERSION, hbcVersion: hbc, pinned, hermesVersionFile: hv, pinKey: key, origin };
}

/** Native tool: explicit path (flag) > env (first name = canonical, later = legacy alias) > `native/build-ota-tools/<name>`. */
function resolveNative(name: string, flagName: string, envNames: string[], explicit?: string): ToolInfo {
  const where = pickPath({ flag: explicit, flagName, envNames, dflt: join(DEFAULT_NATIVE_BUILD_DIR, name) });
  if (!isExec(where.path)) {
    throw new BuildError('NO_TOOL', `${name} not found at ${where.path} (from ${describeOrigin(where.origin)}). Build it: export PATH=/opt/homebrew/bin:$PATH; cmake -S native -B native/build-ota-tools -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++ && cmake --build native/build-ota-tools --target ${name} (or set ${envNames[0]} / ${flagName})`);
  }
  return { path: where.path, sha256: hashFile(where.path), origin: where.origin };
}
export const resolveHdiffz = (explicit?: string): ToolInfo => resolveNative('hdiffz_tool', '--hdiffz', ['OTA_HDIFFZ', 'OTA_HDIFFZ_TOOL'], explicit);
export const resolveOtaApply = (explicit?: string): ToolInfo => resolveNative('ota_apply', '--ota-apply', ['OTA_APPLY'], explicit);

export interface ToolStatus { name: string; ok: boolean; path?: string; sha256?: string; detail: string; origin?: Origin }
/** For `fetch-tools` / tests: report what is available without throwing. */
export function toolStatus(): ToolStatus[] {
  const out: ToolStatus[] = [];
  const t = (name: string, f: () => ToolInfo, extra?: (i: ToolInfo) => string) => {
    try { const i = f(); out.push({ name, ok: true, path: i.path, sha256: i.sha256, origin: i.origin, detail: extra ? extra(i) : '' }); }
    catch (e) { out.push({ name, ok: false, detail: (e as Error).message }); }
  };
  t('hermesc', () => resolveHermesc({}), (i) => `RN ${(i as HermescInfo).rn}, HBC v${(i as HermescInfo).hbcVersion}`);
  t('hdiffz_tool', () => resolveHdiffz());
  t('ota_apply', () => resolveOtaApply());
  return out;
}
