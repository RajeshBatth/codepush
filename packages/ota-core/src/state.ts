import type { BaseInfo, Entry, Hash, Manifest, Platform, UpdateType } from './types.ts';
import { PLATFORMS } from './types.ts';
import { addPatch, halt, setPercent } from './ladder.ts';
import { validateManifest } from './manifest.ts';

/** One immutable state version: both platforms' manifests share the same version number N. */
export interface StateBundle {
  version: number;
  manifests: Record<Platform, Manifest>;
}

export interface PlatformPatch {
  patchUrl: string;
  hash: Hash;
  size: number;
  updateType: UpdateType;
  requiresHost?: string | null;
}

export const HOST_UNIT = 'host';

export function initState(base: BaseInfo, ttlSec = 120): StateBundle {
  const manifests = {} as Record<Platform, Manifest>;
  for (const p of PLATFORMS) {
    manifests[p] = {
      schema: 1,
      platform: p,
      appVersion: base.appVersion,
      patchAlgoVer: base.patchAlgoVer,
      version: 1,
      ttlSec,
      mainBundle: { baseHash: base.host[p], entries: [] },
      units: [],
    };
  }
  return { version: 1, manifests };
}

function withVersion(prev: StateBundle, mutate: (m: Manifest) => Manifest, platforms: readonly Platform[] = PLATFORMS): StateBundle {
  const version = prev.version + 1;
  const manifests = {} as Record<Platform, Manifest>;
  for (const p of PLATFORMS) {
    const base = prev.manifests[p];
    const changed = platforms.includes(p) ? mutate(structuredClone(base)) : structuredClone(base);
    manifests[p] = { ...changed, version };
    const errs = validateManifest(manifests[p]);
    if (errs.length) throw new Error(`invalid manifest (${p}):\n  - ${errs.join('\n  - ')}`);
  }
  return { version, manifests };
}

function entriesOf(m: Manifest, unit: string, base?: BaseInfo): Entry[] {
  if (unit === HOST_UNIT) return m.mainBundle.entries;
  const u = m.units.find((x) => x.unitName === unit);
  if (u) return u.entries;
  if (!base) throw new Error(`unit ${unit} is not in the manifest`);
  const hash = base.units[unit]?.[m.platform];
  if (!hash) throw new Error(`unit ${unit} is not declared in the base release of ${base.appVersion}`);
  const created = { unitName: unit, baseHash: hash, entries: [] as Entry[] };
  m.units.push(created);
  m.units.sort((a, b) => a.unitName.localeCompare(b.unitName));
  return created.entries;
}

function setEntries(m: Manifest, unit: string, entries: Entry[]): void {
  if (unit === HOST_UNIT) m.mainBundle.entries = entries;
  else {
    const u = m.units.find((x) => x.unitName === unit)!;
    u.entries = entries;
  }
}

export interface DeployInput {
  unit: string;
  patchId: string;
  /** Platforms the change affects (a fix in an `.android.js` file changes only Android). At least one is required. */
  perPlatform: Partial<Record<Platform, PlatformPatch>>;
}

/** ota-deploy: add the patch at 0% to the front of the unit's ladder, on both platforms. */
export function applyDeploy(prev: StateBundle, base: BaseInfo, input: DeployInput): StateBundle {
  if (input.unit !== HOST_UNIT && !base.units[input.unit]) throw new Error(`unknown unit ${input.unit}`);
  const affected = PLATFORMS.filter((p) => input.perPlatform[p]);
  if (affected.length === 0) throw new Error('deploy needs a patch for at least one platform');
  return withVersion(prev, (m) => {
    const entries = entriesOf(m, input.unit, base);
    const pp = input.perPlatform[m.platform]!;
    const entry: Entry = {
      id: input.patchId,
      patchUrl: pp.patchUrl,
      hash: pp.hash,
      size: pp.size,
      updateType: pp.updateType,
      requiresHost: pp.requiresHost ?? null,
    };
    setEntries(m, input.unit, addPatch(entries, entry));
    return m;
  }, affected);
}

/** Platforms on which `patchId` currently exists for `unit` (the default scope of rollout/halt). */
function platformsWithPatch(prev: StateBundle, unit: string, patchId: string): Platform[] {
  return PLATFORMS.filter((p) => {
    const m = prev.manifests[p];
    const entries = unit === HOST_UNIT ? m.mainBundle.entries : (m.units.find((u) => u.unitName === unit)?.entries ?? []);
    return entries.some((e) => e.id === patchId);
  });
}

function scope(prev: StateBundle, unit: string, patchId: string, requested?: Platform[]): Platform[] {
  const have = platformsWithPatch(prev, unit, patchId);
  if (have.length === 0) throw new Error(`unknown patch: ${patchId}`);
  if (!requested) return have;
  const missing = requested.filter((p) => !have.includes(p));
  if (missing.length) throw new Error(`patch ${patchId} does not exist on ${missing.join(', ')}`);
  return requested;
}

export interface RolloutInput {
  unit: string;
  patchId: string;
  percent: number;
  /** default: both */
  platforms?: Platform[];
}

/** ota-rollout <percent>: only the latest patch may be ramped; percent 0 is a halt. */
export function applyRollout(prev: StateBundle, input: RolloutInput): StateBundle {
  const platforms = scope(prev, input.unit, input.patchId, input.platforms);
  return withVersion(
    prev,
    (m) => {
      const entries = entriesOf(m, input.unit);
      setEntries(m, input.unit, setPercent(entries, input.patchId, input.percent));
      return m;
    },
    platforms,
  );
}

export interface HaltInput {
  unit: string;
  patchId: string;
  platforms?: Platform[];
}

export function applyHalt(prev: StateBundle, input: HaltInput): StateBundle {
  const platforms = scope(prev, input.unit, input.patchId, input.platforms);
  return withVersion(
    prev,
    (m) => {
      const entries = entriesOf(m, input.unit);
      setEntries(m, input.unit, halt(entries, input.patchId));
      return m;
    },
    platforms,
  );
}

/** Restore: publish the content of an earlier version as the next version (version stays monotonic). */
export function applyRestore(current: StateBundle, from: StateBundle): StateBundle {
  const version = current.version + 1;
  const manifests = {} as Record<Platform, Manifest>;
  for (const p of PLATFORMS) {
    manifests[p] = { ...structuredClone(from.manifests[p]), version };
    const errs = validateManifest(manifests[p]);
    if (errs.length) throw new Error(`invalid restored manifest (${p}): ${errs.join('; ')}`);
  }
  return { version, manifests };
}

/** Latest (newest) patch id of a unit on a platform, or null. */
export function latestPatchId(m: Manifest, unit: string): string | null {
  const entries = unit === HOST_UNIT ? m.mainBundle.entries : (m.units.find((u) => u.unitName === unit)?.entries ?? []);
  return entries[0]?.id ?? null;
}
