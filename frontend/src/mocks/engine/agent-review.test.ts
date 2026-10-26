import { describe, expect, it } from 'vitest';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { AGENT, USER } from '../fixtures/documents';
import { buildSeedState } from '../store';
import { setPolicy } from '../records/connect';
import { reviewDraft, routeOf, getReport } from './agent-review';
import { createDraft, issue } from './commands';
import { checkInvariants } from './invariants';
import { homeApprovals } from './home';
import { withFixedClock } from './log';

const V = 'co-vat';
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };
const codes = (r: { checks: { code: string }[] }) => r.checks.map((c) => c.code);
const acct = PERMISSIONS_BY_ROLE.accountant;
const draftLike = (st: ReturnType<typeof buildSeedState>, id: string, over: { date?: string; qty?: string } = {}) => {
  const d = st.docs.find((x) => x.id === id)!;
  return createDraft(st, V, d.type, { header: { ...d.header, ...(over.date ? { documentDate: over.date } : {}) }, lines: d.lines.map((l) => ({ ...l, ...(over.qty ? { qty: over.qty } : {}) })) }, AGENT, `t-${Math.random()}`);
};

describe('the seed: reports made through the review command', () => {
  const st = buildSeedState();
  it('ti-002, ti-004 and one agent PV draft each carry a stored report; the state version is 62', () => {
    expect(st.version).toBe(62);
    for (const id of ['ti-002', 'ti-004', 'pv-ag1']) {
      const d = st.docs.find((x) => x.id === id)!;
      expect(d.status, id).toBe('draft');
      expect(d.createdBy.kind, id).toBe('agent');
      expect(st.agentReports!.find((r) => r.id === d.agentReportId)).toMatchObject({ docId: id, version: 1, route: 'human' });
    }
    expect(st.agentReports).toHaveLength(3);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the T-class drafts route to a human by policy; the voucher (Auto-if-clean) by its warning; the audit knows the agent reviewed', () => {
    const pv = st.agentReports!.find((r) => r.docId === 'pv-ag1')!;
    expect(pv.policy.mode).toBe('auto');
    expect(codes(pv)).toContain('date_not_current');
    expect(st.agentReports!.find((r) => r.docId === 'ti-002')!.policy.mode).toBe('human');
    expect(st.audit.some((a) => a.command === 'agent.review' && a.actor.kind === 'agent')).toBe(true);
  });
  it('the Home inbox shows the agent drafts on the HUMAN route, each with its report id', () => {
    const rows = homeApprovals(st, V, acct, USER).filter((r) => r.reason === 'agent');
    expect(rows.map((r) => r.id).sort()).toEqual(['pv-ag1', 'ti-002', 'ti-004']);
    for (const r of rows) expect(r.agentReportId).toBe(st.docs.find((d) => d.id === r.id)!.agentReportId);
  });
  it('an agent draft that was never reviewed, or whose report routes auto, is not in the inbox', () => {
    const s = buildSeedState();
    const fresh = draftLike(s, 'ti-002');
    expect(homeApprovals(s, V, acct, USER).some((r) => r.id === fresh.id)).toBe(false);
    s.agentReports!.find((r) => r.docId === 'ti-002')!.route = 'auto';
    expect(homeApprovals(s, V, acct, USER).some((r) => r.id === 'ti-002')).toBe(false);
  });
});

describe('§8.3 checks fire for their vectors', () => {
  it('duplicate: the same party and amount within 7 days (and not 8)', () => {
    const st = buildSeedState();
    const near = draftLike(st, 'ti-002', { date: '2026-10-09' }); // ti-002 is 2026-10-11
    expect(codes(reviewDraft(st, AGENT, near.id))).toContain('duplicate');
    const far = draftLike(st, 'ti-002', { date: '2026-09-30' }); // 11 days from ti-002, 9 from near
    expect(codes(reviewDraft(st, AGENT, far.id))).not.toContain('duplicate');
  });
  it('3x: above three times the party\'s 90-day maximum', () => {
    const st = buildSeedState();
    const base = st.docs.find((x) => x.id === 'ti-002')!;
    const pid = base.header.partyId!;
    const hist = st.docs.filter((d) => d.type === 'TI' && d.header.partyId === pid && ['issued', 'partly_settled', 'settled'].includes(d.status) && d.header.documentDate <= '2026-10-11' && d.header.documentDate >= '2026-07-13');
    const big = draftLike(st, 'ti-002', { qty: '1000' });
    const r = reviewDraft(st, AGENT, big.id);
    expect(hist.length).toBeGreaterThan(0); // the party has history in the 90 days, so the rule can fire
    expect(codes(r)).toContain('over_3x');
    expect(codes(reviewDraft(st, AGENT, 'ti-002'))).not.toContain('over_3x');
  });
  it('first document: a party with no live document', () => {
    const st = buildSeedState();
    const pid = st.docs.find((x) => x.id === 'ti-002')!.header.partyId!;
    for (const d of st.docs) if (d.header.partyId === pid && d.id !== 'ti-002') d.status = 'cancelled'; // the party has nothing live
    expect(codes(reviewDraft(st, AGENT, 'ti-002'))).toContain('first_document');
  });
  it('posting default: Revenue resolved at the company default; date: not in the current month', () => {
    const st = buildSeedState();
    st.postingRules = st.postingRules.filter((r) => !(r.companyId === V && r.role === 'Revenue' && r.level !== 'default'));
    const r = reviewDraft(st, AGENT, 'ti-002');
    expect(codes(r)).toContain('posting_default');
    expect(codes(reviewDraft(st, AGENT, 'pv-ag1'))).toContain('date_not_current');
    expect(codes(r)).not.toContain('date_not_current');
    for (const c of r.checks) expect(['error', 'warning', 'info']).toContain(c.severity);
  });
  it('a closed period and a policy that is Off are errors; the report carries totals, journal rules and the 15-minute token expiry', () => {
    const st = buildSeedState();
    const old = draftLike(st, 'ti-002', { date: '2026-05-10' });
    expect(reviewDraft(st, AGENT, old.id).checks.find((c) => c.code === 'period_closed')?.severity).toBe('error');
    setPolicy(st, USER, V, 'TI', { mode: 'off', cap: '50000.00', version: 1 });
    const r = reviewDraft(st, AGENT, 'ti-002');
    expect(r.checks.find((c) => c.code === 'policy_off')?.severity).toBe('error');
    expect(r.totals.total).toBe(st.docs.find((d) => d.id === 'ti-002')!.totals.total);
    expect(r.journal.entries[0].lines.every((l) => !!l.rule)).toBe(true);
    expect(Date.parse(r.expiresAt) - Date.parse(r.createdAt)).toBe(15 * 60_000);
  });
  it('only an agent reviews, and only its own draft', () => {
    const st = buildSeedState();
    expect(code(() => reviewDraft(st, USER, 'ti-002'))).toBe('agent.review_agent_only');
    const issued = st.docs.find((d) => d.type === 'TI' && d.status === 'issued')!;
    expect(code(() => reviewDraft(st, AGENT, issued.id))).toBe('agent.review_not_draft');
  });
});

describe('ruling 4: the report is frozen', () => {
  it('a later policy change or party-history change never rewrites the stored report; a revise by the agent makes version 2', () => {
    const st = buildSeedState();
    const id = st.docs.find((d) => d.id === 'ti-002')!.agentReportId!;
    const before = JSON.stringify(getReport(st, V, id));
    setPolicy(st, USER, V, 'TI', { mode: 'off', cap: '1.00', version: 1 });
    const pid = st.docs.find((x) => x.id === 'ti-002')!.header.partyId!;
    for (const d of st.docs) if (d.header.partyId === pid && d.id !== 'ti-002') d.status = 'cancelled';
    expect(JSON.stringify(getReport(st, V, id))).toBe(before);
    const again = reviewDraft(st, AGENT, 'ti-002');
    expect(again).toMatchObject({ version: 2, id: 'ar-4' });
    expect(st.docs.find((d) => d.id === 'ti-002')!.agentReportId).toBe('ar-4');
    expect(JSON.stringify(getReport(st, V, id))).toBe(before); // version 1 stays what it was
    expect(getReport(st, V, 'ar-4').policy.mode).toBe('off'); // version 2 saw the new policy
    expect(code(() => getReport(st, 'co-nonvat', id))).toBe('record.not_found');
  });
});

describe('§8.4 route', () => {
  const auto = { mode: 'auto', cap: '50000.00' };
  it('auto only when Auto-if-clean, clean and within the cap; a cancel / reissue is never auto', () => {
    expect(routeOf(auto, { clean: true, total: '50000.00' })).toBe('auto');
    expect(routeOf(auto, { clean: true, total: '50000.01' })).toBe('human');
    expect(routeOf(auto, { clean: false, total: '10.00' })).toBe('human');
    expect(routeOf({ mode: 'human', cap: '50000.00' }, { clean: true, total: '10.00' })).toBe('human');
    for (const action of ['cancel', 'reissue'] as const) expect(routeOf(auto, { action, clean: true, total: '10.00' })).toBe('human');
  });
  it('an N-class draft with a clean report routes auto under the default policy (it posts without a person)', () => {
    const st = buildSeedState();
    const qt = st.docs.find((d) => d.type === 'QT' && d.status === 'issued')!;
    const d = withFixedClock('2026-10-14T10:00:00+07:00', () => createDraft(st, V, 'QT', { header: { ...qt.header, documentDate: '2026-10-14' }, lines: qt.lines }, AGENT, 'auto-qt'));
    const r = reviewDraft(st, AGENT, d.id);
    expect(r.checks.filter((c) => c.severity !== 'info')).toEqual([]);
    expect(r.route).toBe('auto');
    void issue;
  });
});
