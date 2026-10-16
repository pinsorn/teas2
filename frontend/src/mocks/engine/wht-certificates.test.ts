import { beforeEach, describe, expect, it } from 'vitest';
import type { Allocation, Doc, DocLine, WhtMode } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { fixtureIds } from '../fixtures/ids';
import { seed, type MockState } from '../store';
import { markPrinted } from './attachments';
import { buildChain } from './chain';
import { cancel, createDraft, issue, publicDoc, revise } from './commands';
import { checkInvariants } from './invariants';
import { MockError } from './log';
import { toSatang } from './money';
import { PAPER_BUILDERS } from './paper';
import { assertBalanced } from './test-helpers';

const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
let n = 0;
beforeEach(() => { st = seed(); });
const sat = (m: string) => toSatang(m);
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof MockError ? e.code : String(e); } return 'no error'; };
const line = (id: string, unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode: 'EX', ...p });

/** A vendor's bill through the engine: rent 25,000.00 + VAT 1,750.00 = 26,750.00 (EXP-01 carries WHT type RENT). */
const bill = (vendor = 'pv-01', lines: DocLine[] = [line(`b${++n}-l1`, '25000.00', { itemId: 'EXP-01', description: 'ค่าเช่า', taxCode: 'S7', expenseCategory: 'rent' })], company = VAT): Doc => {
  const d = createDraft(st, company, 'PB', { header: { partyId: vendor, documentDate: '2026-10-14', vendorDocNumber: `V-${n}`, vendorDocDate: '2026-10-14' }, lines }, me, `pb-${++n}`);
  return issue(st, d.id, d.version, me);
};
const alloc = (targetId: string, amount: string): Allocation => ({ targetId, targetType: 'PB', amount });
const voucher = (partyId: string, allocations: Allocation[], lines: DocLine[] = [], header: Partial<Doc['header']> = {}, company = VAT): Doc => {
  const d = createDraft(st, company, 'PV', { header: { partyId, documentDate: '2026-10-14', ...header }, lines, allocations }, me, `pv-${++n}`);
  return issue(st, d.id, d.version, me);
};
const wtsOf = (pvId: string, active = true) => st.links.filter((l) => l.kind === 'issues' && l.from === pvId && (!active || l.active)).map((l) => get(l.to));
/** Net credit on one account over every journal entry of a company (cr - dr). */
const credit = (company: string, account: string) => st.journals.filter((j) => get(j.docId).companyId === company).flatMap((j) => j.preview.entries).flatMap((e) => e.lines)
  .filter((l) => l.accountCode === account).reduce((a, l) => a + sat(l.credit) - sat(l.debit), 0);

describe('WHT of a voucher that settles bills (the payee is paid the bill less the tax withheld on its typed lines)', () => {
  it('pb rent 25,000.00 + VAT, paid in full: RENT 5 % of the bill net 25,000.00 = 1,250.00, cash 25,500.00, one WT', () => {
    const pb = bill();
    const pv = voucher('pv-01', [alloc(pb.id, pb.totals.total)]);
    expect([pv.totals.total, pv.totals.wht, pv.totals.cash]).toEqual(['26750.00', '1250.00', '25500.00']);
    const [wt, ...more] = wtsOf(pv.id);
    expect(more).toEqual([]);
    expect(wt).toMatchObject({ type: 'WT', status: 'issued', correctionClass: 'T', header: { partyId: 'pv-01', documentDate: '2026-10-14', whtForm: 'PND53', whtTypeCode: 'RENT', whtTax: '1250.00' } });
    expect(wt.number).toMatch(/^WT-202610-\d{4}$/);
    expect(wt.totals).toMatchObject({ total: '25000.00', wht: '1250.00' });
    expect(wt.lines).toHaveLength(1);
    expect(wt.lines[0]).toMatchObject({ unitPrice: '25000.00' });
    expect(wt.lines[0].description).toContain('40(5)');
    expect(get(pb.id)).toMatchObject({ status: 'settled', outstanding: '0.00' });
    assertBalanced(st);
  });
  it('a part payment withholds on the paid share of the bill (10,700.00 of 26,750.00 = 40 %: base 10,000.00, tax 500.00)', () => {
    const pb = bill();
    const pv = voucher('pv-01', [alloc(pb.id, '10700.00')]);
    expect([pv.totals.wht, pv.totals.cash]).toEqual(['500.00', '10200.00']);
    expect(get(pb.id)).toMatchObject({ status: 'partly_settled', outstanding: '16050.00' });
    assertBalanced(st);
  });
  it('PV with two WHT types issues two WTs whose tax sums to the PV wht (one per type, Σ exact)', () => {
    const pb = bill();
    const pv = voucher('pv-01', [alloc(pb.id, pb.totals.total)], [line('l1', '3000.00', { whtTypeCode: 'TRANS', description: 'ค่าขนส่ง' })]);
    const wts = wtsOf(pv.id);
    expect(wts.map((w) => w.header.whtTypeCode).sort()).toEqual(['RENT', 'TRANS']);
    expect(wts.reduce((a, w) => a + sat(w.header.whtTax!), 0)).toBe(sat(pv.totals.wht!));
    expect(pv.totals.wht).toBe('1280.00'); // 1,250.00 + 1 % of 3,000.00
    assertBalanced(st);
  });
  it('the journal: Dr AP 26,750.00 and the expense line, Cr WHT payable per form, Cr bank; Dr = Cr; the credit on 2132 is the WT tax', () => {
    const pb = bill();
    const before = credit(VAT, '2132');
    const pv = voucher('pv-01', [alloc(pb.id, pb.totals.total)]);
    const entry = st.journals.find((j) => j.docId === pv.id)!.preview.entries[0];
    const row = (c: string) => entry.lines.find((l) => l.accountCode === c);
    expect(row('2110')?.debit).toBe('26750.00');
    expect(row('2132')?.credit).toBe('1250.00');
    expect(credit(VAT, '2132') - before).toBe(125000);
    assertBalanced(st);
  });
  it('an own expense line takes its category account; a capex category capitalises (never 1170)', () => {
    const pv = voucher('pv-09', [], [line('l1', '5000.00', { description: 'ถ่ายภาพ', expenseCategory: 'services' }), line('l2', '30000.00', { description: 'กล้อง', expenseCategory: 'capex-equipment' })]);
    const e = st.journals.find((j) => j.docId === pv.id)!.preview.entries[0];
    expect(e.lines.some((l) => l.accountCode === '1170')).toBe(false);
    expect(e.lines.find((l) => l.accountCode === '1210')?.debit).toBe('30000.00');
    assertBalanced(st);
  });
});

describe('gross-up modes keep the books balanced with a bill and a line together', () => {
  for (const mode of ['deduct', 'grossup_always', 'grossup_once'] as WhtMode[]) {
    it(`${mode}: Σ alloc + line total + WhtExpense = cash + Σ WHT; Dr = Cr`, () => {
      const pb = bill();
      const pv = voucher('pv-01', [alloc(pb.id, '5350.00')], [line('l1', '2000.00', { whtTypeCode: 'SVC', description: 'ค่าบริการ' })], { whtMode: mode });
      const e = st.journals.find((j) => j.docId === pv.id)!.preview.entries[0];
      const sum = (c: string, side: 'debit' | 'credit') => e.lines.filter((l) => l.accountCode === c).reduce((a, l) => a + sat(l[side]), 0);
      const expense = sum('5180', 'debit');
      expect(sat('5350.00') + sat('2000.00') + expense).toBe(sat(pv.totals.cash!) + sat(pv.totals.wht!));
      if (mode === 'grossup_always') { expect(pv.totals.cash).toBe(pv.totals.total); expect(expense).toBe(sat(pv.totals.wht!)); }
      expect(wtsOf(pv.id).reduce((a, w) => a + sat(w.header.whtTax!), 0)).toBe(sat(pv.totals.wht!));
      assertBalanced(st);
    });
  }
});

describe('WT lifecycle follows the PV', () => {
  it('PV revise changing a WHT rate base cancels the old WT and issues a new one; unchanged WHT keeps the WT', () => {
    const pv = voucher('pv-09', [], [line('l1', '5000.00', { whtTypeCode: 'SVC', description: 'ถ่ายภาพ' })]);
    const [first] = wtsOf(pv.id);
    // unchanged WHT (only the note): same WT, same number
    let r = revise(st, pv.id, { header: { ...get(pv.id).header, notes: 'แก้หมายเหตุ' }, lines: get(pv.id).lines, allocations: [] }, get(pv.id).version, 'note', me);
    expect(wtsOf(r.id).map((w) => w.id)).toEqual([first.id]);
    expect(get(first.id).status).toBe('issued');
    // the line becomes ADS 2 %: the SVC WT is cancelled, an ADS WT is issued
    r = revise(st, pv.id, { header: get(pv.id).header, lines: [{ ...get(pv.id).lines[0], whtTypeCode: 'ADS' }], allocations: [] }, get(pv.id).version, 'rate', me);
    const now = wtsOf(r.id);
    expect(now).toHaveLength(1);
    expect(now[0].id).not.toBe(first.id);
    expect(now[0].header).toMatchObject({ whtTypeCode: 'ADS', whtTax: '100.00' });
    expect(get(first.id)).toMatchObject({ status: 'cancelled', cancel: { reasonText: 'ยกเลิกตามใบสำคัญจ่าย' } });
    expect(wtsOf(pv.id, false).filter((l) => get(l.id).status === 'issued')).toHaveLength(1);
    assertBalanced(st);
  });
  it('PV revise changing the amount of the SAME WHT type cancels that WT and issues a new one with the new tax', () => {
    const pv = voucher('pv-09', [], [line('l1', '5000.00', { whtTypeCode: 'SVC', description: 'ถ่ายภาพ' })]);
    const [first] = wtsOf(pv.id);
    revise(st, pv.id, { header: get(pv.id).header, lines: [{ ...get(pv.id).lines[0], unitPrice: '8000.00' }], allocations: [] }, get(pv.id).version, 'amount', me);
    const [now, ...rest] = wtsOf(pv.id);
    expect(rest).toEqual([]);
    expect(now.id).not.toBe(first.id);
    expect(now.header.whtTax).toBe('240.00');
    expect(get(first.id).status).toBe('cancelled');
    assertBalanced(st);
  });
  it('PV revise dropping the WHT cancels its WT; PV total and the active WT tax stay equal', () => {
    const pv = voucher('pv-09', [], [line('l1', '5000.00', { whtTypeCode: 'SVC', description: 'ถ่ายภาพ' })]);
    const [first] = wtsOf(pv.id);
    revise(st, pv.id, { header: get(pv.id).header, lines: [{ ...get(pv.id).lines[0], whtTypeCode: undefined }], allocations: [] }, get(pv.id).version, 'no wht', me);
    expect(get(first.id).status).toBe('cancelled');
    expect(wtsOf(pv.id)).toEqual([]);
    expect(get(pv.id).totals.wht).toBe('0.00');
    assertBalanced(st);
  });
  it('PV cancel cancels its WTs (reason ยกเลิกตามใบสำคัญจ่าย), restores every PB outstanding and leaves the invariants []', () => {
    const pb = bill(), pb2 = bill('pv-01', [line('x1', '1000.00', { itemId: 'EXP-02', taxCode: 'S7', expenseCategory: 'services' })]);
    const pv = voucher('pv-01', [alloc(pb.id, pb.totals.total), alloc(pb2.id, '500.00')]);
    expect(wtsOf(pv.id).length).toBeGreaterThan(0);
    cancel(st, pv.id, get(pv.id).version, 'OTHER', 'ทดสอบ', me);
    for (const w of wtsOf(pv.id, false)) expect(get(w.id)).toMatchObject({ status: 'cancelled', cancel: { reasonText: 'ยกเลิกตามใบสำคัญจ่าย' } });
    expect(wtsOf(pv.id)).toEqual([]);
    expect(get(pb.id)).toMatchObject({ status: 'issued', outstanding: pb.totals.total });
    expect(get(pb2.id)).toMatchObject({ status: 'issued', outstanding: pb2.totals.total });
    assertBalanced(st);
  });
  it('the party of an issued PV is locked (cancel and re-issue instead)', () => {
    const pv = voucher('pv-09', [], [line('l1', '5000.00', { whtTypeCode: 'SVC' })]);
    expect(code(() => revise(st, pv.id, { header: { ...get(pv.id).header, partyId: 'pv-02' }, lines: get(pv.id).lines, allocations: [] }, get(pv.id).version, 'x', me))).toBe('doc.party_locked');
  });
  it('the WT sits in the PV chain', () => {
    const pv = voucher('pv-09', [], [line('l1', '5000.00', { whtTypeCode: 'SVC' })]);
    const chain = buildChain(st, pv.id);
    expect(chain.edges.some((e) => e.kind === 'issues' && e.from === pv.id && e.active)).toBe(true);
    expect(chain.nodes.some((x) => x.type === 'WT')).toBe(true);
  });
});

describe('input VAT only through a bill (D-16)', () => {
  it('standalone S7 line → pv.input_vat_needs_bill; the same payment through a PB issues', () => {
    const body = (lines: DocLine[], allocations: Allocation[] = []) => ({ header: { partyId: 'pv-01', documentDate: '2026-10-14' }, lines, allocations });
    const d = createDraft(st, VAT, 'PV', body([line('l1', '1000.00', { taxCode: 'S7' })]), me, 'k-s7');
    expect(code(() => issue(st, d.id, d.version, me))).toBe('pv.input_vat_needs_bill');
    const pb = bill('pv-01', [line('q1', '1000.00', { taxCode: 'S7', expenseCategory: 'services' })]);
    const ok = voucher('pv-01', [alloc(pb.id, pb.totals.total)]);
    expect(ok.status).toBe('issued');
    expect(get(pb.id).status).toBe('settled');
    assertBalanced(st);
  });
  it('the vendor basis: a non-VAT company PV settles its non-VAT bill; 1170 never moves; npv-style invariants []', () => {
    const pb = bill('nv-03', [line('n1', '1000.00', { taxCode: 'S7', expenseCategory: 'services' })], NV);
    expect(pb.totals.total).toBe('1070.00');
    const pv = voucher('nv-03', [alloc(pb.id, pb.totals.total)], [], {}, NV);
    expect(get(pb.id)).toMatchObject({ status: 'settled', outstanding: '0.00' });
    const e = st.journals.find((j) => j.docId === pv.id)!.preview.entries[0];
    expect(e.lines.some((l) => l.accountCode === '1170')).toBe(false);
    expect(e.lines.find((l) => l.accountCode === '2110')?.debit).toBe('1070.00');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('foreign vendor and individual payees (pv-12 / pv-09)', () => {
  it('pv-12: FOR-SVC grossup_always → PND54, pnd36 line, WT of the foreign payee; cash = total', () => {
    const pv = voucher('pv-12', [], [line('l1', '10000.00', { description: 'ค่าบริการซอฟต์แวร์', whtTypeCode: 'FOR-SVC', pnd36: true })], { whtMode: 'grossup_always' });
    expect(pv.lines[0]).toMatchObject({ pnd36: true });
    const [wt] = wtsOf(pv.id);
    expect(wt.header).toMatchObject({ whtForm: 'PND54', whtTypeCode: 'FOR-SVC' });
    expect(pv.totals.cash).toBe(pv.totals.total);
    assertBalanced(st);
  });
  it('pv-12 with a service line and no explicit type defaults to FOR-SVC / grossup_always / pnd36 at the party pick (editor) and the server fills the same defaults', () => {
    const d = createDraft(st, VAT, 'PV', { header: { partyId: 'pv-12', documentDate: '2026-10-14' }, lines: [line('l1', '10000.00', { description: 'ค่าบริการ' })] }, me, 'k-for');
    expect(get(d.id).header.whtMode).toBe('grossup_always');
    expect(get(d.id).lines[0]).toMatchObject({ whtTypeCode: 'FOR-SVC', pnd36: true });
  });
  it('pv-09 is the individual photographer with EXP-05 as the usual item and SVC as default type', () => {
    const p = st.parties.find((x) => x.id === 'pv-09')!;
    expect(p).toMatchObject({ entityKind: 'individual', vatRegistered: false, usualItemIds: ['EXP-05'], defaultWhtTypeCode: 'SVC' });
    expect(p.name).toContain('อนันต์');
  });
});

describe('WT paper (50 ทวิ) is frozen at the first print (I7)', () => {
  it('a later change of what the paper reads does not change the printed paper', () => {
    const pv = voucher('pv-09', [], [line('l1', '5000.00', { whtTypeCode: 'SVC' })]);
    const [wt] = wtsOf(pv.id);
    const ctx = () => ({ st, company: st.companies.find((c) => c.id === VAT)! }) as unknown as Parameters<NonNullable<(typeof PAPER_BUILDERS)['WT']>>[0];
    const live = PAPER_BUILDERS.WT!(ctx(), publicDoc(get(wt.id)), false);
    expect(live.totals.wht).toBe('150.00');
    markPrinted(st, publicDoc(get(wt.id)), false, me, live);
    st.companies.find((c) => c.id === VAT)!.legalNameTh = 'ชื่อใหม่ จำกัด';
    st.docs.find((d) => d.id === wt.id)!.party!.name = 'ชื่อผู้รับเงินใหม่';
    const frozen = PAPER_BUILDERS.WT!(ctx(), publicDoc(get(wt.id)), true);
    expect(frozen.seller.name).toBe(live.seller.name);
    expect(frozen.buyer.name).toBe(live.buyer.name);
    expect(frozen.copyLabel).toBe('สำเนา');
  });
});

describe('WT / PV invariants fail on a tampered state', () => {
  const base = () => {
    const pb = bill();
    const pv = voucher('pv-01', [alloc(pb.id, pb.totals.total)]);
    expect(checkInvariants(st)).toEqual([]);
    return { pv, wt: wtsOf(pv.id)[0] };
  };
  it('a WT with another tax than the PV withholds', () => {
    const { wt } = base();
    get(wt.id).header.whtTax = '1.00';
    expect(checkInvariants(st).join('\n')).toMatch(/WT/);
  });
  it('a WT cancelled on its own (the PV still withholds)', () => {
    const { wt } = base();
    get(wt.id).status = 'cancelled';
    expect(checkInvariants(st).join('\n')).toMatch(/WT|2132/);
  });
  it('a second active WT of the same WHT type', () => {
    const { pv, wt } = base();
    const dup = { ...structuredClone(get(wt.id)), id: 'wt-dup', number: undefined as unknown as string };
    st.docs.push(dup);
    st.links.push({ companyId: VAT, from: pv.id, to: 'wt-dup', kind: 'issues', amount: wt.header.whtTax, active: true });
    expect(checkInvariants(st).join('\n')).toMatch(/one active WT|WT/);
  });
  it('a live WT whose PV is cancelled', () => {
    const { pv } = base();
    get(pv.id).status = 'cancelled';
    expect(checkInvariants(st).length).toBeGreaterThan(0);
  });
  it('the payable account no longer matches the WT tax of its form', () => {
    const { pv } = base();
    const e = st.journals.find((j) => j.docId === pv.id)!.preview.entries[0];
    const l = e.lines.find((x) => x.accountCode === '2132')!;
    l.credit = '1.00'; e.lines.find((x) => x.accountCode === '1121')!.credit = '26749.00';
    expect(checkInvariants(st).join('\n')).toMatch(/2132|WHT/);
  });
});

describe('seed vectors (hand-checked, satang)', () => {
  it('pv-pay1: pb-1 outstanding 24,075.00 (after pcn-1) paid in full: base 25,000.00 - 2,500.00 = 22,500.00, RENT 5 % = 1,125.00, cash 22,950.00', () => {
    expect(get('pv-pay1').totals).toMatchObject({ total: '24075.00', wht: '1125.00', cash: '22950.00' });
  });
  it('pv-multi: half of pb-2 (the services line only; the entertainment debit is untyped) + 1,000.00 of pb-po + a transport line: SVC 270.00 + TRANS 18.00', () => {
    expect(get('pv-multi').totals).toMatchObject({ total: '15105.00', wht: '288.00', cash: '14817.00' });
    expect(wtsOf('pv-multi').map((w) => [w.header.whtTypeCode, w.header.whtTax, w.totals.total]).sort()).toEqual([['SVC', '270.00', '9000.00'], ['TRANS', '18.00', '1800.00']]);
  });
  it('a debit note on the TYPED line raises the base the payment covers (the share is of the bill as adjusted)', () => {
    const pb = bill();
    const note = createDraft(st, VAT, 'PDN', { header: { partyId: 'pv-01', documentDate: '2026-10-14', refDocId: pb.id, reasonCode: 'PRICE_INCREASE' }, lines: [{ ...line('n1', '1000.00', { taxCode: 'S7' }), sourceLineId: pb.lines[0].id }] }, me, 'k-pdn');
    issue(st, note.id, note.version, me);
    const out = get(pb.id).outstanding!; // 26,750.00 + 1,070.00 = 27,820.00
    const pv = voucher('pv-01', [alloc(pb.id, out)]);
    expect(pv.totals.wht).toBe('1300.00'); // 5 % of (25,000.00 + 1,000.00)
    assertBalanced(st);
  });
});

describe('seed: the PV / WT fixtures (P3)', () => {
  it('named fixtures resolve and tie out', () => {
    const ids = fixtureIds(st);
    for (const k of ['pvMultiWt', 'pvGrossUp', 'pvForeign', 'pvCancelled', 'wtIssued', 'wtCancelled'] as const) expect(get(ids[k]), k).toBeTruthy();
    expect(get(ids.pvMultiWt)).toMatchObject({ type: 'PV', status: 'issued' });
    expect(wtsOf(ids.pvMultiWt).length).toBe(2);
    expect(get(ids.pvCancelled).status).toBe('cancelled');
    expect(get(ids.wtCancelled).status).toBe('cancelled');
    expect(get(ids.wtIssued)).toMatchObject({ type: 'WT', status: 'issued' });
    expect(get('pv-pay1')).toMatchObject({ status: 'issued' });
    expect(get('pb-1')).toMatchObject({ status: 'settled', outstanding: '0.00' });
    expect(get('npv-1')).toMatchObject({ status: 'issued', companyId: NV });
    expect(get('npb-1')).toMatchObject({ status: 'settled' });
    expect(checkInvariants(st)).toEqual([]);
  });
});
