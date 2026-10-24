import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest, Platform, SignedManifest } from '@ota/core';
import type { CdnPort } from '../../ports.ts';

/** Local-filesystem implementation of CdnPort: <cdn>/<platform>/<app-version>/manifest.json + patch files. */
export class LocalFsCdn implements CdnPort {
  root: string;
  /**
   * TEST SEAMS (no production use): called between the publish steps so a test can read the origin in the middle of a
   * publish. Order: patches -> `afterSignature` -> manifest swap -> `afterManifest`.
   */
  hooks: { afterSignature?: () => void; afterManifest?: () => void } = {};
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  private dir(platform: Platform, version: string): string {
    return join(this.root, platform, version);
  }
  /** Patches first, then the signature, then the manifest (atomic renames): a served manifest never references a missing file. */
  publish(platform: Platform, version: string, signed: SignedManifest, patchFiles: { name: string; path: string }[]): void {
    const dir = this.dir(platform, version);
    mkdirSync(dir, { recursive: true });
    for (const f of patchFiles) {
      const dest = join(dir, f.name);
      if (!existsSync(dest)) {
        const tmp = `${dest}.${process.pid}.tmp`;
        copyFileSync(f.path, tmp);
        renameSync(tmp, dest);
      }
    }
    const write = (name: string, data: string) => {
      const tmp = join(dir, `.${name}.${process.pid}.tmp`);
      writeFileSync(tmp, data);
      renameSync(tmp, join(dir, name));
    };
    // PAIR CONSISTENCY (ports.ts, CdnPort 2b): signature first, manifest last. The only mixed pair a reader can ever
    // see is {old manifest, new signature}, which fails verification (fail safe); never a manifest without signature.
    write('manifest.json.sig', signed.sig + '\n');
    this.hooks.afterSignature?.();
    write('manifest.json', signed.json);
    this.hooks.afterManifest?.();
  }
  /** Raw served bytes (manifest.json + its detached signature), or null. */
  readSigned(platform: Platform, version: string): SignedManifest | null {
    const p = join(this.dir(platform, version), 'manifest.json');
    const sp = join(this.dir(platform, version), 'manifest.json.sig');
    // manifest first, then signature: with the publish order (signature, then manifest) a reader that sees a manifest
    // always finds a signature at least as new as it. A missing signature means "not served" (never serve unsigned data).
    if (!existsSync(p) || !existsSync(sp)) return null;
    return { json: readFileSync(p, 'utf8'), sig: readFileSync(sp, 'utf8').trim() };
  }
  servedVersion(platform: Platform, version: string): number | null {
    const s = this.readSigned(platform, version);
    return s ? (JSON.parse(s.json) as Manifest).version : null;
  }
  readManifest(platform: Platform, version: string): Manifest | null {
    const s = this.readSigned(platform, version);
    return s ? JSON.parse(s.json) : null;
  }
  hasFile(platform: Platform, version: string, name: string): boolean {
    return existsSync(join(this.dir(platform, version), name));
  }
}
