import type { DocLine, MarkKey } from '@/domain/types';
import { closeRemainder, setMark } from '../../engine/marks';
import type { MockState } from '../../store';
import { USER } from '../documents';
import type { SeedSpec } from '../seed-runner';

/** Purchase documents seeded THROUGH the engine (D-23); ids are explicit, the named fixtures and later purchase tasks refer to them. */
const VAT = 'co-vat', NV = 'co-nonvat';
const line = (doc: string, n: number, description: string, qty: string, unit: string, unitPrice: string, taxCode: DocLine['taxCode'] = 'S7'): DocLine =>
  ({ id: `${doc}-l${n}`, description, qty, unit, unitPrice, taxCode });
const mark = (id: string, key: MarkKey) => (st: MockState) => { setMark(st, id, key, st.docs.find((d) => d.id === id)!.version, USER); };
const due = (date: string) => ({ dueDate: date }); // PO: "กำหนดรับของ"

export const PURCHASE_SPECS: SeedSpec[] = [
  // ---- P1: purchase orders ----
  { id: 'po-d1', type: 'PO', companyId: VAT, date: '2026-10-13', partyId: 'pv-01', status: 'draft', header: due('2026-10-27'),
    lines: [line('po-d1', 1, 'กระดาษ A4 80 แกรม', '50', 'รีม', '115.00')] },
  { id: 'po-1', type: 'PO', companyId: VAT, date: '2026-10-12', partyId: 'pv-02', status: 'issued', header: due('2026-10-26'),
    lines: [line('po-1', 1, 'หมึกพิมพ์สีดำ', '12', 'ตลับ', '890.00'), line('po-1', 2, 'หมึกพิมพ์สี', '12', 'ตลับ', '1250.00'), line('po-1', 3, 'กระดาษภาพถ่าย A4', '20', 'แพ็ค', '240.00')],
    after: mark('po-1', 'sent') },
  { id: 'po-part', type: 'PO', companyId: VAT, date: '2026-10-11', partyId: 'pv-03', status: 'issued', header: due('2026-10-25'), // billed by pb-po (P2): half of each line
    lines: [line('po-part', 1, 'แฟ้มเอกสารพิมพ์โลโก้', '40', 'เล่ม', '65.00'), line('po-part', 2, 'ปากกาลูกลื่น', '100', 'ด้าม', '12.00')] },
  { id: 'po-closed', type: 'PO', companyId: VAT, date: '2026-10-10', partyId: 'pv-04', status: 'issued', header: due('2026-10-24'),
    lines: [line('po-closed', 1, 'ป้ายไวนิลงานแสดงสินค้า', '6', 'ผืน', '750.00')],
    after: (st) => { closeRemainder(st, 'po-closed', st.docs.find((d) => d.id === 'po-closed')!.version, 'ผู้ขายยกเลิกส่วนที่เหลือ', USER); } },
  // ---- non-VAT company: no VAT anywhere ----
  { id: 'npo-1', type: 'PO', companyId: NV, date: '2026-10-12', partyId: 'nv-01', status: 'issued', header: due('2026-10-19'),
    lines: [line('npo-1', 1, 'ข้าวเปลือก', '2000', 'กก.', '12.00', 'EX')] },
];
