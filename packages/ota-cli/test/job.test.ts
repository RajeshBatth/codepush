import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, sha256, verifyAuditChain, PLATFORMS, type BaseInfo, type Platform, type UnitsConfig } from '@ota/core';
import { LocalFsArtifactStore, LocalFsCdn, LocalEd25519Signer, StaticTeamDirectory, initVersion, reconcile, runCommand, verifyStore, type JobContext, type PlatformBuild } from '../src/index.ts';
import { asyncify } from './async-adapters.ts';

const VERSION = '11.9.0';
const teams: Record<string, string[]> = { 'ota-cabs': ['alice'], 'ota-travelplex': ['tara'], 'ota-super-admin': ['sam'] };
const units: UnitsConfig = {
  superAdminTeam: 'ota-super-admin',
  acceptableTicketStatuses: ['In Progress'],
  defaultSoftLimit: { bytes: 100_000 },
  defaultHardLimit: { bytes: 500_000 },
  units: {
    host: { ownerTeam: 'ota-super-admin', jiraProjects: ['COM'] },
    cabs: { ownerTeam: 'ota-cabs', jiraProjects: ['CAB'] },
    travelplex: { ownerTeam: 'ota-travelplex', jiraProjects: ['TLX'] },
  },
};
const P = (f: (p: Platform) => string) => ({ android: f('android'), ios: f('ios') }) as Record<Platform, string>;
const base: BaseInfo = {
  appVersion: VERSION, releaseTag: 'release/11.9.0', toolchainImage: 'img@sha256:1', patchAlgoVer: 'v1',
  hbc: { bytecodeVersion: 96, hermescSha256: sha256('hermesc-rn-0.78.3') },
  host: P((p) => sha256(`host-${p}`)),
  units: { cabs: P((p) => sha256(`cabs-${p}`)), travelplex: P((p) => sha256(`tlx-${p}`)) },
  sizes: { host: { android: 2e6, ios: 2e6 }, units: { cabs: { android: 4e5, ios: 4e5 }, travelplex: { android: 4e5, ios: 4e5 } } },
};
const keys = generateKeyPair();

let tmp: string;
let work: string;
/** `sync`: the local adapters as they are. `async`: the same adapters behind proxies that answer after a random 0-5 ms delay. */
export type Mode = 'sync' | 'async';
function setup(mode: Mode = 'sync'): JobContext {
  tmp = mkdtempSync(join(tmpdir(), 'ota-job-'));
  work = join(tmp, 'work');
  const w = <T extends object>(x: T): T => (mode === 'async' ? asyncify(x) : x);
  return {
    store: w(new LocalFsArtifactStore(join(tmp, 'store'))), cdn: w(new LocalFsCdn(join(tmp, 'cdn'))), units,
    directory: w(new StaticTeamDirectory(teams)), signer: w(new LocalEd25519Signer(keys)),
    cdnBaseUrl: 'https://cdn.example.com/ota', now: () => new Date('2026-10-21T00:00:00Z'),
  };
}
function builds(tag: string): Record<Platform, PlatformBuild> {
  const out = {} as Record<Platform, PlatformBuild>;
  for (const p of PLATFORMS) {
    const f = join(tmp, `${tag}-${p}.patch`);
    writeFileSync(f, `patch-bytes-${tag}-${p}`);
    out[p] = { patchFile: f, builtHash: sha256(`built-${tag}-${p}`), updateType: 'patch' };
  }
  return out;
}
const who = (o: Partial<{ requester: string; approver: string | null; ticket: string | null }> = {}) => ({
  requester: 'dev', approver: 'alice', ticket: 'CAB-1', pr: 12, sourceSha: 'a'.repeat(40), jobUrl: 'https://jenkins/1', ...o,
});
const deployCabs = (ctx: JobContext, pr = 12) =>
  runCommand(ctx, { command: 'deploy', version: VERSION, unit: 'cabs', patchId: `cabs-pr${pr}`, builds: builds(`c${pr}`), ...who({}) , pr });

before(() => {});

for (const mode of ['sync', 'async'] as const) {
  test(`[${mode}] init -> deploy -> rollout -> halt -> restore with a verified, signed, audited history`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'release-bot' });
    assert.deepEqual((await verifyStore(ctx, VERSION)), []);

    const d = await deployCabs(ctx);
    assert.equal(d.stateVersion, 2);
    const served = (await ctx.cdn.readManifest('android', VERSION))!;
    assert.equal(served.version, 2);
    assert.deepEqual(served.units[0].entries[0].range, [0, 0]);
    assert.ok(served.units[0].entries[0].patchUrl.startsWith('https://cdn.example.com/ota/android/11.9.0/cabs-pr12.'));

    await runCommand(ctx, { command: 'rollout', version: VERSION, unit: 'cabs', patchId: 'cabs-pr12', percent: 10, ...who() });
    assert.deepEqual((await ctx.cdn.readManifest('ios', VERSION))!.units[0].entries[0].range, [0, 0.1]);

    await runCommand(ctx, { command: 'halt', version: VERSION, unit: 'cabs', patchId: 'cabs-pr12', ...who({ approver: null, requester: 'anyone' }) });
    assert.equal((await ctx.cdn.readManifest('android', VERSION))!.units[0].entries.length, 0);

    const r = await runCommand(ctx, { command: 'restore', version: VERSION, unit: 'cabs', fromVersion: 3, ...who() });
    assert.equal(r.stateVersion, 5);
    assert.deepEqual((await ctx.cdn.readManifest('android', VERSION))!.units[0].entries[0].range, [0, 0.1]);

    assert.deepEqual((await verifyStore(ctx, VERSION)), []);
    assert.deepEqual(verifyAuditChain((await ctx.store.allAudits(VERSION))), []);
    assert.deepEqual((await ctx.store.allAudits(VERSION)).map((a) => a.command), ['init', 'deploy', 'rollout', 'halt', 'restore']);
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] authorization is enforced before any state change`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    const before = await ctx.store.latestVersion(VERSION);
    const attempt = (o: Partial<{ requester: string; approver: string | null }>) =>
      runCommand(ctx, { command: 'deploy', version: VERSION, unit: 'travelplex', patchId: 'travelplex-pr5', builds: builds('t5'), ...who({ ticket: 'TLX-1', ...o }), pr: 5 });
    await assert.rejects(attempt({ approver: null }), /approval required/);
    await assert.rejects(attempt({ requester: 'tara', approver: 'tara' }), /not be the requester/);
    await assert.rejects(attempt({ approver: 'alice' }), /not a member of ota-travelplex/);
    assert.equal((await ctx.store.latestVersion(VERSION)), before, 'rejected commands leave no state behind');
    await assert.doesNotReject(attempt({ approver: 'tara' }));
    assert.equal((await ctx.store.latestVersion(VERSION)), (before ?? 0) + 1);
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] ramp only for the latest patch; unknown units rejected; invalid percent rejected`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    await deployCabs(ctx, 1);
    await deployCabs(ctx, 2);
    await assert.rejects(runCommand(ctx, { command: 'rollout', version: VERSION, unit: 'cabs', patchId: 'cabs-pr1', percent: 5, ...who() }), /latest/);
    await assert.rejects(runCommand(ctx, { command: 'rollout', version: VERSION, unit: 'cabs', patchId: 'cabs-pr2', percent: 101, ...who() }), /invalid percent/);
    await assert.rejects(runCommand(ctx, { command: 'deploy', version: VERSION, unit: 'bus', patchId: 'bus-pr1', builds: builds('b'), ...who() }), /unknown unit/);
    assert.equal((await ctx.store.latestVersion(VERSION)), 3, 'failed commands leave no state behind');
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] concurrent commands serialize: no lost updates, contiguous versions`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    await deployCabs(ctx, 1);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runCommand(ctx, { command: 'rollout', version: VERSION, unit: 'cabs', patchId: 'cabs-pr1', percent: i + 1, ...who() })),
    );
    assert.deepEqual(results.map((r) => r.stateVersion).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 3));
    assert.deepEqual((await verifyStore(ctx, VERSION)), []);
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] immutability: writing an existing state version fails even without the lock`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    const { raw, audit } = (await ctx.store.readState(VERSION, 1));
    await assert.rejects(async () => ctx.store.writeState(VERSION, 1, raw, audit), /already exists/);
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] tampered state is refused and detected by verify`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    await deployCabs(ctx);
    const p = join(tmp, 'store', 'ota-state', VERSION, 'v2', 'android', 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    m.units[0].entries[0].range = [0, 1]; // attacker ramps to 100% by editing the artifact
    writeFileSync(p, JSON.stringify(m)); // signature (sidecar) no longer matches the bytes
    await assert.rejects(runCommand(ctx, { command: 'rollout', version: VERSION, unit: 'cabs', patchId: 'cabs-pr12', percent: 5, ...who() }), /signature check failed/);
    assert.match((await verifyStore(ctx, VERSION)).join('|'), /v2\/android: bad signature/);
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] tampered audit history is detected`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    await deployCabs(ctx);
    await runCommand(ctx, { command: 'rollout', version: VERSION, unit: 'cabs', patchId: 'cabs-pr12', percent: 5, ...who() });
    const p = join(tmp, 'store', 'ota-state', VERSION, 'v2', 'audit.json');
    const a = JSON.parse(readFileSync(p, 'utf8'));
    a.approver = 'mallory';
    writeFileSync(p, JSON.stringify(a));
    assert.match((await verifyStore(ctx, VERSION)).join('|'), /prevAuditHash does not match/);
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] reconcile redeploys the CDN when it lags behind the latest state; detects CDN ahead of state`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    await deployCabs(ctx);
    // simulate: the CDN step failed after the state upload
    const failing = { ...ctx, cdn: new Proxy(ctx.cdn, { get: (t, k) => (k === 'publish' ? () => { throw new Error('CDN down'); } : Reflect.get(t, k)) }) } as JobContext;
    await assert.rejects(runCommand(failing, { command: 'rollout', version: VERSION, unit: 'cabs', patchId: 'cabs-pr12', percent: 20, ...who() }), /CDN down/);
    assert.equal((await ctx.store.latestVersion(VERSION)), 3);
    assert.equal((await ctx.cdn.servedVersion('android', VERSION)), 2);
    assert.match((await verifyStore(ctx, VERSION)).join('|'), /serves v2, latest is v3/);
    assert.deepEqual((await reconcile(ctx, VERSION)).redeployed, ['android', 'ios']);
    assert.equal((await ctx.cdn.servedVersion('android', VERSION)), 3);
    assert.deepEqual((await verifyStore(ctx, VERSION)), []);
    assert.deepEqual((await reconcile(ctx, VERSION)).redeployed, []);
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] break-glass: only super-admin, bypasses approval, flagged in the audit record`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    await deployCabs(ctx);
    await assert.rejects(runCommand(ctx, { command: 'restore', version: VERSION, unit: 'cabs', fromVersion: 1, requester: 'dev', approver: null, ticket: null, pr: null, sourceSha: null, jobUrl: null, breakGlass: true }), /super-admin/);
    const r = await runCommand(ctx, { command: 'restore', version: VERSION, unit: 'cabs', fromVersion: 1, requester: 'sam', approver: null, ticket: null, pr: null, sourceSha: null, jobUrl: null, breakGlass: true });
    assert.equal(r.audit.breakGlass, true);
    assert.equal((await ctx.cdn.readManifest('android', VERSION))!.units.length, 0, 'restored v1 content (no units yet)');
    rmSync(tmp, { recursive: true, force: true });
  });

  test(`[${mode}] retired versions accept only halt`, async () => {
    const ctx = setup(mode);
    await initVersion(ctx, base, { requester: 'bot' });
    await deployCabs(ctx);
    (await ctx.store.writeBase({ ...base, retired: true }));
    await assert.rejects(deployCabs(ctx, 99), /retired/);
    await assert.doesNotReject(runCommand(ctx, { command: 'halt', version: VERSION, unit: 'cabs', patchId: 'cabs-pr12', ...who({ approver: null }) }));
    rmSync(tmp, { recursive: true, force: true });
  });
}

test('CLI end to end, including parallel processes racing on one version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ota-cli-'));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run(['keygen', '--out', join(dir, 'keys')]).status, 0);
  writeFileSync(join(dir, 'units.json'), JSON.stringify(units));
  writeFileSync(join(dir, 'teams.json'), JSON.stringify(teams));
  writeFileSync(join(dir, 'base.json'), JSON.stringify(base));
  for (const p of PLATFORMS) writeFileSync(join(dir, `p-${p}.bin`), `patch-${p}`);
  const common = ['--store', join(dir, 'store'), '--cdn', join(dir, 'cdn'), '--units', join(dir, 'units.json'), '--teams', join(dir, 'teams.json'), '--key', join(dir, 'keys/private.pem'), '--pub', join(dir, 'keys/public.pem')];
  assert.equal(run(['init', ...common, '--base', join(dir, 'base.json'), '--requester', 'bot']).status, 0);
  const dep = run(['deploy', ...common, '--version', VERSION, '--unit', 'travelplex', '--pr', '7', '--patch-android', join(dir, 'p-android.bin'), '--patch-ios', join(dir, 'p-ios.bin'), '--built-android', sha256('ba'), '--built-ios', sha256('bi'), '--requester', 'dev', '--approver', 'tara', '--ticket', 'TLX-1244']);
  assert.equal(dep.status, 0, dep.stderr);
  const bad = run(['rollout', ...common, '--version', VERSION, '--unit', 'travelplex', '--pr', '7', '--percent', '5', '--requester', 'tara', '--approver', 'tara', '--ticket', 'TLX-1244']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /not be the requester/);

  // 8 processes ramping concurrently: all succeed, versions stay contiguous
  const procs = Array.from({ length: 8 }, (_, i) => new Promise<number>((res) => {
    const c = spawn(process.execPath, [cli, 'rollout', ...common, '--version', VERSION, '--unit', 'travelplex', '--pr', '7', '--percent', String(i + 1), '--requester', 'dev', '--approver', 'tara', '--ticket', 'TLX-1244'], { stdio: 'ignore' });
    c.on('close', (code) => res(code ?? -1));
  }));
  assert.deepEqual(await Promise.all(procs), Array(8).fill(0));
  const v = run(['verify', ...common, '--version', VERSION]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const show = run(['show', ...common, '--version', VERSION]);
  assert.match(show.stdout, /state 11\.9\.0\/v10:/);
  assert.match(show.stdout, /travelplex-pr7/);
  const halt = run(['rollout', ...common, '--version', VERSION, '--unit', 'travelplex', '--pr', '7', '--percent', '0', '--requester', 'anyone']);
  assert.equal(halt.status, 0, halt.stderr);
  assert.equal(run(['verify', ...common, '--version', VERSION]).status, 0);
  rmSync(dir, { recursive: true, force: true });
});
