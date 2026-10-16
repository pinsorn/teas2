import type { DocLine } from '@/domain/types';
import { postSettlement } from '../../engine/settlement-records';
import { USER } from '../documents';
import type { SeedSpec } from '../seed-runner';

/** FN3 finance documents seeded THROUGH the engine (D-23): a deposit applied to an invoice (stl-001), an invoice waiting for the deposit rc-dep, a vendor prepayment and the bill it can be applied to,
 *  and the printer pc-02 who is also our vendor pv-11 (one invoice each way, for netting). Ids are explicit: the named fixtures and the tests refer to them. */
const VAT = 'co-vat';
const line = (doc: string, n: number, description: string, qty: string, unit: string, unitPrice: string, extra: Partial<DocLine> = {}): DocLine =>
  ({ id: `${doc}-l${n}`, description, qty, unit, unitPrice, taxCode: 'S7', ...extra });
/** A supplies line (no WHT type on the item): a bill of it can be settled without cash. */
const supplies = (doc: string, description: string, unitPrice: string): DocLine => line(doc, 1, description, '1', 'รีม', unitPrice, { itemId: 'EXP-06', expenseCategory: 'supplies' });
const PAID = { paymentMethod: 'transfer' as const, bankAccountId: 'ba-kbank' };

export const FINANCE_SPECS: SeedSpec[] = [
  // pc-08 owes 3,210.00 and has the 5,000.00 deposit rc-dep (S4): the fixture for "apply a deposit"
  { id: 'ti-dep', type: 'TI', companyId: VAT, date: '2026-10-12', partyId: 'pc-08', status: 'issued', header: { dueDate: '2026-10-27' }, lines: [line('ti-dep', 1, 'ค่าออกแบบและควบคุมงานก่อสร้าง', '1', 'งาน', '3000.00')] },
  // pc-05 paid 2,000.00 in advance and the whole invoice ti-dep2 (1,070.00) was taken from it
  { id: 'rc-dep2', type: 'RC', companyId: VAT, date: '2026-10-11', partyId: 'pc-05', status: 'issued', lines: [], header: { ...PAID, depositAmount: '2000.00' } },
  { id: 'ti-dep2', type: 'TI', companyId: VAT, date: '2026-10-11', partyId: 'pc-05', status: 'issued', header: { dueDate: '2026-10-26' }, lines: [line('ti-dep2', 1, 'ค่าบริการพิมพ์ฉลากสินค้า', '1', 'งาน', '1000.00')],
    after: (st) => { postSettlement(st, VAT, { kind: 'apply_deposit', date: '2026-10-11', partyId: 'pc-05', sources: [{ docId: 'rc-dep2', amount: '1070.00' }], targets: [{ docId: 'ti-dep2', amount: '1070.00' }] }, USER); } },
  // a vendor prepayment (3,000.00 to pv-05, nothing applied) and a bill of the same vendor it can be applied to (1,070.00)
  { id: 'pv-prep', type: 'PV', companyId: VAT, date: '2026-10-12', partyId: 'pv-05', status: 'issued', lines: [], header: { ...PAID, reference: 'จ่ายล่วงหน้าค่าโฆษณา', depositAmount: '3000.00' } },
  { id: 'pb-prep', type: 'PB', companyId: VAT, date: '2026-10-12', partyId: 'pv-05', status: 'issued', header: { vendorDocNumber: 'FP-2210', vendorDocDate: '2026-10-12' }, lines: [supplies('pb-prep', 'กระดาษ A4 80 แกรม', '1000.00')] },
  // netting: pc-02 owes 10,700.00 (ti-net), we owe its vendor side pv-11 4,280.00 (pb-net)
  { id: 'ti-net', type: 'TI', companyId: VAT, date: '2026-10-10', partyId: 'pc-02', status: 'issued', header: { dueDate: '2026-10-25' }, lines: [line('ti-net', 1, 'ค่าออกแบบแคตตาล็อก', '1', 'งาน', '10000.00')] },
  { id: 'pb-net', type: 'PB', companyId: VAT, date: '2026-10-10', partyId: 'pv-11', status: 'issued', header: { vendorDocNumber: 'PT-6601', vendorDocDate: '2026-10-10' }, lines: [supplies('pb-net', 'กระดาษพิมพ์งานแคตตาล็อก', '4000.00')] },
];
