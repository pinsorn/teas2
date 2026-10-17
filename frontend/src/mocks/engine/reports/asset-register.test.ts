import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, DocLine } from '@/domain/types';
import { buildSeedState, type MockState } from '../../store';
import { activateAsset, runDepreciation } from '../assets';
import { createDraft, issue } from '../commands';
import { today } from '../log';
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
    for (const asOf of ['2025-06-01', '2025-12-30', '2025-12-31', '2026-03-31', today()]) expect(assetRegister(st, 'co-nonvat', { asOf }).tieOuts![0], asOf).toMatchObject({ diff: '0.00', left: asOf < '2025-12-31' ? '0.00' : '9000.00' });
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
