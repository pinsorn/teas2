import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { createDraft, issue, revise } from './commands';
import { checkInvariants } from './invariants';
import type { MockError } from './log';
import { match, reverseTransfer, suggest, transfer, unmatch } from './reconcile';
import { bankReconciliation } from './reports/bank-reconciliation';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat';
let st: MockState, n = 0;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });
const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const tie = (to = '2026-10-15') => bankReconciliation(st, CO, { account: 'ba-kbank', to }).tieOuts![0].diff;
const closeSep = () => { const p = st.periods.find((x) => x.companyId === CO && x.month === '2026-09')!; p.status = 'closed'; (p as { closedAt?: string }).closedAt = '2026-10-10T09:00:00+07:00'; };
const ents = (id: string) => st.journals.find((j) => j.docId === id)!.preview.entries;
const L = (price: string): DocLine => ({ id: 'g', description: 'x', qty: '1', unit: 'u', unitPrice: price, taxCode: 'S7', expenseCategory: 'supplies' } as DocLine);

/** A voucher dated 20 Aug on ba-kbank, issued while the account had no imports (so it exists before the go-live of 1 Sep). */
const oldVoucher = (): string => {
  const imps = st.bankImports; st.bankImports = [];
  const k = () => `k${++n}`;
  const b = createDraft(st, CO, 'PB', { header: { partyId: 'pv-03', documentDate: '2026-08-20' }, lines: [L('1000.00')] }, ME, k());
  issue(st, b.id, b.version, ME);
  const d = createDraft(st, CO, 'PV', { header: { partyId: 'pv-03', documentDate: '2026-08-20', bankAccountId: 'ba-kbank' }, lines: [], allocations: [{ targetId: b.id, targetType: 'PB', amount: '1070.00' }] }, ME, k());
  issue(st, d.id, d.version, ME);
  st.bankImports = imps;
  return d.id;
};
const notesRevise = (id: string) => { const d = st.docs.find((x) => x.id === id)!; revise(st, id, { header: { ...d.header, notes: 'n' }, lines: d.lines, allocations: d.allocations }, d.version, 'r', ME); };
const kLine = (amount: string) => { st.bankLines.push({ companyId: CO, id: 'kx', accountId: 'ba-kbank', importId: 'bi-001', date: '2026-10-15', description: 'kb', amount, balance: '0.00', status: 'unmatched' }); return 'kx'; };

describe('R2-1: the bank-GL entry date is the later of go-live and the first open date', () => {
  it('F: the go-live month is closed -> a notes-only re-post of a pre-go-live voucher lands in an open month; invariants []', () => {
    const id = oldVoucher();
    closeSep();
    notesRevise(id);
    const es = ents(id);
    for (const e of es.slice(1)) { expect(e.date >= '2026-10-01').toBe(true); expect(e.late).toBe(true); }
    expect(checkInvariants(st)).toEqual([]);
  });
  it('with the go-live month open the entries land on the go-live date (unchanged)', () => {
    const id = oldVoucher();
    notesRevise(id);
    expect(ents(id).slice(1).map((e) => e.date)).toEqual(['2026-09-01', '2026-09-01']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a transfer reversal with the go-live month closed also lands in an open month', () => {
    transfer(st, CO, 'bi-001-001', 'ba-scb', ME);
    const j = st.bankJournals.find((x) => x.kind === 'transfer')!;
    unmatch(st, CO, 'bi-001-001', ME);
    closeSep();
    st.periods.find((x) => x.companyId === CO && x.month === '2026-09')!.closedAt = '2099-01-01T00:00:00+07:00'; // closed after the journal was posted
    reverseTransfer(st, CO, j.id, ME, 'ผิดบัญชี');
    expect(j.entries[1].date >= '2026-10-01').toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('R2-m1: an old document is matchable only by its net post-go-live bank effect', () => {
  it('a notes-only re-post whose entries cancel out leaves it unmatchable, as before', () => {
    const id = oldVoucher();
    const before = st.docs.find((x) => x.id === id)!;
    const line = kLine(`-${before.totals.cash}`);
    expect(err(() => match(st, CO, line, { docIds: [id] }, ME)).code).toBe('bank.match_history');
    notesRevise(id);
    const d = st.docs.find((x) => x.id === id)!;
    expect(suggest(st, CO, line, d.number).map((c) => c.docId)).not.toContain(id);
    expect(err(() => match(st, CO, line, { docIds: [id] }, ME)).code).toBe('bank.match_history');
    expect(tie()).toBe(tie());
  });
  it('a new document is unaffected', () => {
    expect(suggest(st, CO, 'bi-001-003').map((c) => c.docId)).toEqual(['rc-013']);
  });
});

describe('R2-m2: reversing a transfer writes an activity entry on both lines', () => {
  it('with the reason', () => {
    transfer(st, CO, 'bi-001-001', 'ba-scb', ME);
    const date = st.bankLines.find((l) => l.id === 'bi-001-001')!.date;
    st.bankLines.push({ companyId: CO, id: 's1', accountId: 'ba-scb', importId: 'x', date, description: 'scb', amount: '35000.00', balance: '35000.00', status: 'unmatched' });
    transfer(st, CO, 's1', 'ba-kbank', ME);
    const j = st.bankJournals.find((x) => x.kind === 'transfer')!;
    unmatch(st, CO, 's1', ME); unmatch(st, CO, 'bi-001-001', ME);
    reverseTransfer(st, CO, j.id, ME, 'ผิดบัญชี');
    for (const id of ['bi-001-001', 's1']) expect(st.activity.some((a) => a.docId === id && a.action === 'bank.transfer_reverse' && (a.detail ?? '').includes('ผิดบัญชี'))).toBe(true);
  });
});
