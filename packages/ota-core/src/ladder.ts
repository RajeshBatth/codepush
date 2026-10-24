import type { Entry } from './types.ts';
import { isEmpty, percentToFraction, rangeOf } from './ranges.ts';

/**
 * Rollout ladder (section 6). `entries` is ordered newest-first. Ranges are laid out newest-first from
 * bucket 0:   [0,x) newest | [x,y) previous | [y,1) embedded
 * Ramping the newest takes buckets from the previous patch(es); users only move forward.
 * All functions are pure and return a new array.
 */

function clone(entries: Entry[]): Entry[] {
  return entries.map((e) => ({ ...e, range: e.range ? ([...e.range] as [number, number]) : undefined }));
}

/** Recompute ranges after the newest entry's end changed: older entries start where the previous ends. */
function relayout(entries: Entry[]): Entry[] {
  const out = clone(entries);
  for (let j = 1; j < out.length; j++) {
    const start = rangeOf(out[j - 1])[1];
    const end = Math.max(rangeOf(out[j])[1], start);
    out[j].range = [start, end];
  }
  // retire older entries that no longer own any bucket (never the newest: a freshly deployed patch is legitimately empty)
  return out.filter((e, i) => i === 0 || !isEmpty(rangeOf(e)));
}

/** New patches start at 0%: empty range at the front. Older entries keep their ranges until the new one ramps. */
export function addPatch(entries: Entry[], e: Entry): Entry[] {
  if (entries.some((x) => x.id === e.id)) throw new Error(`patch id already exists: ${e.id}`);
  const fresh: Entry = { ...e, range: [0, 0] };
  return [fresh, ...clone(entries)];
}

/**
 * Set the rollout of the newest patch to `percent` (0 < percent <= 100).
 * Only the newest patch can be ramped. percent === 0 is a halt: use halt().
 */
export function setPercent(entries: Entry[], id: string, percent: number): Entry[] {
  if (percent === 0) return halt(entries, id);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`unknown patch: ${id}`);
  if (idx !== 0) throw new Error(`ramp is only allowed for the latest patch (latest is ${entries[0].id}, requested ${id})`);
  const out = clone(entries);
  out[0].range = [0, percentToFraction(percent)];
  return relayout(out);
}

/**
 * Halt = remove the entry. If it was the newest, the next one extends back to bucket 0 so users of the
 * halted patch return to what they had before the ramp. If it was an older one, its buckets become embedded.
 */
export function halt(entries: Entry[], id: string): Entry[] {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`unknown patch: ${id}`);
  const out = clone(entries);
  out.splice(idx, 1);
  if (idx === 0 && out.length > 0) out[0].range = [0, rangeOf(out[0])[1]];
  return out;
}
