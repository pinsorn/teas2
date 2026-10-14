import { beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../store';
import { buildChain } from './chain';
import { cancel, createDraft, issue, reissue } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { toSatang } from './money';
import { assertBalanced, type DocLine, type MockStateLike } from './test-helpers';

const me = { kind: 'user' as const, id: 'u-1', name: 'สมศรี บัญชีดี' };
let st: MockStateLike;
let paidTi: MockStateLike['docs'][number];

beforeEach(() => {
  st = seed();
  paidTi = st.docs.find((d) => d.type === 'TI' && d.status === 'settled' && !d.locks.some((l) => l.kind === 'filing'))!;
});

describe('chain-aware corrections (SP0 §7.11)', () => {
  it('non-fiscal change on an issued TI = one revise step', () => {
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, notes: 'อ้างอิง PO 4471' }, lines: paidTi.lines }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
  });
  it('customer change on a paid TI = cancel RC, reissue TI, reissue RC', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id }, lines: paidTi.lines }, 'accountant');
    expect(plan.steps.map((s) => [s.action, s.docType])).toEqual([['cancel', 'RC'], ['reissue', 'TI'], ['reissue', 'RC']]);
    expect(plan.missingPermissions).toEqual([]);
  });
  it('lower total = propose a credit note for the difference', () => {
    const lines = paidTi.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1.00' } : l));
    const plan = correctionPlan(st, paidTi.id, { header: paidTi.header, lines }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn']);
  });
  it('an operator sees the missing permissions', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id }, lines: paidTi.lines }, 'operator');
    expect(plan.missingPermissions).toEqual(expect.arrayContaining(['doc.RC.cancel', 'doc.TI.correct']));
  });
  it('executing the plan is all-or-nothing and keeps date and total', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id }, lines: paidTi.lines }, 'accountant');
    const result = executePlan(st, plan.planId, plan.planHash, me);
    const newTi = result.affected.find((a) => a.type === 'TI' && a.status === 'settled')!;
    const doc = st.docs.find((d) => d.id === newTi.docId)!;
    expect(doc.header.documentDate).toBe(paidTi.header.documentDate);
    expect(doc.totals.total).toBe(paidTi.totals.total);
    expect(doc.replacesId).toBe(paidTi.id);
    expect(st.docs.find((d) => d.id === paidTi.id)!.status).toBe('replaced');
    assertBalanced(st);
  });
  it('a credit-note plan executes: CN issued, adjusts the TI, ledger balanced', () => {
    const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'settled' && !d.locks.some((l) => l.kind === 'filing') && st.parties.find((p) => p.id === d.header.partyId)?.taxId)!;
    const lines = ti.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1.00' } : l));
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines }, 'accountant');
    const result = executePlan(st, plan.planId, plan.planHash, me);
    const cn = result.affected.find((a) => a.type === 'CN')!;
    expect(cn.status).toBe('issued');
    expect(st.links.some((l) => l.from === cn.docId && l.to === ti.id && l.kind === 'adjusts' && l.active)).toBe(true);
    assertBalanced(st);
  });
  it('a failing step rolls everything back (st unchanged)', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id }, lines: paidTi.lines }, 'accountant');
    delete (st.parties.find((p) => p.id === other.id) as { taxId?: string }).taxId; // reissue of the TI will now fail, after the RC was cancelled
    const snapshot = JSON.stringify(st);
    expect(() => executePlan(st, plan.planId, plan.planHash, me)).toThrow(/doc.incomplete/);
    expect(JSON.stringify(st)).toBe(snapshot);
  });
  it('a CN reduces the TI outstanding by its total; cancelling the CN restores it', () => {
    const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length && !st.links.some((l) => l.to === d.id && l.active))!;
    const before = ti.outstanding!;
    const lines = ti.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1.00' } : l));
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines }, 'accountant');
    const cn = executePlan(st, plan.planId, plan.planHash, me).affected.find((a) => a.type === 'CN')!;
    const cnDoc = st.docs.find((d) => d.id === cn.docId)!;
    expect(toSatang(st.docs.find((d) => d.id === ti.id)!.outstanding!)).toBe(toSatang(before) - toSatang(cnDoc.totals.total));
    cancel(st, cnDoc.id, cnDoc.version, 'OTHER', 'x', me);
    expect(st.docs.find((d) => d.id === ti.id)!.outstanding).toBe(before);
    assertBalanced(st);
  });
  it('party + amount change together: CN for the delta, reissue keeps original date and total (I9)', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const lines = paidTi.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1.00' } : l));
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id, documentDate: '2026-01-02' }, lines }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['cancel', 'reissue', 'reissue', 'issue_cn']);
    const result = executePlan(st, plan.planId, plan.planHash, me);
    const newTi = st.docs.find((d) => d.replacesId === paidTi.id)!;
    expect(newTi.totals.total).toBe(paidTi.totals.total);
    expect(newTi.header.documentDate).toBe(paidTi.header.documentDate);
    expect(newTi.header.partyId).toBe(other.id);
    const cn = st.docs.find((d) => d.id === result.affected.find((a) => a.type === 'CN')!.docId)!;
    expect(st.links.some((l) => l.from === cn.id && l.to === newTi.id && l.kind === 'adjusts' && l.active)).toBe(true);
    expect(cn.header.partyId).toBe(other.id);
    assertBalanced(st);
  });
  it('reissue itself refuses a different total', () => {
    const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length && !st.links.some((l) => l.to === d.id && l.active))!;
    expect(() => reissue(st, ti.id, { header: ti.header, lines: ti.lines.map((l) => ({ ...l, unitPrice: '1.00' })) }, me, 'x')).toThrow(/doc.reissue_total_changed/);
  });
  it('the receipt is replaced (not just cancelled): replaces link, replacesId, chain', () => {
    const other = st.parties.find((p) => p.kind === 'customer' && p.id !== paidTi.header.partyId && p.vatRegistered && p.taxId)!;
    const oldRc = st.docs.find((d) => d.id === st.links.find((l) => l.kind === 'settles' && l.to === paidTi.id)!.from)!;
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, partyId: other.id }, lines: paidTi.lines }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, me);
    const old = st.docs.find((d) => d.id === oldRc.id)!;
    expect(old.status).toBe('replaced');
    const newRc = st.docs.find((d) => d.id === old.replacedById)!;
    expect(newRc.replacesId).toBe(old.id);
    expect(newRc.header.documentDate).toBe(oldRc.header.documentDate);
    expect(newRc.totals.total).toBe(oldRc.totals.total);
    expect(buildChain(st, newRc.id).edges).toContainEqual(expect.objectContaining({ from: newRc.id, to: old.id, kind: 'replaces', active: true }));
  });
  it('a stale plan hash is refused and nothing changes', () => {
    const plan = correctionPlan(st, paidTi.id, { header: { ...paidTi.header, notes: 'x' }, lines: paidTi.lines }, 'accountant');
    const snapshot = JSON.stringify(st);
    expect(() => executePlan(st, plan.planId, 'stale', me)).toThrow(/correction.plan_stale/);
    expect(JSON.stringify(st)).toBe(snapshot);
  });
});

describe('I1: a CN / DN carries one line per tax code and the plan shows exactly what posts', () => {
  const line = (id: string, taxCode: DocLine['taxCode'], unitPrice: string): DocLine => ({ id, description: id, qty: '1', unit: 'งาน', unitPrice, taxCode });
  let n = 0;
  const mkTi = (lines: DocLine[], priceIncludesVat = false) => {
    const party = st.parties.find((p) => p.kind === 'customer' && p.vatRegistered && p.taxId)!;
    const d = createDraft(st, 'co-vat', 'TI', { header: { partyId: party.id, documentDate: '2026-10-01', priceIncludesVat }, lines }, me, `i1-${n++}`);
    const id = issue(st, d.id, d.version, me).id;
    return st.docs.find((x) => x.id === id)!;
  };
  const noteOf = (planned: ReturnType<typeof correctionPlan>, res: ReturnType<typeof executePlan>) => {
    const doc = st.docs.find((d) => d.id === res.affected.find((a) => a.type === 'CN' || a.type === 'DN')!.docId)!;
    expect(planned.steps[0].summary).toContain(` ${doc.totals.total} `); // the plan amount is the posted amount
    return doc;
  };

  it('1,500.00 -> 1,499.95 at S7 is an S7 credit note of 0.05 net, not Z0', () => {
    const ti = mkTi([line('a', 'S7', '1500.00')]);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'S7', '1499.95')] }, 'accountant');
    const cn = noteOf(plan, executePlan(st, plan.planId, plan.planHash, me));
    expect(cn.lines.map((l) => [l.taxCode, l.unitPrice])).toEqual([['S7', '0.05']]);
    expect(cn.totals.net).toBe('0.05');
    assertBalanced(st);
  });
  it('mixed S7 / Z0 change: plan amount == posted CN amount, ledger balanced, TI outstanding follows', () => {
    const ti = mkTi([line('a', 'Z0', '200.00')]);
    const proposed = { header: ti.header, lines: [line('a', 'Z0', '100.00'), line('b', 'S7', '50.00')] };
    const plan = correctionPlan(st, ti.id, proposed, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn']);
    const cn = noteOf(plan, executePlan(st, plan.planId, plan.planHash, me));
    expect(cn.lines.map((l) => [l.taxCode, l.unitPrice]).sort()).toEqual([['S7', '-50.00'], ['Z0', '100.00']]);
    expect(cn.totals.total).toBe('46.50');
    expect(st.docs.find((d) => d.id === ti.id)!.outstanding).toBe('153.50');
    assertBalanced(st);
  });
  it('net-neutral shift S7 -> Z0 (total changes by the VAT): a credit note that executes', () => {
    const ti = mkTi([line('a', 'S7', '100.00')]);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'Z0', '100.00')] }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn']);
    const cn = noteOf(plan, executePlan(st, plan.planId, plan.planHash, me));
    expect(cn.totals.vat).toBe('7.00');
    assertBalanced(st);
  });
  it('proposed total == original total with a code shift (price-inclusive) goes the reissue path and executes', () => {
    const ti = mkTi([line('a', 'S7', '107.00')], true);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'Z0', '107.00')] }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['reissue']);
    executePlan(st, plan.planId, plan.planHash, me);
    const nw = st.docs.find((d) => d.replacesId === ti.id)!;
    expect(nw.lines[0].taxCode).toBe('Z0');
    expect(nw.totals.total).toBe(ti.totals.total);
    assertBalanced(st);
  });
  it('a debit note (higher total) carries per-code lines too', () => {
    const ti = mkTi([line('a', 'S7', '100.00')]);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'S7', '100.00'), line('b', 'Z0', '40.00')] }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_dn']);
    const dn = noteOf(plan, executePlan(st, plan.planId, plan.planHash, me));
    expect(dn.lines.map((l) => [l.taxCode, l.unitPrice])).toEqual([['Z0', '40.00']]);
    assertBalanced(st);
  });
});

describe('I1: ledger never posts a negative amount', () => {
  it('a CN with a negative VAT line posts that side on the opposite column', () => {
    const party = st.parties.find((p) => p.kind === 'customer' && p.vatRegistered && p.taxId)!;
    const l = (id: string, taxCode: 'S7' | 'Z0', unitPrice: string) => ({ id, description: id, qty: '1', unit: 'งาน', unitPrice, taxCode });
    const d = createDraft(st, 'co-vat', 'TI', { header: { partyId: party.id, documentDate: '2026-10-01' }, lines: [l('a', 'Z0', '200.00')] }, me, 'neg');
    const ti = issue(st, d.id, d.version, me);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [l('a', 'Z0', '100.00'), l('b', 'S7', '50.00')] }, 'accountant');
    const cn = executePlan(st, plan.planId, plan.planHash, me).affected.find((a) => a.type === 'CN')!;
    const entry = st.journals.find((j) => j.docId === cn.docId)!.preview.entries[0];
    expect(entry.lines.every((x) => !x.debit.startsWith('-') && !x.credit.startsWith('-'))).toBe(true);
    assertBalanced(st);
  });
});
