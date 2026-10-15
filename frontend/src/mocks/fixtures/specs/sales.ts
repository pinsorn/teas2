import type { DocLine, MarkKey } from '@/domain/types';
import { cancel } from '../../engine/commands';
import { setMark } from '../../engine/marks';
import type { MockState } from '../../store';
import { USER } from '../documents';
import type { SeedSpec } from '../seed-runner';

/** Sales documents seeded THROUGH the engine (D-23). Ids are explicit: the named fixtures and later sales tasks refer to them. */
const VAT = 'co-vat', NV = 'co-nonvat';
const line = (doc: string, n: number, description: string, qty: string, unit: string, unitPrice: string, taxCode: DocLine['taxCode'] = 'S7'): DocLine =>
  ({ id: `${doc}-l${n}`, description, qty, unit, unitPrice, taxCode });
const mark = (id: string, key: MarkKey, reason?: string) => (st: MockState) => {
  setMark(st, id, key, st.docs.find((d) => d.id === id)!.version, USER, reason);
};
const due = (date: string) => ({ dueDate: date }); // QT: "ยืนราคาถึง"

export const SALES_SPECS: SeedSpec[] = [
  // ---- quotations, VAT company ----
  { id: 'qt-d1', type: 'QT', companyId: VAT, date: '2026-10-08', partyId: 'pc-02', status: 'draft', header: due('2026-11-07'),
    lines: [line('qt-d1', 1, 'ออกแบบเว็บไซต์', '1', 'งาน', '85000.00')] },
  { id: 'qt-d2', type: 'QT', companyId: VAT, date: '2026-10-09', partyId: 'pc-05', status: 'draft', header: due('2026-11-08'),
    lines: [line('qt-d2', 1, 'นามบัตร 500 ใบ', '10', 'กล่อง', '450.00'), line('qt-d2', 2, 'โปสเตอร์ A2', '50', 'แผ่น', '180.00')] },
  { id: 'qt-acc', type: 'QT', companyId: VAT, date: '2026-10-06', partyId: 'pc-03', status: 'issued', header: due('2026-11-05'),
    lines: [line('qt-acc', 1, 'ป้ายไวนิล 1x3 ม.', '10', 'ผืน', '750.00'), line('qt-acc', 2, 'สติกเกอร์ฉลากสินค้า', '20', 'ม้วน', '320.00')],
    after: mark('qt-acc', 'accepted') },
  { id: 'qt-rej', type: 'QT', companyId: VAT, date: '2026-10-07', partyId: 'pc-06', status: 'issued', header: due('2026-11-06'),
    lines: [line('qt-rej', 1, 'ผลิตวิดีโอโปรโมท', '1', 'งาน', '48000.00')],
    after: mark('qt-rej', 'rejected', 'ราคาสูงกว่างบประมาณ') },
  { id: 'qt-can', type: 'QT', companyId: VAT, date: '2026-10-05', partyId: 'pc-07', status: 'issued', header: due('2026-11-04'),
    lines: [line('qt-can', 1, 'ที่ปรึกษาการตลาดรายเดือน', '3', 'เดือน', '25000.00')],
    after: (st) => { cancel(st, 'qt-can', st.docs.find((d) => d.id === 'qt-can')!.version, 'OTHER', 'ลูกค้ายกเลิกโครงการ', USER); } },
  // ---- quotations, non-VAT company (no VAT anywhere on them) ----
  { id: 'nqt-d1', type: 'QT', companyId: NV, date: '2026-10-08', partyId: 'nc-01', status: 'draft', header: due('2026-10-22'),
    lines: [line('nqt-d1', 1, 'บริการจัดเลี้ยงอาหารกล่อง', '40', 'ชุด', '120.00', 'EX')] },
  { id: 'nqt-1', type: 'QT', companyId: NV, date: '2026-10-06', partyId: 'nc-02', status: 'issued', header: due('2026-10-20'),
    lines: [line('nqt-1', 1, 'ข้าวสารหอมมะลิ 5 กก.', '30', 'ถุง', '185.00', 'EX'), line('nqt-1', 2, 'น้ำพริกเผา', '12', 'ขวด', '55.00', 'EX')] },
  { id: 'nqt-2', type: 'QT', companyId: NV, date: '2026-10-07', partyId: 'nc-05', status: 'issued', header: due('2026-10-21'),
    lines: [line('nqt-2', 1, 'ข้าวสาร 15 กก.', '20', 'ถุง', '420.00', 'EX'), line('nqt-2', 2, 'ข้าวเหนียว 1 กก.', '40', 'ถุง', '48.00', 'EX')],
    after: mark('nqt-2', 'accepted') },
];
