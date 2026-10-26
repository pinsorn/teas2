import { describe, expect, it } from 'vitest';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { USER } from '../fixtures/documents';
import { buildSeedState } from '../store';
import { approveAndIssue } from './commands';
import { approvalRequiredOf } from './approval';
import { checkInvariants } from './invariants';
import { glBalance } from './reconcile';
import { today } from './log';
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
      const k = homeKpis(st, co);
      expect(k.ar).toBe(total(arAging(st, co, { asOf: today() })));
      expect(k.ap).toBe(total(apAging(st, co, { asOf: today() })));
    }
  });
  it('the seed has an opening-balance receivable that counts in AR (a re-sum that skips OB would differ)', () => {
    const st = buildSeedState();
    const items = openItems(st, NON, 'AR', today());
    expect(items.some((i) => i.doc.type === 'OB' && i.out !== 0)).toBe(true);
    const withoutOb = items.filter((i) => i.doc.type !== 'OB').reduce((n, i) => n + i.out, 0);
    expect(toSatang(homeKpis(st, NON).ar)).not.toBe(withoutOb);
  });
  it('cash is the sum of the bank / cash GL accounts from the journal', () => {
    const st = buildSeedState();
    const codes = [...new Set(st.bankAccounts.filter((b) => b.companyId === VAT).map((b) => b.accountCode))];
    expect(codes.length).toBeGreaterThan(0);
    expect(homeKpis(st, VAT).cash).toBe(fromSatang(codes.reduce((n, c) => n + glBalance(st, VAT, c, today()), 0)));
  });
  it('VAT this month = ภ.พ.30 output (box 5) - input (box 7) for a VAT company; absent (null) for a non-VAT one', () => {
    const st = buildSeedState();
    const boxes = getPp30(st, VAT, today().slice(0, 7)).boxes;
    expect(homeKpis(st, VAT).vatThisMonth).toBe(fromSatang(boxOf(boxes, '5') - boxOf(boxes, '7')));
    expect(homeKpis(st, NON).vatThisMonth).toBeNull();
  });
});

describe('approval inbox = the approval engine', () => {
  it('lists the pending documents the frozen policy wants approved, with requester and age from the trail', () => {
    const st = buildSeedState();
    const rows = homeApprovals(st, VAT, acct, approver);
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
  it('a role without doc.<T>.approve gets no row at all', () => {
    const st = buildSeedState();
    expect(homeApprovals(st, VAT, PERMISSIONS_BY_ROLE.operator, approver)).toEqual([]);
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
    const row = homeApprovals(st, VAT, acct, approver)[0];
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
    expect(homeDrafts(st, VAT, acct).every((d) => d.status === 'draft')).toBe(true);
    for (const d of homeOverdue(st, VAT, acct)) {
      expect(['TI', 'IV', 'PB', 'EX']).toContain(d.type);
      expect(toSatang(d.outstanding ?? '0.00')).toBeGreaterThan(0);
      expect(d.dueDate! < today()).toBe(true);
    }
    expect(homeBank(st, VAT)).toBe(st.bankLines.filter((l) => l.companyId === VAT && l.status === 'unmatched').length);
    expect(homeDeadlines(st, NON).some((x) => x.form === 'ภ.พ.30')).toBe(false);
    const a = homeAgent(st, VAT, acct);
    const mine = st.docs.filter((d) => d.companyId === VAT && d.createdBy.kind === 'agent' && !['cancelled', 'replaced'].includes(d.status));
    expect(a.posted).toBe(mine.filter((d) => d.status !== 'draft').length);
    expect(a.waiting).toBe(mine.filter((d) => d.status === 'draft').length);
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
