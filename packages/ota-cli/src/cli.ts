#!/usr/bin/env node
// Emulates the Jenkins deploy job from a shell. In production these flags come from the approved Jira ticket + PR.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPair, PLATFORMS, type BaseInfo, type Platform, type UnitsConfig } from '@ota/core';
import { LocalFsArtifactStore, LocalFsCdn, LocalEd25519Signer, StaticTeamDirectory } from './index.ts';
import { initVersion, reconcile, runCommand, verifyStore, type JobContext, type PlatformBuild, type Request } from './job.ts';

const USAGE = `ota <command> [flags]

Environment/config flags (all commands): --store DIR --cdn DIR --units units.json --teams teams.json --key private.pem --pub public.pem --cdn-base-url URL
Commands:
  keygen --out DIR
  init     --base base.json --requester U
  deploy   --version V --unit U --pr N [--patch-android F --built-android H] [--patch-ios F --built-ios H] [--update-type patch|full | --update-type-android X --update-type-ios Y]
           (pass only the platforms the change affects)
           --requester U --approver U --ticket KEY [--sha SHA] [--job-url URL] [--break-glass]
  rollout  --version V --unit U --pr N --percent P [--platform android|ios] --requester U --approver U --ticket KEY
  halt     --version V --unit U --pr N [--platform android|ios] --requester U [--ticket KEY]
  restore  --version V --from N [--unit U] --requester U --approver U --ticket KEY [--break-glass]
  show     --version V [--state N]
  verify   --version V
  reconcile --version V`;

const { values: f, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    store: { type: 'string' }, cdn: { type: 'string' }, units: { type: 'string' }, teams: { type: 'string' },
    key: { type: 'string' }, pub: { type: 'string' }, 'cdn-base-url': { type: 'string' }, out: { type: 'string' },
    base: { type: 'string' }, version: { type: 'string' }, unit: { type: 'string' }, pr: { type: 'string' },
    'patch-android': { type: 'string' }, 'patch-ios': { type: 'string' }, 'built-android': { type: 'string' }, 'built-ios': { type: 'string' },
    'update-type': { type: 'string' }, 'update-type-android': { type: 'string' }, 'update-type-ios': { type: 'string' }, requester: { type: 'string' }, approver: { type: 'string' }, ticket: { type: 'string' },
    sha: { type: 'string' }, 'job-url': { type: 'string' }, 'break-glass': { type: 'boolean' }, percent: { type: 'string' },
    platform: { type: 'string' }, from: { type: 'string' }, state: { type: 'string' },
  },
});

function need<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === '') throw new Error(`missing --${name}\n\n${USAGE}`);
  return v;
}
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));

function context(): JobContext {
  const units = json<UnitsConfig>(need(f.units, 'units'));
  const teams = f.teams ? json<Record<string, string[]>>(f.teams) : {};
  return {
    store: new LocalFsArtifactStore(need(f.store, 'store')),
    cdn: new LocalFsCdn(need(f.cdn, 'cdn')),
    units,
    directory: new StaticTeamDirectory(teams),
    signer: new LocalEd25519Signer({ privateKeyPem: readFileSync(need(f.key, 'key'), 'utf8'), publicKeyPem: readFileSync(need(f.pub, 'pub'), 'utf8') }),
    cdnBaseUrl: f['cdn-base-url'] ?? 'https://cdn.example.com/ota',
  };
}

function who() {
  return {
    requester: need(f.requester, 'requester'),
    approver: f.approver ?? null,
    ticket: f.ticket ?? null,
    pr: f.pr ? Number(f.pr) : null,
    sourceSha: f.sha ?? null,
    jobUrl: f['job-url'] ?? null,
    breakGlass: f['break-glass'] ?? false,
  };
}
const platforms = (): Platform[] | undefined => (f.platform ? [f.platform as Platform] : undefined);

async function main(): Promise<void> {
  const cmd = positionals[0];
  switch (cmd) {
    case 'keygen': {
      const out = need(f.out, 'out');
      mkdirSync(out, { recursive: true });
      const kp = generateKeyPair();
      writeFileSync(join(out, 'private.pem'), kp.privateKeyPem, { mode: 0o600 });
      writeFileSync(join(out, 'public.pem'), kp.publicKeyPem);
      console.log(`wrote ${out}/private.pem (keep secret) and ${out}/public.pem (embed in the app)`);
      return;
    }
    case 'init': {
      const n = await initVersion(context(), json<BaseInfo>(need(f.base, 'base')), { requester: need(f.requester, 'requester') });
      console.log(`initialized state v${n}`);
      return;
    }
    case 'deploy': {
      const version = need(f.version, 'version');
      const unit = need(f.unit, 'unit');
      const pr = Number(need(f.pr, 'pr'));
      // Per platform: pass --patch-<p> and --built-<p> (and optionally --update-type-<p>) only for platforms the change affects.
      const builds: Partial<Record<Platform, PlatformBuild>> = {};
      for (const p of PLATFORMS) {
        if (!f[`patch-${p}`] && !f[`built-${p}`]) continue;
        const ut = (f[`update-type-${p}`] ?? f['update-type'] ?? 'patch') as 'patch' | 'full';
        builds[p] = { patchFile: need(f[`patch-${p}`], `patch-${p}`), builtHash: need(f[`built-${p}`], `built-${p}`), updateType: ut };
      }
      if (Object.keys(builds).length === 0) throw new Error('deploy needs --patch-<platform> and --built-<platform> for at least one platform');
      const r = await runCommand(context(), { command: 'deploy', version, unit, patchId: `${unit}-pr${pr}`, builds, ...who() });
      console.log(`deployed ${unit}-pr${pr} at 0% -> state v${r.stateVersion}`);
      return;
    }
    case 'rollout': {
      const unit = need(f.unit, 'unit');
      const pr = Number(need(f.pr, 'pr'));
      const percent = Number(need(f.percent, 'percent'));
      const base = { version: need(f.version, 'version'), unit, patchId: `${unit}-pr${pr}`, platforms: platforms(), ...who() };
      const req: Request = percent === 0 ? { command: 'halt', ...base } : { command: 'rollout', percent, ...base };
      const r = await runCommand(context(), req);
      console.log(`${percent === 0 ? 'halted' : `rollout ${percent}%`} ${base.patchId} -> state v${r.stateVersion}`);
      return;
    }
    case 'halt': {
      const unit = need(f.unit, 'unit');
      const pr = Number(need(f.pr, 'pr'));
      const r = await runCommand(context(), { command: 'halt', version: need(f.version, 'version'), unit, patchId: `${unit}-pr${pr}`, platforms: platforms(), ...who() });
      console.log(`halted ${unit}-pr${pr} -> state v${r.stateVersion}`);
      return;
    }
    case 'restore': {
      const r = await runCommand(context(), { command: 'restore', version: need(f.version, 'version'), unit: f.unit ?? null, fromVersion: Number(need(f.from, 'from')), ...who() });
      console.log(`restored content of v${f.from} as state v${r.stateVersion}`);
      return;
    }
    case 'show': {
      const ctx = context();
      const version = need(f.version, 'version');
      const n = f.state ? Number(f.state) : await ctx.store.latestVersion(version);
      if (n === null) throw new Error(`no state for ${version}`);
      const { manifests, audit } = await ctx.store.readState(version, n);
      console.log(`state ${version}/v${n}: ${audit.command} ${audit.patchId ?? ''} by ${audit.requester}${audit.approver ? `, approved by ${audit.approver}` : ''} (${audit.ts})`);
      for (const p of PLATFORMS) {
        for (const u of [{ unitName: 'host', entries: manifests[p].mainBundle.entries }, ...manifests[p].units]) {
          for (const e of u.entries) {
            const r = e.range ?? [0, 1];
            console.log(`  ${p.padEnd(7)} ${u.unitName.padEnd(11)} ${e.id.padEnd(22)} ${(r[0] * 100).toFixed(2)}% -> ${(r[1] * 100).toFixed(2)}%  (${((r[1] - r[0]) * 100).toFixed(2)}% of devices)`);
          }
        }
      }
      return;
    }
    case 'verify': {
      const problems = await verifyStore(context(), need(f.version, 'version'));
      if (problems.length) {
        console.error(problems.map((p) => `PROBLEM ${p}`).join('\n'));
        process.exit(1);
      }
      console.log('OK: state history, signatures, audit chain and CDN are consistent');
      return;
    }
    case 'reconcile': {
      const r = await reconcile(context(), need(f.version, 'version'));
      console.log(r.redeployed.length ? `redeployed ${r.redeployed.join(', ')}` : 'CDN already up to date');
      return;
    }
    default:
      console.log(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
