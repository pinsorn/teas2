import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { seed, type MockState } from '../store';
import { cancel, createDraft, issue, publicDoc, reissue } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import { toSatang } from './money';
import { PAPER_BUILDERS } from './paper';

// S5 fix round 1 (Opus review F1-F5): the numeric vectors are the reviewer's.
const VAT = 'co-vat';
let st: MockState;
let n = 0;
beforeEach(() => { st = seed(); });
const sat = (m: string) => toSatang(m);
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const err = (fn: () => unknown): { code?: string; title?: string } => { try { fn(); } catch (e) { return e as { code?: string; title?: string }; } return {}; };
const customer = () => st.parties.find((p) => p.companyId === VAT && p.kind === 'customer' && p.vatRegistered && p.taxId)!;
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode, ...p });
const nl = (id: string, src: string, taxCode: DocLine['taxCode'], price: string, p: Partial<DocLine> = {}): DocLine => L(id, taxCode, price, { sourceLineId: src, ...p });
const ti = (lines: DocLine[]): Doc => {
  const d = createDraft(st, VAT, 'TI', { header: { partyId: customer().id, documentDate: '2026-10-01' }, lines }, me, `ti-${++n}`);
  return issue(st, d.id, d.version, me);
};
const note = (type: 'CN' | 'DN', t: Doc, lines: DocLine[], header: Partial<Doc['header']> = {}): Doc => {
  const d = createDraft(st, VAT, type, { header: { documentDate: '2026-10-14', refDocId: t.id, reasonCode: type === 'CN' ? 'PRICE_REDUCTION' : 'PRICE_INCREASE', ...header }, lines }, me, `note-${++n}`);
  return issue(st, d.id, d.version, me);
};
const paper = (id: string) => PAPER_BUILDERS.CN!({ st, company: st.companies.find((c) => c.id === VAT)! } as never, publicDoc(get(id)), false);
const strip = (ls: DocLine[]) => ls.map(({ vatOverride, ...l }) => (void vatOverride, l)); // what an API client sends back
const counts = () => [st.docs.length, st.links.length, st.journals.length, st.revisions.length];

describe('F1: a correction plan on a TI with live notes is refused (422), nothing is written', () => {
  const EXIT = 'ยกเลิกใบลดหนี้/ใบเพิ่มหนี้ที่อ้างถึงก่อน หรือออกใบลดหนี้/เพิ่มหนี้เพิ่มเติม';
  it.each(['50.05', '60.00'])('partial user CN 50.05 on l1 (100.10), then a plan setting l1 to %s', (price) => {
    const t = ti([L('l1', 'S7', '100.10')]);
    note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    const before = counts();
    const e = err(() => correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', price)] }, 'accountant'));
    expect(e.code).toBe('correction.notes_exist');
    expect(e.title).toContain(EXIT);
    expect(counts()).toEqual(before);
    expect(checkInvariants(st)).toEqual([]);
    expect(sat(get(t.id).outstanding!)).toBe(sat('107.11') - sat('53.56'));
  });
  it('a DN first, then a plan, is refused too; once the note is cancelled the plan is offered again', () => {
    const t = ti([L('l1', 'S7', '100.10')]);
    const d = note('DN', t, [nl('a', 'l1', 'S7', '10.00')]);
    expect(err(() => correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '50.05')] }, 'accountant')).code).toBe('correction.notes_exist');
    cancel(st, d.id, d.version, 'OTHER', 'x', me);
    const plan = correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '50.05')] }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, me);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('M4: a locked TI with a live partial CN is told why (not cn.exceeds_original)', () => {
    const t = ti([L('l1', 'S7', '100.00')]);
    note('CN', t, [nl('a', 'l1', 'S7', '40.00')]);
    get(t.id).locks.push({ kind: 'filing', reason: 'Filed', exits: [] });
    const e = err(() => correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '10.00')] }, 'accountant'));
    expect(e.code).toBe('correction.notes_exist');
    expect(e.title).toContain('ล็อก');
    expect(e.title).toContain(EXIT);
  });
});

describe('F2: every line of a user note has net > 0 (CN and DN)', () => {
  it('DN +500 / -100 and CN +100 / -50 are refused; nothing issued', () => {
    const t = ti([L('l1', 'S7', '100.00'), L('l2', 'S7', '1000.00')]);
    const before = counts();
    expect(err(() => note('DN', t, [nl('a', 'l2', 'S7', '500.00'), nl('b', 'l1', 'S7', '-100.00')])).code).toBe('note.line_not_positive');
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '100.00'), L('b', 'S7', '-50.00')])).code).toBe('note.line_not_positive');
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '60.00'), nl('b', 'l2', 'S7', '-10.00')])).code).toBe('note.line_not_positive');
    expect(err(() => note('DN', t, [nl('a', 'l2', 'S7', '500.00'), nl('b', 'l1', 'S7', '0.00')])).code).toBe('note.line_not_positive');
    expect(counts().slice(0, 1)).toEqual(before.slice(0, 1).map((x) => x + 4)); // the four drafts only; no link, journal or revision
    expect(counts().slice(1)).toEqual(before.slice(1));
  });
  it('the engine plan note may carry a signed line (a shift between lines still plans and runs)', () => {
    const t = ti([L('l1', 'S7', '100.00'), L('l2', 'S7', '50.00')]);
    const plan = correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '60.00'), L('l2', 'S7', '50.00'), L('l3', 'Z0', '5.00')] }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, me);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('F3: a user note is priced ex-VAT whatever the client sent', () => {
  it('two CNs of 53.55 sent with priceIncludesVat: true still split l1 100.10 as 3.51 + 3.50 (invariants clean)', () => {
    const t = ti([L('l1', 'S7', '100.10')]);
    const c1 = note('CN', t, [nl('a', 'l1', 'S7', '50.05')], { priceIncludesVat: true });
    const c2 = note('CN', t, [nl('a', 'l1', 'S7', '50.05')], { priceIncludesVat: true });
    expect(c1.header.priceIncludesVat).toBeFalsy();
    expect([c1.totals.vat, c2.totals.vat]).toEqual(['3.51', '3.50']);
    expect(sat(c1.totals.vat) + sat(c2.totals.vat)).toBe(sat('7.01'));
    expect(get(t.id).outstanding).toBe('0.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the engine full credit of a VAT-inclusive TI keeps its own inclusive flag (plan path unchanged)', () => {
    const d = createDraft(st, VAT, 'TI', { header: { partyId: customer().id, documentDate: '2026-10-01', priceIncludesVat: true }, lines: [L('l1', 'S7', '107.00')] }, me, 'incl');
    const t = issue(st, d.id, d.version, me);
    get(t.id).locks.push({ kind: 'filing', reason: 'Filed', exits: [] });
    const other = st.parties.find((p) => p.companyId === VAT && p.kind === 'customer' && p.id !== t.header.partyId)!;
    const plan = correctionPlan(st, t.id, { header: { ...t.header, partyId: other.id }, lines: t.lines }, 'accountant'); // locked + customer changed: the whole invoice is credited
    expect(plan.steps[0].note).toMatchObject({ type: 'CN', priceIncludesVat: true, fullCredit: true });
    const r = executePlan(st, plan.planId, plan.planHash, me);
    const cn = get(r.affected.find((a) => a.type === 'CN')!.docId);
    expect(cn.header.priceIncludesVat).toBe(true);
    expect(cn.totals.total).toBe('107.00');
  });
});

describe('F4: unchanged lines keep their stored VAT (plan and reissue), as revise does', () => {
  it('A 50.05, B 25.00, C 25.05 on l1 100.10; cancel A; B reason PRICE_REDUCTION -> DISCOUNT works at the same total', () => {
    const t = ti([L('l1', 'S7', '100.10')]);
    const a = note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    const b = note('CN', t, [nl('a', 'l1', 'S7', '25.00')]);
    note('CN', t, [nl('a', 'l1', 'S7', '25.05')]);
    expect([a.totals.vat, b.totals.vat]).toEqual(['3.51', '1.75']);
    cancel(st, a.id, a.version, 'OTHER', 'x', me);
    const plan = correctionPlan(st, b.id, { header: { ...b.header, reasonCode: 'DISCOUNT' }, lines: strip(b.lines) }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['reissue']);
    const re = get(executePlan(st, plan.planId, plan.planHash, me).affected.find((x) => x.status === 'issued')!.docId);
    expect([re.header.reasonCode, re.totals.total, re.totals.vat]).toEqual(['DISCOUNT', b.totals.total, '1.75']);
    expect(re.lines.map((l) => l.vatOverride)).toEqual(b.lines.map((l) => l.vatOverride));
    expect(checkInvariants(st)).toEqual([]);
  });
  it('reissue() alone also keeps the stored lines', () => {
    const t = ti([L('l1', 'S7', '100.10')]);
    const a = note('CN', t, [nl('a', 'l1', 'S7', '50.05')]);
    const b = note('CN', t, [nl('a', 'l1', 'S7', '25.00')]);
    note('CN', t, [nl('a', 'l1', 'S7', '25.05')]);
    cancel(st, a.id, a.version, 'OTHER', 'x', me);
    const re = reissue(st, b.id, { header: { ...b.header, reasonCode: 'DISCOUNT' }, lines: strip(b.lines) }, me, 'เหตุผล');
    expect(re.totals).toEqual(b.totals);
  });
});

describe('F5: the printed ม.86/10 values are a snapshot taken at issue', () => {
  it('A 100, B 200 on 1,000: reissuing A leaves B printing 700.00 and A\' still 900.00 (it keeps A\'s values, R2); cancelling A\' later does not move B', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const a = note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    const b = note('CN', t, [nl('a', 'l1', 'S7', '200.00')]);
    expect(paper(a.id).adjusts).toMatchObject({ correctNet: '900.00', diffNet: '100.00' });
    expect(paper(b.id).adjusts).toMatchObject({ correctNet: '700.00', diffNet: '200.00' });
    expect(get(b.id).adjustSnapshot).toEqual({ originalNet: '1000.00', correctNet: '700.00', diffNet: '200.00', vat: '14.00' });
    const re = reissue(st, a.id, { header: { ...a.header, reasonCode: 'DISCOUNT' }, lines: strip(a.lines) }, me, 'เหตุผล');
    expect(paper(b.id).adjusts).toMatchObject({ correctNet: '700.00' }); // before: 800.00
    expect(paper(re.id).adjusts).toMatchObject({ correctNet: '900.00', diffNet: '100.00' });
    expect(re.adjustSnapshot).toEqual({ originalNet: '1000.00', correctNet: '900.00', diffNet: '100.00', vat: '7.00' });
    cancel(st, re.id, get(re.id).version, 'OTHER', 'x', me);
    expect(paper(b.id).adjusts).toMatchObject({ correctNet: '700.00' });
  });
  it('a note without a snapshot (an older state) still prints a computed value', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const a = note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    delete get(a.id).adjustSnapshot;
    expect(paper(a.id).adjusts).toMatchObject({ correctNet: '900.00' });
  });
});

// ---- S5 fix round 2 (Opus re-review R1-R3) ----
describe('R1: a plan whose lines move in both directions issues a CN (decreases) and a DN (increases), never a signed note', () => {
  const mixedTi = () => ti([L('l1', 'S7', '100.00'), L('l2', 'Z0', '100.00')]);
  const toMixed = (t: Doc) => ({ header: t.header, lines: [L('l1', 'S7', '70.00'), L('l2', 'Z0', '200.00')] });
  it('l1 100 -> 70 (S7), l2 100 -> 200 (Z0): plan = [CN l1 30.00 VAT 2.10, DN l2 100.00]; no negative line on either', () => {
    const t = mixedTi();
    const plan = correctionPlan(st, t.id, toMixed(t), 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn', 'issue_dn']);
    const [cn, dn] = plan.steps.map((s) => s.note!);
    expect(cn.lines.map((l) => [l.sourceLineId, l.unitPrice, l.vatOverride])).toEqual([['l1', '30.00', '2.10']]);
    expect(cn.total).toBe('32.10');
    expect(dn.lines.map((l) => [l.sourceLineId, l.unitPrice, l.vatOverride])).toEqual([['l2', '100.00', '0.00']]);
    expect(dn.total).toBe('100.00');
    const r = executePlan(st, plan.planId, plan.planHash, me);
    expect(r.affected.map((a) => a.type)).toEqual(['CN', 'DN']);
    expect(checkInvariants(st)).toEqual([]);
    expect(get(t.id).outstanding).toBe('274.90'); // 207.00 - 32.10 + 100.00
  });
  it('the plan CN counts against the cap: a later user CN on l1 is capped at 70.00 (70.01 refused), and then l1 is whole to the satang', () => {
    const t = mixedTi();
    const plan = correctionPlan(st, t.id, toMixed(t), 'accountant');
    executePlan(st, plan.planId, plan.planHash, me);
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '70.01')])).code).toBe('cn.exceeds_original');
    const c = note('CN', t, [nl('a', 'l1', 'S7', '70.00')]);
    expect(c.totals.vat).toBe('4.90'); // 7.00 - 2.10
    expect(checkInvariants(st)).toEqual([]);
  });
  it('belt and braces: a stored DN with a negative referenced line is a credit for the cap, and for invariant 10', () => {
    const t = mixedTi();
    const d = createDraft(st, VAT, 'DN', { header: { documentDate: '2026-10-14', refDocId: t.id, reasonCode: 'PRICE_INCREASE' }, lines: [nl('a', 'l1', 'S7', '-30.00', { vatOverride: '-2.10' }), nl('b', 'l2', 'Z0', '100.00', { vatOverride: '0.00' })] }, me, 'neg-dn');
    issue(st, d.id, d.version, me); // the engine path (lines carry their VAT)
    expect(err(() => note('CN', t, [nl('a', 'l1', 'S7', '70.01')])).code).toBe('cn.exceeds_original');
    note('CN', t, [nl('a', 'l1', 'S7', '70.00')]);
    expect(checkInvariants(st)).toEqual([]);
    const s2 = structuredClone(st);
    const cn = s2.docs.filter((x) => x.type === 'CN' && x.header.refDocId === t.id).pop()!;
    cn.lines[0].unitPrice = '100.00'; cn.lines[0].vatOverride = '7.00';
    expect(checkInvariants(s2).join(' | ')).toMatch(/exceeds the line's net/);
  });
  it('a plan whose deltas all go one way is unchanged: one note', () => {
    const t = mixedTi();
    const plan = correctionPlan(st, t.id, { header: t.header, lines: [L('l1', 'S7', '70.00'), L('l2', 'Z0', '90.00')] }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn']);
    expect(plan.steps[0].note!.lines.map((l) => l.unitPrice)).toEqual(['30.00', '10.00']);
  });
});

describe('R2 / R3: the snapshot is carried by a reissue and exists on every seeded note', () => {
  it('a reason-only reissue of A carries A\'s snapshot unchanged, whatever was issued after A', () => {
    const t = ti([L('l1', 'S7', '1000.00')]);
    const a = note('CN', t, [nl('a', 'l1', 'S7', '100.00')]);
    note('CN', t, [nl('a', 'l1', 'S7', '200.00')]);
    note('DN', t, [nl('a', 'l1', 'S7', '50.00')]);
    const re = reissue(st, a.id, { header: { ...a.header, reasonCode: 'DISCOUNT' }, lines: strip(a.lines) }, me, 'เหตุผล');
    expect(re.adjustSnapshot).toEqual(get(a.id).adjustSnapshot);
    expect(re.adjustSnapshot!.correctNet).toBe('900.00');
    expect(paper(re.id).adjusts).toMatchObject({ correctNet: '900.00' });
  });
  it('every seeded CN / DN has a snapshot (the paper fallback is never used for them)', () => {
    const notes = st.docs.filter((d) => (d.type === 'CN' || d.type === 'DN') && d.status !== 'draft');
    expect(notes.length).toBeGreaterThan(2);
    for (const d of notes.filter((x) => x.header.refDocId && x.issuedAt)) expect(d.adjustSnapshot, d.id).toBeDefined();
  });
});
