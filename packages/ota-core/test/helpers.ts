import { sha256, type BaseInfo, type UnitsConfig, type Platform } from '../src/index.ts';

export const h = (s: string) => sha256(s);

export function makeBase(): BaseInfo {
  const units = ['cabs', 'bus', 'travelplex'];
  const P = (f: (p: Platform) => string) => ({ android: f('android'), ios: f('ios') }) as Record<Platform, string>;
  return {
    appVersion: '11.9.0',
    releaseTag: 'release/11.9.0',
    toolchainImage: 'registry/rn-build@sha256:abc',
    patchAlgoVer: 'v1',
    hbc: { bytecodeVersion: 96, hermescSha256: h('hermesc-rn-0.78.3') },
    host: P((p) => h(`host-${p}`)),
    units: Object.fromEntries(units.map((u) => [u, P((p) => h(`${u}-${p}`))])),
    sizes: {
      host: { android: 2_000_000, ios: 2_000_000 },
      units: Object.fromEntries(units.map((u) => [u, { android: 400_000, ios: 400_000 }])),
    },
  };
}

export function makeConfig(): UnitsConfig {
  return {
    superAdminTeam: 'ota-super-admin',
    acceptableTicketStatuses: ['In Progress', 'Ready for Release'],
    defaultSoftLimit: { bytes: 100_000, ratio: 0.25 },
    defaultHardLimit: { bytes: 500_000, ratio: 0.6 },
    units: {
      host: { ownerTeam: 'ota-super-admin', jiraProjects: ['COM'] },
      cabs: { ownerTeam: 'ota-cabs', jiraProjects: ['CAB'] },
      bus: { ownerTeam: 'ota-busrails', jiraProjects: ['BR'] },
      travelplex: { ownerTeam: 'ota-travelplex', jiraProjects: ['TLX'] },
    },
  };
}

export function patch(id: string, seed = id) {
  const mk = (p: string) => ({ patchUrl: `https://cdn/${p}/${id}.patch`, hash: h(`${seed}-${p}`), size: 40_000, updateType: 'patch' as const });
  return { android: mk('android'), ios: mk('ios') };
}
