import { beforeEach, describe, expect, it } from 'vitest';
import type { FilingBox } from '@/domain/filings';
import { USER as me } from '../../fixtures/documents';
import { seed, type MockState } from '../../store';
import { checkInvariants } from '../invariants';
import { generalJournal } from '../journal';
import { toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { createDraft, issue } from '../commands';
import { importStatement, utf8Base64 } from '../bank-import';
import { controlExit, glBalance, payTax, reverseTaxPayment, taxPaymentLines } from '../reconcile';
import { KBIZ_OCT_NAME, kbizCsv } from '../../fixtures/statements/kbiz-2026-10.csv';
import { KBANK_ACCOUNT_NO, KBANK_SEP_CLOSING, withBalances } from '../../fixtures/statements/kplus-2026-09';
import { pp36Model } from './pp36';
import { formName } from './pnd-wht';
import { filingHistory, finalizeFiling, getFiling } from './index';
import { glMovement, pp30Boxes, pp30Model, pp30Net, pp30Netting, type Filing } from './pp30';
import { taxDueOf } from './payment';

// TX2c: a finalized ภ.พ.30 closes its VAT into "VAT payable" / "VAT carried forward" on the finalize day; a return is paid by a bank line (Dr its payable / Cr bank).
const CO = 'co-vat';
let st: MockState;
beforeEach(() => { st = seed(); });
const sat = (m: string) => toSatang(m);
const box = (code: string, amount: string): FilingBox => ({ code, labelTh: code, amount });
const boxes = (b5: string, b7: string, b10: string): FilingBox[] => [box('5', b5), box('7', b7), box('10', b10)];
const rows = (b5: string, b7: string, b10: string) => pp30Netting(st, CO, '2026-09', boxes(b5, b7, b10), '2026-10-14').flatMap((e) => e.lines.map((l) => [l.accountCode, l.debit, l.credit]));

describe('2.2 the netting entry (money formula)', () => {
  it.each([
    ['payable', '1000.00', '300.00', '0.00', [['2151', '1000.00', '0.00'], ['1170', '0.00', '300.00'], ['2154', '0.00', '700.00']], '700.00'],
    ['payable after a carry brought in', '1000.00', '300.00', '200.00', [['2151', '1000.00', '0.00'], ['1170', '0.00', '300.00'], ['1172', '0.00', '200.00'], ['2154', '0.00', '500.00']], '500.00'],
    ['excess carried forward', '100.00', '400.00', '0.00', [['2151', '100.00', '0.00'], ['1170', '0.00', '400.00'], ['1172', '300.00', '0.00']], '-300.00'],
    ['carry used and a new excess: two separate 1172 lines', '0.00', '50.00', '100.00', [['1170', '0.00', '50.00'], ['1172', '0.00', '100.00'], ['1172', '150.00', '0.00']], '-150.00'],
    ['a credit-note month', '-70.00', '0.00', '0.00', [['2151', '0.00', '70.00'], ['1172', '70.00', '0.00']], '-70.00'],
  ] as const)('%s', (_n, b5, b7, b10, want, net) => {
    const got = rows(b5, b7, b10);
    expect(got).toEqual(want);
    expect(got.reduce((n, [, d, c]) => n + sat(d as string) - sat(c as string), 0)).toBe(0); // balanced
    expect(pp30Net(boxes(b5, b7, b10))).toBe(sat(net));
  });
  it('nothing to close: no entry', () => expect(pp30Netting(st, CO, '2026-09', boxes('0.00', '0.00', '0.00'), '2026-10-14')).toEqual([]));
  it('the rule names the box and the month', () => {
    const l = pp30Netting(st, CO, '2026-09', boxes('1000.00', '300.00', '0.00'), '2026-10-14')[0].lines;
    expect(l[2].rule).toContain('ภ.พ.30 เดือน ก.ย. 2569 ช่อง 11');
  });
});

describe('TX4 the payment cap is the net payable box (11), not box 8 (the month own tax)', () => {
  it('a carry brought in lowers what is paid: box 8 = 70.00, box 10 = 20.00, pay 50.00', () => {
    const f = { form: 'PP30', boxes: pp30Boxes([{ id: 'o', kind: 'out', type: 'TI', date: '2026-09-01', description: '', state: 'live', base7: '0.00', base0: '0.00', baseEx: '0.00', vat: '100.00' }, { id: 'i', kind: 'in', type: 'PB', date: '2026-09-01', description: '', state: 'live', base7: '0.00', base0: '0.00', baseEx: '0.00', vat: '30.00' }], sat('20.00'), 0, '2026-09') } as Filing;
    expect(taxDueOf(f)).toBe(sat('50.00'));
  });
});

describe('2.3 finalize posts the netting', () => {
  it('the two seeded ภ.พ.30 carry their entry, dated the day each was filed; the invariants hold', () => {
    for (const [period, date] of [['2026-07', '2026-08-14'], ['2026-08', '2026-09-14']]) {
      const f = st.filings.find((x) => x.form === 'PP30' && x.period === period)!;
      expect(f.journal).toHaveLength(1);
      const e = f.journal![0], at = (c: string) => e.lines.filter((l) => l.accountCode === c);
      expect(e.date).toBe(date);
      const b = (c: string) => sat(f.boxes.find((x) => x.code === c)!.amount);
      expect(at('2151').reduce((n, l) => n + sat(l.debit), 0)).toBe(b('5'));
      expect(at('1170').reduce((n, l) => n + sat(l.credit), 0)).toBe(b('7'));
      expect(at('2154').reduce((n, l) => n + sat(l.credit), 0)).toBe(b('11'));
    }
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the tie-outs stay 0.00: the netting is never VAT of a month', () => {
    for (const p of ['2026-07', '2026-08', '2026-09', '2026-10']) for (const t of getFiling(st, CO, 'PP30', p).tieOuts) if (t.labelKey.endsWith('Gl')) expect(t.diff, `${p} ${t.labelKey}`).toBe('0.00');
    // 2026-09 finalizes on the anchor day (2026-10-14): its netting lands in October, and October's draft still ties
    finalizeFiling(st, CO, 'PP30', '2026-09', pp30Model(st, CO, '2026-09').version, me);
    expect(st.filings.find((f) => f.form === 'PP30' && f.period === '2026-09')!.journal![0].date).toBe('2026-10-14');
    for (const t of getFiling(st, CO, 'PP30', '2026-10').tieOuts) if (t.labelKey.endsWith('Gl')) expect(t.diff, t.labelKey).toBe('0.00');
    expect(glMovement(st, CO, '2151', '2026-10')).toBe(sat(getFiling(st, CO, 'PP30', '2026-10').boxes.find((b) => b.code === '5')!.amount));
    expect(checkInvariants(st)).toEqual([]);
  });
  it('refuses while the day it would post on is in a closed month; the exit works', () => {
    const p = st.periods.find((x) => x.companyId === CO && x.month === '2026-10') ?? (st.periods.push({ companyId: CO, month: '2026-10', status: 'open' }), st.periods.at(-1)!);
    p.status = 'closed'; p.closedAt = '2026-10-14T00:00:00.000Z';
    let code = '', title = '';
    try { finalizeFiling(st, CO, 'PP30', '2026-09', pp30Model(st, CO, '2026-09').version, me); } catch (e) { code = (e as { code: string }).code; title = (e as { title: string }).title; }
    expect(code).toBe('period.closed');
    expect(title).toContain('เปิดงวดบัญชีอีกครั้ง');
    expect(st.filings.some((f) => f.form === 'PP30' && f.period === '2026-09')).toBe(false);
    p.status = 'open';
    finalizeFiling(st, CO, 'PP30', '2026-09', pp30Model(st, CO, '2026-09').version, me);
    expect(st.filings.some((f) => f.form === 'PP30' && f.period === '2026-09')).toBe(true);
  });
  it('the general journal labels a filing entry with its own form', () => {
    const groups = generalJournal(st, CO, { source: 'PP30' }).rows.filter((r) => r.kind === 'group');
    expect(groups.map((r) => r.cells.entry)).toEqual(['ภ.พ.30 เดือน ก.ค. 2569', 'ภ.พ.30 เดือน ส.ค. 2569']);
    expect(groups[0].href).toBe('/tax/vat?period=2026-07');
  });
});

// ---------------------------------------------------------------- paying a finalized return (3.3 - 3.6)

const err = (fn: () => unknown): { code?: string; title?: string } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
/** A one-month October statement of ba-kbank (opening = the September closing); returns its lines in order. One per test (a second import of the same month is a duplicate). */
function statement(lines: [date: string, description: string, amount: string][]) {
  const content = utf8Base64(kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'บริษัท ตัวอย่าง จำกัด', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: withBalances(KBANK_SEP_CLOSING, lines) }));
  const imp = importStatement(st, CO, 'ba-kbank', { fileName: KBIZ_OCT_NAME, format: 'kbiz-csv', content }, me);
  return st.bankLines.filter((l) => l.importId === imp.id);
}
const jnl = (id: string) => st.bankJournals.find((j) => j.id === id)!;
const bal = (code: string) => glBalance(st, CO, code, '2099-12-31'); // debit - credit, satang
const PP30_AUG = { form: 'PP30' as const, period: '2026-08' }; // seeded, finalized, tax 7,875.00 (box 8)
const title = (f: { form: string; period: string }) => `ชำระภาษี ${formName(f.form)} เดือน ${monthLabelTh(f.period)}`;
const lineOf = (id: string) => st.bankLines.find((l) => l.id === id)!;
/** The seeded ภ.พ.30 of 2026-08 paid from a fresh 7,875.00 line. */
function paid() {
  const [line] = statement([['2026-10-13', 'ชำระภาษี กรมสรรพากร', '-7875.00']]);
  const out = payTax(st, CO, line.id, PP30_AUG, me);
  return { line, j: jnl(out.journalId!) };
}
const closeOctober = (closedAt: string) => { const p = st.periods.find((x) => x.companyId === CO && x.month === '2026-10'); if (p) Object.assign(p, { status: 'closed', closedAt }); else st.periods.push({ companyId: CO, month: '2026-10', status: 'closed', closedAt }); };
const found = (re: RegExp) => checkInvariants(st).some((m) => re.test(m));

describe('pay a ภ.พ.30', () => {
  it('Dr 2154 / Cr bank on the line date; the payable falls back, the filing reads paid, the history too, the line links back', () => {
    const before2154 = bal('2154'), beforeBank = bal('1121');
    const [line] = statement([['2026-10-13', 'ชำระภาษี กรมสรรพากร', '-7875.00']]);
    expect(getFiling(st, CO, 'PP30', '2026-08').payment).toEqual({ due: '7875.00', status: 'unpaid' });
    const out = payTax(st, CO, line.id, PP30_AUG, me);
    expect(out).toMatchObject({ status: 'posted', taxPayment: { form: 'PP30', period: '2026-08', href: '/tax/vat?period=2026-08' } });
    const j = jnl(out.journalId!);
    expect(j).toMatchObject({ kind: 'tax', lineId: line.id, accountId: 'ba-kbank', label: title(PP30_AUG), filing: { form: 'PP30', period: '2026-08', amount: '7875.00' } });
    expect(j.entries).toHaveLength(1);
    expect(j.entries[0].date).toBe('2026-10-13');
    expect(j.entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2154', '7875.00', '0.00'], ['1121', '0.00', '7875.00']]);
    expect(bal('2154')).toBe(before2154 + 787500); // the payable is cleared by the payment
    expect(bal('1121')).toBe(beforeBank - 787500);
    expect(getFiling(st, CO, 'PP30', '2026-08').payment).toEqual({ due: '7875.00', status: 'paid', paidOn: '2026-10-13', journalId: j.id, lineId: line.id, accountId: 'ba-kbank' });
    expect(filingHistory(st, CO, 'PP30').find((h) => h.period === '2026-08')).toMatchObject({ payment: 'paid', paidOn: '2026-10-13' });
    expect(filingHistory(st, CO, 'PP30').find((h) => h.period === '2026-07')).toMatchObject({ payment: 'unpaid' });
    expect(getFiling(st, CO, 'PP30', '2026-09').payment).toBeUndefined(); // a draft has none
    expect(checkInvariants(st)).toEqual([]);
  });
  it('before any payment 2154 holds exactly the two seeded months tax', () => {
    expect(-bal('2154')).toBe(1171310 + 787500);
  });
  it('a line carrying more than the tax pays the extra legs to a non-control account (fee, เงินเพิ่ม)', () => {
    const [line] = statement([['2026-10-13', 'ชำระภาษี + เงินเพิ่ม', '-7900.00']]);
    expect(err(() => payTax(st, CO, line.id, PP30_AUG, me)).code).toBe('tax_payment.amount');
    expect(err(() => payTax(st, CO, line.id, { ...PP30_AUG, extras: [{ accountCode: '2131', amount: '25.00' }] }, me)).code).toBe('ledger.control_account');
    expect(err(() => payTax(st, CO, line.id, { ...PP30_AUG, extras: [{ accountCode: '5200', amount: '0.00' }] }, me)).code).toBe('tax_payment.extra_amount');
    expect(err(() => payTax(st, CO, line.id, { ...PP30_AUG, extras: [{ accountCode: '1121', amount: '25.00' }] }, me)).code).toBeTruthy(); // the bank's own account
    for (const bad of ['abc', '12.345', '1,234.50', '', ' ']) expect(err(() => payTax(st, CO, line.id, { ...PP30_AUG, extras: [{ accountCode: '5200', amount: bad }] }, me)).code, bad).toBe('tax_payment.extra_amount'); // R2: never a 500
    expect(err(() => payTax(st, CO, line.id, { ...PP30_AUG, extras: {} as never }, me)).code).toBe('tax_payment.extra_amount');
    for (const bad of [null, 1, 'x']) expect(err(() => payTax(st, CO, line.id, { ...PP30_AUG, extras: [bad as never] }, me)).code, String(bad)).toBe('tax_payment.extra_amount'); // a non-object entry is a 422, never a 500
    expect(st.bankJournals.filter((j) => j.kind === 'tax')).toHaveLength(0);
    const out = payTax(st, CO, line.id, { ...PP30_AUG, extras: [{ accountCode: '5200', amount: '25.00' }] }, me);
    expect(jnl(out.journalId!).entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2154', '7875.00', '0.00'], ['5200', '25.00', '0.00'], ['1121', '0.00', '7900.00']]);
    expect(getFiling(st, CO, 'PP30', '2026-08').payment).toMatchObject({ status: 'paid', extras: '25.00' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('each refusal names its code and writes nothing; one live payment per return', () => {
    const [good, back, big, again] = statement([['2026-10-13', 'จ่ายภาษี', '-7875.00'], ['2026-10-13', 'รับโอน', '100.00'], ['2026-10-13', 'จ่ายมากไป', '-9000.00'], ['2026-10-14', 'ภาษีซ้ำ', '-7875.00']]);
    const pay = (id: string, f: { form: 'PP30' | 'PND53'; period: string } = PP30_AUG) => err(() => payTax(st, CO, id, f, me));
    const k = st.audit.length;
    expect(pay('nope').code).toBe('record.not_found');                                           // P1
    expect(pay(back.id).code).toBe('tax_payment.direction');                                      // P2
    expect(pay(good.id, { form: 'PP30', period: '2026-09' }).code).toBe('tax_payment.not_finalized'); // P3
    expect(pay(big.id).code).toBe('tax_payment.amount');                                          // P8
    const kplusFee = st.bankLines.find((l) => l.date === '2026-09-30' && l.amount === '-25.00')!;
    expect(pay(kplusFee.id, { form: 'PND53', period: '2026-09' }).code).toBe('tax_payment.before_period_end'); // P6: dated on the period's last day
    expect(st.bankJournals.filter((j) => j.kind === 'tax')).toHaveLength(0);
    expect(st.audit.length).toBe(k);
    payTax(st, CO, good.id, PP30_AUG, me);
    expect(pay(good.id).code).toBe('bank.line_state');                                            // posted
    expect(pay(again.id).code).toBe('tax_payment.already_paid');                                  // P5
    expect(st.bankJournals.filter((j) => j.kind === 'tax')).toHaveLength(1);
  });
  it('P9: a closed month of the line refuses (the exit is to reopen it)', () => {
    const [line] = statement([['2026-10-13', 'จ่ายภาษี', '-7875.00']]);
    closeOctober('2026-10-14T00:00:00.000Z');
    expect(err(() => payTax(st, CO, line.id, PP30_AUG, me)).code).toBe('period.closed');
    expect(lineOf(line.id).status).toBe('unmatched');
  });
  it('P4: an overpaid month (box 7 > box 5) has nothing to pay; its excess sits in 1172', () => {
    const d = createDraft(st, CO, 'PB', { header: { documentDate: '2026-09-15', partyId: st.parties.find((p) => p.companyId === CO && p.kind === 'vendor' && p.vatRegistered)!.id }, lines: [{ id: 'a', description: 'ซื้อ', qty: '1', unit: 'งาน', unitPrice: '300000.00', taxCode: 'S7' }] }, me, 'ov-1');
    issue(st, d.id, d.version, me); // 21,000.00 input VAT against 12,873.00 output
    const [line] = statement([['2026-10-13', 'จ่ายภาษี', '-8127.00']]);
    finalizeFiling(st, CO, 'PP30', '2026-09', pp30Model(st, CO, '2026-09').version, me);
    expect(getFiling(st, CO, 'PP30', '2026-09').payment).toEqual({ due: '0.00', status: 'nothing_due' });
    expect(err(() => payTax(st, CO, line.id, { form: 'PP30', period: '2026-09' }, me)).code).toBe('tax_payment.nothing_due');
    expect(bal('1172')).toBe(812700);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a ภ.ง.ด.53 is paid Dr 2132; invariant 11 still holds with the payment subtracted', () => {
    const [line] = statement([['2026-10-13', 'ภงด53', '-600.00']]);
    const out = payTax(st, CO, line.id, { form: 'PND53', period: '2026-08' }, me);
    expect(jnl(out.journalId!).entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2132', '600.00', '0.00'], ['1121', '0.00', '600.00']]);
    expect(getFiling(st, CO, 'PND53', '2026-08').payment).toMatchObject({ due: '600.00', status: 'paid' });
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('the candidate lines', () => {
  it('lists unmatched money-out lines after the period with at least the tax, the exact one first', () => {
    const [a, b] = statement([['2026-10-13', 'มากกว่า', '-7900.00'], ['2026-10-12', 'พอดี', '-7875.00']]);
    const got = taxPaymentLines(st, CO, 'PP30', '2026-08');
    expect(got.due).toBe('7875.00');
    expect(got.lines[0].id).toBe(b.id); // the exact amount first, then the earliest
    expect(got.lines.map((l) => l.id)).toContain(a.id);
    expect(got.lines.slice(1).map((l) => l.date)).toEqual(got.lines.slice(1).map((l) => l.date).sort());
    expect(got.lines.every((l) => l.status === 'unmatched' && l.amount.startsWith('-') && l.date > '2026-08-31')).toBe(true);
    expect(err(() => taxPaymentLines(st, CO, 'PP30', '2026-09')).code).toBe('tax_payment.not_finalized');
  });
});

describe('reverse a payment', () => {
  it('needs a reason; mirrors the entry; the line is unmatched again; the same line pays again; a second reverse is refused', () => {
    const { line, j } = paid();
    expect(err(() => reverseTaxPayment(st, CO, j.id, me, '  ')).code).toBe('bank.reason_required');
    reverseTaxPayment(st, CO, j.id, me, 'ผิดแบบ');
    expect(j.entries).toHaveLength(2);
    expect(j.entries[1].kind).toBe('reversal');
    expect(j.entries[1].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2154', '0.00', '7875.00'], ['1121', '7875.00', '0.00']]);
    expect(lineOf(line.id)).toMatchObject({ status: 'unmatched' });
    expect(lineOf(line.id).journalId).toBeUndefined();
    expect(getFiling(st, CO, 'PP30', '2026-08').payment).toEqual({ due: '7875.00', status: 'unpaid' });
    expect(checkInvariants(st)).toEqual([]);
    expect(err(() => reverseTaxPayment(st, CO, j.id, me, 'อีกที')).code).toBe('tax_payment.reversed');
    const again = payTax(st, CO, line.id, PP30_AUG, me);
    expect(again.journalId).not.toBe(j.id);
    expect(checkInvariants(st)).toEqual([]);
    expect(err(() => reverseTaxPayment(st, CO, 'bj-nope', me, 'x')).code).toBe('record.not_found');
  });
  it('a closed month: the reversal posts late on the first open date and the books stay clean; re-paying that line hits the closed month', () => {
    const { line, j } = paid();
    closeOctober(new Date(Date.now() + 60_000).toISOString());
    reverseTaxPayment(st, CO, j.id, me, 'ปิดงวดแล้วแต่ผิด');
    expect(j.entries[1]).toMatchObject({ kind: 'reversal', late: true });
    expect(j.entries[1].date > '2026-10-31').toBe(true);
    expect(lineOf(line.id).status).toBe('unmatched');
    expect(checkInvariants(st)).toEqual([]);
    expect(err(() => payTax(st, CO, line.id, PP30_AUG, me)).code).toBe('period.closed');
  });
  it('a closed year refuses', () => {
    const { j } = paid();
    st.yearCloses.push({ companyId: CO, year: 2026 } as never);
    expect(err(() => reverseTaxPayment(st, CO, j.id, me, 'x')).code).toBe('period.year_closed');
    expect(j.entries).toHaveLength(1);
  });
});

describe('the single-fault tampers (each one is caught by an invariant)', () => {
  const rogue = (code: string): MockState['bankJournals'][number] => {
    const line = (c: string, d: string, cr: string) => ({ accountCode: c, accountName: c, debit: d, credit: cr, rule: 'tamper' });
    return { id: 'bj-rogue', companyId: CO, accountId: 'ba-kbank', kind: 'fee', label: 'rogue', entries: [{ date: '2026-10-13', kind: 'original', postedAt: '2026-10-13T00:00:00.000Z', lines: [line(code, '1.00', '0.00'), line('1121', '0.00', '1.00')] }] };
  };
  const aug = () => st.filings.find((x) => x.form === 'PP30' && x.period === '2026-08')!;
  it('the untouched world is clean', () => { paid(); expect(checkInvariants(st)).toEqual([]); });
  it.each([
    ['1 the stored amount of the payment +0.01', () => { const { j } = paid(); j.filing!.amount = '7875.01'; }, /tax payment bj-\d+/],
    ['2 the payable line +0.01 and the bank line to match', () => { const { j } = paid(); j.entries[0].lines[0].debit = '7875.01'; j.entries[0].lines[1].credit = '7875.01'; }, /tax payment bj-\d+/],
    ['3 a second in-force copy', () => { const { j } = paid(); st.bankJournals.push({ ...structuredClone(j), id: 'bj-dup' }); }, /two live payments/],
    ['4 the line back to unmatched without reversing', () => { const { line } = paid(); lineOf(line.id).status = 'unmatched'; delete lineOf(line.id).journalId; }, /tax payment bj-\d+: .*line/],
    ['5 a rogue Dr 2154', () => { st.bankJournals.push(rogue('2154')); }, /GL 2154/],
    ['6 a rogue Dr 2131', () => { st.bankJournals.push(rogue('2131')); }, /GL 2131/],
    ['7 a rogue Dr 2152', () => { st.bankJournals.push(rogue('2152')); }, /GL 2152/],
    ['8 one PP30 netting line changed', () => { aug().journal![0].lines[2].credit = '7875.01'; }, /netting entry/],
    ['9 the PP30 netting deleted', () => { aug().journal = []; }, /netting entry/],
    ['10 a stored box 10 of a finalized PP30', () => { aug().boxes.find((b) => b.code === '10')!.amount = '1.00'; }, /stored boxes/],
    ['12 the payable line moved to another account (2131)', () => { const { j } = paid(); j.entries[0].lines[0].accountCode = '2131'; }, /tax payment bj-[0-9]+: its first line/],
    ['13 an overpayment consistent on every figure (cap: more than the return tax)', () => { const { j, line } = paid(); j.filing!.amount = '7875.01'; j.entries[0].lines[0].debit = '7875.01'; j.entries[0].lines[1].credit = '7875.01'; lineOf(line.id).amount = '-7875.01'; }, /tax payment bj-[0-9]+: it pays/],
    ['11 the reversal dropped from a reversed payment', () => { const { j } = paid(); reverseTaxPayment(st, CO, j.id, me, 'x'); j.entries.pop(); }, /tax payment bj-\d+: .*line/],
  ] as const)('%s', (_n, tamper, re) => {
    tamper();
    expect(found(re), checkInvariants(st).join('\n')).toBe(true);
  });
});

it('the tax accounts are not for an inline or a journal-voucher post; the exit text points to "ชำระภาษี"', () => {
  for (const code of ['2154', '1172']) for (const scope of ['inline', 'jv'] as const) expect(controlExit(st, CO, code, scope), `${code} ${scope}`).toContain('ชำระภาษี');
});

describe('a ภ.พ.36 payment (footgun: the next ภ.พ.36 tie-out must not see it)', () => {
  it('Dr 2152 on 2026-09-30 leaves the 2026-09 return tie-out at 0.00', () => {
    st.filings = st.filings.filter((f) => !(f.form === 'PP30' && f.period === '2026-08')); // the in-flight rule refuses a pnd36 voucher in a month whose ภ.พ.30 is filed
    const pv = (date: string, id: string) => {
      const d = createDraft(st, CO, 'PV', { header: { partyId: 'pv-12', documentDate: date, bankAccountId: 'ba-cash' }, lines: [{ id, description: 'บริการ', qty: '1', unit: 'งาน', unitPrice: '357.14', taxCode: 'EX', expenseCategory: 'services', whtTypeCode: 'FOR-SVC', pnd36: true }] }, me, `p36-${id}`);
      return issue(st, d.id, d.version, me);
    };
    pv('2026-08-10', 'a');
    finalizeFiling(st, CO, 'PP36', '2026-08', pp36Model(st, CO, '2026-08').version, me, true);
    const fee = st.bankLines.find((l) => l.date === '2026-09-30' && l.amount === '-25.00')!;
    expect(fee.status).toBe('unmatched');
    const out = payTax(st, CO, fee.id, { form: 'PP36', period: '2026-08' }, me);
    expect(jnl(out.journalId!).entries[0]).toMatchObject({ date: '2026-09-30' });
    expect(jnl(out.journalId!).entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['2152', '25.00', '0.00'], ['1121', '0.00', '25.00']]);
    pv('2026-09-10', 'b');
    finalizeFiling(st, CO, 'PP36', '2026-09', pp36Model(st, CO, '2026-09').version, me, true);
    const f9 = st.filings.find((f) => f.form === 'PP36' && f.period === '2026-09')!;
    expect(f9.tieOuts[0]).toMatchObject({ labelKey: 'filing.tie.pp36Gl', diff: '0.00' });
    expect(checkInvariants(st).filter((m) => /tax payment|GL 2152|pp36Gl/.test(m))).toEqual([]);
  });
});
