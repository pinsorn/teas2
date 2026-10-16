import { describe, expect, it } from 'vitest';
import { tinCheckDigit } from '@/domain/tin';
import type { DocLine, VendorInvoice } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { buildSeedState, type MockState } from '../store';
import { approveAndIssue, cancel, convert, createDraft, issue, revise, submitForApproval } from './commands';
import { checkInvariants } from './invariants';
import { MockError } from './log';

/** EX (expense claim, §7.6): owed to an employee (2180), VAT only with the vendor's tax invoice behind the line, paid by a PV with nothing withheld. Every scenario drives the real commands. */
const TIN = '010556000123' + tinCheckDigit('010556000123');
const inv = (date: string, p: Partial<VendorInvoice> = {}): VendorInvoice => ({ vendorName: 'ร้านเครื่องเขียนสยาม', vendorTin: TIN, number: 'INV-1', date, fullTaxInvoice: true, ...p });
const L = (id: string, taxCode: DocLine['taxCode'], price: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'ครั้ง', unitPrice: price, taxCode, expenseCategory: 'supplies', ...p });
const get = (st: MockState, id: string) => st.docs.find((d) => d.id === id)!;
let n = 0;
const claim = (st: MockState, lines: DocLine[], party = 'emp-02', company = 'co-vat') => {
  const d = createDraft(st, company, 'EX', { header: { partyId: party, documentDate: '2026-10-14' }, lines }, me, `ex${n++}`);
  return approveAndIssue(st, d.id, d.version, me);
};
const err = (f: () => unknown): MockError => { try { f(); } catch (e) { return e as MockError; } throw new Error('did not throw'); };
const entry = (st: MockState, id: string, k = 0) => st.journals.find((j) => j.docId === id)!.preview.entries[k];
const acct = (st: MockState, id: string, code: string, side: 'debit' | 'credit', k = 0) => entry(st, id, k).lines.filter((l) => l.accountCode === code).reduce((a, l) => a + Math.round(Number(l[side]) * 100), 0) / 100;
const gl = (st: MockState, company: string, code: string) => st.journals.filter((j) => get(st, j.docId).companyId === company).flatMap((j) => j.preview.entries).flatMap((e) => e.lines).filter((l) => l.accountCode === code).reduce((a, l) => a + Math.round((Number(l.debit) - Number(l.credit)) * 100), 0) / 100;
describe('the seed', () => {
  it('ex-1: 2,855.00 owed to emp-02; the tax invoice line claims VAT 140.00, the meal (entertainment, no invoice) and nothing else is cost', () => {
    const st = buildSeedState();
    expect(checkInvariants(st)).toEqual([]);
    const ex = get(st, 'ex-1');
    expect(ex).toMatchObject({ status: 'issued', outstanding: '2855.00', totals: { net: '2680.00', vat: '175.00', total: '2855.00' }, party: { id: 'emp-02' } });
    expect(ex.approval?.approvedBy?.id).toBe('u-1');
    const e = entry(st, 'ex-1');
    expect(e.lines.map((l) => [l.accountCode, l.debit, l.credit, l.partyName ?? ''])).toEqual(expect.arrayContaining([
      ['5140', '180.00', '0.00', ''], ['5160', '2000.00', '0.00', ''], ['1170', '140.00', '0.00', ''], ['5150', '500.00', '0.00', ''], ['5170', '35.00', '0.00', ''], ['2180', '0.00', '2855.00', ex.party!.name],
    ]));
    expect(e.lines.reduce((a, l) => a + Number(l.debit), 0)).toBe(2855);
    expect(entry(st, 'ex-1').postedAt).toBeTruthy();
  });
  it('ex-late: the vendor invoice is from 2026-03, the window closed: its VAT 70.00 is cost, never 1170', () => {
    const st = buildSeedState();
    expect(acct(st, 'ex-late', '1170', 'debit')).toBe(0);
    expect(acct(st, 'ex-late', '5170', 'debit')).toBe(70);
  });
  it('ex-pend / ex-appr / ex-d1 are not posted; ex-pend carries the receipt photo', () => {
    const st = buildSeedState();
    for (const id of ['ex-pend', 'ex-appr', 'ex-d1']) expect(st.journals.some((j) => j.docId === id)).toBe(false);
    expect(['ex-pend', 'ex-appr', 'ex-d1'].map((id) => get(st, id).status)).toEqual(['pending', 'approved', 'draft']);
    expect(st.attachments.filter((a) => a.docId === 'ex-pend')).toHaveLength(1);
  });
  it('the non-VAT company issues nex-1 directly; the VAT on a vendor receipt is cost', () => {
    const st = buildSeedState();
    expect(get(st, 'nex-1')).toMatchObject({ status: 'issued', totals: { vat: '56.00', total: '856.00' } });
    expect(acct(st, 'nex-1', '1170', 'debit')).toBe(0);
    expect(acct(st, 'nex-1', '5170', 'debit')).toBe(56);
    expect(gl(st, 'co-nonvat', '1170')).toBe(0);
  });
});

describe('input VAT needs the vendor tax invoice (ม.82/3, ม.86/4)', () => {
  it('with the invoice: 1170 and the document month is the claim period; without it: the same VAT is cost (5170)', () => {
    const st = buildSeedState();
    const withInv = claim(st, [L('a', 'S7', '1000.00', { vendorInvoice: inv('2026-10-12') })]);
    const without = claim(st, [L('b', 'S7', '1000.00')]);
    expect([acct(st, withInv.id, '1170', 'debit'), acct(st, withInv.id, '5170', 'debit')]).toEqual([70, 0]);
    expect([acct(st, without.id, '1170', 'debit'), acct(st, without.id, '5170', 'debit')]).toEqual([0, 70]);
    expect(get(st, without.id).totals.total).toBe('1070.00'); // owed to the employee all the same
    expect(acct(st, without.id, '2180', 'credit')).toBe(1070);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the window is per line: V+6 still claims, V+7 is forfeited', () => {
    const st = buildSeedState();
    const ok = claim(st, [L('a', 'S7', '1000.00', { vendorInvoice: inv('2026-04-30') })]); // April + 6 = October
    const late = claim(st, [L('b', 'S7', '1000.00', { vendorInvoice: inv('2026-03-31') })]);
    expect(acct(st, ok.id, '1170', 'debit')).toBe(70);
    expect(acct(st, late.id, '1170', 'debit')).toBe(0);
    expect(acct(st, late.id, '5170', 'debit')).toBe(70);
  });
  it('a category whose VAT is not recoverable stays cost even with an invoice; a capex line capitalises it', () => {
    const st = buildSeedState();
    const ent = claim(st, [L('a', 'S7', '1000.00', { expenseCategory: 'entertainment', vendorInvoice: inv('2026-10-12') })]);
    expect(acct(st, ent.id, '1170', 'debit')).toBe(0);
    const cap = claim(st, [L('b', 'S7', '30000.00', { expenseCategory: 'capex-equipment' })]);
    expect(acct(st, cap.id, '1210', 'debit')).toBe(32100); // no invoice: the VAT is part of the asset
  });
  it('a non-VAT company never claims, whatever the line carries', () => {
    const st = buildSeedState();
    const d = claim(st, [L('a', 'S7', '1000.00', { vendorInvoice: inv('2026-10-12') })], 'nemp-02', 'co-nonvat');
    expect([acct(st, d.id, '1170', 'debit'), acct(st, d.id, '5170', 'debit')]).toEqual([0, 70]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an invoice is whole, valid and not from the future: refused with its code', () => {
    const st = buildSeedState();
    const draft = (v: Partial<VendorInvoice>) => createDraft(st, 'co-vat', 'EX', { header: { partyId: 'emp-02', documentDate: '2026-10-14' }, lines: [L('a', 'S7', '100.00', { vendorInvoice: { ...inv('2026-10-12'), ...v } })] }, me, `ex${n++}`);
    const issueIt = (v: Partial<VendorInvoice>) => { const d = draft(v); return () => approveAndIssue(st, d.id, d.version, me); };
    expect(err(issueIt({ number: ' ' })).code).toBe('ex.invoice_incomplete');
    expect(err(issueIt({ vendorTin: '1234567890123' })).code).toBe('ex.invoice_tin_invalid');
    expect(err(issueIt({ date: '2026-10-15' })).code).toBe('ex.invoice_after_document');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the invariant (4d) catches a claim the books do not support', () => {
    const st = buildSeedState();
    const ex = get(st, 'ex-1');
    ex.lines[1] = { ...ex.lines[1], vendorInvoice: undefined }; // the invoice vanished but 1170 stayed posted
    expect(checkInvariants(st).join('\n')).toMatch(/claim period 2026-10: input VAT 1170 posted/);
  });
});

describe('the employee as a party', () => {
  it('an expense claim needs an employee; no other document may be made out to one (except the voucher that pays a claim)', () => {
    const st = buildSeedState();
    const vend = createDraft(st, 'co-vat', 'EX', { header: { partyId: 'pv-01', documentDate: '2026-10-14' }, lines: [L('a', 'EX', '100.00')] }, me, 'x1');
    expect(err(() => approveAndIssue(st, vend.id, vend.version, me)).code).toBe('doc.incomplete');
    expect(err(() => submitForApproval(st, vend.id, vend.version, me)).code).toBe('doc.incomplete'); // the approver never gets an incomplete claim
    const pb = createDraft(st, 'co-vat', 'PB', { header: { partyId: 'emp-01', documentDate: '2026-10-14' }, lines: [L('b', 'EX', '100.00')] }, me, 'x2');
    expect(err(() => issue(st, pb.id, pb.version, me)).code).toBe('doc.incomplete');
  });
  it('a non-positive claim is not a document', () => {
    const st = buildSeedState();
    const d = createDraft(st, 'co-vat', 'EX', { header: { partyId: 'emp-02', documentDate: '2026-10-14' }, lines: [L('a', 'EX', '0.00')] }, me, 'x3');
    expect(err(() => approveAndIssue(st, d.id, d.version, me)).code).toBe('doc.total_not_positive');
  });
  it('the party of an issued claim is locked', () => {
    const st = buildSeedState();
    const ex = get(st, 'ex-1');
    expect(err(() => revise(st, ex.id, { header: { ...ex.header, partyId: 'emp-03' }, lines: ex.lines }, ex.version, 'x', me)).code).toBe('doc.party_locked');
  });
});

describe('paying a claim: EX -> PV', () => {
  it('converts to a PV draft that allocates the outstanding to the claim, pays it in full and withholds nothing', () => {
    const st = buildSeedState();
    const pv = convert(st, 'ex-1', 'PV', [], me);
    expect(pv).toMatchObject({ type: 'PV', status: 'draft', header: { partyId: 'emp-02' }, allocations: [{ targetId: 'ex-1', targetType: 'EX', amount: '2855.00' }] });
    const i = issue(st, pv.id, pv.version, me);
    expect(i.totals).toMatchObject({ total: '2855.00', wht: '0.00', cash: '2855.00' });
    expect(i.whtFrozen?.bases).toEqual([]);
    expect(st.links.filter((l) => l.kind === 'issues' && l.from === pv.id)).toEqual([]); // no 50 tawi
    expect(get(st, 'ex-1')).toMatchObject({ status: 'settled', outstanding: '0.00' });
    const e = entry(st, pv.id);
    expect(e.lines.map((l) => [l.accountCode, l.debit, l.credit, l.partyName ?? ''])).toEqual(expect.arrayContaining([['2180', '2855.00', '0.00', 'วิชาญ ขยันงาน'], ['1121', '0.00', '2855.00', '']]));
    expect(e.lines.some((l) => l.accountCode === '2131' || l.accountCode === '2132' || l.accountCode === '5180')).toBe(false);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a part-payment leaves the claim partly settled; cancelling the voucher restores the outstanding', () => {
    const st = buildSeedState();
    const edited = createDraft(st, 'co-vat', 'PV', { header: { partyId: 'emp-02', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'ex-1', targetType: 'EX', amount: '1000.00' }] }, me, 'part');
    issue(st, edited.id, edited.version, me);
    expect(get(st, 'ex-1')).toMatchObject({ status: 'partly_settled', outstanding: '1855.00' });
    expect(checkInvariants(st)).toEqual([]);
    expect(convert(st, 'ex-1', 'PV', [], me).allocations).toMatchObject([{ targetId: 'ex-1', amount: '1855.00' }]); // the next voucher pays what is left, not the total
    cancel(st, edited.id, get(st, edited.id).version, 'OTHER', 'x', me);
    expect(get(st, 'ex-1')).toMatchObject({ status: 'issued', outstanding: '2855.00' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a paid claim cannot be cancelled, lowered below what was paid or re-addressed; nothing to convert once settled', () => {
    const st = buildSeedState();
    const ex = get(st, 'ex-paid');
    expect(err(() => cancel(st, ex.id, ex.version, 'OTHER', 'x', me)).code).toBe('doc.has_dependents');
    expect(err(() => revise(st, ex.id, { header: ex.header, lines: [{ ...ex.lines[0], unitPrice: '1000.00' }] }, ex.version, 'x', me)).code).toBe('settle.below_settled');
    expect(err(() => convert(st, ex.id, 'PV', [], me)).code).toBe('doc.nothing_to_pay');
  });
  it('a voucher cannot pay another employee\'s claim', () => {
    const st = buildSeedState();
    const d = createDraft(st, 'co-vat', 'PV', { header: { partyId: 'emp-03', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'ex-1', targetType: 'EX', amount: '100.00' }] }, me, 'x4');
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('settle.party_mismatch');
  });
  it('the 2180 per employee invariant catches a tampered claim', () => {
    const st = buildSeedState();
    get(st, 'ex-1').outstanding = '1.00';
    expect(checkInvariants(st).join('\n')).toMatch(/employee payable 2180 of วิชาญ ขยันงาน/);
  });
});

describe('revising an issued claim (L-class)', () => {
  it('an API revise that omits a line category or vendor invoice keeps them (unchanged); an explicit null invoice clears it and that VAT becomes cost', () => {
    const st = buildSeedState();
    const d = claim(st, [L('a', 'S7', '1000.00', { vendorInvoice: inv('2026-10-12') })]);
    const x = get(st, d.id);
    const { expenseCategory: _c, vendorInvoice: _v, ...bare } = x.lines[0]; void _c; void _v;
    revise(st, x.id, { header: x.header, lines: [bare] }, x.version, 'ไม่ส่งหมวดและใบกำกับ', me);
    expect(get(st, d.id).lines[0]).toMatchObject({ expenseCategory: 'supplies', vendorInvoice: { number: 'INV-1' } });
    expect([acct(st, d.id, '1170', 'debit', 2), acct(st, d.id, '5160', 'debit', 2)]).toEqual([70, 1000]);
    expect(checkInvariants(st)).toEqual([]);
    const y = get(st, d.id);
    revise(st, y.id, { header: y.header, lines: [{ ...bare, vendorInvoice: null as unknown as undefined }] }, y.version, 'ถอนใบกำกับ', me);
    expect(get(st, d.id).lines[0].vendorInvoice).toBeUndefined();
    expect([acct(st, d.id, '1170', 'debit', 4), acct(st, d.id, '5170', 'debit', 4)]).toEqual([0, 70]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('reverses and reposts: the old entry is reversed on its date, 2180 follows the new total', () => {
    const st = buildSeedState();
    const d = claim(st, [L('a', 'EX', '500.00', { expenseCategory: 'transport' })]);
    const x = get(st, d.id);
    revise(st, x.id, { header: x.header, lines: [{ ...x.lines[0], unitPrice: '650.00' }] }, x.version, 'ราคาผิด', me, { approver: me }); // 650.00 is above the 500.00 that was approved: approved in the same command (C1)
    const entries = st.journals.find((j) => j.docId === d.id)!.preview.entries;
    expect(entries.map((e) => e.kind)).toEqual(['original', 'reversal', 'correction']);
    expect(entries.every((e) => !!e.postedAt)).toBe(true);
    expect(get(st, d.id)).toMatchObject({ outstanding: '650.00', totals: { total: '650.00' } });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancelling an unpaid claim reverses its entry and clears 2180', () => {
    const st = buildSeedState();
    const d = claim(st, [L('a', 'EX', '500.00', { expenseCategory: 'transport' })]);
    const before = gl(st, 'co-vat', '2180');
    cancel(st, d.id, get(st, d.id).version, 'OTHER', 'x', me);
    expect(gl(st, 'co-vat', '2180')).toBe(before + 500); // credit-normal account: the cancel takes the 500 back
    expect(checkInvariants(st)).toEqual([]);
  });
});
