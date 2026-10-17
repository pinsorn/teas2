import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { buildSeedState, type MockState } from '../../store';
import { activateAsset, runDepreciation } from '../assets';
import { createDraft, issue } from '../commands';
import { today } from '../log';
import { toSatang } from '../money';
import { companyEntries } from '../ledger';
import { assetRegister } from './asset-register';
import { buildReport } from './index';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

const byName = (m: ReturnType<typeof assetRegister>, name: string) => m.rows.find((r) => r.kind === 'row' && r.cells.name === name)!.cells;

describe('asset register (AC7a: as-of, class labels)', () => {
  it('ties to the ledger at any as-of date, both companies, before and after the opening, runs and the sale', () => {
    for (const co of ['co-vat', 'co-nonvat'])
      for (const asOf of [today(), '2026-09-30', '2026-09-20', '2026-08-31', '2026-07-15', '2026-07-01', '2026-01-15', '2025-12-31', '2025-06-01', '2099-12-31'])
        expect(assetRegister(st, co, { asOf }).tieOuts![0].diff, `${co} ${asOf}`).toBe('0.00');
  });
  it('shows each asset as it stood on the as-of date: accumulated from the runs by then, a sale only once it happened', () => {
    const at = (asOf: string) => assetRegister(st, 'co-vat', { asOf });
    expect(at('2026-07-31').asOf).toBe('2026-07-31');
    expect(byName(at('2026-07-31'), 'เครื่องสแกนเอกสาร')).toMatchObject({ accumulated: '333.33', nbv: '11666.67', status: 'ใช้งานอยู่' });
    expect(byName(at('2026-08-31'), 'เครื่องสแกนเอกสาร')).toMatchObject({ accumulated: '666.66', nbv: '11333.34' });
    expect(byName(at('2026-08-31'), 'เครื่องพิมพ์มัลติฟังก์ชัน')).toMatchObject({ accumulated: '2000.00', nbv: '22000.00', status: 'ใช้งานอยู่' }); // sold on 20 Sep
    expect(byName(at(today()), 'เครื่องพิมพ์มัลติฟังก์ชัน')).toMatchObject({ status: 'ขาย' });
  });
  it('an asset whose source document is dated after the as-of date is not listed', () => {
    const m = assetRegister(st, 'co-vat', { asOf: '2026-06-30' });
    expect(m.rows.filter((r) => r.kind === 'row')).toEqual([]);
  });
  it('names the class by the chart account it lives on, not by its code; totals per class', () => {
    const m = assetRegister(st, 'co-vat', { asOf: '2026-08-31' });
    const groups = m.rows.filter((r) => r.kind === 'group').map((r) => r.cells.number);
    expect(groups).toEqual(['อุปกรณ์สำนักงาน']);
    expect(m.rows.find((r) => r.kind === 'subtotal')!.cells).toMatchObject({ name: 'อุปกรณ์สำนักงาน' });
    expect(JSON.stringify(m.rows)).not.toContain('"equipment"');
  });
  it('an opening-balance asset row nobody has registered yet counts in the tie-out from the cut-off date, not before', () => {
    const gone = new Set(st.docs.filter((d) => d.companyId === 'co-nonvat' && (d.type === 'FA' || d.type === 'DP')).map((d) => d.id));
    st.docs = st.docs.filter((d) => !gone.has(d.id)); st.journals = st.journals.filter((j) => !gone.has(j.docId)); // the asset of nob-1 (cut-off 31 Dec 2025) is not registered
    for (const asOf of ['2025-06-01', '2025-12-30', '2025-12-31', '2026-03-31', today()]) expect(assetRegister(st, 'co-nonvat', { asOf }).tieOuts![0], asOf).toMatchObject({ diff: '0.00', left: asOf < '2025-12-31' ? '0.00' : '105000.00' });
  });
  const glOf = (co: string, asOf: string, sub: string) => {
    const codes = new Set(st.accounts.filter((a) => a.companyId === co && a.subClass === sub).map((a) => a.code));
    return companyEntries(st, co).filter((e) => e.date <= asOf).flatMap((e) => e.lines).filter((l) => codes.has(l.accountCode)).reduce((n, l) => n + toSatang(l.debit) - toSatang(l.credit), 0);
  };
  it('AC7a: the class subtotals and the grand total are the assets HELD at the date: a sold asset is listed with its status but outside them', () => {
    const m = assetRegister(st, 'co-vat', {}), i = (kind: string) => m.rows.findIndex((r) => r.kind === kind);
    const total = m.rows.find((r) => r.kind === 'total')!.cells, sub = m.rows.find((r) => r.kind === 'subtotal')!.cells;
    expect(total).toMatchObject({ cost: '44000.00', accumulated: '666.66', nbv: '43333.34' }); // fa-scan 12,000.00 + fa-nb 32,000.00; the printer (sold 20 Sep) is out
    expect(sub).toMatchObject({ cost: '44000.00', accumulated: '666.66', nbv: '43333.34' });
    const sold = m.rows.findIndex((r) => r.cells.name === 'เครื่องพิมพ์มัลติฟังก์ชัน');
    expect(sold).toBeGreaterThan(i('total')); // listed after the totals, in its own section
    expect(m.rows[sold]).toMatchObject({ kind: 'row', cells: { status: 'ขาย', cost: '24000.00' } });
    expect(m.rows[sold - 1]).toMatchObject({ kind: 'group', cells: { number: 'จำหน่ายแล้ว (ไม่รวมในยอดรวม)' } });
    expect(m.rows.filter((r) => r.kind === 'row' && r.cells.status === 'ใช้งานอยู่').map((r) => r.cells.name)).not.toContain('เครื่องพิมพ์มัลติฟังก์ชัน');
    expect(assetRegister(st, 'co-vat', { asOf: '2026-08-31' }).rows.some((r) => r.cells.number === 'จำหน่ายแล้ว (ไม่รวมในยอดรวม)')).toBe(false); // not sold yet on 31 Aug: held, in the totals
  });
  it('AC7a: the held totals tie to the ledger (FixedAsset and AccumulatedDepreciation) at every as-of date, both companies', () => {
    for (const co of ['co-vat', 'co-nonvat'])
      for (const asOf of [today(), '2026-09-30', '2026-09-19', '2026-08-31', '2026-07-15', '2026-01-15', '2025-12-31', '2025-06-01']) {
        const m = assetRegister(st, co, { asOf });
        expect(m.tieOuts!.map((t) => t.diff), `${co} ${asOf}`).toEqual(['0.00', '0.00']); // accumulated, then cost
      }
    for (const asOf of [today(), '2026-03-31', '2025-12-31']) { // the non-VAT company has no unregistered capex: the register's totals ARE the ledger
      const t = assetRegister(st, 'co-nonvat', { asOf }).rows.find((r) => r.kind === 'total')!.cells;
      expect(toSatang(t.cost), asOf).toBe(glOf('co-nonvat', asOf, 'fixed-asset'));
      expect(toSatang(t.accumulated), asOf).toBe(-glOf('co-nonvat', asOf, 'accumulated-depreciation'));
    }
  });
  it('AC7a: a capex bill nobody has registered is in the ledger and in the cost tie-out from its date, and in no total', () => {
    const line: DocLine = { id: 'cl-un', description: 'เครื่องปรับอากาศ', qty: '1', unit: 'เครื่อง', unitPrice: '20000.00', taxCode: 'EX', expenseCategory: 'capex-equipment' };
    const d = createDraft(st, 'co-vat', 'PB', { header: { documentDate: '2026-08-15', partyId: 'pv-10', vendorDocNumber: 'UN-1', vendorDocDate: '2026-08-15' }, lines: [line] }, ME, 'k-un');
    issue(st, d.id, d.version, ME);
    const before = assetRegister(st, 'co-vat', { asOf: '2026-08-14' }), after = assetRegister(st, 'co-vat', { asOf: '2026-08-31' });
    expect(before.tieOuts![1]).toMatchObject({ left: '36000.00', right: '36000.00', diff: '0.00' }); // the printer and the scanner (bill of 1 Jul); the bill is not there yet
    expect(after.tieOuts![1].diff).toBe('0.00');
    expect(Number(after.tieOuts![1].right) - Number(before.tieOuts![1].right)).toBe(20000); // the bill's cost came into the ledger on 15 Aug
    expect(after.rows.find((r) => r.kind === 'total')!.cells.cost).toBe(before.rows.find((r) => r.kind === 'total')!.cells.cost); // but no asset stands on it: not in the totals
  });
  it('is built by the report engine with asOf defaulting to today', () => {
    expect(buildReport(st, 'co-vat', 'asset-register', {}).asOf).toBe(today());
    expect(buildReport(st, 'co-vat', 'asset-register', { asOf: '2026-08-31' }).asOf).toBe('2026-08-31');
  });
  it('still ties once a late-registered asset has had its catch-up run (the register shows the catch-up in its accumulated)', () => {
    const line: DocLine = { id: 'cl-ar', description: 'เครื่องล้างรถ', qty: '1', unit: 'เครื่อง', unitPrice: '36000.00', taxCode: 'S7', expenseCategory: 'capex-equipment' };
    const d = createDraft(st, 'co-vat', 'PB', { header: { documentDate: '2026-07-10', partyId: 'pv-10', vendorDocNumber: 'AR-1', vendorDocDate: '2026-07-10' }, lines: [line] }, ME, 'k-ar');
    const bill = issue(st, d.id, d.version, ME);
    activateAsset(st, 'co-vat', { source: { kind: 'bill', docId: bill.id, lineId: line.id }, lifeMonths: 36, startDate: '2026-07-10', name: 'เครื่องล้างรถ' }, ME);
    runDepreciation(st, 'co-vat', '2026-09', ME);
    const m = assetRegister(st, 'co-vat', {});
    expect(byName(m, 'เครื่องล้างรถ')).toMatchObject({ accumulated: '2709.68', nbv: '33290.32' });
    expect(m.tieOuts![0].diff).toBe('0.00');
    expect(assetRegister(st, 'co-vat', { asOf: '2026-08-31' }).tieOuts![0].diff).toBe('0.00');
  });
});
