import type { AuditRecord, Hash } from './types.ts';
import { canonicalize, sha256 } from './manifest.ts';

export function auditHash(r: AuditRecord): Hash {
  return sha256(canonicalize(r));
}

export function makeAudit(
  prev: { record: AuditRecord } | null,
  fields: Omit<AuditRecord, 'stateVersion' | 'previousVersion' | 'prevAuditHash'> & { stateVersion: number },
): AuditRecord {
  return {
    ...fields,
    previousVersion: prev ? prev.record.stateVersion : null,
    prevAuditHash: prev ? auditHash(prev.record) : null,
  };
}

/** Verify the hash chain over records ordered by stateVersion. Returns errors (empty = intact). */
export function verifyAuditChain(records: AuditRecord[]): string[] {
  const errors: string[] = [];
  const sorted = [...records].sort((a, b) => a.stateVersion - b.stateVersion);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const prev = sorted[i - 1];
    if (i === 0) {
      if (r.prevAuditHash !== null && r.previousVersion === null) errors.push(`v${r.stateVersion}: first record has a prev hash`);
      continue;
    }
    if (r.previousVersion !== prev.stateVersion) errors.push(`v${r.stateVersion}: previousVersion ${r.previousVersion} != ${prev.stateVersion}`);
    if (r.prevAuditHash !== auditHash(prev)) errors.push(`v${r.stateVersion}: prevAuditHash does not match record v${prev.stateVersion} (tampered or missing)`);
  }
  return errors;
}
