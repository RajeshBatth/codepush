import { statSync } from 'node:fs';
import {
  PLATFORMS, applyDeploy, applyHalt, applyRestore, applyRollout, authorize, initState,
  makeAudit, serializeManifest, validateManifest, verifyAuditChain,
  type AuditRecord, type BaseInfo, type Command, type Hash, type Manifest, type Platform, type SignedManifest, type StateBundle,
  type UnitsConfig, type UpdateType,
} from '@ota/core';
import type { ArtifactStorePort, CdnPort, SignerPort, TeamDirectoryPort } from './ports.ts';

/** Everything the job needs from the outside world: ports only (see ports.ts for the contracts adapters must meet). */
export interface JobContext {
  store: ArtifactStorePort;
  cdn: CdnPort;
  /** KMS stand-in: signs new manifests and verifies stored/served ones. */
  signer: SignerPort;
  /** GitHub team membership lookup. */
  directory: TeamDirectoryPort;
  units: UnitsConfig;
  cdnBaseUrl: string;
  now?: () => Date;
}

export interface Who {
  requester: string;
  approver: string | null;
  ticket: string | null;
  pr: number | null;
  sourceSha: string | null;
  jobUrl: string | null;
  breakGlass?: boolean;
}

export interface PlatformBuild {
  /** the patch file produced by the build (HDiffPatch output) */
  patchFile: string;
  /** sha256 of the BUILT result (patch applied to the embedded unit) as recorded by verify and recomputed at deploy */
  builtHash: Hash;
  updateType: UpdateType;
}

export type Request =
  | ({ command: 'deploy'; version: string; unit: string; patchId: string; builds: Partial<Record<Platform, PlatformBuild>> } & Who)
  | ({ command: 'rollout'; version: string; unit: string; patchId: string; percent: number; platforms?: Platform[] } & Who)
  | ({ command: 'halt'; version: string; unit: string; patchId: string; platforms?: Platform[] } & Who)
  | ({ command: 'restore'; version: string; unit: string | null; fromVersion: number } & Who);

async function sign(ctx: JobContext, s: StateBundle): Promise<Record<Platform, SignedManifest>> {
  const out = {} as Record<Platform, SignedManifest>;
  for (const p of PLATFORMS) {
    const errs = validateManifest(s.manifests[p]);
    if (errs.length) throw new Error(`refusing to sign invalid manifest (${p}): ${errs.join('; ')}`);
    const json = serializeManifest(s.manifests[p]);
    out[p] = { json, sig: await ctx.signer.sign(Buffer.from(json, 'utf8')) };
  }
  return out;
}

async function readVerifiedLatest(ctx: JobContext, version: string): Promise<{ state: StateBundle; audit: AuditRecord }> {
  const n = await ctx.store.latestVersion(version);
  if (n === null) throw new Error(`no state for ${version}; run init first (base release job)`);
  const { manifests, raw, audit } = await ctx.store.readState(version, n);
  for (const p of PLATFORMS) {
    // verify the signature over the exact stored bytes, never over a re-serialization
    if (!(await ctx.signer.verify(raw[p].json, raw[p].sig))) {
      throw new Error(`signature check failed for ${version}/v${n}/${p}: refusing to build on tampered state`);
    }
  }
  return { state: { version: n, manifests }, audit };
}

/**
 * `authorize` (ota-core) is synchronous and calls `isMember` synchronously, but the directory port may be async
 * (GitHub API). Resolve the memberships first (fail closed: a directory error aborts the job), then run `authorize`
 * over the cached answers. Pass 1 records which (team,user) pairs are asked, pass 2 answers them.
 */
async function authorizeAsync(ctx: JobContext, req: Request): Promise<{ ok: boolean; reason: string }> {
  const input = { command: req.command as Command, unit: req.unit ?? 'host', requester: req.requester, approver: req.approver, breakGlass: req.breakGlass };
  const answers = new Map<string, boolean>();
  for (let round = 0; round < 4; round++) {
    const missing: [string, string][] = [];
    const res = authorize(ctx.units, {
      ...input,
      isMember: (team, user) => {
        const k = JSON.stringify([team, user]);
        if (!answers.has(k)) { missing.push([team, user]); return false; }
        return answers.get(k)!;
      },
    });
    if (!missing.length) return res;
    for (const [team, user] of missing) answers.set(JSON.stringify([team, user]), await ctx.directory.isMember(team, user));
  }
  throw new Error('authorization did not converge');
}

function patchName(patchId: string, platform: Platform, fileHash12: string): string {
  return `${patchId}.${fileHash12}.${platform}.patch`;
}

interface PatchFileRef {
  platform: Platform;
  name: string;
  key: string;
}

async function publishAll(ctx: JobContext, version: string, signed: Record<Platform, SignedManifest>): Promise<void> {
  const refs = await patchFileRefs(ctx, version);
  for (const p of PLATFORMS) {
    const files = await Promise.all(refs.filter((r) => r.platform === p).map(async (r) => ({ name: r.name, path: await ctx.store.patchPath(r.key) })));
    await ctx.cdn.publish(p, version, signed[p], files);
  }
}

/** All patch files ever deployed for this version, from the audit chain (used for CDN publish and reconcile). */
async function patchFileRefs(ctx: JobContext, version: string): Promise<PatchFileRef[]> {
  const out: PatchFileRef[] = [];
  for (const a of await ctx.store.allAudits(version)) {
    const files = (a.params as { files?: PatchFileRef[] }).files;
    if (files) out.push(...files);
  }
  return out;
}

/** Base release job: record the base, create state v1 and publish it. */
export async function initVersion(ctx: JobContext, base: BaseInfo, who: { requester: string; jobUrl?: string | null }): Promise<number> {
  await ctx.store.writeBase(base);
  return ctx.store.withLock(base.appVersion, async () => {
    if ((await ctx.store.latestVersion(base.appVersion)) !== null) throw new Error(`${base.appVersion} is already initialized`);
    const state = initState(base);
    const signed = await sign(ctx, state);
    const audit = makeAudit(null, {
      stateVersion: 1, command: 'init', unit: null, patchId: null, params: { releaseTag: base.releaseTag },
      requester: who.requester, approver: null, ticket: null, pr: null, sourceSha: null,
      jobUrl: who.jobUrl ?? null, ts: (ctx.now?.() ?? new Date()).toISOString(),
    });
    await ctx.store.writeState(base.appVersion, 1, signed, audit);
    await publishAll(ctx, base.appVersion, signed);
    return 1;
  });
}

/** The single deploy job: authorize -> lock -> read verified latest -> apply -> sign -> upload vN+1 -> deploy to CDN. */
export async function runCommand(ctx: JobContext, req: Request): Promise<{ stateVersion: number; audit: AuditRecord }> {
  const authz = await authorizeAsync(ctx, req);
  if (!authz.ok) throw new Error(`not authorized: ${authz.reason}`);

  return ctx.store.withLock(req.version, async () => {
    const base = await ctx.store.readBase(req.version);
    if (base.retired && req.command !== 'halt' && !req.breakGlass) throw new Error(`${req.version} is retired: only halt is accepted`);
    const { state: current, audit: prevAudit } = await readVerifiedLatest(ctx, req.version);

    let next: StateBundle;
    let params: Record<string, unknown> = {};
    let patchId: string | null = null;
    let files: PatchFileRef[] = [];

    switch (req.command) {
      case 'deploy': {
        patchId = req.patchId;
        const perPlatform: Partial<Record<Platform, { patchUrl: string; hash: Hash; size: number; updateType: UpdateType }>> = {};
        for (const p of PLATFORMS) {
          const b = req.builds[p];
          if (!b) continue; // this change does not affect `p`
          const data = await ctx.store.putPatch(b.patchFile);
          const name = patchName(req.patchId, p, data.fileHash12);
          files.push({ platform: p, name, key: data.key });
          perPlatform[p] = {
            patchUrl: `${ctx.cdnBaseUrl}/${p}/${req.version}/${name}`,
            hash: b.builtHash,
            size: statSync(b.patchFile).size,
            updateType: b.updateType,
          };
        }
        next = applyDeploy(current, base, { unit: req.unit, patchId: req.patchId, perPlatform });
        params = { files, builtHashes: Object.fromEntries(PLATFORMS.filter((p) => req.builds[p]).map((p) => [p, req.builds[p]!.builtHash])) };
        break;
      }
      case 'rollout':
        patchId = req.patchId;
        next = applyRollout(current, { unit: req.unit, patchId: req.patchId, percent: req.percent, platforms: req.platforms });
        params = { percent: req.percent, platforms: req.platforms ?? [...PLATFORMS] };
        break;
      case 'halt':
        patchId = req.patchId;
        next = applyHalt(current, { unit: req.unit, patchId: req.patchId, platforms: req.platforms });
        params = { platforms: req.platforms ?? [...PLATFORMS] };
        break;
      case 'restore': {
        const from = await ctx.store.readState(req.version, req.fromVersion);
        for (const p of PLATFORMS) {
          if (!(await ctx.signer.verify(from.raw[p].json, from.raw[p].sig))) throw new Error(`v${req.fromVersion} signature invalid: cannot restore`);
        }
        next = applyRestore(current, { version: req.fromVersion, manifests: from.manifests });
        params = { fromVersion: req.fromVersion };
        break;
      }
    }

    const signed = await sign(ctx, next);
    const audit = makeAudit({ record: prevAudit }, {
      stateVersion: next.version, command: req.command, unit: req.unit ?? null, patchId, params,
      requester: req.requester, approver: req.approver, breakGlass: req.breakGlass,
      ticket: req.ticket, pr: req.pr, sourceSha: req.sourceSha, jobUrl: req.jobUrl,
      ts: (ctx.now?.() ?? new Date()).toISOString(),
    });
    await ctx.store.writeState(req.version, next.version, signed, audit); // immutable vN+1
    await publishAll(ctx, req.version, signed); // CDN last; reconcile fixes it if this step fails
    return { stateVersion: next.version, audit };
  });
}

/** Redeploy the latest state if the CDN lags behind it (e.g. the CDN step failed after the upload). */
export async function reconcile(ctx: JobContext, version: string): Promise<{ redeployed: Platform[] }> {
  return ctx.store.withLock(version, async () => {
    const { state } = await readVerifiedLatest(ctx, version);
    const { raw } = await ctx.store.readState(version, state.version);
    const behind: Platform[] = [];
    for (const p of PLATFORMS) {
      const served = await ctx.cdn.servedVersion(p, version);
      if (served !== null && served > state.version) throw new Error(`CDN serves v${served} > latest state v${state.version}: manual investigation required`);
      if (served === null || served < state.version) behind.push(p);
    }
    if (behind.length) await publishAll(ctx, version, raw);
    return { redeployed: behind };
  });
}

/** Full integrity audit of a version's state history and the CDN. Returns problems (empty = healthy). */
export async function verifyStore(ctx: JobContext, version: string): Promise<string[]> {
  const problems: string[] = [];
  const versions = await ctx.store.stateVersions(version);
  if (!versions.length) return [`${version}: no state`];
  for (const [i, n] of versions.entries()) {
    if (n !== i + 1) problems.push(`${version}: state versions are not contiguous at v${n}`);
    const { manifests, raw, audit } = await ctx.store.readState(version, n);
    if (audit.stateVersion !== n) problems.push(`v${n}: audit.stateVersion is ${audit.stateVersion}`);
    for (const p of PLATFORMS) {
      const m = manifests[p];
      if (m.version !== n) problems.push(`v${n}/${p}: manifest.version is ${m.version}`);
      if (m.platform !== p || m.appVersion !== version) problems.push(`v${n}/${p}: manifest platform/appVersion mismatch`);
      for (const e of validateManifest(m)) problems.push(`v${n}/${p}: ${e}`);
      if (!(await ctx.signer.verify(raw[p].json, raw[p].sig))) problems.push(`v${n}/${p}: bad signature`);
    }
  }
  problems.push(...verifyAuditChain(await ctx.store.allAudits(version)).map((e) => `audit: ${e}`));
  const latest = versions[versions.length - 1];
  const { manifests, raw } = await ctx.store.readState(version, latest);
  for (const p of PLATFORMS) {
    const served = await ctx.cdn.readSigned(p, version);
    if (!served) problems.push(`CDN: ${p}/${version} has no manifest`);
    else {
      const sv = (JSON.parse(served.json) as Manifest).version;
      if (sv !== latest) problems.push(`CDN: ${p} serves v${sv}, latest is v${latest}`);
      else if (served.json !== raw[p].json || served.sig !== raw[p].sig) problems.push(`CDN: ${p} manifest/signature bytes differ from state v${latest}`);
      if (!(await ctx.signer.verify(served.json, served.sig))) problems.push(`CDN: ${p} served signature does not verify`);
    }
    for (const e of [...manifests[p].mainBundle.entries, ...manifests[p].units.flatMap((u) => u.entries)]) {
      const name = e.patchUrl.split('/').pop()!;
      if (!(await ctx.cdn.hasFile(p, version, name))) problems.push(`CDN: ${p} missing patch file ${name} (${e.id})`);
    }
  }
  return problems;
}

