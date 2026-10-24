import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, copyFileSync, mkdtempSync, statSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AuditRecord, BaseInfo, Manifest, Platform, SignedManifest } from '@ota/core';
import { PLATFORMS } from '@ota/core';
import type { ArtifactStorePort, PutPatchResult, StoredState } from '../../ports.ts';

export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/**
 * Local-filesystem implementation of ArtifactStorePort (layout from DESIGN.md 7.1):
 *   ota-base/<version>/base.json
 *   ota-patches/<hash12>-<name>
 *   ota-state/<version>/v<N>/{android,ios}/manifest.json + audit.json     (immutable once written)
 * Writes are create-if-absent (mkdir of the final dir fails with EEXIST), so a lost update is impossible
 * even if the lock were bypassed.
 */
export class LocalFsArtifactStore implements ArtifactStorePort {
  root: string;
  /** Lock lease in ms: a lock older than this (or whose same-host pid is dead) is taken over. Default 10 minutes. */
  readonly leaseMs: number;
  constructor(root: string, opts: { leaseMs?: number } = {}) {
    this.root = root;
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    mkdirSync(root, { recursive: true });
  }

  private stateDir(version: string): string {
    return join(this.root, 'ota-state', version);
  }

  // ---- base ----
  writeBase(base: BaseInfo): void {
    const dir = join(this.root, 'ota-base', base.appVersion);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'base.json'), JSON.stringify(base, null, 2) + '\n');
  }
  readBase(version: string): BaseInfo {
    const p = join(this.root, 'ota-base', version, 'base.json');
    if (!existsSync(p)) throw new Error(`no base release recorded for ${version}`);
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  liveVersions(): string[] {
    const dir = join(this.root, 'ota-base');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((v) => !this.readBase(v).retired);
  }

  // ---- patches ----
  putPatch(file: string): PutPatchResult {
    const data = readFileSync(file);
    const fileHash12 = createHash('sha256').update(data).digest('hex').slice(0, 12);
    const name = file.split('/').pop()!;
    const key = `${fileHash12}-${name}`;
    mkdirSync(join(this.root, 'ota-patches'), { recursive: true });
    const dest = join(this.root, 'ota-patches', key);
    if (!existsSync(dest)) {
      // copy to a temp name then rename: a crash never leaves a truncated patch under its final key
      const tmp = `${dest}.${process.pid}.tmp`;
      copyFileSync(file, tmp);
      renameSync(tmp, dest);
    }
    return { key, fileHash12, size: data.length };
  }
  patchPath(key: string): string {
    const p = join(this.root, 'ota-patches', key);
    if (!existsSync(p)) throw new Error(`unknown patch ${key}`);
    return p;
  }

  // ---- state ----
  stateVersions(version: string): number[] {
    const dir = this.stateDir(version);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => /^v\d+$/.test(n))
      .map((n) => Number(n.slice(1)))
      .sort((a, b) => a - b);
  }
  latestVersion(version: string): number | null {
    const v = this.stateVersions(version);
    return v.length ? v[v.length - 1] : null;
  }
  /** Raw signed bytes as stored (what must be verified), plus parsed manifests and the audit record. */
  readState(version: string, n: number): StoredState {
    const dir = join(this.root, 'ota-state', version, `v${n}`);
    if (!existsSync(dir)) throw new Error(`state ${version}/v${n} does not exist`);
    const manifests = {} as Record<Platform, Manifest>;
    const raw = {} as Record<Platform, SignedManifest>;
    for (const p of PLATFORMS) {
      const json = readFileSync(join(dir, p, 'manifest.json'), 'utf8');
      const sig = readFileSync(join(dir, p, 'manifest.json.sig'), 'utf8').trim();
      raw[p] = { json, sig };
      manifests[p] = JSON.parse(json);
    }
    const audit = JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf8'));
    return { manifests, raw, audit };
  }
  /** Create-if-absent, atomic: assemble in a temp dir, then rename to the final name. */
  writeState(version: string, n: number, signed: Record<Platform, SignedManifest>, audit: AuditRecord): void {
    const parent = this.stateDir(version);
    mkdirSync(parent, { recursive: true });
    const final = join(parent, `v${n}`);
    if (existsSync(final)) throw new Error(`state ${version}/v${n} already exists (immutable)`);
    const tmp = mkdtempSync(join(parent, '.tmp-'));
    try {
      for (const p of PLATFORMS) {
        mkdirSync(join(tmp, p));
        writeFileSync(join(tmp, p, 'manifest.json'), signed[p].json);
        writeFileSync(join(tmp, p, 'manifest.json.sig'), signed[p].sig + '\n');
      }
      writeFileSync(join(tmp, 'audit.json'), JSON.stringify(audit, null, 2) + '\n');
      renameSync(tmp, final); // fails if `final` appeared meanwhile (non-empty dir)
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
  allAudits(version: string): AuditRecord[] {
    return this.stateVersions(version).map((n) => this.readState(version, n).audit);
  }

  // ---- lock per app version (Jenkins lockable resource stand-in) ----
  /**
   * LEASE lock (see ports.ts). The lock is the directory `ota-state/<v>/.lock`, created ATOMICALLY WITH ITS CONTENT
   * (`owner.json` = {token, pid, host, acquiredAt}) by renaming a prepared temp dir (rename onto an existing non-empty
   * dir fails). A waiter steals it when (a) the owner is on this host and its pid is dead, or (b) it is older than
   * `leaseMs`. Stealing is a rename to a unique name followed by an owner-token re-check, so two stealers never both win
   * and a live fresh lock that replaced the stale one in the meantime is put back.
   */
  async withLock<T>(version: string, fn: () => Promise<T> | T, timeoutMs = 15_000): Promise<T> {
    const dir = this.stateDir(version);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, '.lock');
    const start = Date.now();
    const token = randomUUID();
    for (;;) {
      if (this.tryAcquire(dir, lock, token)) break;
      this.stealIfStale(dir, lock);
      if (this.tryAcquire(dir, lock, token)) break;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for the lock on ${version}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    try {
      return await fn();
    } finally {
      // only remove OUR lock: if the lease expired and someone preempted us, their lock must survive
      this.release(dir, lock, token);
    }
  }

  /** Atomically move our lock away FIRST (a half-deleted, empty lock dir could be replaced by another acquirer's rename), then delete it. */
  private release(dir: string, lock: string, token: string): void {
    if (readOwner(lock)?.token !== token) return;
    const grave = join(dir, `.lock-released-${process.pid}-${randomUUID()}`);
    try {
      renameSync(lock, grave);
    } catch { return; }
    if (readOwner(grave)?.token !== token) {
      try { renameSync(grave, lock); return; } catch { /* taken again: nothing sane left to restore */ }
    }
    rmSync(grave, { recursive: true, force: true });
  }

  private tryAcquire(dir: string, lock: string, token: string): boolean {
    const tmp = mkdtempSync(join(dir, '.lock-tmp-'));
    try {
      const owner: LockOwner = { token, pid: process.pid, host: hostname(), acquiredAt: Date.now() };
      writeFileSync(join(tmp, 'owner.json'), JSON.stringify(owner));
      renameSync(tmp, lock);
      return true;
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR' || code === 'EPERM') return false;
      throw e;
    }
  }

  private stealIfStale(dir: string, lock: string): void {
    const owner = readOwner(lock);
    let reason: string | null = null;
    if (owner) {
      if (owner.host === hostname() && !pidAlive(owner.pid)) reason = 'dead holder';
      else if (Date.now() - owner.acquiredAt > this.leaseMs) reason = 'lease expired';
    } else {
      // legacy / unreadable lock without owner info: fall back to the directory age
      try {
        if (Date.now() - statSync(lock).mtimeMs > this.leaseMs) reason = 'lease expired';
      } catch { return; } // vanished: released meanwhile
    }
    if (!reason) return;
    const grave = join(dir, `.lock-stale-${process.pid}-${randomUUID()}`);
    try {
      renameSync(lock, grave); // only one stealer can move it
    } catch { return; }
    const moved = readOwner(grave);
    const judged = owner?.token ?? null;
    if ((moved?.token ?? null) !== judged) {
      // we grabbed a different (fresh) lock that appeared between our check and the rename: put it back if possible
      try { renameSync(grave, lock); return; } catch { /* the lock path is taken again; fall through */ }
    }
    rmSync(grave, { recursive: true, force: true });
  }
}

interface LockOwner { token: string; pid: number; host: string; acquiredAt: number }

function readOwner(lock: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as LockOwner;
    return typeof o.token === 'string' && typeof o.pid === 'number' && typeof o.host === 'string' && typeof o.acquiredAt === 'number' ? o : null;
  } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}
