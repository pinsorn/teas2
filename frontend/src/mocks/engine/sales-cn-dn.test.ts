import { beforeEach, describe, expect, it } from 'vitest';
import type { Allocation, Doc, DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { seed, type MockState } from '../store';
import { cancel, compute, createDraft, issue, publicDoc, reissue, revise } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import { toSatang } from './money';
import { PAPER_BUILDERS } from './paper';
import { assertBalanced } from './test-helpers';

const VAT = 'co-vat';
let st: MockState;
let n = 0;
beforeEach(() => { st = seed(); });
const sat = (m: string) => toSatang(m);
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const err = (fn: () => unknown): { code?: string; title?: string } => { try { fn(); } catch (e) { return e as { code?: string; title?: string }; } return {}; };
const customer = () => st.parties.find((p) => p.companyId === VAT && p.kind === 'customer' && p.vatRegistered && p.taxId)!;
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode, ...p });

/** An issued TI of a VAT customer through the engine. */
const ti = (lines: DocLine[], partyId = customer().id): Doc => {
  const d = createDraft(st, VAT, 'TI', { header: { partyId, documentDate: '2026-10-01' }, lines }, me, `ti-${++n}`);
  return issue(st, d.id, d.version, me);
};
const draftOf = (type: 'CN' | 'DN', t: Doc, lines: DocLine[], header: Partial<Doc['header']> = {}): Doc =>
  createDraft(st, VAT, type, { header: { documentDate: '2026-10-14', refDocId: t.id, reasonCode: type === 'CN' ? 'PRICE_REDUCTION' : 'PRICE_INCREASE', ...header }, lines }, me, `note-${++n}`);
const note = (type: 'CN' | 'DN', t: Doc, lines: DocLine[], header: Partial<Doc['header']> = {}): Doc => {
  const d = draftOf(type, t, lines, header);
  return issue(st, d.id, d.version, me);
};
/** A note line crediting / debiting `price` of the TI line `src`. */
const nl = (id: string, src: string, taxCode: DocLine['taxCode'], price: string, p: Partial<DocLine> = {}): DocLine => L(id, taxCode, price, { sourceLineId: src, ...p });

/** SP0 7.11 as a formula over the links alone: total - Σ CN + Σ DN - Σ active settles. */
const owed = (id: string): number => {
  let out = sat(get(id).totals.total);
  for (const l of st.links) {
    if (!l.active || l.to !== id) continue;
    const t = get(l.from).type;
    if (l.kind === 'settles') out -= sat(l.amount!);
    else if (l.kind === 'adjusts') out += t === 'CN' ? -sat(l.amount!) : t === 'DN' ? sat(l.amount!) : 0;
  }
  return out;
};
const rcOf = (t: Doc, amount: string): Doc => {
  const allocations: Allocation[] = [{ targetId: t.id, targetType: 'TI', amount }];
  const d = createDraft(st, VAT, 'RC', { header: { partyId: t.header.partyId, documentDate: '2026-10-14' }, lines: [], allocations }, me, `rc-${++n}`);
  return issue(st, d.id, d.version, me);
};
const role = (docId: string, r: string, side: 'debit' | 'credit') => (st.journals.find((j) => j.docId === docId)?.preview.entries[0].lines ?? [])
  .filter((l) => new RegExp(`: ${r} → `).test(l.rule)).reduce((a, l) => a + sat(l[side]), 0);

describe('rule B for line-based notes: each note line carries the VAT change of its own invoice line (cumulative, to the satang)', () => {
  // TI: l1 S7 100.10 (VAT 7.01), l2 Z0 50.55, l3 EX 20.00 -> total 177.66
  const mixed = () => ti([L('l1', 'S7', '100.10'), L('l2', 'Z0', '50.55'), L('l3', 'EX', '20.00')]);
  it('mixed S7 / Z0 / EX: two credits of l1 (50.05 + 50.05) take exactly its VAT 7.01 (3.51 + 3.50), not 3.50 + 3.50', () => {
    const t = mixed();
    expect(t.totals).toMatchObject({ net: '170.65', vat: '7.01', total: '177.66' });
    const c1 = note('CN', t, [nl('a', 'l1', 'S7', '50.05'), nl('b', 'l2', 'Z0', '10.00'), nl('c', 'l3', 'EX', '5.00')]);
    expect(c1.totals).toMatchObject({ net: '65.05', vat: '3.51', total: '68.56' }); // naive rate x net would give VAT 3.50
    expect(c1.lines.map((l) => l.vatOverride)).toEqual(['3.51', '0.00', '0.00']);
    expect(get(t.id).outstanding).toBe('109.10');
    const c2 = note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    expect(c2.totals).toMatchObject({ net: '50.05', vat: '3.50', total: '53.55' });
    expect(sat(c1.totals.vat) + sat(c2.totals.vat)).toBe(sat('7.01')); // l1's whole VAT is credited, no satang left over
    expect(get(t.id).outstanding).toBe('55.55'); // 177.66 - 68.56 - 53.55 = l2 40.55 + l3 15.00
    expect(sat(get(t.id).outstanding!)).toBe(owed(t.id));
    expect(get(t.id).status).toBe('issued');
    expect(role(c1.id, 'AR', 'credit')).toBe(sat('68.56')); // mirror of the sales posting on the CN's own totals
    expect(role(c1.id, 'OutputVat', 'debit')).toBe(sat('3.51'));
    expect(role(c1.id, 'SalesReturn', 'debit')).toBe(sat('65.05'));
    assertBalanced(st);
  });
  it('cancel order does not drift: A 50.05, B 50.05, cancel A, then C 50.05 still credits the VAT 7.01 of the line in total', () => {
    const t = ti([L('l1', 'S7', '100.10')]);
    const A = note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    const B = note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    expect([A.totals.vat, B.totals.vat]).toEqual(['3.51', '3.50']);
    cancel(st, A.id, A.version, 'OTHER', 'ออกผิด', me);
    const C = note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    expect(sat(B.totals.vat) + sat(C.totals.vat)).toBe(sat('7.01')); // naive: 3.50 + 3.50 = 7.00, a satang of the invoice VAT never credited
    expect(get(t.id).outstanding).toBe('0.00');
    assertBalanced(st);
  });
  it('a debit note carries the same VAT change as the correction plan: 100.10 + 0.50 -> net 0.50 VAT 0.03 total 0.53', () => {
    const t = ti([L('l1', 'S7', '100.10')]);
    const dn = note('DN', t, [nl('a', 'l1', 'S7', '0.50')]);
    expect(dn.totals).toMatchObject({ net: '0.50', vat: '0.03', total: '0.53' });
    expect(get(t.id).outstanding).toBe('107.64');
    const t2 = ti([L('l1', 'S7', '100.10')]);
    const plan = correctionPlan(st, t2.id, { header: t2.header, lines: [L('l1', 'S7', '100.60')] }, 'accountant');
    expect(plan.steps[0].note).toMatchObject({ type: 'DN', total: '0.53' });
    assertBalanced(st);
  });
  it('ONE calculation: the user credit of 50.05 and the plan that lowers the line to 50.05 post the same note', () => {
    const a = ti([L('l1', 'S7', '100.10'), L('l2', 'Z0', '50.55')]);
    const user = note('CN', a, [nl('x', 'l1', 'S7', '50.05')]);
    const b = ti([L('l1', 'S7', '100.10'), L('l2', 'Z0', '50.55')]);
    const plan = correctionPlan(st, b.id, { header: b.header, lines: [L('l1', 'S7', '50.05'), L('l2', 'Z0', '50.55')] }, 'accountant');
    const viaPlan = get(executePlan(st, plan.planId, plan.planHash, me).affected.find((x) => x.type === 'CN')!.docId);
    expect(viaPlan.totals).toMatchObject({ net: user.totals.net, vat: user.totals.vat, total: user.totals.total });
    expect(viaPlan.lines.map((l) => [l.sourceLineId, l.vatOverride])).toEqual([['l1', '3.51']]);
    expect(viaPlan.header.refDocId).toBe(b.id);
    assertBalanced(st);
  });
  it('mixed S7 / Z0 / EX through the plan: net, VAT and total are |proposed - original| and the note lines reference the invoice lines', () => {
    const t = mixed();
    const plan = correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '60.00'), L('l2', 'Z0', '40.00'), L('l3', 'EX', '20.00')] }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn']);
    const cn = get(executePlan(st, plan.planId, plan.planHash, me).affected[0].docId);
    // l1 100.10 -> 60.00: net 40.10, VAT 7.01 - 4.20 = 2.81; l2 50.55 -> 40.00: net 10.55
    expect(cn.totals).toMatchObject({ net: '50.65', vat: '2.81', total: '53.46' });
    expect(cn.lines.map((l) => l.sourceLineId)).toEqual(['l1', 'l2']);
    expect(get(t.id).outstanding).toBe('124.20'); // 177.66 - 53.46
    assertBalanced(st);
  });
});

describe('G3: the per-line cap counts every active credit note, user or plan', () => {
  it('a credit above the remaining creditable amount of a line -> cn.exceeds_original naming the line and what is left', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    note('CN', t, [nl('a', 'l1', 'S7', '600.00')]);
    const e = err(() => note('CN', t, [nl('a', 'l1', 'S7', '500.00')]));
    expect(e.code).toBe('cn.exceeds_original');
    expect(e.title).toContain('รายการ l1');
    expect(e.title).toContain('400.00');
    expect(note('CN', t, [nl('a', 'l1', 'S7', '400.00')]).totals.total).toBe('428.00'); // exactly the rest is allowed
    expect(get(t.id).outstanding).toBe('0.00');
    assertBalanced(st);
  });
  it('a refused issue writes nothing: no number, no link, no journal', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    const d = draftOf('CN', t, [nl('a', 'l1', 'S7', '100.01')]);
    const before = JSON.stringify(st);
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('cn.exceeds_original');
    expect(JSON.stringify(st)).toBe(before);
  });
  it('the editor learns about it too: compute reports the cap as a missing item', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    const r = compute(st, VAT, 'CN', { header: { documentDate: '2026-10-14', refDocId: t.id, reasonCode: 'RETURN' }, lines: [nl('a', 'l1', 'S7', '100.01')] });
    expect(r.missing.map((m) => m.message).join(';')).toContain('100.00');
  });
  it('a plan CN followed by a user CN on the same line: the user CN may only take what the plan left', () => {
    const t = ti([L('l1', 'S7', '1000.00'), L('l2', 'S7', '500.00')]);
    const plan = correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '600.00'), L('l2', 'S7', '500.00')] }, 'accountant');
    const planCn = get(executePlan(st, plan.planId, plan.planHash, me).affected[0].docId);
    expect(planCn.totals.net).toBe('400.00');
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '700.00')])).code).toBe('cn.exceeds_original');
    const user = note('CN', t, [nl('a', 'l1', 'S7', '600.00')]);
    expect(user.totals.net).toBe('600.00');
    expect(sat(planCn.totals.vat) + sat(user.totals.vat)).toBe(sat('70.00')); // l1's VAT 70.00 is fully credited, in two pieces
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '0.01')])).code).toBe('cn.exceeds_original');
    assertBalanced(st);
  });
  it('a cancelled credit note releases its share of the cap', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '1000.00')]);
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '1.00')])).code).toBe('cn.exceeds_original');
    cancel(st, c.id, c.version, 'OTHER', 'ออกผิด', me);
    expect(get(t.id).outstanding).toBe('1070.00');
    expect(note('CN', t, [nl('a', 'l1', 'S7', '1000.00')]).totals.total).toBe('1070.00');
    assertBalanced(st);
  });
  it('a correction plan on an invoice with a live CN is refused before it is shown (F1; it used to be the cap, now the earlier guard)', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    note('CN', t, [nl('a', 'l1', 'S7', '900.00')]);
    expect(err(() => correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '500.00')] }, 'accountant')).code).toBe('correction.notes_exist');
  });
  it('a debit note is not capped', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    expect(note('DN', t, [nl('a', 'l1', 'S7', '500.00')]).totals.total).toBe('535.00');
    expect(get(t.id).outstanding).toBe('642.00');
    assertBalanced(st);
  });
});

describe('the server owns the reference, the party and the company', () => {
  it('a note without refDocId -> doc.incomplete "ต้องอ้างอิงใบกำกับภาษี"; so is one without a reason', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    const d = createDraft(st, VAT, 'CN', { header: { partyId: t.header.partyId, documentDate: '2026-10-14', reasonCode: 'RETURN' }, lines: [L('a', 'S7', '10.00', { sourceLineId: 'l1' })] }, me, 'noref');
    const e = err(() => issue(st, d.id, d.version, me));
    expect(e.code).toBe('doc.incomplete');
    expect(e.title).toContain('ต้องอ้างอิงใบกำกับภาษี');
    const r = draftOf('CN', t, [nl('a', 'l1', 'S7', '10.00')], { reasonCode: undefined });
    expect(err(() => issue(st, r.id, r.version, me)).code).toBe('doc.incomplete');
  });
  it('reason OTHER needs a text; a code of the other note type or an unknown code is incomplete', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    const other = draftOf('CN', t, [nl('a', 'l1', 'S7', '10.00')], { reasonCode: 'OTHER' });
    expect(err(() => issue(st, other.id, other.version, me)).code).toBe('doc.incomplete');
    const wrong = draftOf('CN', t, [nl('a', 'l1', 'S7', '10.00')], { reasonCode: 'PRICE_INCREASE' });
    expect(err(() => issue(st, wrong.id, wrong.version, me)).code).toBe('doc.incomplete');
    const ok = draftOf('CN', t, [nl('a', 'l1', 'S7', '10.00')], { reasonCode: 'OTHER', reasonText: 'ลูกค้าต่อรองราคา' });
    expect(issue(st, ok.id, ok.version, me).header.reasonText).toBe('ลูกค้าต่อรองราคา');
  });
  it('the note\'s customer is the invoice\'s customer whatever the client sent; the reference is the invoice number', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    const other = st.parties.find((p) => p.companyId === VAT && p.kind === 'customer' && p.id !== t.header.partyId)!;
    const c = note('CN', t, [nl('a', 'l1', 'S7', '10.00')], { partyId: other.id });
    expect(c.header.partyId).toBe(t.header.partyId);
    expect(c.party?.id).toBe(t.header.partyId);
    expect(c.header.reference).toBe(t.number);
  });
  it('the invoice must exist in this company, be a TI, and be live', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    const iv = st.docs.find((d) => d.companyId === 'co-nonvat' && d.type === 'IV' && d.status === 'issued')!;
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '10.00')], { refDocId: iv.id })).code).toBe('doc.ref_not_found');
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '10.00')], { refDocId: 'nope' })).code).toBe('doc.ref_not_found');
    const foreign = ti([L('l1', 'S7', '5.00')]);
    get(foreign.id).companyId = 'co-nonvat'; // a tax invoice of another company is not this company's to adjust
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '1.00')], { refDocId: foreign.id })).code).toBe('doc.ref_not_found');
    const draftTi = createDraft(st, VAT, 'TI', { header: { partyId: customer().id, documentDate: '2026-10-01' }, lines: [L('l1', 'S7', '5.00')] }, me, 'dr');
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '1.00')], { refDocId: draftTi.id })).code).toBe('doc.ref_not_live');
    cancel(st, t.id, t.version, 'OTHER', 'x', me);
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '10.00')])).code).toBe('doc.ref_not_live');
  });
  it('the lines must reference the invoice: an unknown line, another tax code, or a positive credit with no reference is refused', () => {
    const t = ti([L('l1', 'S7', '100.00'), L('l2', 'Z0', '10.00')]);
    expect(err(() => note('CN', t, [nl('a', 'zz', 'S7', '10.00')])).code).toBe('doc.line_not_found');
    expect(err(() => note('CN', t, [nl('a', 'l2', 'S7', '1.00')])).code).toBe('doc.tax_code_mismatch');
    expect(err(() => note('CN', t, [L('a', 'S7', '10.00')])).code).toBe('cn.line_not_referenced');
    expect(note('DN', t, [L('a', 'S7', '10.00')]).totals.total).toBe('10.70'); // a debit note may charge something the invoice did not list
  });
  it('an invoice with VAT-inclusive prices is adjusted by a correction plan only; a user line is refused, the editor is told', () => {
    const d = createDraft(st, VAT, 'TI', { header: { partyId: customer().id, documentDate: '2026-10-01', priceIncludesVat: true }, lines: [L('l1', 'S7', '107.00')] }, me, 'incl');
    const t = issue(st, d.id, d.version, me);
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '50.00')])).code).toBe('doc.inclusive_invoice');
    const r = compute(st, VAT, 'CN', { header: { documentDate: '2026-10-14', refDocId: t.id, reasonCode: 'RETURN' }, lines: [nl('a', 'l1', 'S7', '50.00')] });
    expect(r.missing.map((m) => m.message).join(';')).toContain('แผนการแก้ไข');
    const plan = correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '100.00')] }, 'accountant'); // the plan sets its own VAT: still available
    expect(plan.steps[0]).toMatchObject({ action: 'issue_cn' });
    expect(get(executePlan(st, plan.planId, plan.planHash, me).affected[0].docId).totals.total).toBe('7.00');
    assertBalanced(st);
  });
  it('a note dated before its invoice is refused', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '10.00')], { documentDate: '2026-09-30' })).code).toBe('doc.date_before_original');
  });
  it('a note with a total of 0.00 or less is not a document', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '0.00')])).code).toBe('doc.total_not_positive');
  });
  it('the non-VAT company has no credit or debit notes: its draft cannot be issued', () => {
    const iv = st.docs.find((d) => d.companyId === 'co-nonvat' && d.type === 'IV' && d.status === 'issued')!;
    const d = createDraft(st, 'co-nonvat', 'CN', { header: { documentDate: '2026-10-14', refDocId: iv.id, reasonCode: 'RETURN' }, lines: [nl('a', 'l1', 'EX', '1.00')] }, me, 'nv2');
    expect(err(() => issue(st, d.id, d.version, me)).code).toBe('doc.incomplete');
  });
});

describe('outstanding after a note (SP0 7.11, I5)', () => {
  it('a full credit of an unpaid TI leaves it issued with outstanding 0.00 (Ham ruling), to the satang', () => {
    const t = ti([L('l1', 'S7', '100.10'), L('l2', 'Z0', '50.55'), L('l3', 'EX', '20.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '100.10'), nl('b', 'l2', 'Z0', '50.55'), nl('c', 'l3', 'EX', '20.00')], { reasonCode: 'RETURN' });
    expect(c.totals.total).toBe(t.totals.total);
    expect([get(t.id).status, get(t.id).outstanding]).toEqual(['issued', '0.00']);
    expect(owed(t.id)).toBe(0);
    assertBalanced(st);
  });
  it('a credit on a paid TI within the cap makes the outstanding negative (customer credit) and the status stays settled', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    rcOf(t, '1070.00');
    expect(get(t.id).status).toBe('settled');
    const c = note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    expect(get(t.id).outstanding).toBe('-107.00');
    expect(get(t.id).status).toBe('settled');
    expect(owed(t.id)).toBe(-sat(c.totals.total));
    assertBalanced(st);
  });
  it('cancelling the TI is refused while a note adjusts it; allowed once the note is cancelled', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '10.00')]);
    expect(err(() => cancel(st, t.id, get(t.id).version, 'OTHER', 'x', me)).code).toBe('doc.has_dependents');
    cancel(st, c.id, c.version, 'OTHER', 'x', me);
    cancel(st, t.id, get(t.id).version, 'OTHER', 'x', me);
    assertBalanced(st);
  });
});

describe('I9 / ledger 193: a note is reissued at its date and total, and its fiscal fields are not edited in place', () => {
  it('reissue with a different total -> doc.reissue_total_changed', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    expect(err(() => reissue(st, c.id, { header: c.header, lines: [nl('a', 'l1', 'S7', '200.00')] }, me, 'แก้ยอด')).code).toBe('doc.reissue_total_changed');
    expect(get(c.id).status).toBe('issued');
  });
  it('reissue at the same total keeps date, reference and the link; the invoice outstanding is unchanged', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '100.00'), nl('b', 'l1', 'S7', '100.00')]);
    const before = get(t.id).outstanding;
    const re = reissue(st, c.id, { header: { ...c.header, documentDate: '2026-10-10' }, lines: [nl('a', 'l1', 'S7', '200.00')] }, me, 'รวมบรรทัด');
    expect(re.header.documentDate).toBe(c.header.documentDate);
    expect(re.header.refDocId).toBe(t.id);
    expect(re.totals.total).toBe(c.totals.total);
    expect(get(t.id).outstanding).toBe(before);
    expect(st.links.filter((l) => l.active && l.kind === 'adjusts' && l.to === t.id).map((l) => l.from)).toEqual([re.id]);
    assertBalanced(st);
  });
  it('a fiscal edit of an issued note outside a plan -> doc.revise_not_allowed (lines, date, reference, reason); notes are free', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const other = ti([L('l1', 'S7', '1000.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    const go = (header: Partial<Doc['header']>, lines: DocLine[] = c.lines) => err(() => revise(st, c.id, { header: { ...c.header, ...header }, lines }, c.version, 'x', me)).code;
    expect(go({}, [nl('a', 'l1', 'S7', '150.00')])).toBe('doc.revise_not_allowed');
    expect(go({ documentDate: '2026-10-12' })).toBe('doc.revise_not_allowed');
    expect(go({ refDocId: other.id })).toBe('doc.revise_not_allowed');
    expect(go({ reasonCode: 'RETURN' })).toBe('doc.revise_not_allowed');
    const lines = c.lines.map(({ vatOverride, ...l }) => (void vatOverride, l)); // what an API client sends back: the engine-set VAT is stripped
    const ok = revise(st, c.id, { header: { ...c.header, notes: 'ติดตามเอกสารคืน' }, lines }, c.version, 'หมายเหตุ', me);
    expect(ok.header.notes).toBe('ติดตามเอกสารคืน');
    expect(ok.totals).toEqual(c.totals);
    expect(ok.lines).toEqual(c.lines);
    assertBalanced(st);
  });
  it('a correction plan that only changes the reason of a note cancels and reissues it at the same total and date, on the same invoice', () => {
    const t = ti([L('l1', 'S7', '100.10'), L('l2', 'S7', '50.55')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '50.05'), nl('b', 'l2', 'S7', '10.00')]);
    const lines = c.lines.map(({ vatOverride, ...l }) => (void vatOverride, l)); // what the editor sends back
    const plan = correctionPlan(st, c.id, { header: { ...c.header, reasonCode: 'RETURN' }, lines }, 'accountant');
    expect(plan.steps.map((x) => x.action)).toEqual(['reissue']);
    const re = get(executePlan(st, plan.planId, plan.planHash, me).affected.find((x) => x.status === 'issued')!.docId);
    expect([re.header.reasonCode, re.header.refDocId, re.header.documentDate, re.totals.total]).toEqual(['RETURN', t.id, c.header.documentDate, c.totals.total]);
    expect(re.lines.map((l) => l.vatOverride)).toEqual(c.lines.map((l) => l.vatOverride));
    expect(get(c.id).status).toBe('replaced');
    expect(sat(get(t.id).outstanding!)).toBe(owed(t.id));
    assertBalanced(st);
  });
  it('a correction plan for a note whose total would change is refused (cancel it and issue a new one)', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    expect(err(() => correctionPlan(st, c.id, { header: c.header, lines: [nl('a', 'l1', 'S7', '200.00')] }, 'accountant')).code).toBe('doc.reissue_total_changed');
  });
});

describe('the credit note paper (ม.86/10) is built by the server', () => {
  const paper = (id: string) => PAPER_BUILDERS.CN!({ st, company: st.companies.find((c) => c.id === VAT)! } as never, publicDoc(get(id)), false);
  it('prints the reason as Thai text (never the code) and the original / correct / difference values', () => {
    const t = ti([L('l1', 'S7', '1000.00'), L('l2', 'S7', '500.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '100.00')], { reasonCode: 'RETURN' });
    const p = paper(c.id);
    expect(p).toMatchObject({ titleTh: 'ใบลดหนี้', titleEn: 'CREDIT NOTE', number: c.number });
    expect(p.adjusts).toEqual({ number: t.number, date: '2026-10-01', originalNet: '1500.00', correctNet: '1400.00', diffNet: '100.00', reason: 'รับคืนสินค้า / สินค้าชำรุด' });
    expect(JSON.stringify(p)).not.toContain('RETURN');
    expect(p.totals).toEqual(c.totals); // VAT on the difference and the total are the document's own
    expect(p.totals.vat).toBe('7.00');
  });
  it('OTHER prints the typed text; the correct value follows the notes issued before', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    const c2 = note('CN', t, [nl('a', 'l1', 'S7', '50.00')], { reasonCode: 'OTHER', reasonText: 'ลูกค้าต่อรองราคา' });
    const p = paper(c2.id);
    expect(p.adjusts).toMatchObject({ originalNet: '1000.00', correctNet: '850.00', diffNet: '50.00', reason: 'ลูกค้าต่อรองราคา' });
  });
  it('a debit note: correct value = original + difference', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const d = note('DN', t, [nl('a', 'l1', 'S7', '25.00')], { reasonCode: 'PRICE_INCREASE' });
    const p = PAPER_BUILDERS.DN!({ st, company: st.companies.find((c) => c.id === VAT)! } as never, publicDoc(get(d.id)), false);
    expect(p).toMatchObject({ titleTh: 'ใบเพิ่มหนี้', titleEn: 'DEBIT NOTE' });
    expect(p.adjusts).toMatchObject({ originalNet: '1000.00', correctNet: '1025.00', diffNet: '25.00', reason: 'เพิ่มราคาสินค้าหรือบริการ' });
  });
});

describe('seed-wide invariants', () => {
  it('the seed (cn-1, cn-2 and the S5 documents) satisfies every invariant, and each live note has exactly one adjusts link to its refDoc', () => {
    expect(checkInvariants(st)).toEqual([]);
    for (const d of st.docs.filter((x) => x.type === 'CN' || x.type === 'DN')) {
      if (d.status !== 'issued') continue;
      expect(d.header.refDocId).toBeTruthy();
      expect(st.links.filter((l) => l.from === d.id && l.kind === 'adjusts' && l.active).map((l) => l.to)).toEqual([d.header.refDocId]);
    }
  });
  it('the invariants catch a rule B drift: two credits that fully credit a line but give back one satang of VAT too little', () => {
    const t = ti([L('l1', 'S7', '100.10')]);
    note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    const c2 = note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    expect(checkInvariants(st)).toEqual([]);
    const s2 = structuredClone(st);
    s2.docs.find((d) => d.id === c2.id)!.lines[0].vatOverride = '3.49'; // the naive per-line rounding of the second half is 3.50; 3.49 leaves a satang of the invoice's VAT uncredited
    expect(checkInvariants(s2).join(' | ')).toMatch(/rule B/);
  });
  it('the invariants catch a doctored cap, party, link amount and total', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    const c = note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    const mut = (f: (s: MockState) => void) => { const s2 = structuredClone(st); f(s2); return checkInvariants(s2).join('\n'); };
    const cn = (s: MockState) => s.docs.find((d) => d.id === c.id)!;
    expect(mut((s) => { cn(s).lines[0].unitPrice = '150.00'; })).toMatch(/exceed|cap/i);
    expect(mut((s) => { cn(s).header.partyId = 'someone-else'; })).toMatch(/party/i);
    expect(mut((s) => { s.links.find((l) => l.from === c.id)!.amount = '1.00'; })).toMatch(/adjusts|link/i);
    expect(mut((s) => { s.links.find((l) => l.from === c.id)!.active = false; })).toMatch(/adjusts|link/i);
    expect(mut((s) => { cn(s).totals.total = '1.00'; })).toMatch(/total/i);
  });
});
