import { beforeEach, describe, expect, it } from 'vitest';
import type { Allocation, Doc, DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { seed, type MockState } from '../store';
import { buildChain } from './chain';
import { cancel, compute, convert, createDraft, issue, recomputeSettlement, revise } from './commands';
import { checkInvariants } from './invariants';
import { toSatang } from './money';
import { assertBalanced } from './test-helpers';

const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
let n = 0;
beforeEach(() => { st = seed(); });
const sat = (m: string) => toSatang(m);
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const err = (fn: () => unknown): { code?: string; title?: string } => { try { fn(); } catch (e) { return e as { code?: string; title?: string }; } return {}; };
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode, ...p });

/** A draft PB; `issue` is a separate step so a refusal can be asserted. */
const draftPb = (company: string, partyId: string, lines: DocLine[], header: Partial<Doc['header']> = {}): Doc =>
  createDraft(st, company, 'PB', { header: { partyId, documentDate: '2026-10-14', ...header }, lines }, me, `pb-${++n}`);
const pb = (company: string, partyId: string, lines: DocLine[], header: Partial<Doc['header']> = {}): Doc => {
  const d = draftPb(company, partyId, lines, header);
  return issue(st, d.id, d.version, me);
};
const lines = (id: string) => (st.journals.find((j) => j.docId === id)?.preview.entries[0].lines ?? []).map((l) => `${l.accountCode} ${l.debit}/${l.credit}`).sort().join(' | ');
const gl = (company: string, code: string) => st.journals.reduce((a, j) => {
  if (get(j.docId).companyId !== company) return a;
  return a + j.preview.entries.reduce((b, e) => b + e.lines.filter((l) => l.accountCode === code).reduce((c, l) => c + sat(l.debit) - sat(l.credit), 0), 0);
}, 0);
const PV1 = 'pv-01', PV3 = 'pv-03', PV_FOREIGN = 'pv-12', NV_REG = 'nv-03', NV_UNREG = 'nv-02';

describe('input VAT rules of a purchase bill (ม.82/5, A.4, I6)', () => {
  it('vendor not VAT-registered + S7 line -> pb.vendor_not_vat_registered; compute says so before issue; an EX line is fine', () => {
    expect(st.parties.find((p) => p.id === PV_FOREIGN)!.vatRegistered).toBe(false);
    const d = draftPb(VAT, PV_FOREIGN, [L('a', 'S7', '1000.00')]);
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('pb.vendor_not_vat_registered');
    const c = compute(st, VAT, 'PB', { header: d.header, lines: d.lines });
    expect(c.missing.map((m) => m.message).join(' ')).toMatch(/ภาษีมูลค่าเพิ่ม/);
    const ok = pb(VAT, PV_FOREIGN, [L('a', 'EX', '1000.00')]);
    expect(ok.totals).toMatchObject({ vat: '0.00', total: '1000.00' });
    expect(get(ok.id).status).toBe('issued');
    // the same rule reaches a revision and the non-VAT company's own unregistered vendor
    expect(err(() => revise(st, ok.id, { header: ok.header, lines: [L('a', 'S7', '1000.00')] }, ok.version, 'x', me)).code).toBe('pb.vendor_not_vat_registered');
    const nd = draftPb(NV, NV_UNREG, [L('a', 'S7', '1000.00')]);
    expect(err(() => issue(st, nd.id, nd.version, me)).code).toBe('pb.vendor_not_vat_registered');
  });

  it('pb-2 style: services + entertainment at a registered vendor - the entertainment VAT posts to 5170, not 1170; the journal balances', () => {
    const g1170 = gl(VAT, '1170');
    const d = pb(VAT, PV3, [L('a', 'S7', '10000.00', { expenseCategory: 'services' }), L('b', 'S7', '4000.00', { expenseCategory: 'entertainment' })]);
    expect(d.totals).toMatchObject({ net: '14000.00', vat: '980.00', total: '14980.00' });
    expect(lines(d.id)).toBe(['5120 10000.00/0.00', '5150 4000.00/0.00', '1170 700.00/0.00', '5170 280.00/0.00', '2110 0.00/14980.00'].sort().join(' | '));
    expect(gl(VAT, '1170') - g1170).toBe(sat('700.00')); // only the services VAT moved 1170
    expect(get(d.id).outstanding).toBe('14980.00');
    assertBalanced(st);
  });

  it('a VAT-inclusive vendor price keeps the same split (gross 107.00 = net 100.00 + VAT 7.00)', () => {
    const d = pb(VAT, PV1, [L('a', 'S7', '107.00', { expenseCategory: 'rent' })], { priceIncludesVat: true });
    expect(d.totals).toMatchObject({ net: '100.00', vat: '7.00', total: '107.00' });
    expect(lines(d.id)).toBe(['5110 100.00/0.00', '1170 7.00/0.00', '2110 0.00/107.00'].sort().join(' | '));
    assertBalanced(st);
  });

  it('npb-1 vector: a non-VAT company is billed 1,000.00 + VAT 7 % -> AP 1,070.00, the VAT is cost on 5170, GL 1170 untouched', () => {
    const g1170 = gl(NV, '1170'), g2110 = gl(NV, '2110');
    const d = pb(NV, NV_REG, [L('a', 'S7', '1000.00', { expenseCategory: 'rent' })]);
    expect(d.totals).toMatchObject({ net: '1000.00', vat: '70.00', total: '1070.00' });
    expect(lines(d.id)).toBe(['5110 1000.00/0.00', '5170 70.00/0.00', '2110 0.00/1070.00'].sort().join(' | '));
    expect(get(d.id).outstanding).toBe('1070.00');
    expect(gl(NV, '1170') - g1170).toBe(0);
    expect(g1170).toBe(0); // and the seed's own non-VAT bills (npb-1) never touched it either
    expect(gl(NV, '2110') - g2110).toBe(-sat('1070.00'));
    assertBalanced(st);
  });

  it('I1 stays for OUR sales: a non-VAT invoice with an S7 line still carries no VAT', () => {
    const cust = st.parties.find((p) => p.companyId === NV && p.kind === 'customer')!.id;
    const d = createDraft(st, NV, 'IV', { header: { partyId: cust, documentDate: '2026-10-14' }, lines: [L('a', 'S7', '1000.00')] }, me, 'iv-i1');
    expect(d.totals).toMatchObject({ vat: '0.00', total: '1000.00' });
  });

  it('a bill of 0.00 is not a document (cancel instead of issuing it), like an invoice', () => {
    const d = draftPb(VAT, PV1, [L('a', 'S7', '0.00')]);
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('doc.total_not_positive');
  });

  it('an unknown expense category is refused (no silent fall-through to the default account)', () => {
    const d = draftPb(VAT, PV1, [L('a', 'S7', '100.00', { expenseCategory: 'nonsense' })]);
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('pb.unknown_category');
  });

  it('a capex line capitalises to the fixed-asset account of its class; its VAT is claimed', () => {
    const d = pb(VAT, PV3, [L('a', 'S7', '32000.00', { expenseCategory: 'capex-equipment', itemId: 'EXP-08' })]);
    expect(lines(d.id)).toBe(['1210 32000.00/0.00', '1170 2240.00/0.00', '2110 0.00/34240.00'].sort().join(' | '));
    assertBalanced(st);
  });

  it('the category of the picked item applies when the line names none', () => {
    const g1170 = gl(VAT, '1170');
    const d = pb(VAT, PV3, [L('a', 'S7', '4500.00', { itemId: 'EXP-07' })]); // EXP-07 = entertainment
    expect(lines(d.id)).toContain('5170 315.00/0.00');
    expect(gl(VAT, '1170') - g1170).toBe(0);
  });
});

describe('claim period (I6): document month .. +6, default the document month', () => {
  const claim = (period: string | undefined) => {
    const d = draftPb(VAT, PV1, [L('a', 'S7', '100.00')], { documentDate: '2026-10-14', ...(period ? { claimPeriod: period } : {}) });
    return err(() => issue(st, d.id, d.version, me)).code ?? 'ok';
  };
  it('both ends of the window are inside, one month either side is outside', () => {
    expect(claim('2026-10')).toBe('ok');
    expect(claim('2027-04')).toBe('ok');
    expect(claim('2027-05')).toBe('pb.claim_period_out_of_range');
    expect(claim('2026-09')).toBe('pb.claim_period_out_of_range');
    expect(claim('2026-13')).toBe('pb.claim_period_out_of_range');
    expect(claim('26-10')).toBe('pb.claim_period_out_of_range');
  });
  it('an absent claim period becomes the document month at issue', () => {
    const d = pb(VAT, PV1, [L('a', 'S7', '100.00')], { documentDate: '2026-10-10' });
    expect(get(d.id).header.claimPeriod).toBe('2026-10');
  });
  it('a revision that leaves the claim period out files the bill in its document month (the editor clears a period that only followed the date)', () => {
    const d = pb(VAT, PV1, [L('a', 'S7', '100.00')], { documentDate: '2026-10-10', claimPeriod: '2026-12' });
    const { claimPeriod: _c, ...header } = get(d.id).header; void _c;
    const r = revise(st, d.id, { header, lines: get(d.id).lines }, get(d.id).version, 'x', me);
    expect(r.header.claimPeriod).toBe('2026-10');
    assertBalanced(st);
  });
  it('the window crosses a year end (document 2026-12, claim 2027-06 ok, 2027-07 not)', () => {
    const at = (p: string) => { const d = draftPb(VAT, PV1, [L('a', 'S7', '100.00')], { documentDate: '2026-12-01', claimPeriod: p }); return compute(st, VAT, 'PB', { header: d.header, lines: d.lines }).missing.length ? 'missing' : 'ok'; };
    expect(at('2027-06')).toBe('ok');
    expect(at('2027-07')).toBe('missing');
  });
  it('a non-VAT company has no claim period: nothing to check', () => {
    const d = draftPb(NV, NV_REG, [L('a', 'S7', '100.00')], { claimPeriod: '2030-01' });
    expect(err(() => issue(st, d.id, d.version, me)).code).toBeUndefined();
  });
  it('the completeness flag never blocks issue', () => {
    const d = pb(VAT, PV1, [L('a', 'S7', '100.00')], { complete: false });
    expect(get(d.id)).toMatchObject({ status: 'issued', header: { complete: false } });
  });
  it('input VAT posted to 1170 for each claim period = the recoverable VAT of the bills claimed in it (the invariant reads both)', () => {
    pb(VAT, PV1, [L('a', 'S7', '1000.00')], { claimPeriod: '2026-10' });
    pb(VAT, PV1, [L('a', 'S7', '500.00'), L('b', 'S7', '100.00', { expenseCategory: 'entertainment' })], { claimPeriod: '2026-12' });
    assertBalanced(st);
    // break one: move the posted 1170 amount away from the document's claim period total
    const j = st.journals.find((x) => get(x.docId).header.claimPeriod === '2026-12' && x.docId.startsWith('doc-pb'))!;
    const l1170 = j.preview.entries[0].lines.find((l) => l.accountCode === '1170')!;
    l1170.debit = '1.00';
    expect(checkInvariants(st).join('\n')).toMatch(/claim period 2026-12/);
  });
});

describe('vendor credit / debit notes (PCN / PDN) against a purchase bill', () => {
  const bill = () => pb(VAT, PV3, [L('l1', 'S7', '10000.00', { expenseCategory: 'services' }), L('l2', 'S7', '4000.00', { expenseCategory: 'entertainment' })], { vendorDocNumber: 'INV-77' });
  const note = (type: 'PCN' | 'PDN', b: Doc, ls: DocLine[], header: Partial<Doc['header']> = {}) =>
    createDraft(st, VAT, type, { header: { documentDate: '2026-10-14', refDocId: b.id, reasonCode: type === 'PCN' ? 'PRICE_REDUCTION' : 'PRICE_INCREASE', ...header }, lines: ls }, me, `n-${++n}`);
  const issueNote = (type: 'PCN' | 'PDN', b: Doc, ls: DocLine[], header: Partial<Doc['header']> = {}) => { const d = note(type, b, ls, header); return issue(st, d.id, d.version, me); };
  const src = (id: string, s: string, taxCode: DocLine['taxCode'], price: string, p: Partial<DocLine> = {}) => L(id, taxCode, price, { sourceLineId: s, ...p });

  it('PCN reduces the bill outstanding, PDN raises it; GL 2110 = Σ outstanding(PB); the vendor and category come from the bill', () => {
    const g2110 = gl(VAT, '2110');
    const b = bill();
    const c = issueNote('PCN', b, [src('a', 'l1', 'S7', '1000.00')]);
    expect(c.totals).toMatchObject({ net: '1000.00', vat: '70.00', total: '1070.00' });
    expect(c.header.partyId).toBe(PV3);
    expect(c.lines[0].expenseCategory).toBe('services'); // the source line's category, server-set
    expect(get(b.id).outstanding).toBe('13910.00'); // 14,980.00 - 1,070.00
    expect(lines(c.id)).toBe(['2110 1070.00/0.00', '5120 0.00/1000.00', '1170 0.00/70.00'].sort().join(' | '));
    const dn = issueNote('PDN', b, [src('a', 'l2', 'S7', '500.00')]);
    expect(dn.totals).toMatchObject({ net: '500.00', vat: '35.00', total: '535.00' });
    expect(lines(dn.id)).toBe(['5150 500.00/0.00', '5170 35.00/0.00', '2110 0.00/535.00'].sort().join(' | ')); // entertainment: the debit's VAT is cost too
    expect(get(b.id).outstanding).toBe('14445.00'); // 13,910.00 + 535.00
    assertBalanced(st); // includes GL 2110 = Σ outstanding of live PB
    expect(gl(VAT, '2110') - g2110).toBe(-sat('14445.00'));
  });

  it('cancelling a note gives the outstanding back; a note needs a live bill and a reason code of its type', () => {
    const b = bill();
    const c = issueNote('PCN', b, [src('a', 'l1', 'S7', '1000.00')]);
    cancel(st, c.id, get(c.id).version, 'OTHER', 'x', me);
    expect(get(b.id).outstanding).toBe('14980.00');
    const d = note('PCN', b, [src('a', 'l1', 'S7', '1.00')], { reasonCode: 'PRICE_INCREASE' });
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('doc.incomplete');
    cancel(st, b.id, get(b.id).version, 'OTHER', 'x', me);
    const e = note('PCN', b, [src('a', 'l1', 'S7', '1.00')]);
    expect(err(() => issue(st, e.id, e.version, me)).code).toBe('doc.ref_not_live');
  });

  it('the cap: Σ PCN per line (net) never exceeds the bill line; a full credit gives back exactly the line VAT (rule B)', () => {
    const b = bill();
    expect(err(() => issueNote('PCN', b, [src('a', 'l1', 'S7', '10000.01')])).code).toBe('pcn.exceeds_original');
    const c1 = issueNote('PCN', b, [src('a', 'l1', 'S7', '3333.33')]);
    expect(err(() => issueNote('PCN', b, [src('a', 'l1', 'S7', '6666.68')])).code).toBe('pcn.exceeds_original');
    const c2 = issueNote('PCN', b, [src('a', 'l1', 'S7', '6666.67')]);
    expect(sat(c1.totals.vat) + sat(c2.totals.vat)).toBe(sat('700.00'));
    expect(get(b.id).outstanding).toBe('4280.00'); // 14,980.00 - 10,700.00
    assertBalanced(st);
  });

  it('a bill priced WITH VAT: the note is ex-VAT, the cap is the line NET (not the gross), and two halves give back exactly the line VAT', () => {
    const b = pb(VAT, PV1, [L('l1', 'S7', '107.00', { expenseCategory: 'rent' })], { priceIncludesVat: true });
    expect(b.totals).toMatchObject({ net: '100.00', vat: '7.00', total: '107.00' });
    expect(err(() => issueNote('PCN', b, [src('a', 'l1', 'S7', '100.01')])).code).toBe('pcn.exceeds_original');
    const c1 = issueNote('PCN', b, [src('a', 'l1', 'S7', '50.00')]);
    const c2 = issueNote('PCN', b, [src('a', 'l1', 'S7', '50.00')]);
    expect(c1.totals).toMatchObject({ net: '50.00', vat: '3.50', total: '53.50' });
    expect(sat(c1.totals.vat) + sat(c2.totals.vat)).toBe(sat('7.00'));
    expect(get(b.id).outstanding).toBe('0.00'); // credited in full: 107.00 - 53.50 - 53.50
    assertBalanced(st);
  });

  it('a PCN line must reference a bill line, be positive, and keep the bill\'s tax code; a PDN needs no cap', () => {
    const b = bill();
    expect(err(() => issueNote('PCN', b, [L('a', 'S7', '10.00')])).code).toBe('pcn.line_not_referenced');
    expect(err(() => issueNote('PCN', b, [src('a', 'l1', 'S7', '100.00'), src('b', 'l1', 'S7', '-5.00')])).code).toBe('note.line_not_positive'); // a credit cannot hide in a debit
    expect(err(() => issueNote('PCN', b, [src('a', 'l1', 'S7', '-5.00')])).code).toBe('doc.total_not_positive');
    expect(err(() => issueNote('PCN', b, [src('a', 'l1', 'EX', '5.00')])).code).toBe('doc.tax_code_mismatch');
    expect(err(() => issueNote('PCN', b, [src('a', 'nope', 'S7', '5.00')])).code).toBe('doc.line_not_found');
    expect(err(() => issueNote('PDN', b, [src('a', 'l1', 'S7', '99999.00')])).code).toBeUndefined();
  });

  it('the vendor is the bill\'s whatever the client sends; a note dated before the bill is refused', () => {
    const b = bill();
    const d = note('PCN', b, [src('a', 'l1', 'S7', '10.00')], { partyId: PV1 });
    expect(get(d.id).header.partyId).toBe(PV3);
    const e = note('PCN', b, [src('a', 'l1', 'S7', '10.00')], { documentDate: '2026-10-13' });
    expect(err(() => issue(st, e.id, e.version, me)).code).toBe('doc.date_before_original');
  });

  it('a vendor note is revised in place (L-class): the new total moves the bill outstanding and the one adjusts link, the cap and rule B hold, the bill stays', () => {
    const b = bill();
    const c = issueNote('PCN', b, [src('a', 'l1', 'S7', '1000.00')]);
    const body = (price: string, header: Partial<Doc['header']> = {}) => ({ header: { ...get(c.id).header, ...header }, lines: [src('a', 'l1', 'S7', price)] });
    expect(err(() => revise(st, c.id, body('10000.01'), get(c.id).version, 'x', me)).code).toBe('pcn.exceeds_original');
    expect(err(() => revise(st, c.id, body('1000.00', { refDocId: 'pb-1' }), get(c.id).version, 'x', me)).code).toBe('note.ref_locked');
    expect(err(() => revise(st, c.id, body('0.00'), get(c.id).version, 'x', me)).code).toBe('doc.total_not_positive');
    const r = revise(st, c.id, body('4000.00'), get(c.id).version, 'ส่วนลดเพิ่ม', me);
    expect(r.totals).toMatchObject({ net: '4000.00', vat: '280.00', total: '4280.00' });
    expect(r.lines[0].vatOverride).toBe('280.00'); // rule B: the VAT given back is this line's own, the note not counted among its predecessors
    expect(get(b.id).outstanding).toBe('10700.00'); // 14,980.00 - 4,280.00
    expect(st.links.filter((l) => l.active && l.kind === 'adjusts' && l.from === c.id).map((l) => l.amount)).toEqual(['4280.00']);
    expect(st.journals.find((x) => x.docId === c.id)!.preview.entries.map((e) => e.kind)).toEqual(['original', 'reversal', 'correction']);
    expect(lines(c.id)).toBe(['2110 1070.00/0.00', '5120 0.00/1000.00', '1170 0.00/70.00'].sort().join(' | ')); // the original entry stays as posted
    assertBalanced(st); // GL 2110 = Σ outstanding(PB), the claim period, the cap and the adjusts link all re-checked
    const second = issueNote('PCN', b, [src('a', 'l1', 'S7', '6000.00')]); // the line is now fully credited: 4,000.00 + 6,000.00
    expect(sat(r.totals.vat) + sat(second.totals.vat)).toBe(sat('700.00'));
    assertBalanced(st);
  });

  it('the bill cannot be cancelled while a live note adjusts it, nor while a payment voucher has settled it; cancelling the notes / voucher is the exit', () => {
    const b = bill();
    const c = issueNote('PCN', b, [src('a', 'l1', 'S7', '100.00')]);
    expect(err(() => cancel(st, b.id, get(b.id).version, 'OTHER', 'x', me)).code).toBe('doc.has_dependents');
    cancel(st, c.id, get(c.id).version, 'OTHER', 'x', me);
    const alloc: Allocation[] = [{ targetId: b.id, targetType: 'PB', amount: '5000.00' }];
    const pv = createDraft(st, VAT, 'PV', { header: { partyId: PV3, documentDate: '2026-10-14' }, lines: [], allocations: alloc }, me, 'pv-1');
    issue(st, pv.id, pv.version, me);
    expect(err(() => cancel(st, b.id, get(b.id).version, 'OTHER', 'x', me)).code).toBe('doc.has_dependents');
    assertBalanced(st);
  });

  it('a PB revise cannot go below what was paid; the revise reverses and reposts (L-class); the party and lines are frozen while a live note adjusts it', () => {
    const b = pb(VAT, PV1, [L('l1', 'S7', '1000.00', { expenseCategory: 'rent' })]);
    const pv = createDraft(st, VAT, 'PV', { header: { partyId: PV1, documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: b.id, targetType: 'PB', amount: '800.00' }] }, me, 'pv-2');
    issue(st, pv.id, pv.version, me);
    const low = { header: get(b.id).header, lines: [L('l1', 'S7', '700.00', { expenseCategory: 'rent' })] };
    expect(err(() => revise(st, b.id, low, get(b.id).version, 'x', me)).code).toBe('settle.below_settled');
    expect(err(() => revise(st, b.id, { header: { ...get(b.id).header, partyId: PV3 }, lines: get(b.id).lines }, get(b.id).version, 'x', me)).code).toBe('doc.party_locked');
    expect(err(() => revise(st, b.id, { header: get(b.id).header, lines: [L('l1', 'S7', '2000.00', { expenseCategory: 'rent' })] }, get(b.id).version, 'x', me)).code).toBe('pb.settled_locked'); // a paid bill's lines are frozen (cancel the voucher first)
    cancel(st, pv.id, get(pv.id).version, 'OTHER', 'x', me);
    const ok = revise(st, b.id, { header: get(b.id).header, lines: [L('l1', 'S7', '2000.00', { expenseCategory: 'rent' })] }, get(b.id).version, 'x', me);
    expect(ok.totals.total).toBe('2140.00');
    expect(get(b.id).outstanding).toBe('2140.00');
    expect(st.journals.find((j) => j.docId === b.id)!.preview.entries.map((e) => e.kind)).toEqual(['original', 'reversal', 'correction']);
    assertBalanced(st);
    // a live note freezes the lines
    const c = issueNote('PCN', get(b.id), [src('a', 'l1', 'S7', '10.00')]);
    expect(err(() => revise(st, b.id, { header: get(b.id).header, lines: [L('l1', 'S7', '3000.00', { expenseCategory: 'rent' })] }, get(b.id).version, 'x', me)).code).toBe('pb.has_notes');
    expect(err(() => revise(st, b.id, { header: { ...get(b.id).header, notes: 'ok' }, lines: get(b.id).lines }, get(b.id).version, 'x', me)).code).toBeUndefined(); // header text is fine
    cancel(st, c.id, get(c.id).version, 'OTHER', 'x', me);
    assertBalanced(st);
  });
});

describe('PO -> PB (D-29, strict remaining quantity)', () => {
  const po = () => {
    const p = createDraft(st, VAT, 'PO', { header: { partyId: PV1, documentDate: '2026-10-14' }, lines: [L('l1', 'S7', '100.00', { qty: '20' })] }, me, `po-${++n}`);
    return issue(st, p.id, p.version, me);
  };
  it('a PB cannot be edited past the PO line\'s remainder, at issue or at revise; the exact remainder is fine', () => {
    const p = po();
    const first = convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '12' }], me);
    const second = convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '8' }], me);
    // second grows by hand to 9 -> 21 in total
    const grown = { header: get(second.id).header, lines: get(second.id).lines.map((l) => ({ ...l, qty: '9' })) };
    st.docs[st.docs.findIndex((x) => x.id === second.id)] = { ...get(second.id), lines: grown.lines };
    expect(err(() => issue(st, second.id, get(second.id).version, me)).code).toBe('doc.over_conversion');
    st.docs[st.docs.findIndex((x) => x.id === second.id)] = { ...get(second.id), lines: get(second.id).lines.map((l) => ({ ...l, qty: '8' })) };
    const a = issue(st, first.id, first.version, me);
    const b = issue(st, second.id, get(second.id).version, me);
    expect(buildChain(st, p.id).nodes.find((x) => x.id === p.id)!.progress).toBe('รับวางบิลแล้ว 20/20');
    expect(err(() => revise(st, a.id, { header: a.header, lines: a.lines.map((l) => ({ ...l, qty: '13' })) }, a.version, 'x', me)).code).toBe('doc.over_conversion');
    expect(err(() => revise(st, b.id, { header: b.header, lines: b.lines.map((l) => ({ ...l, qty: '7' })) }, b.version, 'x', me)).code).toBeUndefined();
    recomputeSettlement(st, a.id);
    assertBalanced(st);
  });
});

describe('the P2 seed (hand-checked)', () => {
  const j = (id: string) => lines(id);
  const period = (company: string, p: string) => st.journals.reduce((a, x) => {
    const d = get(x.docId);
    if (d.companyId !== company || !(d.type === 'PB' || d.type === 'PCN' || d.type === 'PDN') || (d.header.claimPeriod ?? d.header.documentDate.slice(0, 7)) !== p) return a;
    return a + x.preview.entries.reduce((b, e) => b + e.lines.filter((l) => l.accountCode === '1170').reduce((c, l) => c + sat(l.debit) - sat(l.credit), 0), 0);
  }, 0);
  it('every fixture resolves and the invariants hold', () => {
    assertBalanced(st);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('pb-1 / pcn-1: rent 25,000.00 + 1,750.00; the vendor gives 2,500.00 + 175.00 back', () => {
    expect(j('pb-1')).toBe(['5110 25000.00/0.00', '1170 1750.00/0.00', '2110 0.00/26750.00'].sort().join(' | '));
    expect(j('pcn-1')).toBe(['5110 0.00/2500.00', '1170 0.00/175.00', '2110 2675.00/0.00'].sort().join(' | '));
    expect(get('pb-1').outstanding).toBe('0.00'); // 24,075.00 after pcn-1, paid in full by pv-pay1 (P3)
  });
  it('pb-2 / pdn-1: the entertainment VAT 315.00 (and the debit\'s 35.00) is cost on 5170, never on 1170', () => {
    expect(j('pb-2')).toBe(['5120 18000.00/0.00', '5150 4500.00/0.00', '1170 1260.00/0.00', '5170 315.00/0.00', '2110 0.00/24075.00'].sort().join(' | '));
    expect(j('pdn-1')).toBe(['5150 500.00/0.00', '5170 35.00/0.00', '2110 0.00/535.00'].sort().join(' | '));
    expect(get('pb-2').outstanding).toBe('12305.00'); // 24,610.00 with pdn-1, half paid by pv-multi (P3)
  });
  it('npb-1 / npb-2: the non-VAT company books the vendor VAT as cost; GL 1170 stays 0', () => {
    expect(j('npb-1')).toBe(['5120 1000.00/0.00', '5170 70.00/0.00', '2110 0.00/1070.00'].sort().join(' | '));
    expect(get('npb-1').totals).toMatchObject({ vat: '70.00', total: '1070.00' });
    expect(j('npb-2')).toBe(['5100 6000.00/0.00', '2110 0.00/6000.00'].sort().join(' | '));
    expect(gl(NV, '1170')).toBe(0);
  });
  it('pb-capex capitalises to 1210; pb-po is half of po-part; the claim periods add up (2026-10: 5,719.00, 2026-12: 595.00)', () => {
    expect(j('pb-capex')).toBe(['1210 32000.00/0.00', '1170 2240.00/0.00', '2110 0.00/34240.00'].sort().join(' | '));
    expect(get('pb-po').totals).toMatchObject({ net: '1900.00', vat: '133.00', total: '2033.00' });
    expect(buildChain(st, 'po-part').nodes.find((x) => x.id === 'po-part')!.progress).toBe('รับวางบิลแล้ว 70/140');
    expect(period(VAT, '2026-10')).toBe(sat('5719.00')); // + pb-prep 70.00 and pb-net 280.00 (FN3)
    expect(period(VAT, '2026-12')).toBe(sat('595.00'));
    expect(gl(VAT, '2110')).toBe(-sat('112484.00')); // Σ outstanding of the live bills: 0 (pb-1, paid) + 12,305 (pb-2, half paid) + 1,033 (pb-po, 1,000 paid) + 34,240 + 9,095 + 2,461 + 1,070 (pb-prep) + 4,280 (pb-net), FN3, + 12,000 (pb-ins, AC4) + 36,000 (pb-printer, AC5: two EX capex lines, no VAT)
  });
  it('pb-incomplete issued with its paperwork flag off; the pb-d1 draft posts nothing', () => {
    expect(get('pb-incomplete')).toMatchObject({ status: 'issued', header: { complete: false } });
    expect(st.journals.some((x) => x.docId === 'pb-d1')).toBe(false);
  });
});

describe('the purchase invariants have teeth (each one is broken on purpose and must be reported)', () => {
  const msgs = () => checkInvariants(st).join('\n');
  it('the AP subledger per vendor: a payable posted under another vendor is reported', () => {
    const j = st.journals.find((x) => x.docId === 'pb-1')!;
    j.preview.entries[0].lines.find((l) => l.accountCode === '2110')!.partyName = 'ผู้ขายอื่น';
    expect(msgs()).toMatch(/AP 2110 of .*: GL .* but outstanding of their live PB/);
  });
  it('a vendor note must have exactly one active adjusts link of its total, to a live bill of the same vendor', () => {
    const l = st.links.find((x) => x.from === 'pcn-1' && x.kind === 'adjusts')!;
    l.amount = '1.00';
    expect(msgs()).toMatch(/pcn-1: PCN needs exactly one active adjusts link/);
    l.amount = get('pcn-1').totals.total;
    get('pcn-1').header.partyId = 'pv-05';
    expect(msgs()).toMatch(/pcn-1: PCN party pv-05 is not the party of pb-1/);
  });
  it('the credit cap watchdog: a PCN line that credits more than the bill line is reported', () => {
    get('pcn-1').lines[0].unitPrice = '30000.00';
    expect(msgs()).toMatch(/credit notes take net .* which exceeds the line's net/);
  });
  it('a non-VAT company must not move 1170', () => {
    const j = st.journals.find((x) => x.docId === 'npb-1')!;
    j.preview.entries[0].lines.find((l) => l.accountCode === '5170')!.accountCode = '1170';
    expect(msgs()).toMatch(/co-nonvat: not VAT-registered but GL 1170 moved/);
  });
  it('a payment voucher cannot settle a bill of another vendor; a bill\'s party is locked under a live note', () => {
    const pv = (party: string) => createDraft(st, VAT, 'PV', { header: { partyId: party, documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'pb-2', targetType: 'PB', amount: '100.00' }] }, me, `pv-${++n}`);
    const d = pv(PV1);
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('settle.party_mismatch');
    const b = get('pb-2'); // pdn-1 adjusts it
    expect(err(() => revise(st, b.id, { header: { ...b.header, partyId: PV1 }, lines: b.lines }, b.version, 'x', me)).code).toBe('doc.party_locked');
  });
});
