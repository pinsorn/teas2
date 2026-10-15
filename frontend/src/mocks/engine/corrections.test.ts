import { beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../store';
import { buildChain } from './chain';
import { calc, cancel, createDraft, issue, reissue } from './commands';
import { PERMISSIONS_BY_ROLE } from '../permissions';
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
  const noteOf = (planned: ReturnType<typeof correctionPlan>, res: ReturnType<typeof executePlan>, nth = 0) => {
    const doc = st.docs.find((d) => d.id === res.affected.filter((a) => a.type === 'CN' || a.type === 'DN')[nth].docId)!;
    expect(planned.steps[nth].summary).toContain(` ${doc.totals.total} `); // the plan amount is the posted amount
    const note = planned.steps[nth].note!;
    expect(doc.type).toBe(note.type);
    expect(doc.lines).toEqual(note.lines);
    expect(doc.header.priceIncludesVat).toBe(note.priceIncludesVat);
    expect(doc.totals.total).toBe(note.total);
    for (const row of note.taxLines) {
      const computed = calc({ header: doc.header, lines: doc.lines.filter((l) => l.taxCode === row.taxCode) }, true);
      expect(row).toEqual({ taxCode: row.taxCode, net: computed.totals.net, vat: computed.totals.vat, total: computed.totals.total });
    }
    return doc;
  };

  // Rule B: per tax code, note net/VAT = |proposed - original| of the engine's own per-line figures; total == |delta| always.
  // A change that goes both ways is two notes (R1): the CN (decreases) first, then the DN (increases); together they are exactly the change of the total, and no line is negative.
  type Exp = { type: 'CN' | 'DN'; net: string; vat: string; total: string };
  const deltaAll = (before: DocLine[], after: DocLine[], exps: Exp[], outstanding: string) => {
    const ti = mkTi(before);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: after }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(exps.map((e) => (e.type === 'CN' ? 'issue_cn' : 'issue_dn')));
    expect(plan.steps.reduce((a, s) => a + (s.note!.type === 'DN' ? 1 : -1) * toSatang(s.note!.total), 0)).toBe(toSatang(calc({ header: ti.header, lines: after }, true).totals.total) - toSatang(ti.totals.total));
    const res = executePlan(st, plan.planId, plan.planHash, me);
    const notes = exps.map((_, i) => noteOf(plan, res, i));
    notes.forEach((nd, i) => { expect(nd.totals).toMatchObject({ net: exps[i].net, vat: exps[i].vat, total: exps[i].total }); expect(nd.lines.every((l) => toSatang(l.unitPrice) >= 0)).toBe(true); });
    expect(st.docs.find((d) => d.id === ti.id)!.outstanding).toBe(outstanding);
    assertBalanced(st);
    return notes;
  };
  const delta = (before: DocLine[], after: DocLine[], exp: Exp, outstanding: string) => deltaAll(before, after, [exp], outstanding)[0];
  it('S7 100.10 -> 100.60 (VAT 7.01 -> 7.04): DN net 0.50 VAT 0.03 total 0.53, outstanding 107.64', () => {
    delta([line('a', 'S7', '100.10')], [line('a', 'S7', '100.60')], { type: 'DN', net: '0.50', vat: '0.03', total: '0.53' }, '107.64');
  });
  it('S7 12.34 qty 1 -> 2: DN net 12.34 VAT 0.87 total 13.21 == delta, outstanding 26.41', () => {
    delta([line('a', 'S7', '12.34')], [{ ...line('a', 'S7', '12.34'), qty: '2' }], { type: 'DN', net: '12.34', vat: '0.87', total: '13.21' }, '26.41');
  });
  it('4 x S7 0.08 -> S7 0.33: the four removed lines are a CN (net 0.32 VAT 0.04), the added one a DN (net 0.33 VAT 0.02), outstanding 0.35', () => {
    const [cn, dn] = deltaAll(['a', 'b', 'c', 'd'].map((id) => line(id, 'S7', '0.08')), [line('z', 'S7', '0.33')],
      [{ type: 'CN', net: '0.32', vat: '0.04', total: '0.36' }, { type: 'DN', net: '0.33', vat: '0.02', total: '0.35' }], '0.35');
    expect(cn.lines.map((l) => [l.sourceLineId, l.vatOverride])).toEqual([['a', '0.01'], ['b', '0.01'], ['c', '0.01'], ['d', '0.01']]); // the removed lines reference the invoice
    expect(dn.lines.map((l) => [l.sourceLineId, l.vatOverride])).toEqual([[undefined, '0.02']]); // the added one is a line of its own
    const j = st.journals.find((x) => x.docId === cn.id)!.preview.entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit]);
    expect(j).toEqual(expect.arrayContaining([['4110', '0.32', '0.00'], ['2151', '0.04', '0.00'], ['1130', '0.00', '0.36']]));
    const jd = st.journals.find((x) => x.docId === dn.id)!.preview.entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit]); // the DN: Dr AR 0.35, Cr revenue 0.33, Cr output VAT 0.02
    expect(jd).toEqual(expect.arrayContaining([['1130', '0.35', '0.00'], ['4100', '0.00', '0.33'], ['2151', '0.00', '0.02']]));
  });
  it('2 x S7 0.07 -> S7 0.08: CN net 0.14 VAT 0.00, DN net 0.08 VAT 0.01, outstanding 0.09', () => {
    deltaAll([line('a', 'S7', '0.07'), line('b', 'S7', '0.07')], [line('z', 'S7', '0.08')], [{ type: 'CN', net: '0.14', vat: '0.00', total: '0.14' }, { type: 'DN', net: '0.08', vat: '0.01', total: '0.09' }], '0.09');
  });
  it('reverse: S7 0.08 -> 2 x S7 0.07 is a CN of 0.09 and a DN of net 0.14 VAT 0.00, outstanding 0.14', () => {
    deltaAll([line('z', 'S7', '0.08')], [line('a', 'S7', '0.07'), line('b', 'S7', '0.07')], [{ type: 'CN', net: '0.08', vat: '0.01', total: '0.09' }, { type: 'DN', net: '0.14', vat: '0.00', total: '0.14' }], '0.14');
  });
  it('mixed S7 / Z0 satang amounts (157.66 -> 147.64): CN of the Z0 line 10.55, DN of the S7 line net 0.50 VAT 0.03', () => {
    deltaAll([line('a', 'S7', '100.10'), line('b', 'Z0', '50.55')], [line('a', 'S7', '100.60'), line('b', 'Z0', '40.00')],
      [{ type: 'CN', net: '10.55', vat: '0.00', total: '10.55' }, { type: 'DN', net: '0.50', vat: '0.03', total: '0.53' }], '147.64');
  });
  it('S7 -> Z0 code shift with satang: the old side is a CN (100.10 + VAT 7.01), the new side a DN (100.10)', () => {
    deltaAll([line('a', 'S7', '100.10')], [line('a', 'Z0', '100.10')], [{ type: 'CN', net: '100.10', vat: '7.01', total: '107.11' }, { type: 'DN', net: '100.10', vat: '0.00', total: '100.10' }], '100.10');
  });
  it('a tampered stored vatOverride is refused as plan_stale before writing', () => {
    const ti = mkTi([line('a', 'S7', '100.10')]);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'S7', '100.60')] }, 'accountant');
    st.plans![plan.planId].plan.steps[0].note!.lines[0].vatOverride = '0.99';
    const snapshot = structuredClone(st);
    expect(() => executePlan(st, plan.planId, plan.planHash, me)).toThrow(expect.objectContaining({ status: 409, code: 'correction.plan_stale' }));
    expect(st).toEqual(snapshot);
  });
  it('engine.invariant never fires: note total == |delta| across a sweep of satang prices', () => {
    for (const [a, b] of [['100.10', '100.60'], ['12.34', '24.68'], ['0.08', '0.33'], ['0.07', '0.08'], ['33.33', '33.34'], ['1.15', '0.99'], ['99.99', '100.01']]) {
      const ti = mkTi([line('a', 'S7', a)]);
      expect(() => correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'S7', b)] }, 'accountant')).not.toThrow();
    }
  });
  it('a malformed body is not a TypeError in stripOverrides: it reaches the engine 422', async () => {
    const { stripOverrides } = await import('../handlers/docs-write');
    for (const bad of [{ header: {} }, { header: {}, lines: [null] }, { header: {}, lines: 'x' }]) {
      expect(() => stripOverrides(bad as never)).not.toThrow();
      expect(() => calc(bad as never, true)).toThrow(expect.objectContaining({ status: 422 }));
    }
  });
  it('a body arriving over HTTP cannot carry a vatOverride (stripped at the boundary)', async () => {
    const { stripOverrides } = await import('../handlers/docs-write');
    expect(stripOverrides({ header: { documentDate: '2026-10-01' }, lines: [{ ...line('a', 'S7', '1.00'), vatOverride: '0.00' }] }).lines[0].vatOverride).toBeUndefined();
  });

  it('locked same-party four-line S7 to Z0 executes exactly the full CN authorised without DN permission', () => {
    const ti = mkTi(['a', 'b', 'c', 'd'].map((id) => line(id, 'S7', '0.08')));
    ti.locks.push({ kind: 'filing', reason: 'Filed', exits: [] });
    const permissions = [...PERMISSIONS_BY_ROLE.accountant];
    PERMISSIONS_BY_ROLE.accountant = permissions.filter((p) => p !== 'doc.DN.issue');
    try {
      const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('z', 'Z0', '0.36')] }, 'accountant');
      expect(plan.steps[0].note).toMatchObject({ type: 'CN', fullCredit: true, total: '0.36', taxLines: [{ taxCode: 'S7', net: '0.32', vat: '0.04', total: '0.36' }] });
      expect(st.plans![plan.planId].plan).toEqual(plan);
      expect(plan.missingPermissions).toEqual([]);
      const cn = noteOf(plan, executePlan(st, plan.planId, plan.planHash, me));
      expect(cn.lines).toHaveLength(4);
      expect(st.docs.find((d) => d.id === ti.id)!.outstanding).toBe('0.00');
      assertBalanced(st);
    } finally { PERMISSIONS_BY_ROLE.accountant = permissions; }
  });

  it('same-total four-line S7 to Z0 without a lock reissues with the original date and total', () => {
    const ti = mkTi(['a', 'b', 'c', 'd'].map((id) => line(id, 'S7', '0.08')));
    const plan = correctionPlan(st, ti.id, { header: { ...ti.header, documentDate: '2026-10-02' }, lines: [line('z', 'Z0', '0.36')] }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['reissue']);
    executePlan(st, plan.planId, plan.planHash, me);
    expect(st.docs.find((d) => d.replacesId === ti.id)).toMatchObject({ header: { documentDate: ti.header.documentDate }, totals: { total: '0.36' }, outstanding: '0.36' });
    assertBalanced(st);
  });

  it.each(['lines', 'lock', 'stored note'] as const)('refuses changed %s as plan_stale before writing', (change) => {
    const ti = mkTi([line('a', 'S7', '100.00')]);
    ti.locks.push({ kind: 'filing', reason: 'Filed', exits: [] });
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'Z0', '107.00')] }, 'accountant');
    if (change === 'lines') ti.lines[0].unitPrice = '100.01';
    if (change === 'lock') ti.locks = [];
    if (change === 'stored note') st.plans![plan.planId].plan.steps[0].note!.lines[0].unitPrice = '90.00';
    const snapshot = structuredClone(st);
    expect(() => executePlan(st, plan.planId, plan.planHash, me)).toThrow(expect.objectContaining({ status: 409, code: 'correction.plan_stale' }));
    expect(st).toEqual(snapshot);
  });

  it('rechecks permission for the stored note type before writing', () => {
    const ti = mkTi([line('a', 'Z0', '100.00')]);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'Z0', '90.00')] }, 'accountant');
    const permissions = [...PERMISSIONS_BY_ROLE.accountant];
    PERMISSIONS_BY_ROLE.accountant = permissions.filter((p) => p !== 'doc.CN.issue');
    try {
      const snapshot = structuredClone(st);
      expect(() => executePlan(st, plan.planId, plan.planHash, me)).toThrow(/auth.forbidden/);
      expect(st).toEqual(snapshot);
    } finally { PERMISSIONS_BY_ROLE.accountant = permissions; }
  });

  it('1,500.00 -> 1,499.95 at S7 is an S7 credit note of 0.05 net, not Z0', () => {
    const ti = mkTi([line('a', 'S7', '1500.00')]);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'S7', '1499.95')] }, 'accountant');
    const cn = noteOf(plan, executePlan(st, plan.planId, plan.planHash, me));
    expect(cn.lines.map((l) => [l.taxCode, l.unitPrice])).toEqual([['S7', '0.05']]);
    expect(cn.totals.net).toBe('0.05');
    assertBalanced(st);
  });
  it('mixed S7 / Z0 change: Z0 200 -> 100 is a CN of 100.00, the added S7 50.00 a DN of 53.50; ledger balanced, TI outstanding follows', () => {
    const ti = mkTi([line('a', 'Z0', '200.00')]);
    const proposed = { header: ti.header, lines: [line('a', 'Z0', '100.00'), line('b', 'S7', '50.00')] };
    const plan = correctionPlan(st, ti.id, proposed, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn', 'issue_dn']);
    const res = executePlan(st, plan.planId, plan.planHash, me);
    const cn = noteOf(plan, res, 0), dn = noteOf(plan, res, 1);
    expect(cn.lines.map((l) => [l.taxCode, l.unitPrice])).toEqual([['Z0', '100.00']]);
    expect(dn.lines.map((l) => [l.taxCode, l.unitPrice])).toEqual([['S7', '50.00']]);
    expect([cn.totals.total, dn.totals.total]).toEqual(['100.00', '53.50']);
    expect(st.docs.find((d) => d.id === ti.id)!.outstanding).toBe('153.50');
    assertBalanced(st);
  });
  it('net-neutral shift S7 -> Z0 (total changes by the VAT): a CN of the old side and a DN of the new side, both execute', () => {
    const ti = mkTi([line('a', 'S7', '100.00')]);
    const plan = correctionPlan(st, ti.id, { header: ti.header, lines: [line('a', 'Z0', '100.00')] }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn', 'issue_dn']);
    const res = executePlan(st, plan.planId, plan.planHash, me);
    const cn = noteOf(plan, res, 0);
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

describe('SP2 vectors (ledger 184), kept visible', () => {
  it.todo('SP2 vector: settlement lock vs CN — a CN on a paid TI may not take outstanding below −(…) [ledger 184]');
  it.todo('SP2 vector: second correction must account for existing CN/DN [ledger 184]');
});
