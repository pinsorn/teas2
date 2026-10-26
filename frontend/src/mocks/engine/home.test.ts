import { describe, expect, it } from 'vitest';
import { HOME_NEEDS } from '@/domain/home';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { USER } from '../fixtures/documents';
import { buildSeedState } from '../store';
import { approveAndIssue, createDraft, issue } from './commands';
import { approvalRequiredOf } from './approval';
import { checkInvariants } from './invariants';
import { glBalance } from './reconcile';
import { today, withFixedClock } from './log';
import { fromSatang, toSatang } from './money';
import { boxOf, getPp30 } from './filings/pp30';
import { apAging } from './reports/ap-aging';
import { arAging, openItems } from './reports/ar-aging';
import { numberGaps } from './reports/number-gaps';
import { homeAgent, homeAlerts, homeApprovals, homeBank, homeDeadlines, homeDrafts, homeKpis, homeOverdue } from './home';

const VAT = 'co-vat', NON = 'co-nonvat';
const total = (m: { rows: { kind: string; cells: Record<string, string> }[] }) => m.rows.find((r) => r.kind === 'total')?.cells.total ?? '0.00';
const acct = PERMISSIONS_BY_ROLE.accountant;
const approver = { ...USER, id: 'u-9', name: 'ผู้อนุมัติ ตัวอย่าง' };

describe('KPI strip: one source for every figure', () => {
  it('AR and AP are the RP2 aging totals at today, for both companies', () => {
    const st = buildSeedState();
    for (const co of [VAT, NON]) {
      const k = homeKpis(st, co, acct);
      expect(k.ar).toBe(total(arAging(st, co, { asOf: today() })));
      expect(k.ap).toBe(total(apAging(st, co, { asOf: today() })));
    }
  });
  it('the seed has an opening-balance receivable that counts in AR (a re-sum that skips OB would differ)', () => {
    const st = buildSeedState();
    const items = openItems(st, NON, 'AR', today());
    expect(items.some((i) => i.doc.type === 'OB' && i.out !== 0)).toBe(true);
    const withoutOb = items.filter((i) => i.doc.type !== 'OB').reduce((n, i) => n + i.out, 0);
    expect(toSatang(homeKpis(st, NON, acct).ar!)).not.toBe(withoutOb);
  });
  it('cash is the sum of the GL balances of the chart accounts whose subClass is cash or bank', () => {
    const st = buildSeedState();
    const codes = st.accounts.filter((a) => a.companyId === VAT && a.postable && ['cash', 'bank'].includes(a.subClass)).map((a) => a.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(homeKpis(st, VAT, acct).cash).toBe(fromSatang(codes.reduce((n, c) => n + glBalance(st, VAT, c, today()), 0)));
  });
  it('VAT this month = ภ.พ.30 output (box 5) - input (box 7) for a VAT company; absent (null) for a non-VAT one', () => {
    const st = buildSeedState();
    const boxes = getPp30(st, VAT, today().slice(0, 7)).boxes;
    expect(homeKpis(st, VAT, acct).vatThisMonth).toBe(fromSatang(boxOf(boxes, '5') - boxOf(boxes, '7')));
    expect(homeKpis(st, NON, acct).vatThisMonth).toBeNull();
  });
});

describe('each KPI tile is gated by the right of its own engine', () => {
  it('admin (report.arap.read + bank.read, no tax right) sees no VAT tile; a role with only report.arap.read sees no cash; no right = nothing', () => {
    const st = buildSeedState();
    const admin = homeKpis(st, VAT, PERMISSIONS_BY_ROLE.admin);
    expect(admin.vatThisMonth).toBeNull();
    expect(admin.ar).not.toBeNull();
    expect(admin.cash).not.toBeNull();
    const arOnly = homeKpis(st, VAT, ['report.arap.read']);
    expect(arOnly.cash).toBeNull();
    expect(arOnly.ar).not.toBeNull();
    expect(homeKpis(st, VAT, ['bank.read'])).toMatchObject({ ar: null, ap: null, vatThisMonth: null });
    expect(homeKpis(st, VAT, [])).toEqual({ cash: null, ar: null, ap: null, vatThisMonth: null });
  });
  it('the kpis section is shown exactly when some tile is visible (derived from the tile rights)', () => {
    expect(HOME_NEEDS.kpis([])).toBe(false);
    expect(HOME_NEEDS.kpis(['tax.read'])).toBe(false); // the VAT tile alone needs the preview right too
    expect(HOME_NEEDS.kpis(['tax.read', 'tax.filing.preview'], true)).toBe(true);
    expect(HOME_NEEDS.kpis(['tax.read', 'tax.filing.preview'], false)).toBe(false); // a non-VAT company has no VAT tile
    expect(HOME_NEEDS.kpis(['doc.TI.read'])).toBe(false);
    expect(HOME_NEEDS.kpis(PERMISSIONS_BY_ROLE.admin)).toBe(true);
  });
  it('the VAT tile needs tax.read AND (the preview right, or the month already filed): the register gate', () => {
    const st = buildSeedState();
    expect(homeKpis(st, VAT, ['tax.read']).vatThisMonth).toBeNull();
    expect(homeKpis(st, VAT, ['tax.read', 'tax.filing.preview']).vatThisMonth).not.toBeNull();
    expect(homeKpis(st, VAT, ['tax.filing.preview']).vatThisMonth).toBeNull();
  });
});

describe('approval inbox = the approval engine', () => {
  it('lists the pending documents the frozen policy wants approved, with requester and age from the trail', () => {
    const st = buildSeedState();
    const rows = homeApprovals(st, VAT, acct, approver).filter((r) => !r.reason);
    const pend = st.docs.filter((d) => d.companyId === VAT && d.status === 'pending');
    expect(pend.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.id).sort()).toEqual(pend.filter((d) => approvalRequiredOf(st, d, d.totals.total)).map((d) => d.id).sort());
    const r = rows[0], d = st.docs.find((x) => x.id === r.id)!;
    expect(r.requester).toBe(d.approval!.submittedBy.name);
    const days = Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${d.approval!.submittedAt.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
    expect(r.ageDays).toBe(Math.max(0, days));
    expect(r.version).toBe(d.version);
  });
  it('a role without doc.<T>.approve gets no pending row; it only sees agent drafts it may issue', () => {
    const st = buildSeedState();
    const rows = homeApprovals(st, VAT, PERMISSIONS_BY_ROLE.operator, approver);
    expect(rows.every((r) => r.reason === 'agent')).toBe(true);
    expect(homeApprovals(st, VAT, [], approver)).toEqual([]);
  });
  it('agent-created drafts (ti-002, ti-004) are rows with reason agent for whoever may read + issue them, never for someone who cannot issue', () => {
    const st = buildSeedState();
    const ids = homeApprovals(st, VAT, PERMISSIONS_BY_ROLE.operator, approver).filter((r) => r.reason === 'agent').map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['ti-002', 'ti-004']));
    for (const id of ['ti-002', 'ti-004']) expect(st.docs.find((d) => d.id === id)).toMatchObject({ status: 'draft', createdBy: { kind: 'agent' } });
    expect(homeApprovals(st, VAT, ['doc.TI.read'], approver).map((r) => r.id)).not.toContain('ti-002');
    expect(homeApprovals(st, VAT, ['doc.TI.issue'], approver).map((r) => r.id)).not.toContain('ti-002'); // read is needed too
    expect(homeApprovals(st, NON, PERMISSIONS_BY_ROLE.operator, approver).map((r) => r.id)).not.toContain('ti-002'); // company isolation
  });
  it('a pending document of a type the company cannot use, or one the user cannot read, is not listed', () => {
    const st = buildSeedState();
    const ex = st.docs.find((d) => d.companyId === VAT && d.status === 'pending')!;
    expect(homeApprovals(st, VAT, acct.filter((p) => p !== `doc.${ex.type}.read`), approver).map((r) => r.id)).not.toContain(ex.id);
  });
  it('self-approval off (frozen policy): the requester does not get their own document in the inbox', () => {
    const st = buildSeedState();
    const pend = st.docs.find((d) => d.companyId === VAT && d.status === 'pending')!;
    pend.policy = { enabled: true, selfApproval: false };
    pend.approval = { ...pend.approval!, submittedBy: USER };
    expect(homeApprovals(st, VAT, acct, USER).map((r) => r.id)).not.toContain(pend.id);
    expect(homeApprovals(st, VAT, acct, approver).map((r) => r.id)).toContain(pend.id);
  });
  it('approve-and-issue (the document page command) allocates a number once; a second call is refused and the row is gone', () => {
    const st = buildSeedState();
    const row = homeApprovals(st, VAT, acct, approver).find((r) => !r.reason)!;
    expect(row).toBeDefined();
    const done = approveAndIssue(st, row.id, row.version, approver);
    expect(done.number).toBeTruthy();
    expect(() => approveAndIssue(st, row.id, row.version, approver)).toThrow();
    expect(st.docs.filter((d) => d.number === done.number)).toHaveLength(1);
    expect(homeApprovals(st, VAT, acct, approver).map((r) => r.id)).not.toContain(row.id);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('the other sections come from their engines', () => {
  it('drafts, overdue (TI / IV / PB / EX only), deadlines, bank lines and the agent digest are read from stored data', () => {
    const st = buildSeedState();
    const mineDrafts = homeDrafts(st, VAT, acct, USER);
    expect(mineDrafts.length).toBeGreaterThan(0);
    expect(mineDrafts.every((d) => d.status === 'draft' && !d.createdByAgent)).toBe(true);
    expect(homeDrafts(st, VAT, acct, approver)).toEqual([]); // another user's drafts are not mine
    expect(homeApprovals(st, VAT, acct, approver).map((r) => r.id)).toEqual(expect.arrayContaining(['ti-002', 'ti-004'])); // agent drafts: the inbox only
    for (const d of homeOverdue(st, VAT, acct)) {
      expect(['TI', 'IV', 'PB', 'EX']).toContain(d.type);
      expect(toSatang(d.outstanding ?? '0.00')).toBeGreaterThan(0);
      expect(d.dueDate! < today()).toBe(true);
    }
    expect(homeBank(st, VAT)).toBe(st.bankLines.filter((l) => l.companyId === VAT && l.status === 'unmatched').length);
    expect(homeDeadlines(st, NON).some((x) => x.form.startsWith('ภ.พ.30'))).toBe(false);
  });
  it('deadlines: only the periods after the latest finalized one of each form (the seed lists the September returns, not 20 old months)', () => {
    const st = buildSeedState();
    expect(homeDeadlines(st, VAT)).toEqual([
      { form: 'ภ.ง.ด.1 ก.ย. 2569', due: '2026-10-07' }, { form: 'ภ.พ.30 ก.ย. 2569', due: '2026-10-15' }, { form: 'สปส.1-10 ก.ย. 2569', due: '2026-10-15' }]);
    expect(homeDeadlines(st, NON)).toEqual([{ form: 'ภ.ง.ด.1 ก.ย. 2569', due: '2026-10-07' }, { form: 'สปส.1-10 ก.ย. 2569', due: '2026-10-15' }]);
  });
  it('deadlines: an unfinalized owed month (August) shows even though later months are filed; overdue first', () => {
    const st = buildSeedState();
    const before = homeDeadlines(st, VAT);
    st.filings = st.filings.filter((f) => !(f.companyId === VAT && f.form === 'PP30' && f.period === '2026-08'));
    const after = homeDeadlines(st, VAT);
    const aug = after.find((x) => x.form === 'ภ.พ.30 ส.ค. 2569');
    expect(aug).toEqual({ form: 'ภ.พ.30 ส.ค. 2569', due: '2026-09-15' });
    expect(before.some((x) => x.form === 'ภ.พ.30 ส.ค. 2569')).toBe(false);
    const due = after.map((x) => x.due);
    expect(due.filter((d) => d < today())).toEqual(due.slice(0, due.filter((d) => d < today()).length)); // overdue before not yet due
  });
  it('agent digest: posted = agent documents ISSUED today (Bangkok date, no pinned clock), waiting = agent drafts + pending', () => {
    const st = buildSeedState();
    const base = homeAgent(st, VAT, acct);
    const agent = { kind: 'agent' as const, id: 'ag-1', name: 'ผู้ช่วย AI', ownerName: 'สมศรี' };
    const mk = (n: string) => createDraft(st, VAT, 'TI', { header: { partyId: 'pc-01', documentDate: today() }, lines: [{ id: n, description: 'งานทดสอบ', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'S7' }] }, agent, n);
    const drafted = mk('ag-d1'), issuedNow = mk('ag-d2'), issuedBefore = mk('ag-d3');
    issue(st, issuedNow.id, issuedNow.version, agent); // the real clock, nothing pinned
    withFixedClock('2026-10-01T10:00:00+07:00', () => issue(st, issuedBefore.id, issuedBefore.version, agent));
    const a = homeAgent(st, VAT, acct);
    expect(a.posted).toBe(base.posted + 1); // only the one issued today
    expect(a.waiting).toBe(base.waiting + 1); // the new draft
    expect(drafted.status).toBe('draft');
  });
  it('agent digest: 00:30 Bangkok counts as that Bangkok day (a UTC slice would call it the day before)', () => {
    const st = buildSeedState();
    const agent = { kind: 'agent' as const, id: 'ag-1', name: 'ผู้ช่วย AI', ownerName: 'สมศรี' };
    const d = createDraft(st, VAT, 'TI', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [{ id: 'm1', description: 'งานทดสอบ', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'S7' }] }, agent, 'ag-m1');
    const early = '2026-10-14T00:30:00+07:00'; // = 2026-10-13T17:30Z
    const base = withFixedClock(early, () => homeAgent(st, VAT, acct).posted);
    withFixedClock(early, () => issue(st, d.id, d.version, agent));
    expect(withFixedClock(early, () => homeAgent(st, VAT, acct).posted)).toBe(base + 1);
    expect(withFixedClock('2026-10-15T00:30:00+07:00', () => homeAgent(st, VAT, acct).posted)).toBe(base); // the next Bangkok day
  });
});

describe('alerts reuse their engines', () => {
  it('incomplete PB is counted; number problems agree with the RP3 report; no right = no alert', () => {
    const st = buildSeedState();
    const all = homeAlerts(st, VAT, [...acct, 'audit.read', 'doc.DP.read']);
    expect(all.find((a) => a.code === 'pb_incomplete')?.count).toBe(st.docs.filter((d) => d.companyId === VAT && d.type === 'PB' && d.header.complete === false && ['issued', 'partly_settled', 'settled'].includes(d.status)).length);
    const bad = numberGaps(st, VAT, { onlyProblems: 'true' }).rows.filter((r) => r.level === 0 && r.kind === 'group').length;
    expect(all.some((a) => a.code === 'number_gaps' || a.code === 'number_duplicates')).toBe(bad > 0);
    expect(homeAlerts(st, VAT, [])).toEqual([]);
  });
  it('the VAT threshold alert is for the non-VAT company only, and only from the warning level', () => {
    const st = buildSeedState();
    expect(homeAlerts(st, VAT, ['tax.read']).some((a) => a.code === 'vat_threshold')).toBe(false);
    for (const a of homeAlerts(st, NON, ['tax.read']).filter((x) => x.code === 'vat_threshold')) expect(['warning', 'danger']).toContain(a.severity);
  });
  it('a draft older than 30 days is an alert', () => {
    const st = buildSeedState();
    const d = st.docs.find((x) => x.companyId === VAT && x.status === 'draft' && x.type === 'TI')!;
    d.header = { ...d.header, documentDate: '2026-08-01' };
    expect(homeAlerts(st, VAT, ['doc.TI.create']).find((a) => a.code === 'old_drafts')?.count).toBeGreaterThanOrEqual(1);
  });
});
