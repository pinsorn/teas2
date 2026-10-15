import { beforeEach, describe, expect, it } from 'vitest';
import type { Allocation, Doc, DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { fixtureIds } from '../fixtures/ids';
import { seed, type MockState } from '../store';
import { buildChain } from './chain';
import { CONVERSIONS } from '@/domain/doc-types';
import { calc, cancel, compute, convert, createDraft, issue, publicDoc, reissue, revise, updateDraft } from './commands';
import { buildPlan, correctionPlan, executePlan } from './corrections';
import { checkInvariants } from './invariants';
import { toSatang } from './money';
import { PAPER_BUILDERS } from './paper';
import { assertBalanced } from './test-helpers';
import { computeLine } from './vat';

const NV = 'co-nonvat', VAT = 'co-vat';
const line = (id: string, unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode: 'S7', ...p });
let st: MockState;
let n = 0;
beforeEach(() => { st = seed(); });
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const lastEntry = (id: string) => { const e = st.journals.find((j) => j.docId === id)!.preview.entries; return e[e.length - 1]; };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return undefined; };
const sat = (m: string) => toSatang(m);
const settled = (id: string) => st.links.filter((l) => l.active && l.kind === 'settles' && l.to === id).reduce((a, l) => a + sat(l.amount!), 0);
const bodyOf = (d: Doc, lines: DocLine[]) => ({ header: d.header, lines });
const newBl = (company: string, partyId: string, ids: string[], types: ('TI' | 'IV')[] = ids.map(() => 'IV')) =>
  createDraft(st, company, 'BL', { header: { partyId, documentDate: '2026-10-14' }, lines: [], allocations: ids.map((id, i): Allocation => ({ targetId: id, targetType: types[i], amount: '1.00' })) }, me, `k-${++n}`);

describe('I1: a non-VAT company carries VAT 0.00 whatever the tax code, in every caller of calc', () => {
  it('computeLine: S7 / Z0 / vatOverride / VAT-inclusive price all give VAT 0 for a non-VAT company, and the VAT company is unchanged', () => {
    expect(computeLine(line('a', '1000.00'), false, false)).toMatchObject({ net: 100000, vat: 0, total: 100000 });
    expect(computeLine(line('a', '1000.00'), true, false)).toMatchObject({ net: 100000, vat: 0, total: 100000 }); // nothing to extract
    expect(computeLine(line('a', '1000.00', { vatOverride: '70.00' }), false, false)).toMatchObject({ vat: 0, total: 100000 });
    expect(computeLine(line('a', '1000.00'), false, true)).toMatchObject({ net: 100000, vat: 7000, total: 107000 });
  });
  it('compute: the S7 line of an IV has VAT 0.00 and the journal preview has no 2151 line', () => {
    const r = compute(st, NV, 'IV', { header: { partyId: 'nc-01', documentDate: '2026-10-14' }, lines: [line('l1', '1000.00')] });
    expect(r.lines[0]).toMatchObject({ vat: '0.00', total: '1000.00' });
    expect(r.totals).toMatchObject({ net: '1000.00', vat: '0.00', total: '1000.00' });
    const codes = r.journal!.entries[0].lines.map((l) => l.accountCode);
    expect(codes).not.toContain('2151');
    expect(compute(st, VAT, 'TI', { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [line('l1', '1000.00')] }).totals.vat).toBe('70.00');
  });
  it('insertDraft, updateDraft, issue, revise and reissue all keep VAT 0.00 on an S7 line; the posting is Dr AR = total, Cr Revenue = net, Dr = Cr', () => {
    const d = createDraft(st, NV, 'IV', { header: { partyId: 'nc-01', documentDate: '2026-10-14' }, lines: [line('l1', '1000.00')] }, me, 'k-i1');
    expect(d.totals).toMatchObject({ vat: '0.00', total: '1000.00' });
    const u = updateDraft(st, d.id, { header: d.header, lines: [line('l1', '2000.00', { discountPct: '10' })] }, d.version, me);
    expect(u.totals).toMatchObject({ vat: '0.00', total: '1800.00' });
    const i = issue(st, d.id, u.version, me);
    expect(i.totals).toMatchObject({ vat: '0.00', total: '1800.00' });
    const e = lastEntry(i.id);
    expect(e.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['1130', '1800.00', '0.00'], ['4100', '0.00', '1800.00']]);
    const r = revise(st, i.id, bodyOf(i, [line('l1', '3000.00')]), i.version, 'แก้ราคา', me);
    expect(r.totals).toMatchObject({ vat: '0.00', total: '3000.00' });
    expect(lastEntry(i.id).lines.map((l) => l.accountCode)).toEqual(['1130', '4100']);
    const re = reissue(st, i.id, bodyOf(r, [line('l1', '3500.00')]), me, 'ออกใหม่');
    expect(re.totals).toMatchObject({ vat: '0.00', total: '3500.00' });
    expect(lastEntry(re.id).lines.map((l) => l.accountCode)).toEqual(['1130', '4100']);
    assertBalanced(st);
  });
  it('a VAT-inclusive price on a non-VAT company extracts nothing: IV and a cash-bill RC post Dr = Cr = the full price, no VAT line', () => {
    const iv = createDraft(st, NV, 'IV', { header: { partyId: 'nc-01', documentDate: '2026-10-14', priceIncludesVat: true }, lines: [line('l1', '1070.00')] }, me, 'k-incl');
    const issued = issue(st, iv.id, iv.version, me);
    expect(issued.totals).toMatchObject({ net: '1070.00', vat: '0.00', total: '1070.00' });
    expect(lastEntry(iv.id).lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['1130', '1070.00', '0.00'], ['4100', '0.00', '1070.00']]);
    const rc = createDraft(st, NV, 'RC', { header: { partyId: 'nc-01', documentDate: '2026-10-14', priceIncludesVat: true }, lines: [line('l1', '535.00')] }, me, 'k-cash');
    const paid = issue(st, rc.id, rc.version, me);
    expect(paid.totals).toMatchObject({ vat: '0.00', total: '535.00' });
    const codes = lastEntry(rc.id).lines.map((l) => [l.accountCode, l.debit, l.credit]);
    expect(codes).toEqual([['1121', '535.00', '0.00'], ['4100', '0.00', '535.00']]);
    assertBalanced(st);
  });
  it('calc takes the company flag; the paper of a non-VAT IV has VAT 0.00 and no VAT rows', () => {
    expect(calc({ header: { documentDate: '2026-10-14' }, lines: [line('l1', '100.00')] }, false).totals.vat).toBe('0.00');
    expect(calc({ header: { documentDate: '2026-10-14' }, lines: [line('l1', '100.00')] }, true).totals.vat).toBe('7.00');
    const paper = PAPER_BUILDERS.IV!({ st, company: st.companies.find((c) => c.id === NV)! } as never, publicDoc(get('iv-2')), false);
    expect(paper).toMatchObject({ titleTh: 'ใบแจ้งหนี้', number: get('iv-2').number });
    expect(paper.totals.vat).toBe('0.00');
    expect(paper.vatLines).toBeUndefined();
  });
  it('the seeded S7 IV (iv-2) is VAT 0.00 and the seed holds every invariant', () => {
    expect(get('iv-2').lines[0].taxCode).toBe('S7');
    expect(get('iv-2').totals).toMatchObject({ vat: '0.00', total: '2500.00' });
    expect(st.journals.find((j) => j.docId === 'iv-2')!.preview.entries[0].lines.map((l) => l.accountCode)).toEqual(['1130', '4100']);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('IV settlement, revise (L-class) and cancel', () => {
  it('outstanding = total − Σ active settles, and GL(1130) = Σ outstanding(TI ∪ IV) per company', () => {
    for (const [id, paid] of [['iv-p1', '3000.00'], ['iv-p2', '2500.00'], ['iv-s1', '2000.00'], ['iv-1', '0.00']] as const) {
      const d = get(id);
      expect(settled(id)).toBe(sat(paid));
      expect(sat(d.outstanding!)).toBe(sat(d.totals.total) - sat(paid));
    }
    expect([get('iv-p1').status, get('iv-s1').status, get('iv-1').status]).toEqual(['partly_settled', 'settled', 'issued']);
    for (const co of [NV, VAT]) {
      const gl = st.journals.filter((j) => get(j.docId).companyId === co).flatMap((j) => j.preview.entries.flatMap((e) => e.lines))
        .filter((l) => l.accountCode === '1130').reduce((a, l) => a + sat(l.debit) - sat(l.credit), 0);
      const sub = st.docs.filter((d) => d.companyId === co && ['TI', 'IV'].includes(d.type) && ['issued', 'partly_settled', 'settled'].includes(d.status)).reduce((a, d) => a + sat(d.outstanding!), 0);
      expect(gl).toBe(sub);
    }
    expect(checkInvariants(st)).toEqual([]);
  });
  it('revise below Σ settlements is refused (settle.below_settled + the exit); at or above it reverses and reposts with Dr = Cr', () => {
    const d = get('iv-p1'); // 8,000.00 with 3,000.00 received
    const before = JSON.stringify([get('iv-p1'), st.journals.find((j) => j.docId === 'iv-p1'), st.revisions.length]);
    expect(code(() => revise(st, d.id, bodyOf(d, [line('l1', '2500.00', { taxCode: 'EX' })]), d.version, 'ลดยอด', me))).toBe('settle.below_settled');
    expect(() => revise(st, d.id, bodyOf(d, [line('l1', '2999.99', { taxCode: 'EX' })]), d.version, 'ลดยอด', me)).toThrow('ยกเลิกหรือถอนการรับชำระก่อน');
    expect(JSON.stringify([get('iv-p1'), st.journals.find((j) => j.docId === 'iv-p1'), st.revisions.length])).toBe(before); // a refusal writes nothing
    expect(() => buildPlan(st, d.id, bodyOf(d, [line('l1', '2500.00', { taxCode: 'EX' })]), 'accountant')).toThrow('settle.below_settled'); // the plan says so before anything runs

    const up = revise(st, d.id, bodyOf(d, [line('l1', '9000.00', { taxCode: 'EX' })]), d.version, 'เพิ่มยอด', me);
    expect(up).toMatchObject({ revision: 1, status: 'partly_settled', outstanding: '6000.00' });
    const entries = st.journals.find((j) => j.docId === 'iv-p1')!.preview.entries;
    expect(entries.map((e) => e.kind)).toEqual(['original', 'reversal', 'correction']);
    expect(entries[2].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['1130', '9000.00', '0.00'], ['4100', '0.00', '9000.00']]);
    const exact = revise(st, d.id, bodyOf(up, [line('l1', '3000.00', { taxCode: 'EX' })]), up.version, 'เท่ายอดที่รับ', me);
    expect(exact).toMatchObject({ status: 'settled', outstanding: '0.00' }); // equal to what was received is allowed
    assertBalanced(st);
  });
  it('cancel is blocked while settled (doc.has_dependents), allowed when unpaid (reversal posted)', () => {
    const d = get('iv-p2');
    expect(code(() => cancel(st, d.id, d.version, 'OTHER', 'x', me))).toBe('doc.has_dependents');
    expect(code(() => cancel(st, 'iv-s1', get('iv-s1').version, 'OTHER', 'x', me))).toBe('doc.has_dependents');
    const u = get('iv-3');
    cancel(st, u.id, u.version, 'OTHER', 'ลูกค้ายกเลิก', me);
    expect(st.journals.find((j) => j.docId === 'iv-3')!.preview.entries.map((e) => e.kind)).toEqual(['original', 'reversal']);
    assertBalanced(st);
  });
});

describe('BL: groups open TI / IV of one party, no ledger, total = Σ outstanding at issue (server-computed)', () => {
  it('seeded BLs: total = Σ grouped outstanding, one active groups link per target, no journal', () => {
    for (const [id, targets] of [['bl-1', ['spike-60', 'ti-057']], ['nbl-1', ['iv-1', 'iv-4']]] as const) {
      const d = get(id);
      expect(d).toMatchObject({ type: 'BL', status: 'issued', lines: [] });
      expect(d.allocations!.map((a) => a.targetId)).toEqual(targets);
      // the amounts are what each target owed when the statement was issued; bl-1 (2026-10-10) predates rc-multi (2026-10-12, 1,000.00 + 500.00), so it is stale by 1,500.00 (S4 prefills from the CURRENT outstanding)
      const paidSince = id === 'bl-1' ? 150000 : 0;
      expect(sat(d.totals.total)).toBe(targets.reduce((a, t) => a + sat(get(t).outstanding!), 0) + paidSince);
      expect(d.allocations!.map((a) => sat(a.amount))).toEqual(targets.map((t) => sat(get(t).outstanding!) + (t === 'spike-60' ? 50000 : t === 'ti-057' ? 100000 : 0)));
      expect(st.links.filter((l) => l.active && l.kind === 'groups' && l.from === id).map((l) => l.to)).toEqual(targets);
      expect(st.journals.some((j) => j.docId === id)).toBe(false);
      expect(d.outstanding).toBeUndefined();
    }
    expect(checkInvariants(st)).toEqual([]);
  });
  it('the amounts are the server\'s: a client amount is ignored, and issue re-reads each target\'s outstanding (a payment between draft and issue)', () => {
    const bl = newBl(NV, 'nc-01', ['iv-1', 'iv-4']);
    expect(bl.allocations!.map((a) => a.amount)).toEqual(['4800.00', '3000.00']);
    expect(bl.totals.total).toBe('7800.00');
    const rc = createDraft(st, NV, 'RC', { header: { partyId: 'nc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'iv-1', targetType: 'IV', amount: '1000.00' }] }, me, 'k-rc');
    issue(st, rc.id, rc.version, me);
    const issued = issue(st, bl.id, bl.version, me);
    expect(issued.allocations!.map((a) => a.amount)).toEqual(['3800.00', '3000.00']);
    expect(issued.totals).toMatchObject({ total: '6800.00', vat: '0.00' });
    expect(st.journals.some((j) => j.docId === bl.id)).toBe(false);
    expect(buildChain(st, bl.id).edges.filter((e) => e.kind === 'groups' && e.active && e.from === bl.id).map((e) => e.to).sort()).toEqual(['iv-1', 'iv-4']);
    assertBalanced(st);
  });
  it('refuses a target of another party, another company, a closed / settled / wrong-type one, and an empty list', () => {
    const issueBl = (company: string, party: string, ids: string[], types?: ('TI' | 'IV')[]) => {
      const b = newBl(company, party, ids, types);
      return code(() => issue(st, b.id, b.version, me));
    };
    expect(issueBl(NV, 'nc-01', ['iv-1', 'iv-2'])).toBe('group.party_mismatch'); // iv-2 is nc-03's
    expect(issueBl(NV, 'nc-01', ['spike-60'], ['TI'])).toBe('group.target_not_found'); // another company's document
    expect(issueBl(NV, 'nc-05', ['iv-s1'])).toBe('group.nothing_outstanding');
    expect(issueBl(NV, 'nc-03', ['iv-can'])).toBe('group.target_not_open');
    expect(issueBl(NV, 'nc-02', ['rc-ivp1'])).toBe('group.wrong_type'); // a receipt is not groupable
    expect(issueBl(NV, 'nc-01', ['iv-1'], ['TI'])).toBe('group.wrong_type'); // iv-1 is an IV, not the TI the list says
    const empty = createDraft(st, NV, 'BL', { header: { partyId: 'nc-01', documentDate: '2026-10-14' }, lines: [], allocations: [] }, me, 'k-e');
    expect(code(() => issue(st, empty.id, empty.version, me))).toBe('doc.incomplete');
    expect(compute(st, NV, 'BL', { header: { partyId: 'nc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'iv-2', targetType: 'IV', amount: '1.00' }] }).missing.map((m) => m.field)).toContain('allocations');
    expect(st.links.filter((l) => l.kind === 'groups' && l.active)).toHaveLength(4); // only the seeded BLs hold links: every refusal wrote nothing
    expect(st.series[`${NV}|BL|2026-10`]).toBe(1);
  });
  it('cancel releases the group links (the targets are untouched and can be grouped again); BL has no journal to reverse', () => {
    const before = [get('iv-1').outstanding, get('iv-4').outstanding, get('iv-1').status];
    const b = get('nbl-1');
    cancel(st, b.id, b.version, 'OTHER', 'ลูกค้าขอเปลี่ยน', me);
    expect(get('nbl-1').status).toBe('cancelled');
    expect(st.links.filter((l) => l.kind === 'groups' && l.from === 'nbl-1').every((l) => !l.active)).toBe(true);
    expect([get('iv-1').outstanding, get('iv-4').outstanding, get('iv-1').status]).toEqual(before);
    expect(st.journals.some((j) => j.docId === 'nbl-1')).toBe(false);
    const again = newBl(NV, 'nc-01', ['iv-1', 'iv-4']);
    expect(issue(st, again.id, again.version, me).totals.total).toBe('7800.00');
    assertBalanced(st);
  });
  it('a BL is revised in place (N-class): dropping a target re-points the links and the total follows the kept amounts', () => {
    const b = get('nbl-1');
    const rev = revise(st, b.id, { header: b.header, lines: [], allocations: [b.allocations![0]] }, b.version, 'เหลือใบเดียว', me);
    expect(rev).toMatchObject({ revision: 1, totals: { total: '4800.00' } });
    expect(st.links.filter((l) => l.kind === 'groups' && l.from === 'nbl-1' && l.active).map((l) => l.to)).toEqual(['iv-1']);
    assertBalanced(st);
  });
  it('revising an issued BL to drop one invoice is not blocked by a kept invoice that was paid in full after issue; adding that paid invoice is', () => {
    const rc = createDraft(st, NV, 'RC', { header: { partyId: 'nc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'iv-4', targetType: 'IV', amount: '3000.00' }] }, me, 'k-pay4');
    issue(st, rc.id, rc.version, me);
    const b = get('nbl-1');
    const rev = revise(st, b.id, { header: b.header, lines: [], allocations: b.allocations!.filter((a) => a.targetId === 'iv-4') }, b.version, 'ตัด iv-1 ออก', me);
    expect(rev.totals.total).toBe('3000.00'); // iv-4 stays at what it owed when the statement was issued
    const again = createDraft(st, NV, 'BL', { header: { partyId: 'nc-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: 'iv-4', targetType: 'IV', amount: '1.00' }] }, me, 'k-bl2');
    expect(code(() => issue(st, again.id, again.version, me))).toBe('group.nothing_outstanding'); // a NEW statement cannot group a paid invoice
    assertBalanced(st);
  });
  it('the IV chain node shows the settlement progress like a TI', () => {
    expect(buildChain(st, 'iv-p1').nodes.find((x) => x.id === 'iv-p1')!.progress).toBe('ชำระแล้ว 3000.00 / 8000.00');
  });
  it('IV → BL converts into a BL draft grouping that invoice (no quantities), which issues', () => {
    const iv = get('iv-2');
    const draft = convert(st, iv.id, 'BL', [], me);
    expect(draft).toMatchObject({ type: 'BL', status: 'draft', lines: [], header: { partyId: 'nc-03' } });
    expect(draft.allocations!.map((a) => [a.targetId, a.amount])).toEqual([['iv-2', '2500.00']]);
    expect(issue(st, draft.id, draft.version, me).totals.total).toBe('2500.00');
    assertBalanced(st);
  });
  it('checkInvariants reports a corrupted BL: total off, a group link lost, a journal, a foreign-party target (each can fail)', () => {
    const msgs = (s: MockState) => checkInvariants(s).join('\n');
    const a = seed(); a.docs.find((d) => d.id === 'nbl-1')!.totals.total = '1.00';
    expect(msgs(a)).toMatch(/nbl-1: BL total 1\.00 is not Σ allocation amounts/);
    const b = seed(); b.links.find((l) => l.kind === 'groups' && l.from === 'nbl-1')!.active = false;
    expect(msgs(b)).toMatch(/nbl-1: allocations .* but the active groups links/);
    const c = seed(); c.journals.push({ docId: 'nbl-1', preview: { entries: [] } });
    expect(msgs(c)).toMatch(/nbl-1: .*BL.* has a journal/);
    const d = seed(); d.docs.find((x) => x.id === 'nbl-1')!.header.partyId = 'nc-02';
    expect(msgs(d)).toMatch(/nbl-1: .*party/);
  });
  it('the named fixtures resolve', () => {
    expect(fixtureIds(st)).toMatchObject({ ivDraft: 'iv-d1', ivIssuedUnpaid: 'iv-1', ivPartly: 'iv-p1', ivSettled: 'iv-s1', blVat: 'bl-1', blNonVat: 'nbl-1' });
  });
});

describe('S3 fix round 1 (Opus review)', () => {
  const ivBody = (d: Doc, p: { partyId?: string; documentDate?: string; price?: string } = {}) =>
    ({ header: { ...d.header, ...(p.partyId ? { partyId: p.partyId } : {}), ...(p.documentDate ? { documentDate: p.documentDate } : {}) }, lines: [line('l1', p.price ?? '5000.00', { taxCode: 'EX' })] });
  const snap = () => JSON.stringify([st.docs, st.links, st.journals, st.revisions, st.series]);
  const month = (id: string, m: string) => st.journals.find((j) => j.docId === id)!.preview.entries
    .filter((e) => e.date.startsWith(m)).flatMap((e) => e.lines).filter((l) => l.accountCode === '4100').reduce((a, l) => a + sat(l.credit) - sat(l.debit), 0);

  it('C1: an IV with receipts or a BL cannot change customer (revise and plan); the AR subledger stays clean; an unlinked IV can', () => {
    for (const [id, to] of [['iv-p1', 'nc-01'], ['iv-1', 'nc-02']] as const) {
      const d = get(id), before = snap();
      expect(code(() => revise(st, id, ivBody(d, { partyId: to, price: '4800.00' }), d.version, 'เปลี่ยนลูกค้า', me))).toBe('doc.party_locked');
      expect(() => revise(st, id, ivBody(d, { partyId: to }), d.version, 'x', me)).toThrow('ยกเลิกใบเสร็จ/ใบวางบิลที่อ้างถึงก่อน');
      expect(code(() => buildPlan(st, id, ivBody(d, { partyId: to }), 'accountant'))).toBe('doc.party_locked');
      expect(snap()).toBe(before);
      expect(checkInvariants(st)).toEqual([]);
    }
    const free = get('iv-3');
    revise(st, free.id, ivBody(free, { partyId: 'nc-01', price: '6210.00' }), free.version, 'เปลี่ยนลูกค้า', me);
    expect(get('iv-3').header.partyId).toBe('nc-01');
    assertBalanced(st);
  });

  it('I1: the generic convert never creates a settle-type document (RC / PV), writes nothing, and IV no longer lists RC', () => {
    const before = snap();
    expect(code(() => convert(st, 'iv-1', 'RC', [{ sourceLineId: 'iv-1-l1', qty: '40' }], me))).toBe('doc.conversion_not_allowed');
    expect(code(() => convert(st, fixtureIds(st).tiIssuedUnpaid, 'RC', [{ sourceLineId: get(fixtureIds(st).tiIssuedUnpaid).lines[0].id, qty: '1' }], me))).toBe('doc.conversion_not_allowed');
    expect(snap()).toBe(before);
    expect(CONVERSIONS.IV).toEqual(['BL']);
  });

  it('I2: revise refuses a date in a closed month or the future (IV, and N-class SO through the shared path); an unchanged date is fine', () => {
    const d = get('iv-1'), before = snap();
    expect(code(() => revise(st, d.id, ivBody(d, { documentDate: '2026-05-01', price: '4800.00' }), d.version, 'x', me))).toBe('period.closed');
    expect(code(() => revise(st, d.id, ivBody(d, { documentDate: '2026-12-01', price: '4800.00' }), d.version, 'x', me))).toBe('doc.future_date');
    const so = get('so-part');
    expect(code(() => revise(st, so.id, { header: { ...so.header, documentDate: '2026-12-01' }, lines: so.lines }, so.version, 'x', me))).toBe('doc.future_date');
    expect(snap()).toBe(before);
    expect(revise(st, d.id, ivBody(d, { price: '5000.00' }), d.version, 'ราคา', me).totals.total).toBe('5000.00');
    const ti = get(fixtureIds(st).tiIssuedUnpaid);
    expect(() => revise(st, ti.id, { header: { ...ti.header, documentDate: '2026-12-01' }, lines: ti.lines }, ti.version, 'x', me)).toThrow(); // TI: a date is fiscal, refused earlier
  });

  it('I3: the reversal posts on the original entry\'s date when its month is open: September keeps 9,000.00 net, October nothing', () => {
    const d = get('iv-p1');
    revise(st, d.id, ivBody(d, { price: '9000.00' }), d.version, 'เพิ่มยอด', me); 
    const e = st.journals.find((j) => j.docId === 'iv-p1')!.preview.entries;
    expect(e.map((x) => [x.kind, x.date, !!x.late])).toEqual([['original', '2026-09-20', false], ['reversal', '2026-09-20', false], ['correction', '2026-09-20', false]]);
    expect([month('iv-p1', '2026-09'), month('iv-p1', '2026-10')]).toEqual([900000, 0]);
    assertBalanced(st);
  });
  it('I3: when the original month is closed, the reversal and the new entry post late on the first open date', () => {
    st.periods.find((p) => p.companyId === NV && p.month === '2026-09')!.status = 'closed';
    st.periods.find((p) => p.companyId === NV && p.month === '2026-09')!.closedAt = '2026-10-10T09:00:00+07:00';
    const d = get('iv-p1');
    revise(st, d.id, ivBody(d, { price: '9000.00' }), d.version, 'เพิ่มยอด', me);
    const e = st.journals.find((j) => j.docId === 'iv-p1')!.preview.entries;
    expect(e.map((x) => [x.kind, x.date, !!x.late])).toEqual([['original', '2026-09-20', false], ['reversal', '2026-10-01', true], ['correction', '2026-10-01', true]]);
    assertBalanced(st);
  });

  it('M2: an IV of 0.00 or less is refused with doc.total_not_positive at revise, plan and issue', () => {
    const d = get('iv-3');
    for (const price of ['0.00', '-100.00']) {
      expect(code(() => revise(st, d.id, ivBody(d, { price }), d.version, 'x', me))).toBe('doc.total_not_positive');
      expect(code(() => buildPlan(st, d.id, ivBody(d, { price }), 'accountant'))).toBe('doc.total_not_positive');
      const draft = createDraft(st, NV, 'IV', { header: { partyId: 'nc-01', documentDate: '2026-10-14' }, lines: [line('l1', price, { taxCode: 'EX' })] }, me, `k-z${price}`);
      expect(code(() => issue(st, draft.id, draft.version, me))).toBe('doc.total_not_positive');
    }
    expect(() => revise(st, d.id, ivBody(d, { price: '0.00' }), d.version, 'x', me)).toThrow('ยกเลิก');
  });

  it('R1: after a revise in an open month, closing that month later is not a violation (the reversal is judged by its revision stamp)', () => {
    const d = get('iv-p1');
    revise(st, d.id, ivBody(d, { price: '9000.00' }), d.version, 'เพิ่มยอด', me);
    const p = st.periods.find((x) => x.companyId === NV && x.month === '2026-09')!;
    p.status = 'closed'; p.closedAt = '2099-12-31T09:00:00+07:00'; // closed after the posting
    expect(checkInvariants(st)).toEqual([]);
    p.closedAt = '2000-01-01T09:00:00+07:00'; // closed BEFORE the posting: the reversal is a real violation
    expect(checkInvariants(st).join(' | ')).toMatch(/iv-p1 reversal entry 2026-09-20: dated in closed period/);
  });

  it('R2: the cancel step of a correction plan reverses on the receipt own date: September bank nets once', () => {
    const ti = st.docs.find((x) => x.type === 'TI' && x.status === 'settled' && !x.locks.some((l) => l.kind === 'filing') && x.header.documentDate.startsWith('2026-09'))!;
    const rcLink = st.links.find((l) => l.kind === 'settles' && l.to === ti.id && l.active)!;
    const other = st.parties.find((q) => q.companyId === VAT && q.kind === 'customer' && q.id !== ti.header.partyId && q.vatRegistered && q.taxId)!;
    const plan = correctionPlan(st, ti.id, { header: { ...ti.header, partyId: other.id }, lines: ti.lines }, 'accountant');
    executePlan(st, plan.planId, plan.planHash, me, 'accountant');
    const oldRc0 = get(rcLink.from), m = oldRc0.header.documentDate.slice(0, 7);
    const sep = (docId: string) => st.journals.find((j) => j.docId === docId)!.preview.entries.filter((e) => e.date.startsWith(m)).flatMap((e) => e.lines)
      .filter((l) => l.accountCode.startsWith('112')).reduce((a, l) => a + sat(l.debit) - sat(l.credit), 0);
    const oldRc = get(rcLink.from);
    const rcs = st.docs.filter((x) => x.type === 'RC' && x.replacesId === oldRc.id);
    expect(oldRc.status).toBe('replaced');
    expect(st.journals.find((j) => j.docId === oldRc.id)!.preview.entries.map((e) => e.date)).toEqual([oldRc.header.documentDate, oldRc.header.documentDate]);
    expect(rcs).toHaveLength(1);
    expect(sep(oldRc.id) + sep(rcs[0].id)).toBe(sat(rcs[0].totals.total)); // old nets to 0, the replacement counts once
    assertBalanced(st);
  });

  it('R3: no receipt is created by conversion from a TI either', () => {
    expect(CONVERSIONS.TI).toEqual(['BL', 'CN', 'DN']);
  });
});
