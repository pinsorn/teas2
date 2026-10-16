import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { cancel, createDraft, issue } from './commands';
import { checkInvariants } from './invariants';
import type { MockError } from './log';
import { fromSatang } from './money';
import { glBalance, match, post, reverseTransfer, transfer, unmatch } from './reconcile';
import { bankReconciliation } from './reports/bank-reconciliation';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });
const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const tie = (acc: string, to = '2026-10-15') => bankReconciliation(st, CO, { account: acc, to }).tieOuts![0].diff;
const scbLine = (id: string, date: string, amount: string) => { st.bankLines.push({ companyId: CO, id, accountId: 'ba-scb', importId: 'x', date, description: 'scb', amount, balance: amount, status: 'unmatched' }); return id; };
const OUT = 'bi-001-001';
const date = () => st.bankLines.find((l) => l.id === OUT)!.date;

describe('R1-1: a transfer is never posted twice', () => {
  it('C2: transfer from the other side attaches to the open journal; GL 1122 moves 35,000 once', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    const s = scbLine('s1', date(), '35000.00');
    const l = transfer(st, CO, s, 'ba-kbank', ME);
    expect(l.status).toBe('matched');
    expect(st.bankJournals.filter((j) => j.kind === 'transfer')).toHaveLength(1);
    expect(fromSatang(glBalance(st, CO, '1122', '2026-12-31'))).toBe('35000.00');
    expect(l.transfer).toMatchObject({ side: 'in' });
    expect(tie('ba-kbank')).toBe('0.00');
    expect(tie('ba-scb')).toBe('0.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('two open journals that cover the line: refused, naming them; nothing is written', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    st.bankLines.push({ companyId: CO, id: 'k2', accountId: 'ba-kbank', importId: 'bi-001', date: date(), description: 'x', amount: '-35000.00', balance: '0.00', status: 'unmatched' });
    transfer(st, CO, 'k2', 'ba-scb', ME);
    const n = st.bankJournals.length;
    const e = err(() => transfer(st, CO, scbLine('s1', date(), '35000.00'), 'ba-kbank', ME));
    expect(e.code).toBe('bank.transfer_ambiguous');
    for (const j of st.bankJournals.filter((x) => x.kind === 'transfer')) expect(e.title).toContain(j.id);
    expect(st.bankJournals).toHaveLength(n);
  });
  it('a different amount or a far date posts its own journal as before', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    transfer(st, CO, scbLine('s2', date(), '100.00'), 'ba-kbank', ME);
    expect(st.bankJournals.filter((j) => j.kind === 'transfer')).toHaveLength(2);
  });
  it('the exit of a mis-targeted transfer: unmatch, reverse (reason required, audited), transfer again', () => {
    transfer(st, CO, OUT, 'ba-scb', ME);
    const j = st.bankJournals.find((x) => x.kind === 'transfer')!;
    expect(err(() => reverseTransfer(st, CO, j.id, ME, '  ')).code).toBe('bank.reason_required');
    unmatch(st, CO, OUT, ME);
    reverseTransfer(st, CO, j.id, ME, 'ผิดบัญชี');
    expect(st.audit.some((a) => a.command === 'bank.transfer_reverse' && JSON.stringify(a).includes('ผิดบัญชี'))).toBe(true);
    st.bankAccounts.push({ id: 'ba-x', companyId: CO, kind: 'bank', bankName: 'bbl', nameTh: 'x', accountNo: '1-2', accountCode: '1123' });
    expect(transfer(st, CO, OUT, 'ba-x', ME).status).toBe('matched');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('R1-2: entries, not documents, from the go-live', () => {
  it('P: cancelling a pre-go-live receipt leaves an explained row and ties at 0.00', () => {
    const rc = st.docs.find((d) => d.id === 'rc-014')!;
    expect(rc.header.documentDate < '2026-09-01').toBe(true);
    cancel(st, rc.id, rc.version, 'OTHER', 'x', ME);
    const r = bankReconciliation(st, CO, { account: 'ba-kbank', to: '2026-10-15' });
    const row = r.rows.find((x) => x.cells.item?.includes(rc.number!));
    expect(row?.cells.amount).toBe(`-${rc.totals.cash}`);
    expect(r.tieOuts![0].diff).toBe('0.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a correction of a pre-go-live receipt posts its bank-side entry on the go-live date, late', () => {
    const rc = st.docs.find((d) => d.id === 'rc-014')!;
    cancel(st, rc.id, rc.version, 'OTHER', 'x', ME, { correction: true });
    const es = st.journals.find((j) => j.docId === rc.id)!.preview.entries;
    expect(es.at(-1)).toMatchObject({ kind: 'reversal', date: '2026-09-01', late: true });
    expect(tie('ba-kbank')).toBe('0.00');
    expect(bankReconciliation(st, CO, { account: 'ba-kbank', to: '2026-10-15' }).rows.some((x) => x.cells.item?.includes(rc.number!))).toBe(true);
  });
  it('a new receipt whose bank entry would fall before the go-live is refused 422 bank.before_go_live', () => {
    const d = createDraft(st, 'co-nonvat', 'RC', { header: { partyId: 'nc-04', documentDate: '2026-08-20', bankAccountId: 'nba-kbank' }, lines: [{ id: 'l1', description: 'x', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'EX' }] }, ME, 'k-golive');
    const e = err(() => issue(st, d.id, d.version, ME));
    expect(e.status).toBe(422);
    expect(e.code).toBe('bank.before_go_live');
  });
});

describe('R1-m1: document-owned accounts are not for an inline journal', () => {
  it.each(['4100', '4110', '4120', '1210', '1211', '1220', '1221'])('%s is refused', (code) => {
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: code }, ME)).code).toBe('ledger.control_account');
  });
  it.each(['4200', '4210', '5110', '5200'])('%s stays allowed', (code) => {
    expect(post(st, CO, 'bi-001-017', { accountCode: code }, ME).status).toBe('posted');
  });
  void match;
});
