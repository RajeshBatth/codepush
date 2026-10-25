// hermesc delta mode (-base-bytecode): safety properties, size benefit, determinism, archive-base, doctor.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundle, compileHbc, verifyBuildDir, verifyRepro, type BuildJson } from '../src/bundle.ts';
import { createPatches, roundTrip, type PatchReport } from '../src/patch.ts';
import { archiveBase, verifyArchive } from '../src/archive.ts';
import { baseInfo } from '../src/handoff.ts';
import { runDoctor } from '../src/doctor.ts';
import { resolveHermesc, resolveOtaApply, hermescSupportsBaseBytecode } from '../src/tools.ts';
import { BuildError, listFiles, rmrf, hashFile } from '../src/util.ts';
import { TWO_PACKAGE_APP, append, copyDemo, missingTools, runNode, BUILD_CLI, workRoot } from './helpers.ts';

const skip = missingTools();
if (skip) console.log(`SKIPPING ota-build delta tests: ${skip}`);
const APP_VERSION = '11.9.0';

let W: string;
const b = (name: string) => join(W, name);
const readBuild = (dir: string): BuildJson => JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'));
const code = async (fn: () => unknown): Promise<string> => { try { await fn(); } catch (e) { return (e as BuildError).code ?? String(e); } return 'no-error'; };
const buildOpts = (project: string, out: string, base?: string, extra: object = {}) =>
  ({ project, platform: 'android' as const, out, appVersion: APP_VERSION, sourceSha: 'x', baseBuild: base ?? null, ...extra });
const sameBytes = (x: string, y: string) => readFileSync(x).equals(readFileSync(y));

describe('ota-build delta mode (hermesc -base-bytecode)', { skip }, () => {
  before(async () => {
    W = workRoot('ota-build-delta');
    await bundle(buildOpts(copyDemo(b('app-base')), b('base')));
    await bundle({ ...buildOpts(copyDemo(b('app-base-ios')), b('base-ios')), platform: 'ios' });
    await bundle(buildOpts(TWO_PACKAGE_APP, b('two-base')));
  });
  after(() => rmrf(W));

  test('base build (no base given) is plain: delta.enabled false, js hashes recorded', () => {
    const bj = verifyBuildDir(b('base'));
    assert.equal(bj.delta!.enabled, false);
    assert.equal(bj.delta!.baseBuild, null);
    assert.deepEqual(Object.keys(bj.delta!.files).sort(), ['host.hbc', 'units/bus.hbc', 'units/cabs.hbc', 'units/travelplex.hbc']);
    for (const f of Object.values(bj.delta!.files)) assert.match(f.js, /^sha256:[0-9a-f]{64}$/);
  });

  test('2a: an UNCHANGED file compiled in delta mode against its own base .hbc is byte-identical to it (demo-app, two-package-app)', () => {
    const h = resolveHermesc({});
    let n = 0;
    for (const [dir, label] of [[b('base'), 'demo'], [b('two-base'), 'two']] as const) {
      const bj = readBuild(dir);
      const js: Record<string, string> = { 'host.hbc': 'js/host.js' };
      const unitsJson = JSON.parse(readFileSync(join(dir, 'units.json'), 'utf8')).units as Record<string, { file: string }>;
      for (const [u, e] of Object.entries(bj.units)) js[e.file] = `js/${unitsJson[u].file}`;
      for (const [hbc, jsRel] of Object.entries(js)) {
        const out = b(`ident-${label}-${n++}.hbc`);
        compileHbc(h, join(dir, jsRel), b('ident-work'), out, 'ident', join(dir, hbc));
        assert.ok(sameBytes(out, join(dir, hbc)), `${label}:${hbc} delta-compiled against itself differs from the base`);
      }
    }
    assert.equal(n, 4 + 2);
  });

  test('2b: the base .hbc PATH does not leak into the output (same base in two different directories)', () => {
    const h = resolveHermesc({});
    const js = join(b('base'), 'js/host.js');
    const outs: string[] = [];
    for (const d of ['short', 'a/much/longer/directory/chain/for/the/base']) {
      mkdirSync(b(`pathleak/${d}`), { recursive: true });
      cpSync(join(b('base'), 'host.hbc'), b(`pathleak/${d}/whatever-name.hbc`));
      // a CHANGED source, so the output actually depends on the base
      const changed = b(`pathleak/changed-${outs.length}.js`);
      writeFileSync(changed, readFileSync(js, 'utf8') + "\nglobalThis.__x = 'path-leak-probe';\n");
      const out = b(`pathleak/out-${outs.length}.hbc`);
      compileHbc(h, changed, b('pathleak/work'), out, 'p', b(`pathleak/${d}/whatever-name.hbc`));
      outs.push(out);
    }
    assert.ok(sameBytes(outs[0], outs[1]));
  });

  test('2c: wrong bytecode version / garbage / empty / missing base .hbc fail cleanly', async () => {
    const h = resolveHermesc({});
    const good = readFileSync(join(b('base'), 'host.hbc'));
    const js = join(b('base'), 'js/host.js');
    const v98 = Buffer.from(good); v98.writeUInt32LE(98, 8);
    const cases: [string, Buffer | null, RegExp][] = [
      ['v98', v98, /bytecode version 98/], ['garbage', Buffer.alloc(4096, 7), /not Hermes bytecode/],
      ['empty', Buffer.alloc(0), /not Hermes bytecode/], ['missing', null, /is missing/],
    ];
    for (const [name, data, re] of cases) {
      const f = b(`bad-${name}.hbc`);
      if (data) writeFileSync(f, data);
      assert.throws(() => compileHbc(h, js, b('bad-work'), b(`bad-out-${name}.hbc`), name, f), re, name);
      assert.equal(existsSync(b(`bad-out-${name}.hbc`)), false);
    }
    // truncated but with a valid header: hermesc itself refuses, surfaced as HERMESC_FAILED with its message
    writeFileSync(b('bad-trunc.hbc'), good.subarray(0, 3000));
    assert.throws(() => compileHbc(h, js, b('bad-work'), b('bad-out-trunc.hbc'), 'trunc', b('bad-trunc.hbc')), /hermesc failed[\s\S]*smaller than the size stated/);
  });

  describe('edits: host string, cabs string', () => {
    const reports: Record<string, { delta: PatchReport; plain: PatchReport }> = {};
    before(async () => {
      for (const [name, file, text] of [
        ['host', 'src/host/shared/config.js', `\nexport const OTA_DELTA_MARK = 'delta-mark-one';\n`],
        ['cabs', 'src/units/cabs/fare.js', `\nexport const CAB_NOTE = 'surge pricing may apply at night';\n`],
      ] as const) {
        const app = copyDemo(b(`app-${name}`));
        append(join(app, file), text);
        await bundle(buildOpts(app, b(`${name}-delta`), b('base')));
        await bundle(buildOpts(app, b(`${name}-plain`), b('base'), { delta: 'off' }));
        reports[name] = {
          delta: createPatches({ base: b('base'), new: b(`${name}-delta`), out: b(`p-${name}-delta`), reportPlain: true }),
          plain: createPatches({ base: b('base'), new: b(`${name}-plain`), out: b(`p-${name}-plain`) }),
        };
      }
    });

    for (const name of ['host', 'cabs'] as const) {
      test(`${name} string edit: delta patch <= plain patch (sizes printed), report fields`, () => {
        const { delta, plain } = reports[name];
        assert.equal(delta.deltaMode, true);
        assert.equal(plain.deltaMode, false);
        const d = delta.items[0], p = plain.items[0];
        assert.equal(d.unit, name);
        console.log(`    [measured] ${name} string edit: delta patch ${d.deltaPatchSize} B vs plain patch ${p.deltaPatchSize} B (same edit; zstd full ${d.newZstdSize} B); report-plain says ${d.plainEquivalentSize} B, delta/plain ${d.deltaOverPlain}`);
        assert.ok(d.deltaPatchSize <= p.deltaPatchSize, `delta ${d.deltaPatchSize} > plain ${p.deltaPatchSize}`);
        // --report-plain recompiles the same JS plainly: must equal the actual plain build's patch size
        assert.equal(d.plainEquivalentSize, p.deltaPatchSize);
        assert.equal(d.deltaOverPlain, Number((d.deltaPatchSize / p.deltaPatchSize).toFixed(4)));
        assert.equal(p.plainEquivalentSize, undefined, 'plain fields are absent without --report-plain');
      });
    }

    test('host: delta is strictly smaller (the large-renumbering case)', () => {
      assert.ok(reports.host.delta.items[0].deltaPatchSize < reports.host.plain.items[0].deltaPatchSize);
    });

    test('round trip: ota_apply(base, delta patch) == the delta build, byte for byte, still valid v96', () => {
      const apply = resolveOtaApply();
      for (const [name, file] of [['host', 'host.hbc'], ['cabs', 'units/cabs.hbc']] as const) {
        const it = reports[name].delta.items[0];
        const rt = roundTrip(apply, join(b('base'), file), join(b(`p-${name}-delta`), it.patchFile), it.builtHash, b('rt'));
        assert.equal(rt.ok, true, rt.detail);
        assert.equal(hashFile(join(b(`${name}-delta`), file)), it.builtHash);
        assert.equal(readBuild(b(`${name}-delta`)).toolchain.hbcVersion, 96);
      }
    });

    test('one-unit rule with delta on: only the edited file differs from the base', () => {
      const base = readBuild(b('base'));
      for (const name of ['host', 'cabs']) {
        const nb = readBuild(b(`${name}-delta`));
        const diff = [nb.host.hash !== base.host.hash ? 'host' : '', ...Object.keys(base.units).filter((u) => nb.units[u].hash !== base.units[u].hash)].filter(Boolean);
        assert.deepEqual(diff, [name]);
        assert.deepEqual(reports[name].delta.changedUnits, name === 'host' ? [] : ['cabs']);
        assert.equal(reports[name].delta.hostChanged, name === 'host');
        // unchanged units are byte-identical to the base files (copied, never recompiled)
        for (const u of Object.keys(base.units).filter((x) => x !== name)) assert.ok(sameBytes(join(b(`${name}-delta`), `units/${u}.hbc`), join(b('base'), `units/${u}.hbc`)));
      }
    });

    test('build.json delta record: baseBuild = hash of base build.json, per-file baseHbc/js hashes', () => {
      const nb = readBuild(b('cabs-delta'));
      const base = readBuild(b('base'));
      assert.equal(nb.delta!.enabled, true);
      assert.equal(nb.delta!.baseBuild, hashFile(join(b('base'), 'build.json')));
      assert.equal(nb.delta!.files['host.hbc'].baseHbc, base.host.hash);
      assert.equal(nb.delta!.files['units/cabs.hbc'].baseHbc, base.units.cabs.hash);
      assert.notEqual(nb.delta!.files['units/cabs.hbc'].js, base.delta!.files['units/cabs.hbc'].js);
      assert.equal(nb.delta!.files['units/bus.hbc'].js, base.delta!.files['units/bus.hbc'].js);
      const off = readBuild(b('cabs-plain'));
      assert.equal(off.delta!.enabled, false);
      assert.equal(off.delta!.baseBuild, null);
    });

    test('--delta off reproduces the plain recipe exactly (same JS, hermesc -O -emit-binary -g0, no base flag)', () => {
      const h = resolveHermesc({});
      for (const [file, js] of [['host.hbc', 'js/host.js'], ['units/cabs.hbc', 'js/units/cabs.js']] as const) {
        const out = b('off-recompile.hbc');
        compileHbc(h, join(b('cabs-plain'), js), b('off-work'), out, 'off');
        assert.ok(sameBytes(out, join(b('cabs-plain'), file)));
      }
    });

    test('patch refuses a delta build against a base it was not compiled from', async () => {
      const other = b('other-base');
      await bundle(buildOpts(b('app-base'), other, undefined, { sourceSha: 'different-sha' }));
      assert.equal(await code(() => createPatches({ base: other, new: b('cabs-delta'), out: b('p-wrong-base') })), 'DELTA_BASE_MISMATCH');
    });
  });

  test('2d: determinism: two delta builds in different directories are byte-identical; verify-repro covers delta (API + CLI)', async () => {
    const app = b('app-cabs');
    await bundle(buildOpts(app, b('det-a/x'), b('base')));
    await bundle(buildOpts(app, b('det-b/much/longer/y'), b('base')));
    const fa = listFiles(b('det-a/x')), fb = listFiles(b('det-b/much/longer/y'));
    assert.deepEqual(fa, fb);
    for (const f of fa) assert.ok(sameBytes(join(b('det-a/x'), f), join(b('det-b/much/longer/y'), f)), f);
    const r = await verifyRepro({ project: app, platform: 'android', baseBuild: b('base'), workDir: b('vr') });
    assert.equal(r.ok, true, r.differences.join('; '));
    const cli = runNode(BUILD_CLI, ['verify-repro', '--project', app, '--platform', 'android', '--base-build', b('base'), '--work', b('vr-cli')]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /REPRODUCIBLE/);
  });

  test('2e: the delta base must be the embedded base build, never a delta (patch) build', async () => {
    assert.equal(await code(() => bundle(buildOpts(b('app-cabs'), b('chain'), b('cabs-delta')))), 'DELTA_BASE_IS_DELTA');
    assert.equal(existsSync(b('chain')), false);
    // --delta off may still use any build as the splitter's base (no delta involved)
    await bundle(buildOpts(b('app-cabs'), b('chain-off'), b('cabs-delta'), { delta: 'off' }));
    assert.equal(readBuild(b('chain-off')).delta!.enabled, false);
  });

  test('--delta on: fails loudly (no base given / base .hbc missing / unsupported hermesc / toolchain mismatch); never falls back to plain', async () => {
    const app = b('app-cabs');
    assert.equal(await code(() => bundle(buildOpts(app, b('on-nobase'), undefined, { delta: 'on' }))), 'DELTA_NO_BASE');
    // base dir without the .hbc bytes
    cpSync(b('base'), b('base-nohbc'), { recursive: true });
    rmrf(join(b('base-nohbc'), 'units/cabs.hbc'));
    for (const mode of ['on', 'auto'] as const) {
      const e = await bundle(buildOpts(app, b(`on-nohbc-${mode}`), b('base-nohbc'), { delta: mode })).then(() => null, (x: Error) => x as BuildError);
      assert.equal(e?.code, 'DELTA_BASE_MISSING');
      assert.match(e!.message, /needs the base \.hbc BYTES/);
      assert.equal(existsSync(b(`on-nohbc-${mode}`)), false);
    }
    // hermesc without -base-bytecode
    const fake = b('fake-hermesc.sh');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "HBC bytecode version: 96"; exit 0; fi\nif [ "$1" = "-help" ]; then echo "  -O - optimize"; exit 0; fi\nexit 1\n');
    chmodSync(fake, 0o755);
    assert.equal(hermescSupportsBaseBytecode(fake), false);
    assert.equal(hermescSupportsBaseBytecode(resolveHermesc({}).path), true);
    assert.equal(await code(() => bundle(buildOpts(app, b('on-fake'), b('base'), { delta: 'on', hermescPath: fake, allowUnpinnedHermesc: true }))), 'DELTA_UNSUPPORTED');
    // base made by another hermesc
    cpSync(b('base'), b('base-othertc'), { recursive: true });
    const j = readBuild(b('base-othertc')); j.toolchain.hermescSha256 = `sha256:${'1'.repeat(64)}`;
    writeFileSync(join(b('base-othertc'), 'build.json'), JSON.stringify(j, null, 2) + '\n');
    assert.equal(await code(() => bundle(buildOpts(app, b('on-tc'), b('base-othertc'), { delta: 'on' }))), 'TOOLCHAIN_MISMATCH');
  });

  describe('archive-base', () => {
    test('archives exactly what a delta build needs; --verify checks it (and base.json); a delta build from the archive is byte-identical to one from the full build dir', async () => {
      const m = archiveBase({ build: b('base'), out: b('arch') });
      assert.deepEqual(Object.keys(m.files).sort(), ['build.json', 'host.hbc', 'ids.json', 'units.json', 'units/bus.hbc', 'units/cabs.hbc', 'units/travelplex.hbc']);
      assert.deepEqual(readdirSync(b('arch')).sort(), ['archive-manifest.json', 'build.json', 'host.hbc', 'ids.json', 'units', 'units.json']);
      assert.equal(verifyArchive({ dir: b('arch') }).files, 7);
      const baseJson = b('base.json');
      writeFileSync(baseJson, JSON.stringify(baseInfo({ android: b('base'), ios: b('base-ios'), releaseTag: 'r', toolchainImage: 'img', appVersion: APP_VERSION })));
      assert.equal(verifyArchive({ dir: b('arch'), baseJson }).platform, 'android');
      const cli = runNode(BUILD_CLI, ['archive-base', '--verify', b('arch'), '--base-json', baseJson]);
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /archive OK: android, 7 files, hashes match base.json/);
      // delta build against the archive (no js/ dir there) == against the full build dir
      await bundle(buildOpts(b('app-cabs'), b('from-arch'), b('arch')));
      for (const f of ['host.hbc', 'units/cabs.hbc']) assert.ok(sameBytes(join(b('from-arch'), f), join(b('cabs-delta'), f)));
      // tampering / mismatching base.json is caught
      cpSync(b('arch'), b('arch-bad'), { recursive: true });
      writeFileSync(join(b('arch-bad'), 'host.hbc'), Buffer.concat([readFileSync(join(b('arch-bad'), 'host.hbc')), Buffer.from([0])]));
      assert.equal(await code(() => verifyArchive({ dir: b('arch-bad') })), 'BAD_ARCHIVE');
      const bj = JSON.parse(readFileSync(baseJson, 'utf8')); bj.host.android = `sha256:${'2'.repeat(64)}`;
      writeFileSync(b('base-wrong.json'), JSON.stringify(bj));
      assert.equal(await code(() => verifyArchive({ dir: b('arch'), baseJson: b('base-wrong.json') })), 'ARCHIVE_MISMATCH');
      // a delta build is not archivable as a base
      assert.equal(await code(() => archiveBase({ build: b('cabs-delta'), out: b('arch-delta') })), 'DELTA_BASE_IS_DELTA');
    });
  });

  describe('doctor: hermesc-delta check', () => {
    const fakeProject = (): string => copyDemo(b(`doc-${Math.random().toString(36).slice(2)}`));
    test('pinned hermesc supports -base-bytecode -> PASS', async () => {
      const r = await runDoctor({ project: fakeProject() });
      assert.equal(r.checks.find((c) => c.id === 'hermesc-delta')?.status, 'PASS');
    });
    test('hermesc without -base-bytecode -> FAIL with remedy (auto/on), WARN with --delta off', async () => {
      const fake = b('fake-hermesc.sh');
      if (!existsSync(fake)) writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "HBC bytecode version: 96"; exit 0; fi\nif [ "$1" = "-help" ]; then echo "  -O - optimize"; exit 0; fi\nexit 1\n');
      chmodSync(fake, 0o755);
      const saved = process.env.OTA_HERMESC;
      process.env.OTA_HERMESC = fake;
      try {
        const p = fakeProject();
        for (const [mode, st] of [['auto', 'FAIL'], ['on', 'FAIL'], ['off', 'WARN']] as const) {
          const c = (await runDoctor({ project: p, delta: mode })).checks.find((x) => x.id === 'hermesc-delta')!;
          assert.equal(c.status, st, mode);
          assert.match(c.remedy ?? c.detail, /fetch-tools|--delta off|pinned/);
        }
      } finally { if (saved === undefined) delete process.env.OTA_HERMESC; else process.env.OTA_HERMESC = saved; }
    });
  });
});
