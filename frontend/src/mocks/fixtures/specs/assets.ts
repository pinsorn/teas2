import type { DocLine } from '@/domain/types';
import { activateAsset, disposeAsset, runDepreciation } from '../../engine/assets';
import { withFixedClock } from '../../engine/log';
import type { MockState } from '../../store';
import { USER } from '../documents';
import type { SeedSpec } from '../seed-runner';

/** AC5. A second capex bill (VAT company): the printer `fa-sold` is made from and sold in September. Seeded with the other history (date order); the assets and runs below are made AFTER every document, through the engine. */
const PRINTER: DocLine = { id: 'pb-printer-l1', description: 'เครื่องพิมพ์มัลติฟังก์ชัน', qty: '1', unit: 'เครื่อง', unitPrice: '24000.00', taxCode: 'EX', expenseCategory: 'capex-equipment' };
const SCANNER: DocLine = { id: 'pb-printer-l2', description: 'เครื่องสแกนเอกสาร', qty: '1', unit: 'เครื่อง', unitPrice: '12000.00', taxCode: 'EX', expenseCategory: 'capex-equipment' };
export const ASSET_SPECS: SeedSpec[] = [
  { id: 'pb-printer', type: 'PB', companyId: 'co-vat', date: '2026-07-01', partyId: 'pv-10', status: 'issued', header: { vendorDocNumber: 'IT-2026-0050', vendorDocDate: '2026-07-01', dueDate: '2026-07-31' }, lines: [PRINTER, SCANNER] },
];

/** AC5 assets, depreciation runs and the disposal, seeded THROUGH the engine (D-23), each under the clock of its own day (a run is made the day after its month, a closed month's run before the period closed on the 10th).
 *  VAT: `fa-scan` (a scanner on the same bill, 36 months, the asset September depreciates), `fa-nb` (the notebook of `pb-capex`, in service from its bill's date 9 Oct 2026, 36 months: not due yet), `fa-sold` (the printer, 24 months from 1 Jul, sold on 20 Sep for 20,000.00 + VAT: the loss is 1,333.33); runs for July and August; September is due, October has not ended.
 *  Non-VAT: `nfa-1` is the asset of the opening balance `nob-1` (45,000.00, 9,000.00 accumulated at 31 Dec 2025, salvage 1.00), depreciated January to August. */
export function seedAssets(st: MockState): void {
  const at = (iso: string, fn: () => void) => withFixedClock(`${iso}T10:00:00+07:00`, fn);
  at('2026-07-01', () => activateAsset(st, 'co-vat', { source: { kind: 'bill', docId: 'pb-printer', lineId: 'pb-printer-l1' }, name: 'เครื่องพิมพ์มัลติฟังก์ชัน', lifeMonths: 24, startDate: '2026-07-01' }, USER, { id: 'fa-sold', date: '2026-07-01' }));
  at('2026-07-01', () => activateAsset(st, 'co-vat', { source: { kind: 'bill', docId: 'pb-printer', lineId: 'pb-printer-l2' }, name: 'เครื่องสแกนเอกสาร', lifeMonths: 36, startDate: '2026-07-01' }, USER, { id: 'fa-scan', date: '2026-07-01' }));
  at('2026-10-09', () => activateAsset(st, 'co-vat', { source: { kind: 'bill', docId: 'pb-capex', lineId: 'pb-capex-l1' }, name: 'โน้ตบุ๊ก', lifeMonths: 36, startDate: '2026-10-09' }, USER, { id: 'fa-nb', date: '2026-10-09' }));
  const ob = st.docs.find((d) => d.id === 'nob-1')!;
  const car = ob.opening!.assets[1];
  at('2026-01-02', () => activateAsset(st, 'co-nonvat', { source: { kind: 'ob', docId: 'nob-1', rowId: ob.opening!.assets[0].id! }, salvage: '1.00' }, USER, { id: 'nfa-1', date: '2026-01-02' }));
  at('2026-08-02', () => runDepreciation(st, 'co-vat', '2026-07', USER, { id: 'dp-2026-07' }));
  at('2026-09-02', () => runDepreciation(st, 'co-vat', '2026-08', USER, { id: 'dp-2026-08' }));
  for (const m of ['01', '02', '03', '04', '05', '06', '07', '08']) at(`2026-${String(Number(m) + 1).padStart(2, '0')}-02`, () => { runDepreciation(st, 'co-nonvat', `2026-${m}`, USER, { id: `ndp-2026-${m}` }); });
  at('2026-09-03', () => activateAsset(st, 'co-nonvat', { source: { kind: 'ob', docId: 'nob-1', rowId: car.id! } }, USER, { id: 'nfa-car', date: '2026-09-03' })); // registered after the August run: September's run is its catch-up from January
  at('2026-09-20', () => disposeAsset(st, 'co-vat', 'fa-sold', { date: '2026-09-20', kind: 'sale', proceeds: '20000.00', buyerId: 'pc-07' }, USER));
}
