import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorize, makeAudit, verifyAuditChain, validateUnitsConfig, ticketFromTitle, unitForTicket, evaluateSize,
  verifyPinPr, hasErrors, parsePinPath, validatePin, type AuditRecord, type VerifyInput,
} from '../src/index.ts';
import { makeConfig } from './helpers.ts';

const teams: Record<string, string[]> = {
  'ota-cabs': ['alice'], 'ota-travelplex': ['tara'], 'ota-super-admin': ['sam'], 'ota-busrails': ['bob'],
};
const isMember = (team: string, user: string) => (teams[team] ?? []).includes(user);

test('authz: anyone requests, owner approves, approver is never the requester', () => {
  const c = makeConfig();
  const base = { command: 'deploy' as const, unit: 'cabs', requester: 'dev', approver: 'alice', isMember };
  assert.equal(authorize(c, base).ok, true);
  assert.match(authorize(c, { ...base, approver: null }).reason, /approval required/);
  assert.match(authorize(c, { ...base, requester: 'alice' }).reason, /not be the requester/);
  assert.match(authorize(c, { ...base, approver: 'tara' }).reason, /not a member of ota-cabs/);
  assert.equal(authorize(c, { ...base, command: 'rollout', approver: 'alice' }).ok, true);
});

test('authz: halt needs no approval; host needs super-admin; break-glass needs super-admin', () => {
  const c = makeConfig();
  assert.equal(authorize(c, { command: 'halt', unit: 'cabs', requester: 'anyone', approver: null, isMember }).ok, true);
  assert.equal(authorize(c, { command: 'deploy', unit: 'host', requester: 'dev', approver: 'alice', isMember }).ok, false);
  assert.equal(authorize(c, { command: 'deploy', unit: 'host', requester: 'dev', approver: 'sam', isMember }).ok, true);
  assert.equal(authorize(c, { command: 'deploy', unit: 'cabs', requester: 'dev', approver: null, breakGlass: true, isMember }).ok, false);
  assert.equal(authorize(c, { command: 'restore', unit: 'cabs', requester: 'sam', approver: null, breakGlass: true, isMember }).ok, true);
  assert.equal(authorize(c, { command: 'deploy', unit: 'nope', requester: 'a', approver: 'b', isMember }).ok, false);
});

function chain(n: number): AuditRecord[] {
  const recs: AuditRecord[] = [];
  for (let i = 1; i <= n; i++) {
    recs.push(makeAudit(recs.length ? { record: recs[recs.length - 1] } : null, {
      stateVersion: i, command: 'rollout', unit: 'cabs', patchId: 'cabs-pr1', params: { percent: i },
      requester: 'dev', approver: 'alice', ticket: 'CAB-1', pr: 1, sourceSha: null, jobUrl: null, ts: `2026-01-0${i}T00:00:00Z`,
    }));
  }
  return recs;
}

test('audit chain: intact chain verifies; tampering and gaps are detected', () => {
  const recs = chain(4);
  assert.deepEqual(verifyAuditChain(recs), []);
  const tampered = structuredClone(recs);
  tampered[1].approver = 'mallory';
  assert.match(verifyAuditChain(tampered).join('|'), /v3: prevAuditHash does not match/);
  const gap = [recs[0], recs[2], recs[3]];
  assert.match(verifyAuditChain(gap).join('|'), /previousVersion/);
});

test('units config validation', () => {
  assert.deepEqual(validateUnitsConfig(makeConfig()), []);
  const c = makeConfig();
  c.units.bus.jiraProjects = ['TLX'];
  assert.match(validateUnitsConfig(c).join('|'), /TLX mapped to both/);
  const d = makeConfig();
  delete (d.units as Record<string, unknown>).host;
  assert.match(validateUnitsConfig(d).join('|'), /host/);
});

test('jira: title parsing and project -> unit mapping (TLX -> travelplex)', () => {
  const c = makeConfig();
  assert.equal(ticketFromTitle('TLX-1244: fix crash'), 'TLX-1244');
  assert.equal(ticketFromTitle('fix TLX-1244'), null);
  assert.equal(unitForTicket(c, 'TLX-1244'), 'travelplex');
  assert.equal(unitForTicket(c, 'BR-34091'), 'bus');
  assert.equal(unitForTicket(c, 'ZZZ-1'), null);
});

test('size limits: soft warns, hard blocks, either bytes or ratio triggers, per-unit override', () => {
  const c = makeConfig();
  assert.equal(evaluateSize(c, 'cabs', 10_000, 400_000).level, 'ok');
  assert.equal(evaluateSize(c, 'cabs', 150_000, 4_000_000).level, 'warn'); // bytes soft
  assert.equal(evaluateSize(c, 'cabs', 90_000, 200_000).level, 'warn'); // ratio soft (45%)... below hard 60%
  assert.equal(evaluateSize(c, 'cabs', 600_000, 40_000_000).level, 'block'); // bytes hard
  assert.equal(evaluateSize(c, 'cabs', 130_000, 200_000).level, 'block'); // ratio hard 65%
  c.units.cabs.hardLimit = { bytes: 5_000_000 };
  assert.equal(evaluateSize(c, 'cabs', 600_000, 40_000_000).level, 'warn');
});

test('pin paths and pins', () => {
  assert.deepEqual(parsePinPath('11.9.0/travelplex.json'), { version: '11.9.0', unit: 'travelplex' });
  assert.equal(parsePinPath('11.9.0/travelplex.state.json'), null);
  assert.equal(parsePinPath('units.json'), null);
  assert.deepEqual(validatePin({ branch: 'ota/cabs/11.9.0', sha: 'a'.repeat(40) }, 'cabs', '11.9.0'), []);
  assert.equal(validatePin({ branch: 'feature/x', sha: 'abc' }, 'cabs', '11.9.0').length, 2);
});

function goodInput(): VerifyInput {
  return {
    config: { ...makeConfig(), enforceJira: true },
    prChangedFiles: ['11.9.0/travelplex.json'],
    prCommitCount: 1,
    prTitle: 'TLX-1244: fix empty state crash',
    pin: { branch: 'ota/travelplex/11.9.0', sha: 'b'.repeat(40) },
    liveVersions: ['11.9.0', '11.8.0', '11.7.0'],
    ticket: { key: 'TLX-1244', status: 'In Progress' },
    git: { shaOnBranch: true, descendsFromReleaseTag: true, branchProtected: true },
    build: {
      changedUnits: ['travelplex'], hostChanged: false, tier1Errors: [],
      patchSizes: { android: 20_000, ios: 21_000 }, unitBaseSizes: { android: 400_000, ios: 400_000 },
    },
  };
}
const checks = (i: VerifyInput) => verifyPinPr(i).filter((f) => f.severity === 'error').map((f) => f.check);

test('verify: a good PR passes with no findings', () => {
  assert.deepEqual(verifyPinPr(goodInput()), []);
});

test('verify: Jira checks are off by default (deferred)', () => {
  const i = goodInput();
  i.config = makeConfig(); // enforceJira unset
  i.prTitle = 'no ticket here';
  i.ticket = null;
  assert.deepEqual(verifyPinPr(i), []);
});

test('verify: each rule fires', () => {
  const t = (mut: (i: VerifyInput) => void) => { const i = goodInput(); mut(i); return checks(i); };
  assert.ok(t((i) => { i.prCommitCount = 2; }).includes('single-commit'));
  assert.ok(t((i) => { i.prChangedFiles = ['11.9.0/travelplex.json', '11.9.0/cabs.json']; }).includes('single-file'));
  assert.ok(t((i) => { i.prChangedFiles = ['README.md']; }).includes('pin-path'));
  assert.ok(t((i) => { i.liveVersions = ['11.8.0']; }).includes('live-version'));
  assert.ok(t((i) => { i.prTitle = 'fix the thing'; }).includes('jira-title'));
  assert.ok(t((i) => { i.prTitle = 'BR-34091: fix'; i.ticket = { key: 'BR-34091', status: 'In Progress' }; }).includes('jira-unit'));
  assert.ok(t((i) => { i.ticket = null; }).includes('jira-exists'));
  assert.ok(t((i) => { i.ticket = { key: 'TLX-1244', status: 'Closed' }; }).includes('jira-status'));
  assert.ok(t((i) => { i.pin.branch = 'feature/x'; }).includes('pin'));
  assert.ok(t((i) => { i.git.shaOnBranch = false; }).includes('sha-on-branch'));
  assert.ok(t((i) => { i.git.descendsFromReleaseTag = false; }).includes('descends-from-tag'));
  assert.ok(t((i) => { i.git.branchProtected = false; }).includes('branch-protected'));
  assert.ok(t((i) => { i.build.tier1Errors = ['dependency drift']; }).includes('tier1'));
});

test('verify: host change or other units changed -> one-unit rule; no change -> error; sizes warn/block', () => {
  const t = (mut: (i: VerifyInput) => void) => { const i = goodInput(); mut(i); return verifyPinPr(i); };
  assert.ok(t((i) => { i.build.hostChanged = true; }).some((f) => f.check === 'only-one-unit' && /host/.test(f.message)));
  assert.ok(t((i) => { i.build.changedUnits = ['travelplex', 'cabs']; }).some((f) => f.check === 'only-one-unit' && /cabs/.test(f.message)));
  assert.ok(t((i) => { i.build.changedUnits = []; }).some((f) => f.check === 'has-change'));
  const warn = t((i) => { i.build.patchSizes.android = 150_000; });
  assert.ok(warn.some((f) => f.check === 'size-soft' && f.severity === 'warning') && !hasErrors(warn));
  assert.ok(hasErrors(t((i) => { i.build.patchSizes.ios = 300_000; })));
});
