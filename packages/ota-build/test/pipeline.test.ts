import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { bucket, selectUnit, type Manifest } from '../../ota-core/src/index.ts';
import { bundle, verifyBuildDir, type BuildJson } from '../src/bundle.ts';
import { createPatches, roundTrip, type PatchReport } from '../src/patch.ts';
import { baseInfo, deployArgs } from '../src/handoff.ts';
import { readHbcHeader, validateHbc } from '../src/hbc.ts';
import { resolveHermesc, resolveHdiffz, resolveOtaApply } from '../src/tools.ts';
import { BuildError, hashFile, rmrf, sha256Of, listFiles } from '../src/util.ts';
import { BUILD_CLI, OTA_CLI, append, copyDemo, missingTools, runBin, runNode, workRoot } from './helpers.ts';

const skip = missingTools();
if (skip) console.log(`SKIPPING ota-build pipeline tests: ${skip}`);
const APP_VERSION = '11.9.0';
const PLATFORMS = ['android', 'ios'] as const;

let W: string;
const b = (name: string) => join(W, name);
const readBuild = (dir: string): BuildJson => JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'));

async function bundleBoth(project: string, prefix: string, extra: { baseBuildPrefix?: string; sha?: string } = {}) {
  for (const p of PLATFORMS) {
    await bundle({
      project, platform: p, out: b(`${prefix}-${p}`), appVersion: APP_VERSION, sourceSha: extra.sha ?? prefix,
      baseBuild: extra.baseBuildPrefix ? b(`${extra.baseBuildPrefix}-${p}`) : null,
    });
  }
}
function patchBoth(basePrefix: string, newPrefix: string, outPrefix: string, opts: { fullThreshold?: number; forceFull?: boolean } = {}): Record<string, PatchReport> {
  const r: Record<string, PatchReport> = {};
  for (const p of PLATFORMS) r[p] = createPatches({ base: b(`${basePrefix}-${p}`), new: b(`${newPrefix}-${p}`), out: b(`${outPrefix}-${p}`), ...opts });
  return r;
}

describe('ota-build pipeline', { skip }, () => {
  before(async () => {
    W = workRoot('ota-build-test');
    await bundleBoth(copyDemo(b('app-base')), 'base');
  });
  after(() => rmrf(W));

  test('toolchain: hermesc is the pinned RN 0.78.3 binary with bytecode v96', () => {
    const h = resolveHermesc({});
    assert.equal(h.pinned, true);
    assert.equal(h.sha256, 'sha256:a82e519e1fa3737f6b95554cdb9edaaf37458fb03abcdc2144f039fa0b3302ab');
    assert.equal(h.hbcVersion, 96);
  });

  test('bundle: build.json schema, every .hbc has the Hermes magic and the toolchain version', () => {
    for (const p of PLATFORMS) {
      const dir = b(`base-${p}`);
      const bj = verifyBuildDir(dir);
      assert.equal(bj.platform, p);
      assert.equal(bj.toolchain.hbcVersion, 96);
      assert.equal(bj.toolchain.hermescFlags, '-O -emit-binary -g0');
      assert.deepEqual(Object.keys(bj.units), ['bus', 'cabs', 'travelplex']);
      const unitsJson = JSON.parse(readFileSync(join(dir, 'units.json'), 'utf8'));
      for (const [name, u] of Object.entries(bj.units)) {
        const data = readFileSync(join(dir, u.file));
        const hdr = readHbcHeader(data);
        assert.ok(hdr.magicOk && hdr.version === 96, `${name} header`);
        assert.equal(u.hash, sha256Of(data));
        assert.equal(u.size, data.length);
        assert.ok(u.zstdSize > 0 && u.zstdSize <= u.size + 64);
        assert.equal(u.entryModuleId, unitsJson.units[name].entryId);
      }
      assert.ok(bj.host.size > 10_000);
      assert.deepEqual(readdirSync(dir).sort(), ['build.json', 'host.hbc', 'ids.json', 'js', 'units', 'units.json']);
    }
    // the splitter now builds per platform: the host differs (platform-specific module in the demo app)...
    const a = readBuild(b('base-android')), i = readBuild(b('base-ios'));
    assert.equal(a.platform, 'android');
    assert.equal(i.platform, 'ios');
    assert.notEqual(a.host.hash, i.host.hash, 'android and ios hosts must differ');
    // ...while units that use no platform-specific code are identical across platforms
    assert.equal(a.units.cabs.hash, i.units.cabs.hash);
  });

  test('hbc validation rejects wrong version / non-bytecode', () => {
    const good = readFileSync(join(b('base-android'), 'host.hbc'));
    validateHbc(good, 96, 'host');
    const v98 = Buffer.from(good);
    v98.writeUInt32LE(98, 8);
    assert.throws(() => validateHbc(v98, 96, 'host'), /bytecode version 98/);
    assert.throws(() => validateHbc(Buffer.from('__d(function(){});'.padEnd(200)), 96, 'js'), /not Hermes bytecode/);
  });

  test('verify-repro: two builds in different directories are byte-identical (CLI)', () => {
    const r = runNode(BUILD_CLI, ['verify-repro', '--project', b('app-base'), '--platform', 'android', '--work', b('repro')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REPRODUCIBLE: \d+ files byte-identical/);
  });

  test('bundle refuses to write into a non-empty directory that is not a previous build', async () => {
    const dir = b('precious');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'x');
    await assert.rejects(bundle({ project: b('app-base'), platform: 'android', out: dir }), /refusing to delete/);
    assert.ok(existsSync(join(dir, 'keep.txt')));
    // and a failing build leaves no staging dirs behind
    assert.deepEqual(readdirSync(W).filter((n) => n.includes('.stage-')), []);
  });

  test('identical builds -> no items, nothing to deploy', async () => {
    await bundleBoth(b('app-base'), 'same', { sha: 'other-sha' });
    const reports = patchBoth('base', 'same', 'patch-same');
    for (const p of PLATFORMS) {
      assert.deepEqual(reports[p].items, []);
      assert.equal(reports[p].hostChanged, false);
      assert.deepEqual(reports[p].changedUnits, []);
      assert.deepEqual(readdirSync(b(`patch-same-${p}`)), ['patch-report.json']);
    }
    assert.throws(() => deployArgs({ reports: PLATFORMS.map((p) => join(b(`patch-same-${p}`), 'patch-report.json')), unit: 'cabs', version: APP_VERSION, pr: 1 }), /nothing to deploy/);
  });

  describe('end to end: edit cabs -> patch -> init/deploy/rollout -> device applies the served patch', () => {
    let reports: Record<string, PatchReport>;
    before(async () => {
      const app = copyDemo(b('app-cabs'));
      append(join(app, 'src/units/cabs/fare.js'), `
export function surge(km, hour) {
  const mult = hour >= 22 || hour < 5 ? 1.5 : 1.0;
  return formatMoney(getConfig('rates.cab.base') * mult + getConfig('rates.cab.perKm') * km);
}
`);
      await bundleBoth(app, 'cabs', { baseBuildPrefix: 'base' });
      reports = patchBoth('base', 'cabs', 'patch-cabs');
    });

    test('patch report: only cabs changed, round-tripped, sizes recorded', () => {
      for (const p of PLATFORMS) {
        const r = reports[p];
        assert.equal(r.hostChanged, false);
        assert.deepEqual(r.changedUnits, ['cabs']);
        assert.equal(r.items.length, 1);
        const it = r.items[0];
        const baseB = readBuild(b(`base-${p}`));
        const newB = readBuild(b(`cabs-${p}`));
        assert.equal(it.baseHash, baseB.units.cabs.hash);
        assert.equal(it.builtHash, newB.units.cabs.hash);
        assert.notEqual(it.builtHash, it.baseHash);
        assert.equal(it.updateType, 'patch');
        assert.ok(it.patchSize > 0 && it.patchSize < newB.units.cabs.zstdSize);
        assert.equal(it.ratioOfZstdFull, Number((it.patchSize / newB.units.cabs.zstdSize).toFixed(4)));
        assert.equal(r.algo.patchAlgoVer, 'v1');
        assert.equal(r.algo.zstdLevel, 19);
        assert.deepEqual(readdirSync(b(`patch-cabs-${p}`)).sort(), [it.patchFile, 'patch-report.json'].sort());
        console.log(`    [measured] ${p}: cabs patch ${it.patchSize} B = ${(it.ratioOfZstdFull * 100).toFixed(1)}% of zstd(new unit) ${newB.units.cabs.zstdSize} B (unit ${newB.units.cabs.size} B)`);
      }
    });

    test('hand-off: base-info -> ota-cli init -> deploy -> rollout 10 -> verify -> device simulation', () => {
      const store = b('store');
      const cdn = b('cdn');
      const keys = b('keys');
      const cfg = b('cfg');
      mkdirSync(cfg, { recursive: true });
      writeFileSync(join(cfg, 'units.json'), JSON.stringify({
        superAdminTeam: 'ota-super-admin', acceptableTicketStatuses: ['In Progress'],
        defaultSoftLimit: { bytes: 100_000 }, defaultHardLimit: { bytes: 500_000 },
        units: {
          host: { ownerTeam: 'ota-super-admin', jiraProjects: ['COM'] },
          cabs: { ownerTeam: 'ota-cabs', jiraProjects: ['CAB'] },
          bus: { ownerTeam: 'ota-bus', jiraProjects: ['BUS'] },
          travelplex: { ownerTeam: 'ota-travelplex', jiraProjects: ['TLX'] },
        },
      }));
      writeFileSync(join(cfg, 'teams.json'), JSON.stringify({ 'ota-cabs': ['alice'], 'ota-super-admin': ['sam'] }));
      const common = ['--store', store, '--cdn', cdn, '--units', join(cfg, 'units.json'), '--teams', join(cfg, 'teams.json'),
        '--key', join(keys, 'private.pem'), '--pub', join(keys, 'public.pem')];
      const cli = (args: string[]) => {
        const r = runNode(OTA_CLI, args);
        assert.equal(r.status, 0, `ota ${args[0]} failed: ${r.stderr}${r.stdout}`);
        return r.stdout;
      };
      cli(['keygen', '--out', keys]);

      // base-info via the CLI -> ota-cli init
      const baseJson = join(cfg, 'base.json');
      const bi = runNode(BUILD_CLI, ['base-info', '--android', b('base-android'), '--ios', b('base-ios'), '--release-tag', 'release/11.9.0', '--toolchain-image', 'img@sha256:test', '--out', baseJson]);
      assert.equal(bi.status, 0, bi.stderr);
      const base = JSON.parse(readFileSync(baseJson, 'utf8'));
      assert.equal(base.hbc.bytecodeVersion, 96);
      assert.equal(base.hbc.hermescSha256, 'sha256:a82e519e1fa3737f6b95554cdb9edaaf37458fb03abcdc2144f039fa0b3302ab');
      assert.equal(base.patchAlgoVer, 'v1');
      assert.equal(base.units.cabs.android, readBuild(b('base-android')).units.cabs.hash);
      cli(['init', ...common, '--base', baseJson, '--requester', 'release-bot']);

      // deploy-args via the CLI -> ota-cli deploy
      const da = runNode(BUILD_CLI, ['deploy-args', '--json', '--report', join(b('patch-cabs-android'), 'patch-report.json'),
        '--report', join(b('patch-cabs-ios'), 'patch-report.json'), '--unit', 'cabs', '--version', APP_VERSION, '--pr', '42']);
      assert.equal(da.status, 0, da.stderr);
      const args = JSON.parse(da.stdout) as { flags: [string, string][]; updateTypes: Record<string, string>; platforms: string[] };
      assert.deepEqual(args.updateTypes, { android: 'patch', ios: 'patch' });
      assert.deepEqual(args.platforms, ['android', 'ios']);
      cli(['deploy', ...common, ...args.flags.flat(), '--requester', 'dev', '--approver', 'alice', '--ticket', 'CAB-1']);
      cli(['rollout', ...common, '--version', APP_VERSION, '--unit', 'cabs', '--pr', '42', '--percent', '10', '--requester', 'dev', '--approver', 'alice', '--ticket', 'CAB-1']);
      assert.match(cli(['verify', ...common, '--version', APP_VERSION]), /OK/);

      // device simulation per platform against the SERVED manifest
      const apply = resolveOtaApply();
      for (const p of PLATFORMS) {
        const served = JSON.parse(readFileSync(join(cdn, p, APP_VERSION, 'manifest.json'), 'utf8')) as Manifest;
        const cabs = served.units.find((u) => u.unitName === 'cabs')!;
        assert.equal(cabs.baseHash, readBuild(b(`base-${p}`)).units.cabs.hash);
        const entry = cabs.entries[0];
        assert.deepEqual(entry.range, [0, 0.1]);
        assert.equal(entry.updateType, 'patch');
        assert.equal(entry.hash, reports[p].items[0].builtHash);
        const ctx = (deviceId: string) => ({ bucket: bucket(deviceId, 'cabs'), embeddedHash: cabs.baseHash, supportedAlgos: ['v1'], runningHostId: 'embedded' });
        let inRange = '', outRange = '';
        for (let i = 0; !(inRange && outRange); i++) {
          const id = `device-${i}`;
          if (bucket(id, 'cabs') < 0.1) inRange ||= id; else outRange ||= id;
        }
        assert.equal(selectUnit(served, 'cabs', ctx(outRange)).source, 'embedded');
        const sel = selectUnit(served, 'cabs', ctx(inRange));
        assert.equal(sel.source, 'patch');
        const fileName = sel.entry!.patchUrl.split('/').pop()!;
        const served_file = join(cdn, p, APP_VERSION, fileName);
        assert.ok(existsSync(served_file), `served patch ${fileName}`);
        const out = b(`device-${p}-cabs.hbc`);
        const r = runBin(apply.path, [join(b(`base-${p}`), 'units/cabs.hbc'), served_file, out, sel.entry!.hash]);
        assert.equal(r.status, 0, r.stdout);
        assert.equal(hashFile(out), sel.entry!.hash);
        // and it is exactly the unit the new build produced
        assert.deepEqual(readFileSync(out), readFileSync(join(b(`cabs-${p}`), 'units/cabs.hbc')));
        validateHbc(readFileSync(out), 96, 'device result');
        // tampered download is rejected by the shipped apply code
        const bad = Buffer.from(readFileSync(served_file));
        bad[Math.floor(bad.length / 2)] ^= 0xff;
        writeFileSync(b('bad.patch'), bad);
        const rr = runBin(apply.path, [join(b(`base-${p}`), 'units/cabs.hbc'), b('bad.patch'), b('bad.out'), sel.entry!.hash]);
        assert.notEqual(rr.status, 0);
        assert.equal(existsSync(b('bad.out')), false);
      }
    });
  });

  test('host change -> hostChanged, no units changed; unit PR rule rejects it in deploy-args', async () => {
    const app = copyDemo(b('app-host'));
    append(join(app, 'src/host/shared/config.js'), `\nexport const OTA_TEST_MARK = 'host-change';\n`);
    await bundleBoth(app, 'host', { baseBuildPrefix: 'base' });
    const reports = patchBoth('base', 'host', 'patch-host');
    for (const p of PLATFORMS) {
      assert.equal(reports[p].hostChanged, true);
      assert.deepEqual(reports[p].changedUnits, []);
      assert.deepEqual(reports[p].items.map((i) => i.unit), ['host']);
      assert.equal(reports[p].items[0].builtHash, readBuild(b(`host-${p}`)).host.hash);
    }
    const files = PLATFORMS.map((p) => join(b(`patch-host-${p}`), 'patch-report.json'));
    assert.throws(() => deployArgs({ reports: files, unit: 'cabs', version: APP_VERSION, pr: 1 }), /RULE|host changed/);
    const ok = deployArgs({ reports: files, unit: 'host', version: APP_VERSION, pr: 1 });
    assert.equal(ok.flags.find(([k]) => k === '--unit')![1], 'host');
  });

  test('two units changed at once are reported; one-unit rule rejects either as a unit PR', async () => {
    const app = copyDemo(b('app-two'));
    append(join(app, 'src/units/cabs/fare.js'), `\nexport const CABS_MARK = 1;\n`);
    append(join(app, 'src/units/bus/seats.js'), `\nexport const BUS_MARK = 2;\n`);
    await bundleBoth(app, 'two', { baseBuildPrefix: 'base' });
    const reports = patchBoth('base', 'two', 'patch-two');
    for (const p of PLATFORMS) {
      assert.deepEqual(reports[p].changedUnits, ['bus', 'cabs']);
      assert.equal(reports[p].hostChanged, false);
      assert.equal(reports[p].items.length, 2);
    }
    const files = PLATFORMS.map((p) => join(b(`patch-two-${p}`), 'patch-report.json'));
    assert.throws(() => deployArgs({ reports: files, unit: 'cabs', version: APP_VERSION, pr: 1 }), /expected only \[cabs\] to change/);
  });

  test('full fallback: patch above the threshold is emitted as `full` (diff against empty) and round-trips with old "-"', () => {
    const reports = patchBoth('base', 'cabs', 'patch-full', { fullThreshold: 0.1 });
    for (const p of PLATFORMS) {
      const it = reports[p].items[0];
      assert.equal(it.updateType, 'full');
      assert.ok(it.deltaPatchSize > 0.1 * it.newZstdSize);
      assert.match(it.patchFile, /\.full\.hdiff$/);
      const out = b(`full-out-${p}`);
      const r = runBin(resolveOtaApply().path, ['-', join(b(`patch-full-${p}`), it.patchFile), out, it.builtHash]);
      assert.equal(r.status, 0, r.stdout);
      assert.equal(hashFile(out), it.builtHash);
      // a full patch must not apply onto the (non-empty) base file
      const wrong = runBin(resolveOtaApply().path, [join(b(`base-${p}`), 'units/cabs.hbc'), join(b(`patch-full-${p}`), it.patchFile), b('full-wrong'), it.builtHash]);
      assert.notEqual(wrong.status, 0);
    }
    const files = PLATFORMS.map((p) => join(b(`patch-full-${p}`), 'patch-report.json'));
    assert.deepEqual(deployArgs({ reports: files, unit: 'cabs', version: APP_VERSION, pr: 3 }).updateTypes, { android: 'full', ios: 'full' });
    // --force-full gives the same
    const forced = patchBoth('base', 'cabs', 'patch-forced', { forceFull: true });
    assert.equal(forced.android.items[0].updateType, 'full');
  });

  test('mixed update types across platforms are passed per platform', () => {
    const a = JSON.parse(readFileSync(join(b('patch-cabs-android'), 'patch-report.json'), 'utf8')) as PatchReport;
    const i = JSON.parse(readFileSync(join(b('patch-full-ios'), 'patch-report.json'), 'utf8')) as PatchReport;
    mkdirSync(b('rep-a'), { recursive: true });
    mkdirSync(b('rep-i'), { recursive: true });
    writeFileSync(b('rep-a/patch-report.json'), JSON.stringify(a));
    writeFileSync(b('rep-i/patch-report.json'), JSON.stringify(i));
    const args = deployArgs({ reports: [b('rep-a/patch-report.json'), b('rep-i/patch-report.json')], unit: 'cabs', version: APP_VERSION, pr: 1 });
    assert.deepEqual(args.updateTypes, { android: 'patch', ios: 'full' });
    assert.match(args.command, /--update-type-android patch/);
    assert.match(args.command, /--update-type-ios full/);
  });

  describe('platform-specific change: only android differs', () => {
    test('bus changes on android only -> deploy, ramp and halt only affect android', async () => {
      const app = copyDemo(b('app-bus-android'));
      append(join(app, 'src/units/bus/seat-label.android.js'), "export const androidOnly = true;\n");
      await bundleBoth(app, 'busA', { baseBuildPrefix: 'base' });
      const reports = patchBoth('base', 'busA', 'patch-busA');
      assert.deepEqual(reports.android.changedUnits, ['bus']);
      assert.deepEqual(reports.ios.changedUnits, [], 'ios bytes are untouched');
      assert.equal(reports.ios.hostChanged, false);

      const args = deployArgs({ reports: PLATFORMS.map((p) => join(b(`patch-busA-${p}`), 'patch-report.json')), unit: 'bus', version: APP_VERSION, pr: 7 });
      assert.deepEqual(args.platforms, ['android']);
      assert.ok(args.warnings.some((w) => /unchanged on ios/.test(w)));
      assert.ok(!args.command.includes('--patch-ios'));

      // deploy through the real ota-cli job, then the default rollout scope is android only
      const store = b('busA-store'), cdn = b('busA-cdn'), keys = b('busA-keys');
      const common = ['--store', store, '--cdn', cdn, '--units', join(keys, 'units.json'), '--teams', join(keys, 'teams.json'), '--key', join(keys, 'private.pem'), '--pub', join(keys, 'public.pem')];
      mkdirSync(keys, { recursive: true });
      writeFileSync(join(keys, 'units.json'), JSON.stringify({ superAdminTeam: 'sa', acceptableTicketStatuses: ['x'], defaultSoftLimit: {}, defaultHardLimit: {}, units: { host: { ownerTeam: 'sa', jiraProjects: ['COM'] }, bus: { ownerTeam: 'bus-team', jiraProjects: ['BR'] }, cabs: { ownerTeam: 'cabs-team', jiraProjects: ['CAB'] }, travelplex: { ownerTeam: 'tlx-team', jiraProjects: ['TLX'] } } }));
      writeFileSync(join(keys, 'teams.json'), JSON.stringify({ 'bus-team': ['alice'] }));
      const run = (args: string[]) => { const r = runNode(OTA_CLI, args); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout; };
      run(['keygen', '--out', keys]);
      writeFileSync(join(keys, 'base.json'), JSON.stringify(baseInfo({ android: b('base-android'), ios: b('base-ios') })));
      run(['init', ...common, '--base', join(keys, 'base.json'), '--requester', 'bot']);
      run(['deploy', ...common, ...args.flags.flat(), '--requester', 'dev', '--approver', 'alice', '--ticket', 'BR-1']);
      run(['rollout', ...common, '--version', APP_VERSION, '--unit', 'bus', '--pr', '7', '--percent', '25', '--requester', 'dev', '--approver', 'alice', '--ticket', 'BR-1']);
      const android = JSON.parse(readFileSync(join(cdn, 'android', APP_VERSION, 'manifest.json'), 'utf8')) as Manifest;
      const ios = JSON.parse(readFileSync(join(cdn, 'ios', APP_VERSION, 'manifest.json'), 'utf8')) as Manifest;
      assert.deepEqual(android.units.find((u) => u.unitName === 'bus')!.entries[0].range, [0, 0.25]);
      assert.equal(ios.units.length, 0, 'ios manifest has no bus entry');
      assert.equal(android.version, ios.version, 'state version is shared');
      assert.match(run(['verify', ...common, '--version', APP_VERSION]), /OK/);
      run(['rollout', ...common, '--version', APP_VERSION, '--unit', 'bus', '--pr', '7', '--percent', '0', '--requester', 'anyone']);
      assert.equal((JSON.parse(readFileSync(join(cdn, 'android', APP_VERSION, 'manifest.json'), 'utf8')) as Manifest).units[0].entries.length, 0);
    });
  });

  test('round trip detects a tampered patch and a wrong expected hash; scratch is cleaned', () => {
    const it = (JSON.parse(readFileSync(join(b('patch-cabs-android'), 'patch-report.json'), 'utf8')) as PatchReport).items[0];
    const patch = join(b('patch-cabs-android'), it.patchFile);
    const apply = resolveOtaApply();
    const baseFile = join(b('base-android'), 'units/cabs.hbc');
    const scratch = b('rt-scratch');
    assert.equal(roundTrip(apply, baseFile, patch, it.builtHash, scratch).ok, true);
    const bytes = Buffer.from(readFileSync(patch));
    for (const pos of [Math.floor(bytes.length / 2), Math.floor(bytes.length / 3), bytes.length - 5]) {
      const t = Buffer.from(bytes);
      t[pos] ^= 0x5a;
      writeFileSync(b('tampered.patch'), t);
      assert.equal(roundTrip(apply, baseFile, b('tampered.patch'), it.builtHash, scratch).ok, false, `flip at ${pos}`);
    }
    writeFileSync(b('trunc.patch'), bytes.subarray(0, bytes.length - 10));
    assert.equal(roundTrip(apply, baseFile, b('trunc.patch'), it.builtHash, scratch).ok, false);
    const wrongHash = roundTrip(apply, baseFile, patch, `sha256:${'0'.repeat(64)}`, scratch);
    assert.equal(wrongHash.ok, false);
    assert.equal(wrongHash.status, 'HashMismatch');
    assert.deepEqual(readdirSync(scratch), []);
  });

  test('never emits an unverified patch: a diff tool producing garbage aborts and leaves nothing behind', () => {
    const fake = b('fake-hdiffz.sh');
    writeFileSync(fake, '#!/bin/sh\nfor last; do :; done\nprintf "garbage-not-a-patch" > "$last"\n');
    chmodSync(fake, 0o755);
    const out = b('patch-garbage');
    assert.throws(
      () => createPatches({ base: b('base-android'), new: b('cabs-android'), out, hdiffzPath: fake }),
      (e: unknown) => e instanceof BuildError && e.code === 'ROUNDTRIP_FAILED',
    );
    assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'no files emitted');
    assert.deepEqual(readdirSync(W).filter((n) => n.includes('.stage-')), [], 'staging cleaned');
  });

  test('toolchain / platform / app-version mismatch and modified build dirs are errors', () => {
    const tamperBuildJson = (name: string, mut: (j: BuildJson) => void) => {
      const dst = b(name);
      cpSync(b('base-android'), dst, { recursive: true });
      const j = readBuild(dst);
      mut(j);
      writeFileSync(join(dst, 'build.json'), JSON.stringify(j, null, 2) + '\n');
      return dst;
    };
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as BuildError).code; } return 'no-error'; };
    const other = tamperBuildJson('tc-sha', (j) => { j.toolchain.hermescSha256 = `sha256:${'1'.repeat(64)}`; });
    assert.equal(code(() => createPatches({ base: b('base-android'), new: other, out: b('p1') })), 'TOOLCHAIN_MISMATCH');
    const v98 = tamperBuildJson('tc-ver', (j) => { j.toolchain.hbcVersion = 98; });
    assert.equal(code(() => createPatches({ base: b('base-android'), new: v98, out: b('p2') })), 'TOOLCHAIN_MISMATCH');
    assert.equal(code(() => createPatches({ base: b('base-android'), new: b('base-ios'), out: b('p3') })), 'PLATFORM_MISMATCH');
    const av = tamperBuildJson('tc-app', (j) => { j.appVersion = '12.0.0'; });
    assert.equal(code(() => createPatches({ base: b('base-android'), new: av, out: b('p4') })), 'APPVERSION_MISMATCH');
    const modified = b('modified');
    cpSync(b('base-android'), modified, { recursive: true });
    writeFileSync(join(modified, 'host.hbc'), Buffer.concat([readFileSync(join(modified, 'host.hbc')), Buffer.from([0])]));
    assert.equal(code(() => createPatches({ base: b('base-android'), new: modified, out: b('p5') })), 'BAD_BUILD');
    for (const n of ['p1', 'p2', 'p3', 'p4', 'p5']) assert.equal(existsSync(b(n)), false, `${n} not created`);
    assert.equal(code(() => baseInfo({ android: b('base-android'), ios: b('base-android') })), 'PLATFORM_MISMATCH');
  });

  test('patch refuses to overwrite an existing report without --overwrite; deterministic file names', () => {
    const out = b('patch-cabs-android');
    assert.throws(() => createPatches({ base: b('base-android'), new: b('cabs-android'), out }), /--overwrite/);
    const before = listFiles(out);
    const r = createPatches({ base: b('base-android'), new: b('cabs-android'), out, overwrite: true });
    assert.deepEqual(listFiles(out), before);
    const hbase = readBuild(b('base-android')).units.cabs.hash.slice(7, 19);
    const hnew = readBuild(b('cabs-android')).units.cabs.hash.slice(7, 19);
    assert.equal(r.items[0].patchFile, `cabs.android.${hbase}-${hnew}.delta.hdiff`);
    resolveHdiffz();
  });
});
