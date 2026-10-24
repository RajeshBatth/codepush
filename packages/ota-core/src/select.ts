import type { Entry, Manifest } from './types.ts';
import { contains, rangeOf } from './ranges.ts';

export type SelectReason =
  | 'ok'
  | 'unit-not-in-manifest'
  | 'base-mismatch'
  | 'algo-unsupported'
  | 'no-range-match'
  | 'requires-host-mismatch';

export interface SelectContext {
  /** device bucket for this unit, from bucket(deviceId, unitName) */
  bucket: number;
  /** hash of the unit/host bundle embedded in THIS binary */
  embeddedHash: string;
  /** patch algorithm versions the binary can apply, e.g. ["v1"] */
  supportedAlgos: string[];
  /** id of the host entry the running VM booted with, or "embedded" */
  runningHostId: string;
}

export interface Selection {
  source: 'embedded' | 'patch';
  entry?: Entry;
  reason: SelectReason;
}

function pick(entries: Entry[], ctx: SelectContext): Selection {
  // The bucket can fall in at most one range (validated). Find it, then apply eligibility:
  // an ineligible owner of the bucket means embedded (v1 does not search for an older patch).
  const owner = entries.find((e) => contains(rangeOf(e), ctx.bucket));
  if (!owner) return { source: 'embedded', reason: 'no-range-match' };
  if (owner.requiresHost != null && owner.requiresHost !== ctx.runningHostId) {
    return { source: 'embedded', reason: 'requires-host-mismatch' };
  }
  return { source: 'patch', entry: owner, reason: 'ok' };
}

/** Section 5.2 step 2: choose embedded or a patch for one unit. Pure function; mirrored in native SDKs. */
export function selectUnit(m: Manifest, unitName: string, ctx: SelectContext): Selection {
  if (!ctx.supportedAlgos.includes(m.patchAlgoVer)) return { source: 'embedded', reason: 'algo-unsupported' };
  const u = m.units.find((x) => x.unitName === unitName);
  if (!u) return { source: 'embedded', reason: 'unit-not-in-manifest' };
  if (u.baseHash !== ctx.embeddedHash) return { source: 'embedded', reason: 'base-mismatch' };
  return pick(u.entries, ctx);
}

/** Same for the host (mainBundle); requiresHost is meaningless there. */
export function selectHost(m: Manifest, ctx: SelectContext): Selection {
  if (!ctx.supportedAlgos.includes(m.patchAlgoVer)) return { source: 'embedded', reason: 'algo-unsupported' };
  if (m.mainBundle.baseHash !== ctx.embeddedHash) return { source: 'embedded', reason: 'base-mismatch' };
  return pick(m.mainBundle.entries, { ...ctx, runningHostId: 'embedded' });
}
