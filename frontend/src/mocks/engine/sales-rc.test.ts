import { beforeEach, describe, expect, it } from 'vitest';
import type { Allocation, Doc, DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { fixtureIds } from '../fixtures/ids';
import { seed, type MockState } from '../store';
import { cancel, compute, createDraft, issue, publicDoc, revise, updateDraft } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import { toSatang } from './money';
import { PAPER_BUILDERS } from './paper';
import { assertBalanced } from './test-helpers';

const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
let n = 0;
beforeEach(() => { st = seed(); });
const sat = (m: string) => toSatang(m);
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return undefined; };
const line = (id: string, unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode: 'EX', ...p });
const alloc = (targetId: string, amount: string, p: Partial<Allocation> = {}): Allocation => ({ targetId, targetType: get(targetId).type as 'TI' | 'IV', amount, ...p });

/** An issued receipt through the engine (the same path as the screens). */
const receipt = (company: string, partyId: string, allocations: Allocation[], header: Partial<Doc['header']> = {}, lines: DocLine[] = []): Doc => {
  const d = createDraft(st, company, 'RC', { header: { partyId, documentDate: '2026-10-14', ...header }, lines, allocations }, me, `rc-${++n}`);
  return issue(st, d.id, d.version, me);
};

/** SP0 7.11 as a formula over the links alone: total - Σ CN + Σ DN - Σ active settles. */
const owed = (id: string): number => {
  let out = sat(get(id).totals.total);
  for (const l of st.links) {
    if (!l.active || l.to !== id) continue;
    const t = st.docs.find((x) => x.id === l.from)?.type; // a settles link may start at a settlement record (FN3)
    if (l.kind === 'settles') out -= sat(l.amount!);
    else if (l.kind === 'adjusts') out += t === 'CN' ? -sat(l.amount!) : t === 'DN' ? sat(l.amount!) : 0;
  }
  return out;
};
/** GL movement (debit - credit) of one account over a document's journal entries, in satang. */
const move = (docId: string, account: string) => (st.journals.find((j) => j.docId === docId)?.preview.entries ?? [])
  .flatMap((e) => e.lines).filter((l) => l.accountCode === account).reduce((a, l) => a + sat(l.debit) - sat(l.credit), 0);
const glCompany = (company: string, account: string) => st.journals.filter((j) => get(j.docId).companyId === company)
  .flatMap((j) => j.preview.entries).flatMap((e) => e.lines).filter((l) => l.accountCode === account).reduce((a, l) => a + sat(l.debit) - sat(l.credit), 0);
/** The money identity of a receipt: cash + Σ wht = Σ allocation amounts + deposit + cash-bill net (lines, VAT included). */
const identity = (d: Doc) => {
  const allocs = d.allocations ?? [];
  const lhs = sat(d.totals.cash!) + allocs.reduce((a, x) => a + sat(x.wht ?? '0.00'), 0);
  const rhs = allocs.reduce((a, x) => a + sat(x.amount), 0) + sat(d.header.depositAmount ?? '0.00') + sat(d.totals.net) + sat(d.totals.vat);
  return [lhs, rhs];
};
/** Per bank / cash account and month: Σ (debit - credit) on that account over every journal entry of the company (by entry date). */
const bankMonths = (company: string): Record<string, number> => {
  const codes = new Set(['1120', ...st.bankAccounts.filter((b) => b.companyId === company).map((b) => b.accountCode)]);
  const out: Record<string, number> = {};
  for (const j of st.journals) {
    if (get(j.docId).companyId !== company) continue;
    for (const e of j.preview.entries) for (const l of e.lines) {
      if (!codes.has(l.accountCode)) continue;
      const k = `${l.accountCode}|${e.date.slice(0, 7)}`;
      out[k] = (out[k] ?? 0) + sat(l.debit) - sat(l.credit);
    }
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
};
const diff = (a: Record<string, number>, b: Record<string, number>) => {
  const o: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] ?? 0) !== (b[k] ?? 0)) o[k] = (b[k] ?? 0) - (a[k] ?? 0);
  return o;
};

describe('VAT company: a receipt settles invoices, it has no lines', () => {
  it('a VAT-company RC with cash-bill lines is refused rc.lines_need_invoice by create, update and compute, and nothing is written', () => {
    const before = st.docs.length;
    const body = { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [line('l1', '100.00')] };
    expect(code(() => createDraft(st, VAT, 'RC', body, me, 'k1'))).toBe('rc.lines_need_invoice');
    expect(code(() => compute(st, VAT, 'RC', body))).toBe('rc.lines_need_invoice');
    const ok = createDraft(st, VAT, 'RC', { header: body.header, lines: [], allocations: [alloc('spike-1', '100.00')] }, me, 'k2');
    expect(code(() => updateDraft(st, ok.id, body, ok.version, me))).toBe('rc.lines_need_invoice');
    expect(st.docs.length).toBe(before + 1); // only the legitimate draft
    expect(get(ok.id).lines).toEqual([]);
    try { createDraft(st, VAT, 'RC', body, me, 'k3'); } catch (e) { expect((e as { status: number }).status).toBe(422); expect((e as Error).message).toContain('ต้องออกใบกำกับภาษีก่อนรับชำระ'); }
  });
  it('the non-VAT company may sell over the counter: the same body is accepted', () => {
    const d = createDraft(st, NV, 'RC', { header: { partyId: 'nc-04', documentDate: '2026-10-14' }, lines: [line('l1', '100.00')] }, me, 'k4');
    expect(d.lines).toHaveLength(1);
  });
  it('an RC with neither allocations, lines nor a deposit is doc.incomplete at issue (a zero deposit is no deposit)', () => {
    for (const header of [{}, { depositAmount: '0.00' }]) {
      const d = createDraft(st, VAT, 'RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14', ...header }, lines: [] }, me, `k5-${n++}`);
      expect(code(() => issue(st, d.id, d.version, me))).toBe('doc.incomplete');
      expect(get(d.id).status).toBe('draft');
      expect(get(d.id).number).toBeUndefined();
    }
  });
});

describe('seeded receipts: every formula over satang, per receipt and seed-wide', () => {
  it('fixture keys resolve to the seeded documents', () => {
    const f = fixtureIds(st);
    expect([f.rcMulti, f.rcNoCert, f.rcDeposit, f.nrcCashBill]).toEqual(['rc-multi', 'rc-nocert', 'rc-dep', 'nrc-cash']);
    expect([f.rcTargetsA, f.rcTargetsB]).toEqual(['spike-1', 'spike-25']); // still untouched: the e2e settles them
  });
  it('rc-multi: 1,000.00 (WHT 30.00, certificate) + 500.00 -> total 1,500.00, WHT 30.00, cash 1,470.00; each target outstanding is total - settles', () => {
    const d = get('rc-multi');
    expect(d.totals).toMatchObject({ total: '1500.00', wht: '30.00', cash: '1470.00' });
    expect(d.allocations!.map((a) => [a.targetId, a.amount, a.wht, a.certNumber])).toEqual([['ti-057', '1000.00', '30.00', 'ท.2569/0451'], ['spike-60', '500.00', undefined, undefined]]);
    expect(identity(d)).toEqual([150000, 150000]);
    expect(get('ti-057').outstanding).toBe('63200.00'); // 64,200.00 - 1,000.00
    expect(get('spike-60').outstanding).toBe('761875.00'); // 762,375.00 - 500.00
    for (const id of ['ti-057', 'spike-60']) expect(sat(get(id).outstanding!)).toBe(owed(id));
    expect(move('rc-multi', '1180')).toBe(3000); // GL(1180) movement of the RC = Σ wht
    expect(move('rc-multi', '1130')).toBe(-150000);
    expect(move('rc-multi', '1121')).toBe(147000);
  });
  it('rc-nocert carries WHT without a certificate number (the chase list of TX2)', () => {
    const d = get('rc-nocert');
    expect(d.allocations).toHaveLength(1);
    expect(d.allocations![0]).toMatchObject({ targetId: 'ti-037', amount: '10000.00', wht: '300.00' });
    expect(d.allocations![0].certNumber).toBeUndefined();
    expect(identity(d)).toEqual([1000000, 1000000]);
    expect(move('rc-nocert', '1180')).toBe(30000);
  });
  it('rc-dep: a 5,000.00 deposit from pc-08 with no allocation credits the customer deposit and settles nothing', () => {
    const d = get('rc-dep');
    expect(d.header.partyId).toBe('pc-08');
    expect(d.allocations ?? []).toEqual([]);
    expect(d.totals).toMatchObject({ total: '5000.00', cash: '5000.00', wht: '0.00' });
    expect(identity(d)).toEqual([500000, 500000]);
    expect(st.links.some((l) => l.from === 'rc-dep' && l.kind === 'settles')).toBe(false);
    expect(move('rc-dep', '2140')).toBe(-500000);
    expect(move('rc-dep', '1121')).toBe(500000);
  });
  it('nrc-cash: a non-VAT cash bill prints its lines; no VAT, Dr bank = Cr revenue = Σ lines', () => {
    const d = get('nrc-cash');
    expect(d.companyId).toBe(NV);
    expect(d.lines).toHaveLength(2);
    expect(d.totals).toMatchObject({ vat: '0.00', total: '850.00', cash: '850.00' });
    expect(identity(d)).toEqual([85000, 85000]);
    expect(move('nrc-cash', '1121')).toBe(85000);
    expect(move('nrc-cash', '4100')).toBe(-85000);
    expect(move('nrc-cash', '2151')).toBe(0);
  });
  it('seed-wide: every receipt satisfies the identity, GL(1180) = Σ WHT of the live receipts, and the invariants hold', () => {
    const live = st.docs.filter((d) => d.type === 'RC' && ['issued', 'partly_settled', 'settled'].includes(d.status));
    expect(live.length).toBeGreaterThan(40);
    for (const d of live) { const [l, r] = identity(d); expect({ id: d.id, l }).toEqual({ id: d.id, l: r }); }
    for (const company of [VAT, NV]) {
      expect(glCompany(company, '1180')).toBe(live.filter((d) => d.companyId === company).reduce((a, d) => a + sat(d.totals.wht!), 0));
    }
    expect(glCompany(VAT, '1180')).toBe(33000); // rc-multi 30.00 + rc-nocert 300.00
    for (const t of st.docs.filter((d) => ['TI', 'IV'].includes(d.type) && ['issued', 'partly_settled', 'settled'].includes(d.status))) expect({ id: t.id, o: sat(t.outstanding!) }).toEqual({ id: t.id, o: owed(t.id) });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('every seeded receipt names the bank account it posts to', () => {
    for (const d of st.docs.filter((x) => x.type === 'RC' && x.status !== 'draft')) expect({ id: d.id, bank: d.header.bankAccountId }).toEqual({ id: d.id, bank: expect.stringMatching(/^n?ba-/) });
  });
});

describe('a multi-invoice receipt through the engine', () => {
  it('two invoices + a deposit: total, WHT and cash are the engine\'s, the targets follow the links, cancel gives every target back its pre-RC outstanding', () => {
    const pre = { a: get('spike-1').outstanding, b: get('spike-25').outstanding };
    const rc = receipt(VAT, 'pc-01', [alloc('spike-1', '1000.00', { wht: '30.00', whtTypeCode: 'SVC' }), alloc('spike-25', '500.00')], { depositAmount: '250.00' });
    expect(rc.totals).toMatchObject({ total: '1750.00', wht: '30.00', cash: '1720.00' });
    expect(identity(rc)).toEqual([175000, 175000]);
    expect(get('spike-1')).toMatchObject({ outstanding: '70.00', status: 'partly_settled' });
    expect(get('spike-25').outstanding).toBe('164280.00');
    for (const id of ['spike-1', 'spike-25']) expect(sat(get(id).outstanding!)).toBe(owed(id));
    expect(move(rc.id, '1180')).toBe(3000);
    expect(move(rc.id, '2140')).toBe(-25000);
    expect(move(rc.id, '1130')).toBe(-150000);
    assertBalanced(st);

    cancel(st, rc.id, get(rc.id).version, 'OTHER', 'ทดสอบ', me);
    expect({ a: get('spike-1').outstanding, b: get('spike-25').outstanding }).toEqual(pre);
    expect([get('spike-1').status, get('spike-25').status]).toEqual(['issued', 'issued']);
    for (const id of ['spike-1', 'spike-25']) expect(sat(get(id).outstanding!)).toBe(owed(id));
    expect(move(rc.id, '1180')).toBe(0); // reversed: nothing stays receivable
    expect(move(rc.id, '1121')).toBe(0);
    expect(st.links.filter((l) => l.from === rc.id && l.active)).toEqual([]);
    assertBalanced(st);
  });
  it('over-allocation, WHT above the amount and another customer\'s invoice are refused before anything is written', () => {
    const attempt = (a: Allocation[], partyId = 'pc-01') => { const d = createDraft(st, VAT, 'RC', { header: { partyId, documentDate: '2026-10-14' }, lines: [], allocations: a }, me, `k-${++n}`); return code(() => issue(st, d.id, d.version, me)); };
    expect(attempt([alloc('spike-1', '1070.01')])).toBe('settle.over_allocation');
    expect(attempt([alloc('spike-1', '100.00', { wht: '100.01' })])).toBe('rc.wht_exceeds_amount');
    expect(attempt([alloc('ti-037', '100.00')])).toBe('settle.party_mismatch');
    expect(get('spike-1').outstanding).toBe('1070.00');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('late certificate (50 tawi): a non-fiscal in-place edit of an issued receipt (T-class, SP0 7.3)', () => {
  const withCert = (d: Doc, certNumber: string) => ({ header: d.header, lines: d.lines, allocations: d.allocations!.map((a) => ({ ...a, certNumber })) });
  it('revise keeps the number, bumps the revision, leaves links, totals and journal untouched, and the activity names the certificate', () => {
    const d = get('rc-nocert');
    const journal = structuredClone(st.journals.find((j) => j.docId === d.id)!.preview);
    const links = structuredClone(st.links.filter((l) => l.from === d.id));
    const r = revise(st, d.id, withCert(d, 'ท.2569/0777'), d.version, 'บันทึกหนังสือรับรอง', me);
    expect(r.number).toBe(d.number);
    expect(r.revision).toBe(d.revision + 1);
    expect(r.allocations![0].certNumber).toBe('ท.2569/0777');
    expect(r.totals).toEqual(d.totals);
    expect(st.journals.find((j) => j.docId === d.id)!.preview).toEqual(journal);
    expect(st.links.filter((l) => l.from === d.id)).toEqual(links);
    expect(st.activity.filter((a) => a.docId === d.id).at(-1)).toMatchObject({ action: 'revise', detail: 'บันทึกเลขที่หนังสือรับรองหัก ณ ที่จ่าย ท.2569/0777' });
    assertBalanced(st);
  });
  it('the correction plan for a certificate-only change is the single revise step', () => {
    const d = get('rc-nocert');
    const plan = correctionPlan(st, d.id, withCert(d, 'ท.2569/0888'), 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
    executePlan(st, plan.planId, plan.planHash, me);
    expect(get(d.id)).toMatchObject({ number: d.number, revision: d.revision + 1, status: d.status });
    expect(get(d.id).allocations![0].certNumber).toBe('ท.2569/0888');
  });
  it('changing the money in place is still refused: only the certificate number is free', () => {
    const d = get('rc-nocert');
    const money = { header: d.header, lines: d.lines, allocations: d.allocations!.map((a) => ({ ...a, wht: '250.00' })) };
    expect(code(() => revise(st, d.id, money, d.version, 'x', me))).toBe('doc.revise_not_allowed');
    expect(get(d.id).revision).toBe(d.revision);
  });
});

describe('correction plan on a receipt: cancel + reissue keeps each target\'s settled amount and the bank it posted to', () => {
  it('a WHT change reissues rc-multi: same 1,000.00 / 500.00 on the same targets, same account, only the WHT moves cash', () => {
    const d = get('rc-multi');
    const banks = bankMonths(VAT), gl1180 = glCompany(VAT, '1180');
    const proposed = { header: d.header, lines: d.lines, allocations: d.allocations!.map((a) => (a.wht ? { ...a, wht: '25.00' } : a)) };
    const plan = correctionPlan(st, d.id, proposed, 'accountant');
    expect(plan.steps.map((s) => [s.action, s.docType])).toEqual([['cancel', 'RC'], ['reissue', 'RC']]);
    const res = executePlan(st, plan.planId, plan.planHash, me);
    const nw = get(res.affected.find((a) => a.type === 'RC' && a.status === 'issued')!.docId);
    expect(nw.replacesId).toBe('rc-multi');
    expect(get('rc-multi').status).toBe('replaced');
    expect(nw.allocations!.map((a) => [a.targetId, a.amount, a.wht])).toEqual([['ti-057', '1000.00', '25.00'], ['spike-60', '500.00', undefined]]);
    expect(get('ti-057').outstanding).toBe('63200.00');
    expect(get('spike-60').outstanding).toBe('761875.00');
    for (const id of ['ti-057', 'spike-60']) expect(sat(get(id).outstanding!)).toBe(owed(id));
    expect(nw.header.bankAccountId).toBe(d.header.bankAccountId);
    expect(nw.header.documentDate).toBe(d.header.documentDate);
    expect(identity(nw)).toEqual([150000, 150000]);
    expect(nw.totals).toMatchObject({ wht: '25.00', cash: '1475.00' });
    // the only thing that moved: 5.00 more cash in the SAME account and month, 5.00 less WHT receivable
    expect(diff(banks, bankMonths(VAT))).toEqual({ '1121|2026-10': 500 });
    expect(glCompany(VAT, '1180') - gl1180).toBe(-500);
    assertBalanced(st);
  });
  it('a header without a bank account still reissues into the original account (the posted one, not the company default)', () => {
    const d = get('rc-multi');
    const other = st.bankAccounts.find((b) => b.companyId === VAT && b.id !== 'ba-kbank' && b.accountCode !== '1110')!; // ba-scb
    const moved = executePlanFor('rc-multi', { ...d.header, bankAccountId: other.id }, d);
    expect(get(moved).header.bankAccountId).toBe(other.id);
    const second = get(moved);
    const stripped = { ...second.header }; delete stripped.bankAccountId;
    const again = executePlanFor(moved, { ...stripped, dimensions: { project: 'X' } }, second); // a real change with the bank field absent: reissued, into the posted account
    expect(get(again).header.bankAccountId).toBe(other.id);
    assertBalanced(st);
  });
  it('a notes-only edit with the bank field absent stays in place (S6 carry 3) and keeps the posted account, even when it is not the company default', () => {
    const first = get('rc-multi');
    const other = st.bankAccounts.find((b) => b.companyId === VAT && b.id !== 'ba-kbank' && b.accountCode !== '1110')!;
    const id = executePlanFor('rc-multi', { ...first.header, bankAccountId: other.id }, first); // now posted to a bank that is not the company default
    const d = get(id);
    expect(d.header.bankAccountId).toBe(other.id);
    const stripped = { ...d.header, notes: 'x' }; delete stripped.bankAccountId;
    const plan = correctionPlan(st, id, { header: stripped, lines: d.lines, allocations: d.allocations }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
    executePlan(st, plan.planId, plan.planHash, me);
    expect(get(id).header.bankAccountId).toBe(other.id);
    expect(get(id).header.notes).toBe('x');
    assertBalanced(st);
  });
  /** Correction plan that changes the header of receipt `id`. */
  function executePlanFor(id: string, header: Doc['header'], d: Doc): string {
    const plan = correctionPlan(st, id, { header, lines: d.lines, allocations: d.allocations }, 'accountant');
    const res = executePlan(st, plan.planId, plan.planHash, me);
    return res.affected.find((a) => a.type === 'RC' && a.status === 'issued')!.docId;
  }
  it('ti-011 customer change (TI, its receipt cancelled and reissued): no bank account changes in any month', () => {
    const ti = get('ti-011');
    const rcId = st.links.find((l) => l.active && l.kind === 'settles' && l.to === 'ti-011')!.from;
    const rcAmount = sat(get(rcId).totals.total);
    const before = bankMonths(VAT);
    const month = `${get(rcId).header.documentDate.slice(0, 7)}`;
    const bankCode = st.bankAccounts.find((b) => b.id === get(rcId).header.bankAccountId)!.accountCode;
    const key = `${bankCode}|${month}`;
    expect(before[key]).toBeGreaterThanOrEqual(rcAmount); // the receipt is in that account's month
    const other = st.parties.find((p) => p.kind === 'customer' && p.companyId === VAT && p.id !== ti.header.partyId && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, 'ti-011', { header: { ...ti.header, partyId: other.id }, lines: ti.lines }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, me);
    expect(diff(before, bankMonths(VAT))).toEqual({}); // 1121 September stays; nothing moves to another account
    expect(get('ti-011').status).toBe('replaced');
    assertBalanced(st);
  });
  it('a plan that really changes money moves only that account and month (cash receipt -> other bank)', () => {
    const d = get('rc-multi');
    const before = bankMonths(VAT);
    executePlanFor('rc-multi', { ...d.header, bankAccountId: 'ba-scb' }, d);
    expect(diff(before, bankMonths(VAT))).toEqual({ '1121|2026-10': -147000, '1122|2026-10': 147000 });
  });
});

describe('new invariants: every entry has postedAt; GL(1180) is the live receipts\' WHT', () => {
  it('an entry without postedAt is reported, naming the document', () => {
    const j = st.journals.find((x) => x.docId === 'rc-multi')!;
    delete j.preview.entries[0].postedAt;
    expect(checkInvariants(st).join('\n')).toMatch(/rc-multi.*postedAt/);
  });
  it('every entry of a freshly written receipt, its reversal and its reissue carries postedAt', () => {
    const rc = receipt(VAT, 'pc-01', [alloc('spike-25', '100.00')]);
    cancel(st, rc.id, get(rc.id).version, 'OTHER', 'x', me);
    for (const e of st.journals.find((x) => x.docId === rc.id)!.preview.entries) expect(e.postedAt).toBeTruthy();
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a stray 1180 posting is caught seed-wide', () => {
    const j = st.journals.find((x) => x.docId === 'rc-multi')!;
    j.preview.entries.push({ date: '2026-10-12', kind: 'correction', postedAt: '2026-10-12T10:00:00+07:00', lines: [
      { accountCode: '1180', accountName: 'x', debit: '5.00', credit: '0.00', rule: 'r' }, { accountCode: '1130', accountName: 'x', debit: '0.00', credit: '5.00', rule: 'r' }] });
    expect(checkInvariants(st).join('\n')).toMatch(/GL 1180/);
  });
});

describe('fix round 1 (Opus S4 review): party on an RC correction, in-place whitelist, satang, certificate, pre-validation, 1180 role', () => {
  const rcBody = (d: Doc, p: { header?: Partial<Doc['header']>; allocations?: Allocation[]; lines?: DocLine[] } = {}) =>
    ({ header: { ...d.header, ...p.header }, lines: p.lines ?? d.lines, allocations: p.allocations ?? d.allocations });
  const written = () => JSON.stringify([st.docs, st.links, st.journals]);

  it('I1: rc-multi given to another customer while keeping its allocations is refused before the plan is shown, with an exit, nothing written', () => {
    const d = get('rc-multi');
    const before = written();
    let err: { code?: string; status?: number; message?: string } = {};
    try { correctionPlan(st, d.id, rcBody(d, { header: { partyId: 'pc-02' } }), 'accountant'); } catch (e) { err = e as typeof err; }
    expect(err.code).toBe('settle.party_mismatch');
    expect(err.status).toBe(422);
    expect(err.message).toContain('ยกเลิกใบเสร็จแล้วออกใบใหม่ให้ลูกค้าที่ถูกต้อง');
    expect(written()).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('I1: the settlement layer alone also refuses a carried allocation when the receipt\'s own party changed (prior no longer exempts the party check)', () => {
    const d = get('rc-multi');
    const draft = createDraft(st, VAT, 'RC', { header: { ...d.header, partyId: 'pc-02' }, lines: [], allocations: d.allocations!.map((a) => ({ ...a })) }, me, `k-${++n}`);
    cancel(st, d.id, d.version, 'OTHER', 'x', me);
    const before = written();
    expect(code(() => issue(st, draft.id, draft.version, me, { keepDate: true, prior: d.allocations, priorParty: d.header.partyId }))).toBe('settle.party_mismatch');
    expect(written()).toBe(before);
  });
  it('I1 guard: a customer change on a settled invoice still carries amounts, certificate and bank into the reissued receipt (receipt party unchanged)', () => {
    const rc = receipt(VAT, 'pc-01', [alloc('spike-1', '1000.00', { wht: '30.00', whtTypeCode: 'SVC', certNumber: 'C-1' }), alloc('spike-25', '500.00')], { bankAccountId: 'ba-scb' });
    const ti = get('spike-1');
    const other = st.parties.find((p) => p.kind === 'customer' && p.companyId === VAT && p.id !== 'pc-01' && p.vatRegistered && p.taxId)!;
    const plan = correctionPlan(st, ti.id, { header: { ...ti.header, partyId: other.id }, lines: ti.lines }, 'accountant');
    expect(plan.steps.map((s) => [s.action, s.docType])).toEqual([['cancel', 'RC'], ['reissue', 'TI'], ['reissue', 'RC']]);
    executePlan(st, plan.planId, plan.planHash, me);
    const nw = st.docs.find((x) => x.replacesId === rc.id)!;
    expect(nw.header).toMatchObject({ bankAccountId: 'ba-scb', partyId: 'pc-01' });
    expect(nw.allocations!.map((a) => [a.amount, a.wht, a.certNumber])).toEqual([['1000.00', '30.00', 'C-1'], ['500.00', undefined, undefined]]);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('M1: in place, a receipt takes only certificate numbers, notes and reference; dimensions and cheque are refused doc.revise_not_allowed', () => {
    const d = get('rc-nocert');
    const dims = rcBody(d, { header: { dimensions: { project: 'P9' } } });
    const cheque = rcBody(d, { header: { paymentMethod: 'cheque', cheque: { number: '123', date: '2026-10-14', bank: 'KBANK' } } });
    expect(code(() => revise(st, d.id, dims, d.version, 'x', me))).toBe('doc.revise_not_allowed');
    expect(code(() => revise(st, d.id, cheque, d.version, 'x', me))).toBe('doc.revise_not_allowed');
    expect(get(d.id).revision).toBe(d.revision);
    const ok = revise(st, d.id, rcBody(d, { header: { notes: 'หมายเหตุ', reference: 'REF-1' }, allocations: d.allocations!.map((a) => ({ ...a, certNumber: 'ท.2569/0999' })) }), d.version, 'x', me);
    expect(ok).toMatchObject({ revision: d.revision + 1, header: { notes: 'หมายเหตุ', reference: 'REF-1' } });
    expect(ok.allocations![0].certNumber).toBe('ท.2569/0999');
  });
  it('M1: the plan for a dimension change on a receipt is cancel + reissue, not an in-place revise that would fail at execute', () => {
    const d = get('rc-nocert');
    const plan = correctionPlan(st, d.id, rcBody(d, { header: { dimensions: { project: 'P9' } } }), 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['cancel', 'reissue']);
  });

  it('M2: a deposit of "5000" equals the stored "5000.00": revise is fine and the plan is a single revise, never cancel + reissue of an identical receipt', () => {
    const d = get('rc-dep');
    expect(d.header.depositAmount).toBe('5000.00');
    const body = rcBody(d, { header: { depositAmount: '5000', notes: 'x' } });
    expect(code(() => revise(st, d.id, body, d.version, 'x', me))).toBeUndefined();
    const d2 = get('rc-dep');
    const plan = correctionPlan(st, d2.id, rcBody(d2, { header: { depositAmount: '5000.0', notes: 'y' } }), 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
    const real = correctionPlan(st, d2.id, rcBody(d2, { header: { depositAmount: '4000' } }), 'accountant');
    expect(real.steps.map((s) => s.action)).toEqual(['cancel', 'reissue']);
  });

  it('M3: a certificate number on an allocation with no WHT is 422 rc.cert_without_wht at issue, revise and plan; nothing is written', () => {
    const d = get('rc-multi');
    const bad = d.allocations!.map((a) => (a.wht ? a : { ...a, certNumber: 'NOWHT' }));
    const draft = createDraft(st, VAT, 'RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [], allocations: [alloc('spike-1', '100.00', { certNumber: 'X-1' })] }, me, `k-${++n}`);
    const before = written();
    expect(code(() => revise(st, d.id, rcBody(d, { allocations: bad }), d.version, 'x', me))).toBe('rc.cert_without_wht');
    expect(code(() => correctionPlan(st, d.id, rcBody(d, { allocations: bad }), 'accountant'))).toBe('rc.cert_without_wht');
    expect(code(() => issue(st, draft.id, draft.version, me))).toBe('rc.cert_without_wht');
    expect(written()).toBe(before);
  });

  it('M4: a plan that cannot execute is never offered (lines on a VAT receipt, over-allocation)', () => {
    const d = get('rc-multi');
    expect(code(() => correctionPlan(st, d.id, rcBody(d, { lines: [line('l1', '10.00')] }), 'accountant'))).toBe('rc.lines_need_invoice');
    const over = d.allocations!.map((a) => (a.targetId === 'ti-057' ? { ...a, amount: '999999.00' } : a));
    expect(code(() => correctionPlan(st, d.id, rcBody(d, { allocations: over }), 'accountant'))).toBe('settle.over_allocation');
    expect(Object.keys(st.plans ?? {})).toEqual([]);
  });
  it('M4: a legitimate correction of a receipt (its own amounts given back) still plans and runs', () => {
    const d = get('rc-multi');
    const plan = correctionPlan(st, d.id, rcBody(d, { allocations: d.allocations!.map((a) => (a.wht ? { ...a, wht: '20.00' } : a)) }), 'accountant');
    executePlan(st, plan.planId, plan.planHash, me);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('M5: GL(1180) is judged on the account the posting profile gives WhtReceivable, not on the code 1180', () => {
    const acc = st.accounts.find((a) => a.companyId === VAT && a.code === '1180')!;
    st.accounts.push({ ...acc, code: '1181' });
    st.postingRules.find((r) => r.companyId === VAT && r.role === 'WhtReceivable')!.accountCode = '1181';
    for (const j of st.journals) if (get(j.docId).companyId === VAT) for (const e of j.preview.entries) for (const l of e.lines) if (l.accountCode === '1180') l.accountCode = '1181';
    expect(checkInvariants(st).filter((x) => /GL 11/.test(x))).toEqual([]);
    const j = st.journals.find((x) => x.docId === 'rc-multi')!;
    j.preview.entries.push({ date: '2026-10-12', kind: 'correction', postedAt: '2026-10-12T10:00:00+07:00', lines: [
      { accountCode: '1181', accountName: 'x', debit: '5.00', credit: '0.00', rule: 'r' }, { accountCode: '1130', accountName: 'x', debit: '0.00', credit: '5.00', rule: 'r' }] });
    expect(checkInvariants(st).join('\n')).toMatch(/GL 1181/);
  });
});

describe('receipt paper model (server-built: rows, figures, words, payment)', () => {
  const paper = (id: string, company = VAT) => PAPER_BUILDERS.RC!({ st, company: st.companies.find((c) => c.id === company)! } as never, publicDoc(get(id)), false);
  it('rc-multi: one row per settled invoice with number, date, amount and its WHT; the figures and the words are the document\'s', () => {
    const p = paper('rc-multi');
    expect(p).toMatchObject({ titleTh: 'ใบเสร็จรับเงิน', titleEn: 'RECEIPT', number: get('rc-multi').number });
    expect(p.lines.map((l) => [l.description, l.amount, l.wht])).toEqual([
      [expect.stringMatching(/^ใบกำกับภาษี TI-202601-0003 ลงวันที่ /), '1000.00', '30.00'],
      [expect.stringMatching(/^ใบกำกับภาษี TI-202503-0003 ลงวันที่ /), '500.00', undefined]]);
    expect(p.totals).toEqual(get('rc-multi').totals);
    expect(p.totals).toMatchObject({ total: '1500.00', wht: '30.00', cash: '1470.00' });
    expect(p.totals.amountInWords).toBe('หนึ่งพันห้าร้อยบาทถ้วน');
    expect(p.vatLines).toBeUndefined(); // a receipt is not a tax document: no VAT rows even for a VAT company
    expect(p.payment).toBe('โอนเงิน · กสิกรไทย กระแสรายวัน 012-3-45678-9');
  });
  it('rc-dep: the deposit prints as its own row so the rows add up to the total', () => {
    const p = paper('rc-dep');
    expect(p.lines.map((l) => [l.description, l.amount])).toEqual([['เงินรับล่วงหน้า', '5000.00']]);
    expect(p.totals.total).toBe('5000.00');
  });
  it('nrc-cash: the cash bill prints its own lines with quantity and price, no settled-document rows', () => {
    const p = paper('nrc-cash', NV);
    expect(p.lines.map((l) => [l.description, l.qty, l.unit, l.unitPrice, l.amount])).toEqual([
      ['ค่าเช่าแผงชั่วคราวรายวัน', '2', 'วัน', '350.00', '700.00'], ['ค่าไฟฟ้าแผง', '1', 'งาน', '150.00', '150.00']]);
    expect(p.vatLines).toBeUndefined();
  });
  it('a cheque and a cash receipt say how the money came in', () => {
    const chq = receipt(VAT, 'pc-01', [alloc('spike-25', '100.00')], { paymentMethod: 'cheque', cheque: { number: '0012345', date: '2026-10-14', bank: 'ธนาคารกรุงเทพ' } });
    expect(paper(chq.id).payment).toBe('เช็ค 0012345 ลงวันที่ 14 ต.ค. 2569 ธนาคารกรุงเทพ');
    const cash = receipt(VAT, 'pc-01', [alloc('spike-25', '100.00')], { paymentMethod: 'cash' });
    expect(paper(cash.id).payment).toBe('เงินสด · เงินสดย่อย');
  });
  it('a cancelled receipt is stamped void with its reason', () => {
    const rc = receipt(VAT, 'pc-01', [alloc('spike-25', '100.00')]);
    cancel(st, rc.id, get(rc.id).version, 'OTHER', 'คีย์ผิด', me);
    expect(paper(rc.id).voidMark).toEqual({ label: 'ยกเลิก', note: 'คีย์ผิด' });
  });
});
