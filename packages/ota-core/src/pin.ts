import type { Pin } from './types.ts';

export function branchFor(unit: string, version: string): string {
  return `ota/${unit}/${version}`;
}

export function validatePin(p: Pin, unit: string, version: string): string[] {
  const errors: string[] = [];
  if (typeof p.branch !== 'string' || !p.branch) errors.push('branch missing');
  else if (p.branch !== branchFor(unit, version)) errors.push(`branch must be ${branchFor(unit, version)}, got ${p.branch}`);
  if (typeof p.sha !== 'string' || !/^[0-9a-f]{40}$/.test(p.sha)) errors.push('sha must be a full 40-char lowercase hex commit id');
  return errors;
}

/** "<version>/<unit>.json" -> { version, unit } or null (any other path is not a pin file). */
export function parsePinPath(path: string): { version: string; unit: string } | null {
  const m = /^([0-9]+\.[0-9]+\.[0-9]+)\/([a-z][a-z0-9-]*)\.json$/.exec(path);
  return m ? { version: m[1], unit: m[2] } : null;
}
