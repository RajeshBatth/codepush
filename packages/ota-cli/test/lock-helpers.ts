import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Leave `version` locked as if a holder on ANOTHER host crashed just now (only the lease can free it). */
export function plantForeignLock(root: string, version: string, over: Partial<{ pid: number; host: string; acquiredAt: number }> = {}): void {
  const lock = join(root, 'ota-state', version, '.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'crashed-holder', pid: 1, host: 'some-other-host', acquiredAt: Date.now(), ...over }));
}
