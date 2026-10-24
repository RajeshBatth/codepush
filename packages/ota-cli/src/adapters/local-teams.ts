import type { TeamDirectoryPort } from '../ports.ts';

/** TeamDirectoryPort backed by a `{team: [users]}` object (the CLI reads it from teams.json). */
export class StaticTeamDirectory implements TeamDirectoryPort {
  private teams: Record<string, string[]>;
  constructor(teams: Record<string, string[]>) {
    this.teams = teams;
  }
  isMember(team: string, user: string): boolean {
    return (this.teams[team] ?? []).includes(user);
  }
}
