import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, BankLine } from '@/domain/types';
import { buildSeedState, type MockState } from '../store';
import { cancel, correctionReversal, reissue, revise } from './commands';
import { buildPlan } from './corrections';
import { checkInvariants } from './invariants';
import { derivedLocks } from './locks';
import type { MockError } from './log';
import { fromSatang, toSatang } from './money';
import { glBalance, ignore, linesOf, lockTo, match, post, suggest, unignore, unmatch } from './reconcile';
import { bankReconciliation } from './reports/bank-reconciliation';
import { assertBalanced } from './test-helpers';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const CO = 'co-vat', ACC = 'ba-kbank';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const err = (fn: () => unknown): MockError => { try { fn(); } catch (e) { return e as MockError; } throw new Error('expected a refusal'); };
const line = (id: string) => st.bankLines.find((l) => l.id === id)!;
const doc = (id: string) => st.docs.find((d) => d.id === id)!;
/** A statement line of the account the tests add by hand (balance is not used by the reconciliation). */
const addLine = (id: string, date: string, amount: string, accountId = ACC): string => {
  st.bankLines.push({ companyId: CO, id, accountId, importId: 'bi-001', date, description: 'ทดสอบ', amount, balance: '0.00', status: 'unmatched' });
  return id;
};
// seed: bi-001-003 = +6,955.00 on 5 Sep = rc-013 cash; bi-001-006 = +64,200 on 11 Sep = rc-012; bi-001-010 = +18,297 (17 Sep) = rc-011; bi-001-013 = +43,228 (23 Sep) = rc-010
const L013 = 'bi-001-003';

describe('suggestions', () => {
  it('lists the receipt of the same account with the exact cash within 7 days, and nothing else', () => {
    expect(suggest(st, CO, L013).map((c) => [c.docId, c.exact])).toEqual([['rc-013', true]]);
    expect(suggest(st, CO, 'bi-001-001')).toEqual([]); // -35,000: no payment voucher is that amount
  });
  it('a money-out line is suggested a payment voucher, never a receipt', () => {
    const id = addLine('x-out', '2026-10-14', '-22950.00');
    expect(suggest(st, CO, id).map((c) => c.docId)).toEqual(['pv-pay1']);
    expect(suggest(st, CO, addLine('x-in', '2026-10-14', '22950.00'))).toEqual([]);
  });
  it('is bounded by 7 days and ranks by nearest date, then number', () => {
    const near = addLine('x-near', '2026-09-12', '64200.00'); // rc-012 is 11 Sep (1 day); rc-034 (14 Apr) is far
    expect(suggest(st, CO, near).map((c) => c.docId)).toEqual(['rc-012']);
    const far = addLine('x-far', '2026-09-30', '6955.00'); // 25 days after rc-013
    expect(suggest(st, CO, far)).toEqual([]);
    // the search ignores the window and amount, ranks the exact ones first
    expect(suggest(st, CO, far, 'RC-202609-0001').map((c) => c.docId)).toEqual(['rc-013']);
    expect(suggest(st, CO, far, 'rc-2026').length).toBeGreaterThan(1);
  });
  it('lists only documents of the line\'s own account (ruling 1)', () => {
    st.docs.find((d) => d.id === 'rc-013')!.header = { ...doc('rc-013').header, bankAccountId: 'ba-scb' };
    expect(suggest(st, CO, L013)).toEqual([]);
    expect(suggest(st, CO, L013, 'RC-202609-0001')).toEqual([]);
  });
  it('a document already matched is not suggested again', () => {
    match(st, CO, L013, { docIds: ['rc-013'] }, ME);
    expect(suggest(st, CO, addLine('x-dup', '2026-09-05', '6955.00'))).toEqual([]);
  });
});

describe('match', () => {
  it('one line to one receipt: stores the share and the frozen document figures, status matched', () => {
    const l = match(st, CO, L013, { docIds: ['rc-013'] }, ME);
    expect(l).toMatchObject({ status: 'matched', matchedDocIds: ['rc-013'], matches: [{ docId: 'rc-013', type: 'RC', number: 'RC-202609-0001', amount: '6955.00', docCash: '6955.00', accountId: ACC, docDate: '2026-09-05' }] });
    expect(l.diff).toBeUndefined();
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a batch: several receipts for one line, Σ cash = the line', () => {
    const id = addLine('x-batch', '2026-09-20', '25252.00'); // 6,955 + 18,297
    const l = match(st, CO, id, { docIds: ['rc-013', 'rc-011'] }, ME);
    expect(l.matches!.map((m) => m.amount)).toEqual(['6955.00', '18297.00']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the sum rule: Σ matched cash + difference must equal the line, and the message shows both sides', () => {
    const id = addLine('x-bad', '2026-09-20', '25000.00');
    const e = err(() => match(st, CO, id, { docIds: ['rc-013', 'rc-011'] }, ME));
    expect(e.code).toBe('bank.match_amount');
    expect(e.title).toContain('25,252.00');
    expect(e.title).toContain('25,000.00');
    expect(line(id).status).toBe('unmatched');
    expect(st.bankJournals.filter((j) => j.kind === 'fee')).toHaveLength(0); // nothing written by a refused match
  });
  it('a bank fee: the line is the cash less the fee, a balanced journal Dr BankFee / Cr bank is written at the line date with postedAt', () => {
    const id = addLine('x-fee', '2026-09-05', '6930.00');
    const before = glBalance(st, CO, '1121', '2026-12-31');
    const l = match(st, CO, id, { docIds: ['rc-013'], diff: { role: 'BankFee', amount: '-25.00' } }, ME);
    expect(l.diff).toMatchObject({ role: 'BankFee', amount: '-25.00' });
    const j = st.bankJournals.find((x) => x.id === l.diff!.journalId)!;
    expect(j.entries).toHaveLength(1);
    const e = j.entries[0];
    expect(e.date).toBe('2026-09-05');
    expect(e.postedAt).toBeTruthy();
    expect(e.lines.map((g) => [g.accountCode, g.debit, g.credit, g.rule])).toEqual([['5200', '25.00', '0.00', 'ค่าธรรมเนียมจากการกระทบยอด'], ['1121', '0.00', '25.00', 'ค่าธรรมเนียมจากการกระทบยอด']]);
    expect(glBalance(st, CO, '1121', '2026-12-31') - before).toBe(-2500);
    expect(checkInvariants(st)).toEqual([]);
    assertBalanced(st);
  });
  it('a fee on a payment: the bank paid more than the voucher', () => {
    const id = addLine('x-payfee', '2026-10-14', '-22975.00');
    const l = match(st, CO, id, { docIds: ['pv-pay1'], diff: { role: 'BankFee', amount: '-25.00' } }, ME);
    expect(l.matches![0].amount).toBe('22950.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a fee must reduce the bank; a rounding difference may go either way', () => {
    expect(err(() => match(st, CO, addLine('x-pos', '2026-09-05', '6980.00'), { docIds: ['rc-013'], diff: { role: 'BankFee', amount: '25.00' } }, ME)).code).toBe('bank.match_diff');
    const up = match(st, CO, addLine('x-up', '2026-09-05', '6955.50'), { docIds: ['rc-013'], diff: { role: 'RoundingDifference', amount: '0.50' } }, ME);
    const e = st.bankJournals.find((x) => x.id === up.diff!.journalId)!.entries[0];
    expect(e.lines.map((g) => [g.accountCode, g.debit, g.credit])).toEqual([['5210', '0.00', '0.50'], ['1121', '0.50', '0.00']]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a difference in a closed month is refused (the existing date guard) and writes nothing', () => {
    const id = addLine('x-closed', '2026-06-05', '8214.00'); // rc-024 (22 Jun) cash 8,239 less 25
    const e = err(() => match(st, CO, id, { docIds: ['rc-024'], diff: { role: 'BankFee', amount: '-25.00' } }, ME));
    expect(e.code).toBe('period.closed');
    expect(line(id).status).toBe('unmatched');
    expect(st.bankJournals.filter((j) => j.kind === 'fee')).toHaveLength(0);
  });
  it('split: one receipt over several lines; fully matched only when the shares add up to its cash, never beyond', () => {
    const a = addLine('x-s1', '2026-09-11', '30000.00'), b = addLine('x-s2', '2026-09-12', '30000.00'), c = addLine('x-s3', '2026-09-13', '4200.00'), d = addLine('x-s4', '2026-09-14', '4201.00');
    match(st, CO, a, { docIds: ['rc-012'], amounts: { 'rc-012': '30000.00' } }, ME); // a share is said out loud
    expect(line(a).matches![0]).toMatchObject({ amount: '30000.00', docCash: '64200.00' });
    expect(suggest(st, CO, c).map((x) => x.docId)).toEqual([]); // not a whole-cash candidate any more
    expect(suggest(st, CO, c, 'RC-202609-0002').map((x) => [x.docId, x.remaining])).toEqual([['rc-012', '34200.00']]);
    match(st, CO, b, { docIds: ['rc-012'], amounts: { 'rc-012': '30000.00' } }, ME);
    const e = err(() => match(st, CO, d, { docIds: ['rc-012'], amounts: { 'rc-012': '4201.00' } }, ME)); // 4,200.00 is all that is left
    expect(e.code).toBe('bank.match_over');
    expect(e.title).toContain('4,200.00');
  });
  it('split completes at exactly its cash and the next line cannot take more', () => {
    const a = addLine('x-s1', '2026-09-11', '30000.00'), b = addLine('x-s2', '2026-09-12', '34200.00'), c = addLine('x-s3', '2026-09-13', '5.00');
    match(st, CO, a, { docIds: ['rc-012'], amounts: { 'rc-012': '30000.00' } }, ME);
    match(st, CO, b, { docIds: ['rc-012'] }, ME); // the remainder
    expect(st.bankLines.filter((l) => l.matches?.some((m) => m.docId === 'rc-012')).reduce((n, l) => n + toSatang(l.matches![0].amount), 0)).toBe(6420000);
    const e = err(() => match(st, CO, c, { docIds: ['rc-012'] }, ME));
    expect(e.code).toBe('bank.match_amount'); // nothing left: its share would be 0
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a bigger document picked by mistake is a mismatch, not a quiet partial match', () => {
    const e = err(() => match(st, CO, L013, { docIds: ['rc-012'] }, ME)); // 64,200 against a 6,955 line
    expect(e.code).toBe('bank.match_amount');
    expect(line(L013).status).toBe('unmatched');
  });
  it('a document is matched on its own account only (422 bank.match_account), and by direction', () => {
    st.docs.find((d) => d.id === 'rc-013')!.header = { ...doc('rc-013').header, bankAccountId: 'ba-scb' };
    const e = err(() => match(st, CO, L013, { docIds: ['rc-013'] }, ME));
    expect(e.code).toBe('bank.match_account');
    expect(line(L013).status).toBe('unmatched');
    expect(err(() => match(st, CO, 'bi-001-001', { docIds: ['pv-pay1'] }, ME)).code).toBe('bank.match_amount'); // right direction, wrong amount
    expect(err(() => match(st, CO, 'bi-001-001', { docIds: ['rc-013'] }, ME)).code).toBe('bank.match_direction');
  });
  it('a cash-box receipt resolves to the cash box, not the header bank (the FN1 rule)', () => {
    st.docs.find((d) => d.id === 'rc-013')!.header = { ...doc('rc-013').header, paymentMethod: 'cash' }; // header still names ba-kbank, but the cash goes to ba-cash
    expect(err(() => match(st, CO, L013, { docIds: ['rc-013'] }, ME)).code).toBe('bank.match_account');
  });
  it('a line that is not unmatched cannot be matched again; a cancelled receipt is not matchable', () => {
    match(st, CO, L013, { docIds: ['rc-013'] }, ME);
    expect(err(() => match(st, CO, L013, { docIds: ['rc-013'] }, ME)).code).toBe('bank.line_state');
    st.docs.find((d) => d.id === 'rc-012')!.status = 'cancelled';
    expect(err(() => match(st, CO, 'bi-001-006', { docIds: ['rc-012'] }, ME)).code).toBe('bank.match_doc_status');
  });
});

describe('unmatch, ignore and the posted line', () => {
  it('unmatch returns the line and the receipt to free, and reverses a fee journal exactly once on its own date', () => {
    const id = addLine('x-fee', '2026-09-05', '6930.00');
    const l = match(st, CO, id, { docIds: ['rc-013'], diff: { role: 'BankFee', amount: '-25.00' } }, ME);
    const gl = glBalance(st, CO, '1121', '2026-12-31');
    unmatch(st, CO, id, ME);
    expect(line(id)).toMatchObject({ status: 'unmatched' });
    expect(line(id).matches).toBeUndefined();
    const j = st.bankJournals.find((x) => x.id === l.diff!.journalId)!;
    expect(j.entries.map((e) => [e.kind, e.date])).toEqual([['original', '2026-09-05'], ['reversal', '2026-09-05']]);
    expect(glBalance(st, CO, '1121', '2026-12-31') - gl).toBe(2500);
    expect(err(() => unmatch(st, CO, id, ME)).code).toBe('bank.line_state'); // not matched any more: no second reversal
    expect(j.entries).toHaveLength(2);
    // matching again writes a NEW journal
    const again = match(st, CO, id, { docIds: ['rc-013'], diff: { role: 'BankFee', amount: '-25.00' } }, ME);
    expect(again.diff!.journalId).not.toBe(l.diff!.journalId);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('ignore and unignore; an ignored line is not an unmatched one', () => {
    ignore(st, CO, 'bi-001-001', ME, 'ซ้ำกับรายการอื่น');
    expect(line('bi-001-001')).toMatchObject({ status: 'ignored', note: 'ซ้ำกับรายการอื่น' });
    expect(err(() => match(st, CO, 'bi-001-001', { docIds: ['pv-pay1'] }, ME)).code).toBe('bank.line_state');
    unignore(st, CO, 'bi-001-001', ME);
    expect(line('bi-001-001').status).toBe('unmatched');
  });
  it('an inline journal: two balanced lines dated at the line, labelled, posted line is immutable', () => {
    const l = post(st, CO, 'bi-001-017', { accountCode: '5200', description: 'ค่าธรรมเนียมรายเดือน' }, ME); // the -25.00 fee line
    expect(l).toMatchObject({ status: 'posted' });
    const j = st.bankJournals.find((x) => x.id === l.journalId)!;
    expect(j.entries[0]).toMatchObject({ date: '2026-09-30', kind: 'original' });
    expect(j.entries[0].postedAt).toBeTruthy();
    expect(j.entries[0].lines.map((g) => [g.accountCode, g.debit, g.credit, g.rule])).toEqual([['1121', '0.00', '25.00', 'ค่าธรรมเนียมรายเดือน'], ['5200', '25.00', '0.00', 'ค่าธรรมเนียมรายเดือน']]);
    for (const f of [() => unmatch(st, CO, 'bi-001-017', ME), () => ignore(st, CO, 'bi-001-017', ME), () => unignore(st, CO, 'bi-001-017', ME), () => match(st, CO, 'bi-001-017', { docIds: ['pv-pay1'] }, ME), () => post(st, CO, 'bi-001-017', { accountCode: '5200' }, ME)]) {
      expect(err(f).code).toBe('bank.line_state');
    }
    const interest = post(st, CO, 'bi-001-018', { accountCode: '4200' }, ME); // +3.12 interest: Dr bank / Cr other income
    expect(st.bankJournals.find((x) => x.id === interest.journalId)!.entries[0].lines.map((g) => [g.accountCode, g.debit, g.credit])).toEqual([['1121', '3.12', '0.00'], ['4200', '0.00', '3.12']]);
    assertBalanced(st);
  });
  it('refuses VAT / WHT control accounts, AR / AP without a party, the bank itself, a closed month, and writes nothing', () => {
    const n = st.bankJournals.length;
    for (const code of ['1170', '2151', '1180', '2131', '2152', '5170']) expect(err(() => post(st, CO, 'bi-001-017', { accountCode: code }, ME)).code).toBe('ledger.control_account');
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '1130' }, ME)).code).toBe('ledger.party_required');
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '2110' }, ME)).code).toBe('ledger.party_required');
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '1130', partyId: 'pv-03' }, ME)).code).toBe('ledger.party_invalid'); // a vendor on a receivable
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '1121' }, ME)).code).toBe('bank.post_same_account');
    expect(err(() => post(st, CO, 'bi-001-017', { accountCode: '5000' }, ME)).code).toBe('ledger.account_invalid'); // a header, not postable
    expect(err(() => post(st, CO, addLine('x-jun', '2026-06-10', '-100.00'), { accountCode: '5200' }, ME)).code).toBe('period.closed');
    expect(st.bankJournals).toHaveLength(n);
    const ar = post(st, CO, 'bi-001-017', { accountCode: '1130', partyId: 'pc-01' }, ME); // with a customer it is allowed, and carried on the line
    expect(st.bankJournals.find((x) => x.id === ar.journalId)!.entries[0].lines[1]).toMatchObject({ accountCode: '1130', partyName: expect.any(String) });
  });
});

describe('the reconciliation lock on documents', () => {
  const matched = () => match(st, CO, L013, { docIds: ['rc-013'] }, ME);
  it('a matched receipt reads with the lock naming its exit and the bank line; unmatching removes it', () => {
    expect(derivedLocks(st, doc('rc-013')).some((l) => l.kind === 'reconciliation')).toBe(false);
    matched();
    const lock = derivedLocks(st, doc('rc-013')).find((l) => l.kind === 'reconciliation')!;
    expect(lock).toMatchObject({ exits: ['ยกเลิกการจับคู่'], href: `/finance/bank-accounts/${ACC}?line=${L013}` });
    expect(lock.reason).toBe('จับคู่กับรายการเดินบัญชี 5 ก.ย. 2569 6,955.00 แล้ว');
    unmatch(st, CO, L013, ME);
    expect(derivedLocks(st, doc('rc-013')).some((l) => l.kind === 'reconciliation')).toBe(false);
  });
  it('cancel and reissue of a matched document are refused (doc.reconciled), changing nothing; after unmatch they work', () => {
    matched();
    const d = doc('rc-013'), v = d.version, status = d.status;
    expect(err(() => cancel(st, 'rc-013', v, 'X', 'ทดสอบ', ME)).code).toBe('doc.reconciled');
    expect(err(() => reissue(st, 'rc-013', { header: d.header, lines: d.lines, allocations: d.allocations }, ME, 'ทดสอบ')).code).toBe('doc.reconciled');
    expect(doc('rc-013')).toMatchObject({ version: v, status });
    unmatch(st, CO, L013, ME);
    expect(cancel(st, 'rc-013', v, 'X', 'ทดสอบ', ME).status).toBe('cancelled');
  });
  it('a correction plan that would cancel the matched receipt is refused up front', () => {
    matched();
    const ti = st.docs.find((x) => x.id === doc('rc-013').allocations![0].targetId)!;
    const proposed = { header: ti.header, lines: ti.lines.map((l) => ({ ...l, description: `${l.description} (แก้)` })) }; // same total, new content: the invoice is reissued and its receipts cancelled
    expect(err(() => buildPlan(st, ti.id, proposed, 'accountant')).code).toBe('doc.reconciled');
  });
  it('a matched voucher: a revision that moves its cash, account or date is refused; any other header edit stays free', () => {
    match(st, CO, addLine('x-pv', '2026-10-13', '-5000.00'), { docIds: ['pv-gross'] }, ME);
    const d = doc('pv-gross'), body = (h: object, lines = d.lines) => ({ header: { ...d.header, ...h }, lines, allocations: d.allocations });
    expect(err(() => revise(st, d.id, body({ documentDate: '2026-10-12' }), d.version, 'x', ME)).code).toBe('doc.reconciled');
    expect(err(() => revise(st, d.id, body({ bankAccountId: 'ba-scb' }), d.version, 'x', ME)).code).toBe('doc.reconciled');
    expect(d.lines.length).toBeGreaterThan(0);
    expect(err(() => revise(st, d.id, body({}, d.lines.map((l) => ({ ...l, unitPrice: fromSatang(toSatang(l.unitPrice) + 10000) }))), d.version, 'x', ME)).code).toBe('doc.reconciled');
    const ok = revise(st, d.id, body({ reference: 'อ้างอิงใหม่' }), d.version, 'แก้อ้างอิง', ME);
    expect(ok.header.reference).toBe('อ้างอิงใหม่');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('the lock to a date', () => {
  it('refuses while a line up to the date is unmatched, then marks lines locked; the date only moves forward', () => {
    const e = err(() => lockTo(st, CO, ACC, '2026-09-05', ME));
    expect(e.code).toBe('bank.lock_unmatched');
    expect(e.title).toContain('3 รายการ'); // 2, 4 and 5 Sep
    ignore(st, CO, 'bi-001-001', ME); ignore(st, CO, 'bi-001-002', ME);
    match(st, CO, L013, { docIds: ['rc-013'] }, ME);
    lockTo(st, CO, ACC, '2026-09-05', ME);
    expect(linesOf(st, CO, ACC).filter((l) => l.locked).map((l) => l.id).sort()).toEqual(['bi-001-001', 'bi-001-002', 'bi-001-003']);
    expect(linesOf(st, CO, ACC).find((l) => l.id === 'bi-001-004')!.locked).toBeUndefined();
    expect(err(() => lockTo(st, CO, ACC, '2026-09-01', ME)).code).toBe('bank.lock_backwards');
    expect(err(() => lockTo(st, CO, ACC, '2026-12-31', ME)).code).toBe('bank.lock_date');
  });
  it('unmatching / unignoring a locked line needs a reason and is audited on the line and the document', () => {
    ignore(st, CO, 'bi-001-001', ME); ignore(st, CO, 'bi-001-002', ME);
    match(st, CO, L013, { docIds: ['rc-013'] }, ME);
    lockTo(st, CO, ACC, '2026-09-05', ME);
    expect(err(() => unmatch(st, CO, L013, ME)).code).toBe('bank.reason_required');
    expect(err(() => unmatch(st, CO, L013, ME, '   ')).code).toBe('bank.reason_required');
    expect(err(() => unignore(st, CO, 'bi-001-001', ME)).code).toBe('bank.reason_required');
    expect(line(L013).status).toBe('matched');
    const audits = st.audit.length;
    unmatch(st, CO, L013, ME, 'จับคู่ผิดใบ');
    expect(line(L013).status).toBe('unmatched');
    expect(st.activity.filter((a) => a.docId === 'rc-013' && a.action === 'bank.unmatch').at(-1)!.detail).toContain('จับคู่ผิดใบ');
    expect(st.activity.filter((a) => a.docId === L013 && a.action === 'bank.unmatch')).toHaveLength(1);
    expect(st.audit.length).toBe(audits + 1);
    expect(st.audit.at(-1)).toMatchObject({ command: 'bank.unmatch', target: L013, after: { reason: 'จับคู่ผิดใบ', locked: true } });
    unignore(st, CO, 'bi-001-001', ME, 'เปิดใหม่');
    expect(line('bi-001-001').status).toBe('unmatched');
  });
});

describe('the reconciliation identity (ruling 6)', () => {
  /** GL(bank) - Σ unmatched journal-side items = statement closing - Σ unmatched lines, computed here from the raw state, independently of the report. */
  const identity = (s: MockState, co: string, acct: string, to: string) => {
    const bank = s.bankAccounts.find((b) => b.id === acct)!;
    const gl = glBalance(s, co, bank.accountCode, to);
    let j = 0;
    for (const d of s.docs) {
      if (d.companyId !== co || (d.type !== 'RC' && d.type !== 'PV') || d.header.documentDate > to) continue;
      const cash = toSatang(d.totals.cash ?? '0.00');
      const live = d.status === 'issued';
      const used = (d.header.paymentMethod === 'cash' ? 'ba-cash' : d.header.bankAccountId) === acct;
      if (!live || !used) continue;
      const matchedSat = s.bankLines.filter((l) => l.date <= to).flatMap((l) => l.matches ?? []).filter((m) => m.docId === d.id).reduce((n, m) => n + toSatang(m.amount), 0);
      j += (d.type === 'RC' ? 1 : -1) * (cash - matchedSat);
    }
    const lines = s.bankLines.filter((l) => l.accountId === acct && l.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const closing = toSatang(lines.at(-1)!.balance);
    const u = lines.filter((l) => l.status === 'unmatched' || l.status === 'ignored').reduce((n, l) => n + toSatang(l.amount), 0);
    return { left: gl - j, right: closing - u };
  };
  it('holds on the seed after matching every suggestion, for both companies, and the report ties out to 0.00', () => {
    for (const [co, acct, to] of [[CO, ACC, '2026-09-30'], ['co-nonvat', 'nba-kbank', '2026-09-30']] as const) {
      let n = 0;
      for (const l of st.bankLines.filter((x) => x.companyId === co && x.accountId === acct)) {
        const s = suggest(st, co, l.id);
        if (s.length) { match(st, co, l.id, { docIds: [s[0].docId] }, ME); n++; }
      }
      expect(n).toBeGreaterThan(0);
      const { left, right } = identity(st, co, acct, to);
      expect(fromSatang(left)).toBe(fromSatang(right));
      expect(bankReconciliation(st, co, { account: acct, to }).tieOuts![0]).toMatchObject({ diff: '0.00' });
    }
    expect(checkInvariants(st)).toEqual([]);
  });
  it('holds before any matching too, and through fee, inline journals, ignore and an unmatched split', () => {
    expect(identity(st, CO, ACC, '2026-09-30').left).toBe(identity(st, CO, ACC, '2026-09-30').right);
    // the bank took 25.00 off receipt rc-013: the statement line and every later balance are 25.00 lower
    const imp = st.bankLines.filter((l) => l.importId === 'bi-001').sort((a, b) => a.id.localeCompare(b.id)), k = imp.findIndex((l) => l.id === L013);
    imp[k].amount = '6930.00';
    for (const l of imp.slice(k)) l.balance = fromSatang(toSatang(l.balance) - 2500);
    match(st, CO, L013, { docIds: ['rc-013'], diff: { role: 'BankFee', amount: '-25.00' } }, ME);
    post(st, CO, 'bi-001-017', { accountCode: '5200' }, ME);
    post(st, CO, 'bi-001-018', { accountCode: '4200' }, ME);
    ignore(st, CO, 'bi-001-001', ME);
    const s2 = suggest(st, CO, 'bi-001-006'); match(st, CO, 'bi-001-006', { docIds: [s2[0].docId] }, ME);
    const r = identity(st, CO, ACC, '2026-09-30');
    expect(r.left).toBe(r.right);
    expect(bankReconciliation(st, CO, { account: ACC, to: '2026-09-30' }).tieOuts![0].diff).toBe('0.00');
  });
  it('a missing opening balance shows as the gap in the report instead of being hidden', () => {
    st.bankJournals = st.bankJournals.filter((j) => !(j.kind === 'opening' && j.accountId === ACC));
    expect(bankReconciliation(st, CO, { account: ACC, to: '2026-09-30' }).tieOuts![0].diff).toBe('300000.00');
  });
});

describe('invariants catch what the commands forbid', () => {
  const matched = () => match(st, CO, L013, { docIds: ['rc-013'] }, ME);
  it('a changed cash, account or date on a matched document, a share over its cash, a broken line sum, an unbalanced journal', () => {
    const msgs = () => checkInvariants(st).join('\n');
    matched();
    expect(msgs()).toBe('');
    const d = doc('rc-013'), t = d.totals;
    d.totals = { ...t, cash: '6954.00' }; expect(msgs()).toMatch(/cash is now 6954.00 but it was matched at 6955.00/); d.totals = t;
    const h = d.header;
    d.header = { ...h, bankAccountId: 'ba-scb' }; expect(msgs()).toMatch(/was matched on ba-kbank/); d.header = h;
    d.header = { ...h, documentDate: '2026-09-06' }; expect(msgs()).toMatch(/dated 2026-09-06 but was matched at 2026-09-05/); d.header = h;
    const m = line(L013).matches![0].amount;
    line(L013).matches![0].amount = '6954.00'; expect(msgs()).toMatch(/is not the line amount/); line(L013).matches![0].amount = m;
    line(L013).matches![0].docCash = '6900.00'; line(L013).matches![0].amount = '6955.00'; expect(msgs()).toMatch(/matched for 6955.00 but its cash is|cash is now/); line(L013).matches![0].docCash = '6955.00';
    const id = addLine('x-over', '2026-09-30', '100.00');
    Object.assign(line(id), { status: 'matched', matches: [{ ...line(L013).matches![0], amount: '100.00' }] });
    expect(msgs()).toMatch(/matched for 7055.00 but its cash is 6955.00/);
    Object.assign(line(id), { status: 'unmatched' }); delete line(id).matches;
    post(st, CO, 'bi-001-017', { accountCode: '5200' }, ME);
    st.bankJournals.at(-1)!.entries[0].lines[0].credit = '24.00'; expect(msgs()).toMatch(/unbalanced/);
  });
  it('a stored reconciliation lock is rejected (derived at read only)', () => {
    doc('rc-013').locks = [{ kind: 'reconciliation', reason: 'x', exits: [] }];
    expect(checkInvariants(st).join()).toMatch(/stored reconciliation lock/);
  });
});

it('the line API shape hides the company and keeps matches', () => {
  match(st, CO, L013, { docIds: ['rc-013'] }, ME);
  const l = linesOf(st, CO, ACC).find((x) => x.id === L013) as BankLine & { companyId?: string };
  expect(l.companyId).toBeUndefined();
  expect(correctionReversal).toBeTypeOf('function');
});
