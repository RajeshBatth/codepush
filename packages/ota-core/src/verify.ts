import type { Pin, UnitsConfig, Platform } from './types.ts';
import { PLATFORMS } from './types.ts';
import { parsePinPath, validatePin } from './pin.ts';
import { evaluateSize, ticketFromTitle, unitForTicket } from './units.ts';

export type Severity = 'error' | 'warning';
export interface Finding {
  severity: Severity;
  check: string;
  message: string;
}

export interface VerifyInput {
  config: UnitsConfig;
  prChangedFiles: string[];
  prCommitCount: number;
  prTitle: string;
  /** Pin as proposed by the PR (the contents of <version>/<unit>.json). */
  pin: Pin;
  /** Live app versions (base artifact exists, line within the latest 3). */
  liveVersions: string[];
  /** Jira lookup result for the ticket in the title; only consulted when config.enforceJira. */
  ticket?: { key: string; status: string } | null;
  /** Git facts established by Jenkins. */
  git: { shaOnBranch: boolean; descendsFromReleaseTag: boolean; branchProtected: boolean };
  /** Output of the verify build (unit-splitter diffAgainstBase + patch sizes). */
  build: {
    changedUnits: string[];
    hostChanged: boolean;
    tier1Errors: string[];
    patchSizes: Record<Platform, number>;
    unitBaseSizes: Record<Platform, number>;
  };
}

/** The verify phase (section 7.3) as a pure function. Any `error` finding fails the required check. */
export function verifyPinPr(i: VerifyInput): Finding[] {
  const out: Finding[] = [];
  const err = (check: string, message: string) => out.push({ severity: 'error', check, message });
  const warn = (check: string, message: string) => out.push({ severity: 'warning', check, message });

  if (i.prCommitCount !== 1) err('single-commit', `PR must have exactly one commit (has ${i.prCommitCount})`);
  if (i.prChangedFiles.length !== 1) err('single-file', `PR must change exactly one file (changes ${i.prChangedFiles.length})`);
  const parsed = i.prChangedFiles.length === 1 ? parsePinPath(i.prChangedFiles[0]) : null;
  if (i.prChangedFiles.length === 1 && !parsed) err('pin-path', `${i.prChangedFiles[0]} is not a pin file (<version>/<unit>.json)`);
  if (!parsed) return out;
  const { version, unit } = parsed;

  if (!i.config.units[unit]) err('known-unit', `unit "${unit}" is not declared in units.json`);
  if (!i.liveVersions.includes(version)) err('live-version', `app version ${version} is not live (live: ${i.liveVersions.join(', ') || 'none'})`);

  for (const e of validatePin(i.pin, unit, version)) err('pin', e);

  if (i.config.enforceJira) {
    const key = ticketFromTitle(i.prTitle);
    if (!key) err('jira-title', 'PR title must start with a Jira key, e.g. "TLX-1244: ..."');
    else {
      const mapped = unitForTicket(i.config, key);
      if (mapped !== unit) err('jira-unit', `ticket ${key} belongs to ${mapped ?? 'no unit'}, not ${unit}`);
      if (!i.ticket) err('jira-exists', `ticket ${key} does not exist`);
      else if (!i.config.acceptableTicketStatuses.includes(i.ticket.status)) {
        err('jira-status', `ticket ${key} is "${i.ticket.status}"; acceptable: ${i.config.acceptableTicketStatuses.join(', ')}`);
      }
    }
  }

  if (!i.git.shaOnBranch) err('sha-on-branch', 'pinned sha is not reachable from the pinned branch');
  if (!i.git.descendsFromReleaseTag) err('descends-from-tag', 'pinned sha does not descend from the release tag of this version');
  if (!i.git.branchProtected) err('branch-protected', 'pinned branch is not protected');

  for (const e of i.build.tier1Errors) err('tier1', e);
  if (i.build.hostChanged && unit !== 'host') err('only-one-unit', `host artifact differs from base but this PR claims unit "${unit}"`);
  const others = i.build.changedUnits.filter((u) => u !== unit);
  if (others.length) err('only-one-unit', `other units differ from base: ${others.join(', ')}`);
  if (unit !== 'host' && !i.build.changedUnits.includes(unit)) err('has-change', `unit "${unit}" is byte-identical to the base: nothing to patch`);

  for (const p of PLATFORMS) {
    const r = evaluateSize(i.config, unit, i.build.patchSizes[p], i.build.unitBaseSizes[p]);
    if (r.level === 'block') err('size-hard', `${p}: ${r.detail}`);
    else if (r.level === 'warn') warn('size-soft', `${p}: ${r.detail}`);
  }
  return out;
}

export function hasErrors(f: Finding[]): boolean {
  return f.some((x) => x.severity === 'error');
}
