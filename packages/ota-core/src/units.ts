import type { SizeLimit, UnitsConfig } from './types.ts';

export function validateUnitsConfig(c: UnitsConfig): string[] {
  const errors: string[] = [];
  if (!c.superAdminTeam) errors.push('superAdminTeam missing');
  if (!c.acceptableTicketStatuses?.length) errors.push('acceptableTicketStatuses must be non-empty');
  const keyOwner = new Map<string, string>();
  for (const [name, u] of Object.entries(c.units ?? {})) {
    if (!u.ownerTeam) errors.push(`unit ${name}: ownerTeam missing`);
    if (!Array.isArray(u.jiraProjects) || u.jiraProjects.length === 0) errors.push(`unit ${name}: jiraProjects must be non-empty`);
    for (const k of u.jiraProjects ?? []) {
      if (!/^[A-Z][A-Z0-9]+$/.test(k)) errors.push(`unit ${name}: invalid Jira project key ${k}`);
      const other = keyOwner.get(k);
      if (other && other !== name) errors.push(`Jira project ${k} mapped to both ${other} and ${name}`);
      keyOwner.set(k, name);
    }
  }
  if (!c.units?.host) errors.push('the special unit "host" must be declared');
  return errors;
}

/** "TLX-1244: fix crash" -> "TLX-1244" */
export function ticketFromTitle(title: string): string | null {
  const m = /^([A-Z][A-Z0-9]+-\d+)\b/.exec(title.trim());
  return m ? m[1] : null;
}

export function projectOf(ticket: string): string {
  return ticket.slice(0, ticket.lastIndexOf('-'));
}

export function unitForTicket(c: UnitsConfig, ticket: string): string | null {
  const project = projectOf(ticket);
  for (const [name, u] of Object.entries(c.units)) if (u.jiraProjects.includes(project)) return name;
  return null;
}

export type SizeLevel = 'ok' | 'warn' | 'block';

function exceeds(limit: SizeLimit | undefined, size: number, baseSize: number): string | null {
  if (!limit) return null;
  if (limit.bytes !== undefined && size > limit.bytes) return `${size} B > ${limit.bytes} B`;
  if (limit.ratio !== undefined && baseSize > 0 && size / baseSize > limit.ratio) {
    return `${(size / baseSize * 100).toFixed(1)}% of base > ${(limit.ratio * 100).toFixed(1)}%`;
  }
  return null;
}

/** Soft limit -> warn (PR comment); hard limit -> block (check fails). Either bytes or ratio triggers. */
export function evaluateSize(c: UnitsConfig, unit: string, size: number, baseSize: number): { level: SizeLevel; detail: string | null } {
  const u = c.units[unit];
  const hard = u?.hardLimit ?? c.defaultHardLimit;
  const soft = u?.softLimit ?? c.defaultSoftLimit;
  const h = exceeds(hard, size, baseSize);
  if (h) return { level: 'block', detail: `hard limit: ${h}` };
  const s = exceeds(soft, size, baseSize);
  if (s) return { level: 'warn', detail: `soft limit: ${s}` };
  return { level: 'ok', detail: null };
}
