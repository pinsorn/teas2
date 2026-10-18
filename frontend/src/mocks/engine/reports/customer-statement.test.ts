import { beforeEach, describe, expect, it } from 'vitest';
import type { ReportModel } from '@/domain/reports';
import { buildSeedState, type MockState } from '../../store';
import { companyEntries } from '../ledger';
import { today } from '../log';
import { toSatang } from '../money';
import { generalLedger } from './general-ledger';
import { reportCsv } from './index';
import { customerStatement } from './customer-statement';
import { vendorLedger } from './vendor-ledger';

const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

/** The test's own oracle: the raw posted lines of one account for one party id, with their entry date, straight from the stores. */
const raw = (co: string, code: string, partyId: string) => [...companyEntries(st, co)].flatMap((e) => e.lines.filter((l) => l.accountCode === code && l.partyId === partyId).map((l) => ({ date: e.date, dr: toSatang(l.debit), cr: toSatang(l.credit) })));
const body = (m: ReportModel) => m.rows.filter((r) => r.kind === 'row');
const opening = (m: ReportModel) => toSatang(m.rows[0].cells.balance), closing = (m: ReportModel) => toSatang(m.rows.at(-1)!.cells.balance);
const parties = (co: string, kind: string) => st.parties.filter((p) => p.companyId === co && p.kind === kind);
const codeErr = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { status?: number; code?: string }); } return undefined; };

describe('ruling 3: customer statement', () => {
  it.each([VAT, NV])('%s: for every customer, opening = ledger before `from`, each running balance follows, opening + Σdr - Σcr = closing = the ledger at `to`', (co) => {
    for (const p of parties(co, 'customer')) for (const [from, to] of [['2026-01-01', '2026-10-14'], ['2026-07-01', '2026-09-30'], ['2025-01-01', '2026-03-31']] as const) {
      const m = customerStatement(st, co, { party: p.id, from, to });
      const all = raw(co, '1130', p.id);
      const before = all.filter((x) => x.date < from).reduce((n, x) => n + x.dr - x.cr, 0);
      const inside = all.filter((x) => x.date >= from && x.date <= to), net = inside.reduce((n, x) => n + x.dr - x.cr, 0);
      const toBal = all.filter((x) => x.date <= to).reduce((n, x) => n + x.dr - x.cr, 0);
      if (!m.rows.length) { expect(before, `${p.code} ${from}`).toBe(0); expect(inside).toHaveLength(0); continue; }
      expect(opening(m), `${p.code} opening ${from}`).toBe(before);
      let run = opening(m), dr = 0, cr = 0;
      for (const r of body(m)) { const d = toSatang(r.cells.debit || '0.00'), c = toSatang(r.cells.credit || '0.00'); run += d - c; dr += d; cr += c; expect(toSatang(r.cells.balance)).toBe(run); }
      expect(body(m)).toHaveLength(inside.length);
      expect(opening(m) + dr - cr).toBe(closing(m));
      expect(dr - cr).toBe(net);
      expect(closing(m), `${p.code} closing ${to}`).toBe(toBal);
      expect(m.tieOuts!.map((t) => t.diff)).toEqual(['0.00', '0.00']);
    }
  });
  it('lists the documents, receipts, credit notes and write-offs of the customer in date order, each linked', () => {
    // C06 (pc-?): TI-202605-0005 with the credit note CN-202610-0002; find the customer by the document
    const ti = st.docs.find((d) => d.number === 'TI-202605-0005')!;
    const m = customerStatement(st, VAT, { party: ti.header.partyId!, from: '2026-05-01', to: today() });
    const labels = body(m).map((r) => r.cells.doc);
    expect(labels.some((l) => l.startsWith('TI-202605-0005'))).toBe(true);
    const cn = body(m).find((r) => r.cells.doc.startsWith('CN-202610-0002'))!;
    expect(cn.cells.credit).toBe('8966.60');
    expect(cn.links!.doc).toMatch(/credit-notes\//);
    expect(body(m).map((r) => r.cells.date)).toEqual([...body(m).map((r) => r.cells.date)].sort());
    // a receipt and a deposit application (settlement record) of another customer
    const rc = customerStatement(st, VAT, { party: st.docs.find((d) => d.number === 'TI-202610-0003')!.header.partyId!, from: '2026-10-01', to: today() });
    expect(body(rc).some((r) => r.cells.doc.startsWith('STL') || r.cells.doc.startsWith('stl') || r.cells.doc.toUpperCase().includes('STL-001'))).toBe(true);
  });
  it('the party is its id: a rename leaves the lines, the opening and the closing alone; the line keeps the name as the document was issued; the header names the master', () => {
    const p = st.parties.find((x) => x.id === st.docs.find((d) => d.number === 'TI-202605-0005')!.header.partyId)!;
    const old = p.name;
    const before = customerStatement(st, VAT, { party: p.id, from: '2026-01-01', to: today() });
    p.name = 'ชื่อใหม่ จำกัด';
    const after = customerStatement(st, VAT, { party: p.id, from: '2026-01-01', to: today() });
    expect(after.rows.map((r) => r.cells)).toEqual(before.rows.map((r) => r.cells));
    expect(body(after).every((r) => r.cells.party === old)).toBe(true);
    expect(after.notes!.join(' ')).toContain('ชื่อใหม่ จำกัด');
  });
  it('a duplicate-named customer is a different statement', () => {
    const [a, b] = parties(VAT, 'customer').filter((p) => raw(VAT, '1130', p.id).length > 0);
    b.name = a.name;
    expect(body(customerStatement(st, VAT, { party: a.id, from: '2025-01-01', to: today() })).length).toBe(raw(VAT, '1130', a.id).length);
    expect(body(customerStatement(st, VAT, { party: b.id, from: '2025-01-01', to: today() })).length).toBe(raw(VAT, '1130', b.id).length);
  });
  it('refusals: party required, other company -> 404, a vendor is not a customer, bad dates', () => {
    expect(codeErr(() => customerStatement(st, VAT, {}))).toMatchObject({ status: 422 });
    expect(codeErr(() => customerStatement(st, VAT, { party: parties(NV, 'customer')[0].id }))).toMatchObject({ status: 404 });
    expect(codeErr(() => customerStatement(st, VAT, { party: parties(VAT, 'vendor')[0].id }))).toMatchObject({ status: 422 });
    expect(codeErr(() => customerStatement(st, VAT, { party: parties(VAT, 'customer')[0].id, from: '2026-05-01', to: '2026-04-01' }))).toMatchObject({ status: 422 });
    expect(codeErr(() => customerStatement(st, VAT, { party: parties(VAT, 'customer')[0].id, to: '2026-02-30' }))).toMatchObject({ status: 422 });
  });
  it('the CSV carries the running balance', () => {
    const p = parties(VAT, 'customer').find((x) => raw(VAT, '1130', x.id).length > 2)!;
    const csv = reportCsv(customerStatement(st, VAT, { party: p.id, from: '2025-01-01', to: today() }));
    expect(csv.split('\r\n')[0]).toContain('คงเหลือ');
    expect(csv.split('\r\n').length).toBeGreaterThan(4);
  });
});

describe('ruling 3: vendor ledger mirrors on 2110', () => {
  it('for every vendor: opening + Σcr - Σdr = closing = the payable at `to` (credit side), running balance follows', () => {
    for (const co of [VAT, NV]) for (const p of parties(co, 'vendor')) for (const [from, to] of [['2026-01-01', today()], ['2026-08-01', '2026-10-05']] as const) {
      const m = vendorLedger(st, co, { party: p.id, from, to });
      const all = raw(co, '2110', p.id);
      const before = all.filter((x) => x.date < from).reduce((n, x) => n + x.cr - x.dr, 0), toBal = all.filter((x) => x.date <= to).reduce((n, x) => n + x.cr - x.dr, 0);
      if (!m.rows.length) { expect(before).toBe(0); continue; }
      expect(opening(m)).toBe(before);
      let run = opening(m), dr = 0, cr = 0;
      for (const r of body(m)) { const d = toSatang(r.cells.debit || '0.00'), c = toSatang(r.cells.credit || '0.00'); run += c - d; dr += d; cr += c; expect(toSatang(r.cells.balance)).toBe(run); }
      expect(opening(m) + cr - dr).toBe(closing(m));
      expect(closing(m)).toBe(toBal);
      expect(m.tieOuts!.map((t) => t.diff)).toEqual(['0.00', '0.00']);
    }
    expect(vendorLedger(st, VAT, { party: parties(VAT, 'vendor')[0].id }).kind).toBe('vendor-ledger');
  });
  it('a customer is not a vendor', () => {
    expect(codeErr(() => vendorLedger(st, VAT, { party: parties(VAT, 'customer')[0].id }))).toMatchObject({ status: 422 });
  });
});

describe('ruling 8c: the general ledger party parameter is an id', () => {
  const cust = () => st.parties.find((p) => p.companyId === VAT && p.kind === 'customer' && raw(VAT, '1130', p.id).length > 0)!;
  it('the id selects the party; a code or a name no longer does', () => {
    const p = cust();
    expect(body(generalLedger(st, VAT, { account: '1130', party: p.id })).length).toBe(raw(VAT, '1130', p.id).length);
    expect(codeErr(() => generalLedger(st, VAT, { account: '1130', party: p.code }))).toMatchObject({ status: 404 });
    expect(codeErr(() => generalLedger(st, VAT, { account: '1130', party: p.name }))).toMatchObject({ status: 404 });
  });
  it('the statement and the general ledger of a party agree line for line', () => {
    const p = cust();
    const gl = generalLedger(st, VAT, { account: '1130', party: p.id, from: '2026-01-01', to: today() });
    const s = customerStatement(st, VAT, { party: p.id, from: '2026-01-01', to: today() });
    expect(body(s).map((r) => [r.cells.date, r.cells.debit, r.cells.credit, r.cells.balance])).toEqual(body(gl).map((r) => [r.cells.date, r.cells.debit, r.cells.credit, r.cells.balance]));
  });
});
