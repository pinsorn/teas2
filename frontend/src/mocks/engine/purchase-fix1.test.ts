import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, DocLine } from '@/domain/types';
import { USER as me } from '../fixtures/documents';
import { seed, type MockState } from '../store';
import { convert, createDraft, issue, revise, updateDraft } from './commands';
import { checkInvariants } from './invariants';
import { toSatang } from './money';
import { assertBalanced } from './test-helpers';

const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
let n = 0;
beforeEach(() => { st = seed(); });
const sat = (m: string) => toSatang(m);
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const err = (fn: () => unknown): { code?: string } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode, ...p });
const draftOf = (company: string, type: 'PB' | 'PCN' | 'PDN', header: Partial<Doc['header']>, lines: DocLine[]): Doc =>
  createDraft(st, company, type, { header: { documentDate: '2026-10-14', ...header }, lines }, me, `f-${++n}`);
const draftPb = (company: string, partyId: string, lines: DocLine[], header: Partial<Doc['header']> = {}) => draftOf(company, 'PB', { partyId, ...header }, lines);
const pb = (company: string, partyId: string, lines: DocLine[], header: Partial<Doc['header']> = {}): Doc => { const d = draftPb(company, partyId, lines, header); return issue(st, d.id, d.version, me); };
const noteDraft = (company: string, type: 'PCN' | 'PDN', b: Doc, ls: DocLine[], header: Partial<Doc['header']> = {}) =>
  draftOf(company, type, { refDocId: b.id, reasonCode: type === 'PCN' ? 'PRICE_REDUCTION' : 'PRICE_INCREASE', ...header }, ls);
const issueDraft = (d: Doc) => issue(st, d.id, get(d.id).version, me);
const net1170 = (...ids: string[]) => st.journals.filter((j) => ids.includes(j.docId)).reduce((a, j) =>
  a + j.preview.entries.reduce((b, e) => b + e.lines.filter((l) => l.accountCode === '1170').reduce((c, l) => c + sat(l.debit) - sat(l.credit), 0), 0), 0);
const lines = (id: string) => (st.journals.find((j) => j.docId === id)?.preview.entries[0].lines ?? []).map((l) => `${l.accountCode} ${l.debit}/${l.credit}`).sort().join(' | ');

describe('C1 - a purchase line carries its resolved expense category; posting never reads the live item master', () => {
  it('a draft PCN, the bill revised entertainment -> services, then the PCN issued: the credit follows the bill (outstanding 0.00, 1170 net 0.00)', () => {
    const b = pb(VAT, 'pv-01', [L('a', 'S7', '1000.00', { expenseCategory: 'entertainment' })]);
    const c = noteDraft(VAT, 'PCN', b, [L('n', 'S7', '1000.00', { sourceLineId: 'a' })]);
    expect(c.lines[0].expenseCategory).toBe('entertainment');
    revise(st, b.id, { header: get(b.id).header, lines: [L('a', 'S7', '1000.00', { expenseCategory: 'services' })] }, get(b.id).version, 'x', me);
    const issued = issueDraft(c);
    expect(issued.lines[0].expenseCategory).toBe('services'); // re-taken from the bill line at issue, whatever the draft carried
    expect(get(b.id).outstanding).toBe('0.00');
    expect(net1170(b.id, c.id)).toBe(0);
    expect(lines(c.id)).toBe(['5120 0.00/1000.00', '1170 0.00/70.00', '2110 1070.00/0.00'].sort().join(' | '));
    assertBalanced(st);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('a line that names only an item stores the item\'s category at save and issue; editing the item afterwards moves no posted number and keeps the invariants', () => {
    const d = draftPb(VAT, 'pv-03', [L('a', 'S7', '4500.00', { itemId: 'EXP-07' })]);
    expect(d.lines[0].expenseCategory).toBe('entertainment'); // snapshot at save
    const b = issueDraft(d);
    expect(get(b.id).lines[0].expenseCategory).toBe('entertainment');
    const before = lines(b.id);
    st.items.find((i) => i.id === 'EXP-07' && i.companyId === VAT)!.expenseCategory = 'services';
    expect(lines(b.id)).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
    const c = issueDraft(noteDraft(VAT, 'PCN', b, [L('n', 'S7', '4500.00', { sourceLineId: 'a' })])); // the note follows the bill's stored category, not the edited item
    expect(c.lines[0].expenseCategory).toBe('entertainment');
    expect(net1170(b.id, c.id)).toBe(0);
    expect(checkInvariants(st)).toEqual([]);
  });

  it('a draft keeps the snapshot of the moment it was saved; issuing after the item changed still resolves a line that had none', () => {
    const item = st.items.find((i) => i.id === 'EXP-07' && i.companyId === VAT)!;
    const d = draftPb(VAT, 'pv-03', [L('a', 'S7', '100.00')]);
    expect(d.lines[0].expenseCategory).toBeUndefined();
    item.expenseCategory = 'rent';
    const upd = updateDraft(st, d.id, { header: d.header, lines: [L('a', 'S7', '100.00', { itemId: 'EXP-07' })] }, d.version, me);
    expect(upd.lines[0].expenseCategory).toBe('rent');
  });

  it('invariant: a live note line has its bill line\'s category - a tampered note is reported', () => {
    const b = pb(VAT, 'pv-03', [L('a', 'S7', '1000.00', { expenseCategory: 'services' })]);
    const c = issueDraft(noteDraft(VAT, 'PCN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })]));
    expect(checkInvariants(st)).toEqual([]);
    get(c.id).lines[0].expenseCategory = 'entertainment';
    expect(checkInvariants(st).join('\n')).toMatch(new RegExp(`${c.id}.*category`));
  });
});

describe('I1 (round 2: D .. V+6, see purchase-fix2.test.ts) - the claim window starts at the vendor\'s tax-invoice month (ม.82/3)', () => {
  const issueWith = (header: Partial<Doc['header']>) => err(() => issueDraft(draftPb(VAT, 'pv-01', [L('a', 'S7', '100.00')], { documentDate: '2026-10-14', ...header }))).code ?? 'ok';
  it('a vendor invoice dated after the bill is refused', () => {
    expect(issueWith({ vendorDocDate: '2026-10-15' })).toBe('pb.vendor_invoice_after_document');
  });
  it('a PDN is judged on its own vendor invoice: inside the window it claims, outside it is cost', () => {
    const b = pb(VAT, 'pv-03', [L('a', 'S7', '1000.00', { expenseCategory: 'services' })]);
    const late = issueDraft(noteDraft(VAT, 'PDN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })], { vendorDocDate: '2026-03-05', claimPeriod: '2027-04' }));
    expect(get(late.id).header.inputVatForfeited).toBe(true);
    const ok = issueDraft(noteDraft(VAT, 'PDN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })], { vendorDocDate: '2026-09-05', claimPeriod: '2027-03' }));
    expect(get(ok.id).header.claimPeriod).toBe('2027-03');
    assertBalanced(st);
  });
});

describe('I2 - a PCN has no deferral: it is filed in the month of its document date', () => {
  it('claim period 2027-04 on a PCN dated 2026-10 is refused (draft preview, issue and revise); the document month, or none, is fine', () => {
    const b = pb(VAT, 'pv-03', [L('a', 'S7', '1000.00', { expenseCategory: 'services' })]);
    const bad = noteDraft(VAT, 'PCN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })], { claimPeriod: '2027-04' });
    expect(err(() => issueDraft(bad)).code).toBe('pcn.claim_period_fixed');
    const ok = issueDraft(noteDraft(VAT, 'PCN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })], { claimPeriod: '2026-10' }));
    expect(err(() => revise(st, ok.id, { header: { ...get(ok.id).header, claimPeriod: '2027-01' }, lines: get(ok.id).lines }, get(ok.id).version, 'x', me)).code).toBe('pcn.claim_period_fixed');
    const none = issueDraft(noteDraft(VAT, 'PCN', b, [L('n2', 'S7', '100.00', { sourceLineId: 'a' })]));
    expect(net1170(b.id, ok.id, none.id)).toBe(sat('70.00') - sat('7.00') * 2);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a PCN moved to another month by a revise is filed in the new month (no stale period)', () => {
    const b = pb(VAT, 'pv-03', [L('a', 'S7', '1000.00', { expenseCategory: 'services' })], { documentDate: '2026-09-01' });
    const c = issueDraft(noteDraft(VAT, 'PCN', b, [L('n', 'S7', '100.00', { sourceLineId: 'a' })], { documentDate: '2026-09-20' }));
    revise(st, c.id, { header: { ...get(c.id).header, documentDate: '2026-10-02' }, lines: get(c.id).lines }, get(c.id).version, 'x', me);
    expect(checkInvariants(st)).toEqual([]);
    assertBalanced(st);
  });
});

describe('I3 - unclaimable VAT on a capex line is part of the asset cost (TAS 16)', () => {
  it('a non-VAT company buys a 32,000.00 notebook + VAT: Dr 1210 34,240.00, Cr 2110 34,240.00, 1170 untouched; a PCN mirrors it', () => {
    const b = pb(NV, 'nv-03', [L('a', 'S7', '32000.00', { expenseCategory: 'capex-equipment' })]);
    expect(lines(b.id)).toBe(['1210 34240.00/0.00', '2110 0.00/34240.00'].sort().join(' | '));
    const c = issueDraft(noteDraft(NV, 'PCN', b, [L('n', 'S7', '1000.00', { sourceLineId: 'a' })]));
    expect(lines(c.id)).toBe(['1210 0.00/1070.00', '2110 1070.00/0.00'].sort().join(' | '));
    expect(net1170(b.id, c.id)).toBe(0);
    assertBalanced(st);
  });
  it('a VAT company still claims the VAT on a capex line', () => {
    const b = pb(VAT, 'pv-03', [L('a', 'S7', '32000.00', { expenseCategory: 'capex-equipment' })]);
    expect(lines(b.id)).toBe(['1210 32000.00/0.00', '1170 2240.00/0.00', '2110 0.00/34240.00'].sort().join(' | '));
  });
});

describe('M2 - the vendor\'s VAT status is a snapshot taken at issue (round 2: R1-M1 / M2 in purchase-fix2.test.ts)', () => {
  it('editing only the notes of an old bill still works after the vendor deregisters; a new bill is judged on the vendor as it is', () => {
    const b = pb(VAT, 'pv-03', [L('a', 'S7', '1000.00', { expenseCategory: 'services' })]);
    expect(get(b.id).header.vendorVatRegistered).toBe(true);
    st.parties.find((p) => p.id === 'pv-03' && p.companyId === VAT)!.vatRegistered = false;
    const r = revise(st, b.id, { header: { ...get(b.id).header, notes: 'หมายเหตุ' }, lines: get(b.id).lines }, get(b.id).version, 'x', me);
    expect(r.header.notes).toBe('หมายเหตุ');
    expect(get(b.id).header.vendorVatRegistered).toBe(true); // an API caller cannot rewrite it
    const forged = revise(st, b.id, { header: { ...get(b.id).header, vendorVatRegistered: false }, lines: get(b.id).lines }, get(b.id).version, 'x', me);
    expect(forged.header.vendorVatRegistered).toBe(true);
    const fresh = draftPb(VAT, 'pv-03', [L('a', 'S7', '100.00')]);
    expect(err(() => issueDraft(fresh)).code).toBe('pb.vendor_not_vat_registered');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('M3 - the generic convert PB -> PCN / PDN is refused (notes are made through ?adjust=)', () => {
  it('convert refuses both, and creates nothing', () => {
    const b = pb(VAT, 'pv-03', [L('a', 'S7', '1000.00', { expenseCategory: 'services' })]);
    const docs = st.docs.length, links = st.links.length;
    for (const t of ['PCN', 'PDN'] as const) expect(err(() => convert(st, b.id, t, [{ sourceLineId: 'a', qty: '1' }], me)).code).toBe('doc.conversion_not_allowed');
    expect([st.docs.length, st.links.length]).toEqual([docs, links]);
  });
});
