import type { Command, UnitsConfig } from './types.ts';

export interface AuthzInput {
  command: Command;
  unit: string;
  requester: string;
  approver: string | null;
  breakGlass?: boolean;
  /** Is `user` a member of GitHub team `team`? (Jenkins answers this via the GitHub API.) */
  isMember: (team: string, user: string) => boolean;
}

/**
 * "Anyone can request; the unit's owner team approves; the approver is never the requester."
 * Exceptions: halt needs no approval; break-glass needs a super-admin (recorded in the audit record).
 */
export function authorize(c: UnitsConfig, a: AuthzInput): { ok: boolean; reason: string } {
  const unit = c.units[a.unit];
  if (!unit) return { ok: false, reason: `unknown unit ${a.unit}` };
  if (a.breakGlass) {
    return a.isMember(c.superAdminTeam, a.requester)
      ? { ok: true, reason: 'break-glass by super-admin (audited)' }
      : { ok: false, reason: 'break-glass requires the super-admin team' };
  }
  if (a.command === 'halt') return { ok: true, reason: 'halt needs no approval' };
  if (!a.approver) return { ok: false, reason: 'approval required' };
  if (a.approver === a.requester) return { ok: false, reason: 'approver must not be the requester' };
  const team = a.unit === 'host' ? c.superAdminTeam : unit.ownerTeam;
  if (!a.isMember(team, a.approver)) return { ok: false, reason: `approver is not a member of ${team}` };
  return { ok: true, reason: `approved by ${a.approver} (${team})` };
}
