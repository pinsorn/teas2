import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, DocLine } from '@/domain/types';
import { USER as me } from '../../fixtures/documents';
import { seed, type MockState } from '../../store';
import { approveAndIssue, cancel, createDraft, issue, reissue, revise } from '../commands';
import { correctionPlan, executePlan } from '../corrections';
import { checkInvariants } from '../invariants';
import { derivedLocks } from '../locks';
import { tinCheckDigit } from '@/domain/tin';
import { toSatang } from '../money';
import { chainStart, exportFilingText, filingHistory, finalizeFiling, getFiling } from './index';
import { pp30Docs, pp30Model } from './pp30';
import { buildReport } from '../reports';

// TX1: the ภ.พ.30 is computed from DOCUMENTS (I12); a finalized one is a frozen snapshot. The seed finalizes 2026-07 and 2026-08, leaves 2026-09 finalizable and 2026-10 with blockers.
const CO = 'co-vat';
let st: MockState, n = 0;
beforeEach(() => { st = seed(); });
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const box = (m: { boxes: { code: string; amount: string }[] }, code: string) => m.boxes.find((b) => b.code === code)!.amount;
const sat = (m: string) => toSatang(m);
const err = (fn: () => unknown): { code?: string; title?: string; status?: number } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
const L = (id: string, taxCode: DocLine['taxCode'], unitPrice: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice, taxCode, ...p });
const customer = () => st.parties.find((p) => p.companyId === CO && p.kind === 'customer' && p.vatRegistered && p.taxId && p.branchCode)!;
const vendor = () => st.parties.find((p) => p.companyId === CO && p.kind === 'vendor' && p.vatRegistered)!;
const mk = (type: 'TI' | 'CN' | 'PB', lines: DocLine[], header: Partial<Doc['header']>): Doc => {
  const d = createDraft(st, CO, type, { header: { documentDate: '2026-09-15', ...(type === 'PB' ? { partyId: vendor().id } : { partyId: customer().id }), ...header }, lines }, me, `fx-${++n}`);
  return issue(st, d.id, d.version, me);
};
const sepTi = () => st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && d.header.documentDate.startsWith('2026-09') && !st.links.some((l) => l.active && l.to === d.id))!;

describe('the seed', () => {
  it('has 2026-07 and 2026-08 finalized, 2026-09 finalizable and 2026-10 blocked; the chain starts at 2026-07', () => {
    expect(st.filings.filter((f) => f.companyId === CO).map((f) => `${f.form} ${f.period}`)).toEqual(['PP30 2026-07', 'PP30 2026-08']);
    expect(chainStart(st, CO)).toBe('2026-07');
    expect(getFiling(st, CO, 'PP30', '2026-08')).toMatchObject({ status: 'finalized', finalizedBy: me.name, blockers: [] });
    expect(getFiling(st, CO, 'PP30', '2026-09')).toMatchObject({ status: 'draft', blockers: [] });
    const oct = getFiling(st, CO, 'PP30', '2026-10');
    expect(oct.blockers.map((b) => b.code)).toContain('draft_document');
    expect(oct.blockers.map((b) => b.code)).toContain('previous_open');
    expect(oct.blockers.find((b) => b.code === 'previous_open')?.href).toBe('/tax/vat?period=2026-09');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('every tie-out is 0.00 on every month of the seed', () => {
    for (const p of ['2026-07', '2026-08', '2026-09', '2026-10']) for (const t of getFiling(st, CO, 'PP30', p).tieOuts) expect({ p, k: t.labelKey, diff: t.diff }).toEqual({ p, k: t.labelKey, diff: '0.00' });
  });
});

describe('box identities (money invariants)', () => {
  it.each(['2026-07', '2026-08', '2026-09', '2026-10'])('%s: box 4 = 1 - 2 - 3; box 5 = Σ output VAT; box 8/9 by sign of 5 - 7 - 10', (p) => {
    const m = pp30Model(st, CO, p);
    expect(sat(box(m, '4'))).toBe(sat(box(m, '1')) - sat(box(m, '2')) - sat(box(m, '3')));
    const docs = pp30Docs(st, CO, p);
    expect(sat(box(m, '5'))).toBe(docs.filter((d) => d.kind === 'out').reduce((a, d) => a + sat(d.vat), 0));
    expect(sat(box(m, '7'))).toBe(docs.filter((d) => d.kind === 'in').reduce((a, d) => a + sat(d.vat), 0));
    const net = sat(box(m, '5')) - sat(box(m, '7')) - sat(box(m, '10'));
    expect([sat(box(m, '8')), sat(box(m, '9'))]).toEqual(net >= 0 ? [net, 0] : [0, -net]);
    expect(sat(box(m, '11'))).toBe(Math.abs(net));
  });
  it('lists every issued TI / CN / DN of the month exactly once', () => {
    const want = st.docs.filter((d) => d.companyId === CO && ['TI', 'CN', 'DN'].includes(d.type) && d.header.documentDate.startsWith('2026-08') && !['draft', 'pending', 'approved'].includes(d.status)).map((d) => d.id).sort();
    expect(pp30Docs(st, CO, '2026-08').filter((d) => d.kind === 'out').map((d) => d.id).sort()).toEqual(want);
  });
  it('a credit note in the month reduces the output; box 4 and 5 move by its base and VAT', () => {
    const before = pp30Model(st, CO, '2026-09');
    const t = mk('TI', [L('a', 'S7', '1000.00')], {});
    const mid = pp30Model(st, CO, '2026-09');
    expect(sat(box(mid, '5')) - sat(box(before, '5'))).toBe(7000);
    mk('CN', [L('n', 'S7', '100.00', { sourceLineId: 'a' })], { documentDate: '2026-09-30', refDocId: t.id, reasonCode: 'PRICE_REDUCTION' });
    const after = pp30Model(st, CO, '2026-09');
    expect([sat(box(mid, '5')) - sat(box(after, '5')), sat(box(mid, '4')) - sat(box(after, '4'))]).toEqual([700, 10000]);
  });
  it('zero-rated and exempt bases go to box 2 and 3, not 4', () => {
    const before = pp30Model(st, CO, '2026-09');
    mk('TI', [L('a', 'Z0', '500.00'), L('b', 'EX', '200.00')], {});
    const a = pp30Model(st, CO, '2026-09');
    expect([sat(box(a, '2')) - sat(box(before, '2')), sat(box(a, '3')) - sat(box(before, '3')), sat(box(a, '4')) - sat(box(before, '4')), sat(box(a, '5')) - sat(box(before, '5'))]).toEqual([50000, 20000, 0, 0]);
    expect(sat(box(a, '1')) - sat(box(before, '1'))).toBe(70000);
  });
  it('a cancelled TI is listed as ยกเลิก 0.00 and leaves the boxes', () => {
    const t = sepTi();
    const before = pp30Model(st, CO, '2026-09');
    cancel(st, t.id, t.version, 'OTHER', 'ทดสอบ', me);
    const row = pp30Docs(st, CO, '2026-09').find((d) => d.id === t.id)!;
    expect(row).toMatchObject({ state: 'cancelled', vat: '0.00', base7: '0.00' });
    expect(sat(box(before, '5')) - sat(box(pp30Model(st, CO, '2026-09'), '5'))).toBe(sat(t.totals.vat));
  });
  it('the sale of a fixed asset is output VAT like any TI and its row says ขายสินทรัพย์ <FA number>', () => {
    const sale = st.docs.find((d) => d.header.disposal)!;
    const row = pp30Docs(st, CO, sale.header.documentDate.slice(0, 7)).find((d) => d.id === sale.id)!;
    expect(row.vat).toBe(sale.totals.vat);
    expect(row.description).toBe(`ขายสินทรัพย์ ${sale.header.disposal!.faNumber}`);
  });
});

describe('input VAT', () => {
  it('a bill with a claim period two months on lands in that month, not its own', () => {
    const b = mk('PB', [L('a', 'S7', '1000.00')], { claimPeriod: '2026-11' });
    expect(pp30Docs(st, CO, '2026-11').some((d) => d.id === b.id && d.kind === 'in' && d.vat === '70.00')).toBe(true);
    expect(pp30Docs(st, CO, '2026-09').some((d) => d.id === b.id)).toBe(false);
  });
  it('only the recoverable VAT of a bill is claimed (entertainment VAT is cost)', () => {
    const b = get('pb-2'); // services + non-claimable entertainment
    const row = pp30Docs(st, CO, '2026-10').find((d) => d.id === b.id)!;
    expect(sat(row.vat)).toBeGreaterThan(0);
    expect(sat(row.vat)).toBeLessThan(sat(b.totals.vat));
  });
  it('a vendor credit note gives input VAT back (negative row) in the month it is received', () => {
    const row = pp30Docs(st, CO, '2026-10').find((d) => d.id === 'pcn-1')!;
    expect(row.vat).toBe('-175.00');
  });
  it('an expense claim with a full vendor tax invoice claims its VAT; the register total ties to GL 1170', () => {
    expect(pp30Docs(st, CO, '2026-10').find((d) => d.id === 'ex-1')?.vat).toBe('140.00');
    expect(getFiling(st, CO, 'PP30', '2026-10').tieOuts.find((t) => t.labelKey.endsWith('inputGl'))?.diff).toBe('0.00');
  });
  it('excess input VAT is carried into the next month (box 9 of the filed month is box 10 of the next)', () => {
    mk('PB', [L('a', 'S7', '300000.00')], {}); // 21,000.00 input VAT against ~12,873.00 output
    const sep = getFiling(st, CO, 'PP30', '2026-09');
    expect(sat(box(sep, '9'))).toBeGreaterThan(0);
    expect(box(sep, '8')).toBe('0.00');
    finalizeFiling(st, CO, 'PP30', '2026-09', sep.version, me);
    const oct = pp30Model(st, CO, '2026-10');
    expect(box(oct, '10')).toBe(box(sep, '9'));
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('tie-outs can fail', () => {
  it('removing a TI VAT line from GL 2151 shows a non-zero output tie-out; the identical register still ties to the boxes', () => {
    const t = sepTi();
    const e = st.journals.find((j) => j.docId === t.id)!.preview.entries[0];
    e.lines = e.lines.filter((l) => l.accountCode !== '2151');
    const ties = pp30Model(st, CO, '2026-09').tieOuts;
    expect(ties.find((x) => x.labelKey.endsWith('outputGl'))!.diff).toBe(t.totals.vat); // box 5 (documents) minus the ledger
    expect(ties.find((x) => x.labelKey.endsWith('outputRegister'))!.diff).toBe('0.00');
  });
});

describe('finalize', () => {
  it('stores the snapshot, derives the filing lock on every document that fed it, and refuses a second finalize', () => {
    const m = getFiling(st, CO, 'PP30', '2026-09');
    const t = sepTi();
    expect(derivedLocks(st, get(t.id)).some((l) => l.kind === 'filing')).toBe(false);
    const done = finalizeFiling(st, CO, 'PP30', '2026-09', m.version, me);
    expect(done).toMatchObject({ status: 'finalized', finalizedBy: me.name });
    const lock = derivedLocks(st, get(t.id)).find((l) => l.kind === 'filing')!;
    expect(lock).toMatchObject({ reason: 'ภ.พ.30 เดือน ก.ย. 2569 ยื่นแล้ว', exits: ['ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป'], href: '/tax/vat?period=2026-09' });
    expect(err(() => finalizeFiling(st, CO, 'PP30', '2026-09', m.version, me)).code).toBe('filing.already_finalized');
    expect(st.filings.filter((f) => f.companyId === CO && f.period === '2026-09')).toHaveLength(1);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('is refused while a blocker stands, naming it (October: drafts, and September not finalized)', () => {
    const e = err(() => finalizeFiling(st, CO, 'PP30', '2026-10', getFiling(st, CO, 'PP30', '2026-10').version, me));
    expect(e).toMatchObject({ status: 422, code: 'filing.blocked' });
  });
  it('is refused on a stale preview (a document changed since the preview was computed)', () => {
    const m = getFiling(st, CO, 'PP30', '2026-09');
    mk('TI', [L('a', 'S7', '10.00')], {});
    expect(err(() => finalizeFiling(st, CO, 'PP30', '2026-09', m.version, me)).code).toBe('filing.stale');
  });
  it('a month before the chain start, or before one already filed, cannot be finalized', () => {
    const m = getFiling(st, CO, 'PP30', '2026-06');
    expect(m.blockers.map((b) => b.code)).toContain('before_chain');
    expect(err(() => finalizeFiling(st, CO, 'PP30', '2026-06', m.version, me)).code).toBe('filing.blocked');
  });
  it('a gap after the chain start blocks: filing 2026-09 first is impossible once 2026-08 is open again', () => {
    st.filings = st.filings.filter((f) => f.period !== '2026-08');
    const m = getFiling(st, CO, 'PP30', '2026-09');
    expect(m.blockers.find((b) => b.code === 'previous_open')?.href).toBe('/tax/vat?period=2026-08');
  });
  it('a placeholder company TIN is refused (I10)', () => {
    st.companies.find((c) => c.id === CO)!.taxId = '0000000000000';
    const m = getFiling(st, CO, 'PP30', '2026-09');
    expect(m.blockers.map((b) => b.code)).toContain('company_tin');
    expect(err(() => finalizeFiling(st, CO, 'PP30', '2026-09', m.version, me)).code).toBe('filing.blocked');
  });
  it('a company outside VAT has no ภ.พ.30', () => {
    expect(err(() => getFiling(st, 'co-nonvat', 'PP30', '2026-09'))).toMatchObject({ status: 404, code: 'filing.not_available' });
  });
  it('later reads of a finalized period show the snapshot, never a recomputation (ruling 1)', () => {
    const before = JSON.stringify(getFiling(st, CO, 'PP30', '2026-08').boxes);
    const t = st.docs.find((d) => d.type === 'TI' && d.header.documentDate.startsWith('2026-08') && d.status === 'settled')!;
    t.lines[0].unitPrice = '99999.00'; // tamper with a filed document
    expect(JSON.stringify(getFiling(st, CO, 'PP30', '2026-08').boxes)).toBe(before);
    expect(checkInvariants(st).join('\n')).toMatch(/filing PP30 2026-08/);
  });
  it('the registers of a finalized month read the snapshot too, and sum to the filed boxes', () => {
    const t = st.docs.find((d) => d.type === 'TI' && d.header.documentDate.startsWith('2026-08') && d.status === 'settled')!;
    const was = JSON.stringify(buildReport(st, CO, 'vat-output-register', { period: '2026-08' }).rows);
    t.lines[0].unitPrice = '99999.00';
    const m = buildReport(st, CO, 'vat-output-register', { period: '2026-08' });
    expect(JSON.stringify(m.rows)).toBe(was);
    expect(m.rows.at(-1)!.cells.vat).toBe(box(getFiling(st, CO, 'PP30', '2026-08'), '5'));
    const inp = buildReport(st, CO, 'vat-input-register', { period: '2026-08' }).rows;
    expect(inp.filter((r) => r.kind === 'row').map((r) => [r.cells.number, r.cells.date])).toEqual([['SI-5390', '2026-08-11']]); // M6/M7: the vendor's invoice number and date
    expect(inp.at(-1)!.cells.vat).toBe(box(getFiling(st, CO, 'PP30', '2026-08'), '7'));
  });
  it('exports the RD Prep text with CRLF line ends, and lists the filings in the history', () => {
    const txt = exportFilingText(st, CO, 'PP30', '2026-08');
    expect(txt.split('\r\n').length).toBeGreaterThan(5);
    expect(txt).toContain('|0105569012345|');
    expect(filingHistory(st, CO, 'PP30').map((h) => h.period)).toEqual(['2026-08', '2026-07']);
  });
});

// ---------------------------------------------------------------- the filing lock (rulings 2 and 3)

/** A September bill with claimable VAT and a September TI, then September finalized: both are now "filed". */
const filedSep = () => {
  const pb = mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-09-20', vendorDocDate: '2026-09-10' });
  const ti = mk('TI', [L('a', 'S7', '1000.00')], {});
  finalizeFiling(st, CO, 'PP30', '2026-09', getFiling(st, CO, 'PP30', '2026-09').version, me);
  return { pb: get(pb.id), ti: get(ti.id) };
};
const body = (d: Doc, h: Partial<Doc['header']> = {}, lines: DocLine[] = d.lines) => ({ header: { ...d.header, ...h }, lines });
const EXIT = 'ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป';

describe('filing lock: cancel, reissue (ruling 3)', () => {
  it('a filed TI cannot be cancelled: filing.locked with the CN / DN exit', () => {
    const { ti } = filedSep();
    const e = err(() => cancel(st, ti.id, ti.version, 'OTHER', 'x', me));
    expect(e).toMatchObject({ status: 409, code: 'filing.locked' });
    expect(e.title).toContain(EXIT);
    expect(get(ti.id).status).toBe('issued');
  });
  it('a filed TI cannot be reissued', () => {
    const { ti } = filedSep();
    expect(err(() => reissue(st, ti.id, body(ti), me, 'x')).code).toBe('filing.locked');
  });
  it('a filed bill cannot be cancelled or reissued either', () => {
    const { pb } = filedSep();
    expect(err(() => cancel(st, pb.id, pb.version, 'OTHER', 'x', me)).code).toBe('filing.locked');
    expect(err(() => reissue(st, pb.id, body(pb), me, 'x')).code).toBe('filing.locked');
  });
  it('a document in an open month that is not filed cancels as before', () => {
    filedSep();
    const t = mk('TI', [L('a', 'S7', '10.00')], { documentDate: '2026-10-05' });
    expect(cancel(st, t.id, t.version, 'OTHER', 'x', me).status).toBe('cancelled');
  });
});

describe('filing lock: revise (ruling 2, M5 + R2-M1)', () => {
  it.each([
    ['price', (d: Doc) => body(d, {}, [{ ...d.lines[0], unitPrice: '1100.00' }])],
    ['tax code', (d: Doc) => body(d, {}, [{ ...d.lines[0], taxCode: 'Z0' as const }])],
    ['claim period', (d: Doc) => body(d, { claimPeriod: '2026-10' })],
    ['vendor invoice date, inside the window', (d: Doc) => body(d, { vendorDocDate: '2026-09-05' })],
    ['vendor invoice date, flipping the forfeit', (d: Doc) => body(d, { vendorDocDate: '2025-12-01' })],
    ['document date', (d: Doc) => body(d, { documentDate: '2026-09-21' })],
    ['vendor (TIN)', (d: Doc) => body(d, { partyId: st.parties.find((p) => p.companyId === CO && p.kind === 'vendor' && p.vatRegistered && p.id !== d.header.partyId && p.taxId !== d.party?.taxId)!.id })],
  ])('a filed bill: a change of %s is refused', (_n, make) => {
    const { pb } = filedSep();
    const b = make(pb);
    expect(err(() => revise(st, pb.id, b, pb.version, 'x', me)).code).toBe('filing.locked');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a filed bill: the same TIN on another branch is refused', () => {
    const { pb } = filedSep();
    st.parties.push({ ...st.parties.find((p) => p.id === pb.header.partyId)!, id: 'v-branch-2', code: 'V-BR2', branchCode: '00002' });
    expect(err(() => revise(st, pb.id, body(pb, { partyId: 'v-branch-2' }), pb.version, 'x', me)).code).toBe('filing.locked');
  });
  it('M4: a vendor TIN edited in the master after filing does not stop a notes-only revise: the stored party snapshot (as filed) is kept; changing the party itself stays refused', () => {
    const { pb } = filedSep();
    const filedTin = get(pb.id).party?.taxId;
    st.parties.find((p) => p.id === pb.header.partyId)!.taxId = '0105500000019';
    const r = revise(st, pb.id, body(pb, { notes: 'x' }), pb.version, 'x', me);
    expect(r.header.notes).toBe('x');
    expect(get(pb.id).party?.taxId).toBe(filedTin);
    expect(checkInvariants(st)).toEqual([]);
    const other = st.parties.find((p) => p.companyId === CO && p.kind === 'vendor' && p.vatRegistered && p.id !== pb.header.partyId && p.taxId === filedTin);
    const clone = other ?? (st.parties.push({ ...st.parties.find((p) => p.id === pb.header.partyId)!, id: 'v-same-tin', code: 'V-ST', taxId: filedTin }), st.parties.at(-1)!); // same TIN and branch, other party
    expect(err(() => revise(st, pb.id, body(get(pb.id), { partyId: clone.id }), get(pb.id).version, 'x', me)).code).toBe('filing.locked');
  });
  it('a filed bill: notes and paper-only fields stay free', () => {
    const { pb } = filedSep();
    const r = revise(st, pb.id, body(pb, { notes: 'หมายเหตุใหม่', reference: 'REF-1' }), pb.version, 'x', me);
    expect(r.header.notes).toBe('หมายเหตุใหม่');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a bill that did not feed the filing (another month) is free', () => {
    filedSep();
    const o = mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-10-05' });
    expect(revise(st, o.id, body(o, {}, [{ ...o.lines[0], unitPrice: '1200.00' }]), o.version, 'x', me).totals.net).toBe('1200.00');
  });
});

describe('filing lock: a correction plan is refused before it is shown (F4)', () => {
  it('a filed bill: a plan that moves the price is never shown', () => {
    const { pb } = filedSep();
    expect(err(() => correctionPlan(st, pb.id, body(pb, {}, [{ ...pb.lines[0], unitPrice: '1100.00' }]), 'accountant')).code).toBe('filing.locked');
    expect(st.plans ?? {}).toEqual({});
  });
  it('a filed bill: a plan that flips the forfeit through the vendor invoice date is never shown', () => {
    const { pb } = filedSep();
    expect(err(() => correctionPlan(st, pb.id, body(pb, { vendorDocDate: '2025-12-01' }), 'accountant')).code).toBe('filing.locked');
  });
  it('a filed bill: a notes-only plan is a plain revise step', () => {
    const { pb } = filedSep();
    expect(correctionPlan(st, pb.id, body(pb, { notes: 'x' }), 'accountant').steps.map((s) => s.action)).toEqual(['revise']);
  });
  it('a filed TI: a money correction is the credit note of the next open month (no cancel, no reissue of the filed invoice)', () => {
    const { ti } = filedSep();
    const plan = correctionPlan(st, ti.id, body(ti, {}, [{ ...ti.lines[0], unitPrice: '900.00' }]), 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['issue_cn']);
  });
  it('a filed TI: running the credit-note plan issues the CN in the open month, leaves the filed invoice and the filing alone, and every invariant holds', () => {
    const { ti } = filedSep();
    const plan = correctionPlan(st, ti.id, body(ti, {}, [{ ...ti.lines[0], unitPrice: '900.00' }]), 'accountant');
    executePlan(st, plan.planId, plan.planHash, me);
    const cn = st.docs.find((d) => d.type === 'CN' && d.header.refDocId === ti.id)!;
    expect([cn.status, cn.header.documentDate.slice(0, 7), get(ti.id).status, get(ti.id).totals.total]).toEqual(['issued', '2026-10', 'issued', ti.totals.total]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a filed TI: a party change is the full credit note only', () => {
    const { ti } = filedSep();
    const other = st.parties.find((p) => p.companyId === CO && p.kind === 'customer' && p.vatRegistered && p.taxId && p.branchCode && p.id !== ti.header.partyId)!;
    expect(correctionPlan(st, ti.id, body(ti, { partyId: other.id }), 'accountant').steps.map((s) => s.action)).toEqual(['issue_cn']);
  });
  it('a filed credit note: a fiscal correction is refused (it would cancel and reissue a filed document)', () => {
    const t = mk('TI', [L('a', 'S7', '1000.00')], { documentDate: '2026-09-10' });
    const cn = mk('CN', [L('n', 'S7', '100.00', { sourceLineId: 'a' })], { documentDate: '2026-09-12', refDocId: t.id, reasonCode: 'PRICE_REDUCTION' });
    finalizeFiling(st, CO, 'PP30', '2026-09', getFiling(st, CO, 'PP30', '2026-09').version, me);
    const c = get(cn.id);
    expect(err(() => correctionPlan(st, c.id, body(c, {}, [{ ...c.lines[0], unitPrice: '50.00' }]), 'accountant')).code).toBe('filing.locked');
  });
});

// ---------------------------------------------------------------- ruling 1: the finalize invariants fail on a single-fault tamper

describe('finalized filings are frozen (invariants)', () => {
  const aug = () => st.filings.find((f) => f.period === '2026-08')!;
  const bad = () => checkInvariants(st).filter((m) => m.includes('filing PP30 2026-08'));
  it('the untouched seed holds', () => expect(checkInvariants(st)).toEqual([]));
  it('a stored box that is not what the stored documents give', () => {
    aug().boxes.find((b) => b.code === '5')!.amount = '1.00';
    expect(bad().join('\n')).toMatch(/stored boxes are not what its stored documents give/);
  });
  it('a listed document whose figures moved', () => {
    const id = aug().docs.find((d) => d.state === 'live')!.id;
    get(id).lines[0].unitPrice = '1.00';
    expect(bad().join('\n')).toMatch(new RegExp(`${id} no longer carries the figures`));
  });
  it('a listed document that is gone', () => {
    const id = aug().docs[0].id;
    st.docs = st.docs.filter((d) => d.id !== id);
    expect(bad().join('\n')).toMatch(new RegExp(`document ${id} is gone`));
  });
  it('a listed live document that was cancelled behind the lock', () => {
    const id = aug().docs.find((d) => d.state === 'live')!.id;
    get(id).status = 'cancelled';
    expect(bad().join('\n')).toMatch(new RegExp(`${id} is listed live but is cancelled`));
  });
  it('a snapshot row of a document that is not cancelled but says so', () => {
    aug().docs.find((d) => d.state === 'live')!.state = 'cancelled';
    expect(bad().length).toBeGreaterThan(0);
  });
  it('a carry that is not the previous month\'s excess', () => {
    aug().carryIn = '5.00';
    expect(bad().join('\n')).toMatch(/brought forward/);
  });
  it('a tie-out whose diff is not left - right', () => {
    aug().tieOuts[0].diff = '9.99';
    expect(bad().join('\n')).toMatch(/is not left - right/);
  });
  it('a month finalized twice', () => {
    st.filings.push(structuredClone(aug()));
    expect(bad().join('\n')).toMatch(/finalized twice/);
  });
});

// ---------------------------------------------------------------- TX1 fix 1: B1 / B1a / M1 - M4 / M6 / M7

const mkNote = (type: 'CN' | 'DN', tiId: string, header: Partial<Doc['header']>): Doc => {
  const ti = get(tiId);
  return mk(type as never, [L('n', ti.lines[0].taxCode, '10.00', { sourceLineId: ti.lines[0].id })], { refDocId: ti.id, reasonCode: type === 'CN' ? 'PRICE_REDUCTION' : 'PRICE_INCREASE', partyId: ti.header.partyId, ...header });
};
/** An expense claim (EX) of the VAT company with these vendor tax invoices, approved and issued in one go. */
const mkEx = (documentDate: string, invoices: { name: string; first12: string; no: string; date: string; price: string }[]): Doc => {
  const lines = invoices.map((v, i) => L(`e${i}`, 'S7', v.price, { expenseCategory: 'supplies', vendorInvoice: { vendorName: v.name, vendorTin: v.first12 + tinCheckDigit(v.first12), number: v.no, date: v.date, fullTaxInvoice: true } }));
  const d = createDraft(st, CO, 'EX' as never, { header: { documentDate, partyId: 'emp-02' }, lines }, me, `ex-fx-${++n}`);
  return approveAndIssue(st, d.id, d.version, me);
};
const inv = (name: string, first12: string, no: string, date: string, price: string) => ({ name, first12, no, date, price });
const REFUSED = { status: 409, code: 'filing.period_filed' };

describe('B1: nothing enters a filed month (the engine, every issue path)', () => {
  it('a TI dated in a filed month is refused, says why and what to do, and leaves no invoice and no invariant broken', () => {
    const e = err(() => mk('TI', [L('a', 'S7', '1000.00')], { documentDate: '2026-08-31' }));
    expect(e).toMatchObject(REFUSED);
    expect(e.title).toContain('ภ.พ.30 เดือน ส.ค. 2569 ยื่นแล้ว');
    expect(e.title).toContain('ลงวันที่ในงวดที่ยังไม่ยื่น');
    expect(st.docs.some((d) => d.type === 'TI' && d.header.documentDate === '2026-08-31' && d.status === 'issued' && d.totals.net === '1000.00')).toBe(false);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a TI dated in an open month still issues (September, October)', () => {
    expect(mk('TI', [L('a', 'S7', '1000.00')], { documentDate: '2026-09-30' }).status).toBe('issued');
    expect(mk('TI', [L('a', 'S7', '1000.00')], { documentDate: '2026-10-10' }).status).toBe('issued');
  });
  it('a CN and a DN on a filed invoice, dated in the filed month, are refused (the exit is a note in an open month)', () => {
    expect(err(() => mkNote('CN', 'ti-015', { documentDate: '2026-08-31' }))).toMatchObject(REFUSED);
    expect(err(() => mkNote('DN', 'ti-015', { documentDate: '2026-08-31' }))).toMatchObject(REFUSED);
    expect(mkNote('CN', 'ti-015', { documentDate: '2026-10-05' }).status).toBe('issued');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a bill dated in a filed month claims in the first UNFILED month inside its window (ม.82/3), and the filed month does not move', () => {
    const before = JSON.stringify(getFiling(st, CO, 'PP30', '2026-08').boxes);
    const b = mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-08-10', vendorDocDate: '2026-08-10' });
    expect(get(b.id).header.claimPeriod).toBe('2026-09');
    expect(pp30Docs(st, CO, '2026-09').some((d) => d.id === b.id && d.vat === '70.00')).toBe(true);
    expect(JSON.stringify(getFiling(st, CO, 'PP30', '2026-08').boxes)).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a bill with an EXPLICITLY chosen filed claim period is refused, naming the first open month', () => {
    const e = err(() => mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-08-10', vendorDocDate: '2026-08-10', claimPeriod: '2026-08' }));
    expect(e).toMatchObject(REFUSED);
    expect(e.title).toContain('ก.ย. 2569');
  });
  it('a bill whose whole claim window is filed is refused; one already past its window keeps the existing forfeit (cost, not refused)', () => {
    expect(err(() => mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-08-10', vendorDocDate: '2026-02-10' }))).toMatchObject(REFUSED); // V+6 = 2026-08: no open month left
    const late = mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-09-10', vendorDocDate: '2026-02-10' }); // D > V+6: the forfeit rule of R1-I1 already covers it
    expect(get(late.id).header.inputVatForfeited).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a bill revised INTO a filed month (date and claim period) is refused', () => {
    const pb = mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-09-02', vendorDocDate: '2026-08-20' });
    const d = get(pb.id);
    expect(err(() => revise(st, d.id, body(d, { documentDate: '2026-08-25', claimPeriod: '2026-08' }), d.version, 'x', me))).toMatchObject(REFUSED);
    expect(get(pb.id).header.documentDate).toBe('2026-09-02');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a correction plan that moves a bill into a filed month is never shown', () => {
    const pb = mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-09-02', vendorDocDate: '2026-08-20' });
    const d = get(pb.id);
    expect(err(() => correctionPlan(st, d.id, body(d, { documentDate: '2026-08-25', claimPeriod: '2026-08' }), 'accountant'))).toMatchObject(REFUSED);
    expect(st.plans ?? {}).toEqual({});
  });
  it('a vendor credit note and an expense claim claim in their document month: refused when it is filed', () => {
    const pb = mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-09-03', vendorDocDate: '2026-09-03' });
    finalizeFiling(st, CO, 'PP30', '2026-09', getFiling(st, CO, 'PP30', '2026-09').version, me);
    const p = get(pb.id);
    const pcn = (date: string) => mk('PCN' as never, [L('n', 'S7', '10.00', { sourceLineId: p.lines[0].id })], { documentDate: date, refDocId: p.id, reasonCode: 'PRICE_REDUCTION', partyId: p.header.partyId });
    expect(err(() => pcn('2026-09-30'))).toMatchObject(REFUSED);
    expect(pcn('2026-10-05').status).toBe('issued');
    expect(err(() => mkEx('2026-09-20', [inv('บริษัท ก จำกัด', '010556000881', 'EX-1', '2026-09-19', '100.00')]))).toMatchObject(REFUSED);
    expect(mkEx('2026-10-06', [inv('บริษัท ก จำกัด', '010556000881', 'EX-2', '2026-10-05', '100.00')]).status).toBe('issued');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an approval reaches the same issue(): an approved draft dated into a filed month cannot be issued', () => {
    const d = createDraft(st, CO, 'TI', { header: { documentDate: '2026-08-20', partyId: customer().id }, lines: [L('a', 'S7', '100.00')] }, me, 'late-ti');
    expect(err(() => approveAndIssue(st, d.id, d.version, me))).toMatchObject(REFUSED);
  });
  it('invariant: a live TI of a filed month that is missing from the snapshot fails, and so does a claiming bill of its claim period (single-fault)', () => {
    const bad = (p: string) => checkInvariants(st).filter((m) => m.includes(`filing PP30 ${p}`));
    expect(bad('2026-08')).toEqual([]);
    st.docs.push({ ...structuredClone(get('ti-015')), id: 'ti-sneak', number: 'TI-SNEAK' });
    expect(bad('2026-08').join('\n')).toMatch(/ti-sneak is missing from the snapshot/);
    const { pb } = filedSep();
    st.docs.push({ ...structuredClone(get(pb.id)), id: 'pb-sneak', number: 'PB-SNEAK' });
    expect(bad('2026-09').join('\n')).toMatch(/pb-sneak is missing from the snapshot/);
  });
});

describe('B1a: a month that has not ended cannot be finalized', () => {
  it('the current month (and later) carries period_not_ended; a finished month does not', () => {
    expect(getFiling(st, CO, 'PP30', '2026-10').blockers.map((b) => b.code)).toContain('period_not_ended');
    expect(getFiling(st, CO, 'PP30', '2026-11').blockers.map((b) => b.code)).toContain('period_not_ended');
    expect(getFiling(st, CO, 'PP30', '2026-09').blockers.map((b) => b.code)).not.toContain('period_not_ended');
    expect(getFiling(st, CO, 'PP30', '2026-10').blockers.find((b) => b.code === 'period_not_ended')?.labelTh).toContain('ยังไม่สิ้นเดือน');
  });
  it('October cannot be finalized on 14 October even with no drafts and September filed', () => {
    finalizeFiling(st, CO, 'PP30', '2026-09', getFiling(st, CO, 'PP30', '2026-09').version, me);
    st.docs = st.docs.filter((d) => !(['TI', 'CN', 'DN'].includes(d.type) && ['draft', 'pending', 'approved'].includes(d.status)));
    const m = getFiling(st, CO, 'PP30', '2026-10');
    expect(m.blockers.map((b) => b.code)).toEqual(['period_not_ended']);
    expect(err(() => finalizeFiling(st, CO, 'PP30', '2026-10', m.version, me)).code).toBe('filing.blocked');
  });
});

describe('M1: the lock is per form', () => {
  it('a filing of another form that lists a document does not lock it as a ภ.พ.30; the lock reason names the form filed', () => {
    const t = mk('TI', [L('a', 'S7', '10.00')], {});
    const f = { ...structuredClone(st.filings[0]), form: 'PP36' as const, period: '2026-09', docs: [{ ...st.filings[0].docs[0], id: t.id, state: 'live' as const }] };
    st.filings.push(f as never);
    expect(derivedLocks(st, get(t.id)).some((l) => l.kind === 'filing')).toBe(false);
    expect(cancel(st, t.id, t.version, 'OTHER', 'x', me).status).toBe('cancelled');
    expect(derivedLocks(st, get('ti-015')).find((l) => l.kind === 'filing')?.reason).toContain('ภ.พ.30');
  });
});

describe('M2: the company is frozen on the filing', () => {
  it('the text file and the model read the company as it was at finalize, not the master now', () => {
    const co = st.companies.find((c) => c.id === CO)!;
    const was = { taxId: co.taxId, branchCode: co.branchCode, legalNameTh: co.legalNameTh };
    const txt = exportFilingText(st, CO, 'PP30', '2026-08');
    co.taxId = '0105500000019'; co.branchCode = '00009'; co.legalNameTh = 'ชื่อใหม่ จำกัด';
    expect(exportFilingText(st, CO, 'PP30', '2026-08')).toBe(txt);
    expect(txt).toContain(`|${was.taxId}|${was.branchCode}|`);
    expect(getFiling(st, CO, 'PP30', '2026-08').company).toEqual(was);
  });
});

describe('M3: the snapshot is what the filing printed', () => {
  const aug = () => st.filings.find((f) => f.period === '2026-08')!;
  const bad = () => checkInvariants(st).filter((m) => m.includes('filing PP30 2026-08')).join('\n');
  it('a deleted tie-out entry fails', () => {
    aug().tieOuts = aug().tieOuts.slice(1);
    expect(bad()).toMatch(/tie-out .* is missing/);
  });
  it('a tie-out whose left is not the stored box fails', () => {
    const t = aug().tieOuts.find((x) => x.labelKey.endsWith('outputGl'))!;
    t.left = '1.00'; t.diff = (Number(t.left) - Number(t.right)).toFixed(2);
    expect(bad()).toMatch(/is not the stored box/);
  });
  it.each(['number', 'partyName', 'description'] as const)('a snapshot row whose %s differs from the document fails', (k) => {
    (aug().docs.find((d) => d.state === 'live' && d[k])! as unknown as Record<string, string>)[k] = 'ผิด';
    expect(bad()).toMatch(new RegExp(`${k} .* differs`));
  });
});

describe('M6: the input register carries the vendor invoice', () => {
  it('a bill row shows the vendor tax-invoice number and date, not our number and recording date', () => {
    mk('PB', [L('a', 'S7', '1000.00')], { documentDate: '2026-09-20', vendorDocDate: '2026-09-10', vendorDocNumber: 'TX-77/1' });
    const r = buildReport(st, CO, 'vat-input-register', { period: '2026-09' }).rows.find((x) => x.kind === 'row' && x.cells.number === 'TX-77/1')!;
    expect(r.cells.date).toBe('2026-09-10');
  });
  it('an expense claim with two vendor invoices gives one row per invoice; the boxes do not change; the fields are frozen in the snapshot', () => {
    const before = box(pp30Model(st, CO, '2026-09'), '7');
    const ex = mkEx('2026-09-20', [inv('บริษัท ก จำกัด', '010556000881', 'A-1', '2026-09-01', '100.00'), inv('บริษัท ข จำกัด', '010556000892', 'B-1', '2026-09-02', '200.00')]);
    const rows = () => buildReport(st, CO, 'vat-input-register', { period: '2026-09' }).rows.filter((x) => x.kind === 'row' && x.href?.includes(ex.id));
    expect(rows().map((x) => [x.cells.number, x.cells.date, x.cells.party, x.cells.vat])).toEqual([['A-1', '2026-09-01', 'บริษัท ก จำกัด', '7.00'], ['B-1', '2026-09-02', 'บริษัท ข จำกัด', '14.00']]);
    expect(sat(box(pp30Model(st, CO, '2026-09'), '7')) - sat(before)).toBe(2100);
    finalizeFiling(st, CO, 'PP30', '2026-09', getFiling(st, CO, 'PP30', '2026-09').version, me);
    get(ex.id).lines[0].vendorInvoice!.number = 'CHANGED';
    expect(rows().map((x) => x.cells.number)).toEqual(['A-1', 'B-1']);
  });
});

describe('M7: the seed has a claimed bill in a filed month', () => {
  it('pb-aug is in the August snapshot with input VAT, carries the filing lock, and August ties out', () => {
    const f = st.filings.find((x) => x.period === '2026-08')!;
    expect(f.docs.find((d) => d.id === 'pb-aug')).toMatchObject({ kind: 'in', claimPeriod: '2026-08' });
    expect(sat(box(getFiling(st, CO, 'PP30', '2026-08'), '7'))).toBeGreaterThan(0);
    expect(derivedLocks(st, get('pb-aug')).some((l) => l.kind === 'filing')).toBe(true);
    expect(getFiling(st, CO, 'PP30', '2026-08').tieOuts.every((t) => t.diff === '0.00')).toBe(true);
    expect(checkInvariants(st)).toEqual([]);
  });
});
