import type { Entry, Range } from './types.ts';

export function rangeOf(e: Entry): Range {
  return e.range ?? [0, 1];
}

export function isEmpty(r: Range): boolean {
  return r[1] <= r[0];
}

export function contains(r: Range, b: number): boolean {
  return r[0] <= b && b < r[1];
}

/** Percent (0..100, up to 2 decimals) -> exact-ish fraction. Rounds through basis points. */
export function percentToFraction(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error(`invalid percent: ${percent}`);
  return Math.round(percent * 100) / 10000;
}

export function fractionToPercent(f: number): number {
  return Math.round(f * 10000) / 100;
}
