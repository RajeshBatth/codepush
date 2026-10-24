// Shared types. Everything here is JSON-serializable; the manifest is the wire format read by the SDK.

export type Platform = 'android' | 'ios';
export const PLATFORMS: readonly Platform[] = ['android', 'ios'];

/** "sha256:" + 64 lowercase hex chars. */
export type Hash = string;

export type UpdateType = 'patch' | 'full';

/** Half-open interval over a device's bucket in [0,1): start <= bucket < end. Absent = [0,1) (100%). */
export type Range = [number, number];

export interface Entry {
  /** `<unit>-pr<N>` (N = ota-deployments PR number). Same for both platforms. */
  id: string;
  patchUrl: string;
  /** sha256 of the BUILT result (patch applied to the embedded unit), verified on device. */
  hash: Hash;
  size: number;
  updateType: UpdateType;
  range?: Range;
  /** Optional escape hatch for coupled releases: only usable if the VM booted with this host entry id. */
  requiresHost?: string | null;
}

export interface UnitManifest {
  unitName: string;
  /** Hash of the embedded unit bundle this unit's patches apply to. */
  baseHash: Hash;
  /** Ladder order: index 0 is the newest patch. */
  entries: Entry[];
}

export interface MainBundle {
  baseHash: Hash;
  entries: Entry[];
}

export interface Manifest {
  schema: 1;
  platform: Platform;
  appVersion: string;
  patchAlgoVer: string;
  /** Monotonic per (platform, appVersion). Replay/downgrade protection. */
  version: number;
  ttlSec: number;
  mainBundle: MainBundle;
  units: UnitManifest[];
}

/** Hashes of the bundles embedded in the binary, written by the base release job (ota-base/<version>/base.json). */
export interface BaseInfo {
  appVersion: string;
  releaseTag: string;
  toolchainImage: string;
  patchAlgoVer: string;
  /** Hermes compiler used for the embedded bundles; patches must be built with exactly this one. */
  hbc: { bytecodeVersion: number; hermescSha256: Hash };
  /** hashes by platform */
  host: Record<Platform, Hash>;
  units: Record<string, Record<Platform, Hash>>;
  /** zstd-compressed size in bytes of each embedded unit/host bundle: the base for the size-ratio limits (what shipping the unit in full would cost). */
  sizes: { host: Record<Platform, number>; units: Record<string, Record<Platform, number>> };
  /** Set by the base release job when the release line leaves the live window. */
  retired?: boolean;
}

export type Command = 'init' | 'deploy' | 'rollout' | 'halt' | 'restore';

export interface AuditRecord {
  stateVersion: number;
  previousVersion: number | null;
  /** sha256 of the canonical JSON of the previous version's audit record: tamper-evident chain. */
  prevAuditHash: Hash | null;
  command: Command;
  unit: string | null;
  patchId: string | null;
  /** command-specific parameters, e.g. { percent: 10, platforms: ["android"] } */
  params: Record<string, unknown>;
  requester: string;
  /** null only for halt (no approval) and break-glass (flagged below). */
  approver: string | null;
  breakGlass?: boolean;
  ticket: string | null;
  pr: number | null;
  sourceSha: string | null;
  jobUrl: string | null;
  ts: string;
}

export interface SizeLimit {
  /** absolute bytes */
  bytes?: number;
  /** ratio of the unit's base bundle size, e.g. 0.3 */
  ratio?: number;
}

export interface UnitConfig {
  /** GitHub team whose members may approve this unit's commands. */
  ownerTeam: string;
  /** Jira project keys mapped to this unit, e.g. ["TLX"]. */
  jiraProjects: string[];
  softLimit?: SizeLimit;
  hardLimit?: SizeLimit;
}

export interface UnitsConfig {
  superAdminTeam: string;
  /** Jira validation at verify time is OFF unless true (deferred; see DESIGN.md 7.3). */
  enforceJira?: boolean;
  /** Jira statuses acceptable at verify time (only used when enforceJira). */
  acceptableTicketStatuses: string[];
  defaultSoftLimit: SizeLimit;
  defaultHardLimit: SizeLimit;
  /** includes the special unit "host" */
  units: Record<string, UnitConfig>;
}

export interface Pin {
  branch: string;
  sha: string;
}
