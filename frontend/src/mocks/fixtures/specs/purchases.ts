import type { DocHeader, DocLine, MarkKey, VendorInvoice } from '@/domain/types';
import { tinCheckDigit } from '@/domain/tin';
import { seedAttachment } from '../../engine/attachments';
import { closeRemainder, setMark } from '../../engine/marks';
import type { MockState } from '../../store';
import { USER } from '../documents';
import type { SeedSpec } from '../seed-runner';

/** Purchase documents seeded THROUGH the engine (D-23); ids are explicit, the named fixtures and later purchase tasks refer to them. */
const VAT = 'co-vat', NV = 'co-nonvat';
const line = (doc: string, n: number, description: string, qty: string, unit: string, unitPrice: string, taxCode: DocLine['taxCode'] = 'S7', extra: Partial<DocLine> = {}): DocLine =>
  ({ id: `${doc}-l${n}`, description, qty, unit, unitPrice, taxCode, ...extra });
/** A bill's expense line: the item (its code names the category) and the category the line posts under. */
const exp = (doc: string, n: number, description: string, unit: string, unitPrice: string, itemId: string, expenseCategory: string, taxCode: DocLine['taxCode'] = 'S7', qty = '1'): DocLine =>
  line(doc, n, description, qty, unit, unitPrice, taxCode, { itemId, expenseCategory });
/** Vendor paperwork of a bill: the number and date printed on the vendor's own document. */
const vendorDoc = (no: string, date: string, extra: Partial<DocHeader> = {}): Partial<DocHeader> => ({ vendorDocNumber: no, vendorDocDate: date, ...extra });
const mark = (id: string, key: MarkKey) => (st: MockState) => { setMark(st, id, key, st.docs.find((d) => d.id === id)!.version, USER); };
const due = (date: string) => ({ dueDate: date }); // PO: "กำหนดรับของ"
/** The vendor's tax invoice behind an expense-claim line (a fictional TIN with a correct check digit). */
const inv = (vendorName: string, first12: string, number: string, date: string): { vendorInvoice: VendorInvoice } => ({ vendorInvoice: { vendorName, vendorTin: first12 + tinCheckDigit(first12), number, date, fullTaxInvoice: true } });
/** A 1 x 1 PNG: the photo of a receipt. */
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

  // ---- P2: purchase bills, vendor credit / debit notes (VAT company) ----
  // pb-1: rent 25,000.00 + VAT 1,750.00 = 26,750.00, all claimable in 2026-10 (the claim period defaults to the document month)
  { id: 'pb-1', type: 'PB', companyId: VAT, date: '2026-10-06', partyId: 'pv-01', status: 'issued', header: { ...vendorDoc('INV-2026-1007', '2026-10-05'), dueDate: '2026-11-05' },
    lines: [exp('pb-1', 1, 'ค่าเช่าสำนักงาน ตุลาคม 2569', 'เดือน', '25000.00', 'EXP-01', 'rent')] },
  // pb-2: services 18,000.00 + entertainment 4,500.00, VAT 1,260.00 + 315.00; the entertainment VAT is not claimable (5170)
  { id: 'pb-2', type: 'PB', companyId: VAT, date: '2026-10-08', partyId: 'pv-03', status: 'issued', header: { ...vendorDoc('TX-88/0412', '2026-10-07'), dueDate: '2026-11-07' },
    lines: [exp('pb-2', 1, 'ค่าที่ปรึกษาระบบบัญชี', 'งาน', '18000.00', 'EXP-05', 'services'), exp('pb-2', 2, 'ค่ารับรองลูกค้า', 'ครั้ง', '4500.00', 'EXP-07', 'entertainment')] },
  // pb-po: half of each line of po-part (20 of 40, 50 of 100)
  { id: 'pb-po', type: 'PB', companyId: VAT, date: '2026-10-12', partyId: 'pv-03', status: 'issued', header: vendorDoc('TX-88/0431', '2026-10-12'),
    lines: [], convertFrom: { id: 'po-part', lines: [{ sourceLineId: 'po-part-l1', qty: '20' }, { sourceLineId: 'po-part-l2', qty: '50' }] } },
  { id: 'pb-capex', type: 'PB', companyId: VAT, date: '2026-10-09', partyId: 'pv-10', status: 'issued', header: vendorDoc('IT-2026-0093', '2026-10-09'),
    lines: [exp('pb-capex', 1, 'เครื่องคอมพิวเตอร์โน้ตบุ๊ก', 'เครื่อง', '32000.00', 'EXP-08', 'capex-equipment')] },
  // pb-claim-late: dated October, claimed two months later (2026-12)
  { id: 'pb-claim-late', type: 'PB', companyId: VAT, date: '2026-10-05', partyId: 'pv-02', status: 'issued', header: { ...vendorDoc('SI-5521', '2026-10-05'), claimPeriod: '2026-12' },
    lines: [exp('pb-claim-late', 1, 'ค่าบริการทำความสะอาด', 'เดือน', '8500.00', 'EXP-02', 'services')] },
  // pb-incomplete: the vendor's tax invoice has not arrived (เอกสารไม่ครบ) - it issues, the Home inbox counts it (HC1)
  { id: 'pb-incomplete', type: 'PB', companyId: VAT, date: '2026-10-10', partyId: 'pv-04', status: 'issued', header: { complete: false },
    lines: [exp('pb-incomplete', 1, 'กระดาษ A4 80 แกรม', 'รีม', '115.00', 'EXP-06', 'supplies', 'S7', '20')] },
  { id: 'pb-d1', type: 'PB', companyId: VAT, date: '2026-10-13', partyId: 'pv-05', status: 'draft', header: vendorDoc('FP-1180', '2026-10-13'),
    lines: [exp('pb-d1', 1, 'ค่าโฆษณาออนไลน์ ตุลาคม', 'เดือน', '12000.00', 'EXP-03', 'advertising')] },
  // pcn-1: a 10 % rent discount from the vendor; its VAT 175.00 gives back the claim of 2026-10
  { id: 'pcn-1', type: 'PCN', companyId: VAT, date: '2026-10-12', status: 'issued',
    header: { ...vendorDoc('CN-2026-0042', '2026-10-12'), refDocId: 'pb-1', reasonCode: 'PRICE_REDUCTION' },
    lines: [line('pcn-1', 1, 'ส่วนลดค่าเช่า 10%', '1', 'เดือน', '2500.00', 'S7', { sourceLineId: 'pb-1-l1' })] },
  // pdn-1: the vendor charged 500.00 more for entertainment; the VAT 35.00 is cost, like the bill's
  { id: 'pdn-1', type: 'PDN', companyId: VAT, date: '2026-10-13', status: 'issued',
    header: { ...vendorDoc('DN-2026-0007', '2026-10-13'), refDocId: 'pb-2', reasonCode: 'PRICE_INCREASE' },
    lines: [line('pdn-1', 1, 'ค่ารับรองเพิ่ม', '1', 'ครั้ง', '500.00', 'S7', { sourceLineId: 'pb-2-l2' })] },

  // ---- non-VAT company: the VAT on a vendor's tax invoice is cost (A.4, D-25) ----
  { id: 'npb-1', type: 'PB', companyId: NV, date: '2026-10-07', partyId: 'nv-03', status: 'issued', header: vendorDoc('V-3391', '2026-10-07'),
    lines: [line('npb-1', 1, 'ค่าซ่อมแซมอุปกรณ์โรงสี', '1', 'งาน', '1000.00', 'S7', { expenseCategory: 'services' })] },
  { id: 'npb-2', type: 'PB', companyId: NV, date: '2026-10-08', partyId: 'nv-01', status: 'issued', header: vendorDoc('R-204', '2026-10-08'),
    lines: [exp('npb-2', 1, 'ข้าวเปลือก', 'กก.', '12.00', 'nv-EXP-02', 'cost-of-sales', 'EX', '500')] },

  // ---- P4: expense claims (EX, owed to an employee: 2180) - the approval policy of the VAT company wants every claim approved (the seed's own user approves, self-approval is on) ----
  // ex-d1: a draft, taxi + a meal, nothing with VAT
  { id: 'ex-d1', type: 'EX', companyId: VAT, date: '2026-10-13', partyId: 'emp-02', status: 'draft', header: {},
    lines: [line('ex-d1', 1, 'ค่าแท็กซี่ไปพบลูกค้า', '1', 'เที่ยว', '180.00', 'EX', { expenseCategory: 'transport' }), line('ex-d1', 2, 'ค่าอาหารระหว่างเดินทาง', '1', 'มื้อ', '320.00', 'EX', { expenseCategory: 'transport' })] },
  // ex-pend: waiting for approval, a receipt photo attached; the stationery line carries its vendor tax invoice
  { id: 'ex-pend', type: 'EX', companyId: VAT, date: '2026-10-13', partyId: 'emp-03', status: 'pending', header: {},
    lines: [line('ex-pend', 1, 'ค่าอุปกรณ์สำนักงานซื้อด่วน', '1', 'ชุด', '1000.00', 'S7', { expenseCategory: 'supplies', ...inv('ร้านเครื่องเขียนสยาม', '010556000123', 'INV-5521', '2026-10-13') })],
    after: (st) => seedAttachment(st, VAT, 'ex-pend', { id: 'att-seed-ex-pend', category: 'receipt', name: 'ใบเสร็จร้านเครื่องเขียน.png', dataUrl: PHOTO }, USER.name) },
  // ex-appr: approved, not issued yet (VAT 175.00 has no tax invoice: it will be cost)
  { id: 'ex-appr', type: 'EX', companyId: VAT, date: '2026-10-12', partyId: 'emp-01', status: 'approved', header: {},
    lines: [line('ex-appr', 1, 'ค่าซ่อมโปรเจกเตอร์ห้องประชุม', '1', 'งาน', '2500.00', 'S7', { expenseCategory: 'services' })] },
  // ex-1: issued, unpaid. Taxi 180.00 (no VAT) + supplies 2,000.00 with its tax invoice (VAT 140.00 -> 1170) + a meal 500.00 whose VAT 35.00 has no invoice (cost, 5170) = 2,855.00
  { id: 'ex-1', type: 'EX', companyId: VAT, date: '2026-10-10', partyId: 'emp-02', status: 'issued', header: {},
    lines: [line('ex-1', 1, 'ค่าแท็กซี่', '1', 'เที่ยว', '180.00', 'EX', { expenseCategory: 'transport' }),
      line('ex-1', 2, 'ค่าวัสดุสิ้นเปลือง', '1', 'ชุด', '2000.00', 'S7', { expenseCategory: 'supplies', ...inv('บริษัท เครื่องเขียนอเนกประสงค์ จำกัด', '010556000771', 'TX-77/1024', '2026-10-09') }),
      line('ex-1', 3, 'ค่าอาหารลูกค้า', '1', 'มื้อ', '500.00', 'S7', { expenseCategory: 'entertainment' })] },
  // ex-late: the vendor's tax invoice is from 2026-03: the window of ม.82/3 closed in 2026-09, so its VAT 70.00 is cost
  { id: 'ex-late', type: 'EX', companyId: VAT, date: '2026-10-09', partyId: 'emp-03', status: 'issued', header: {},
    lines: [line('ex-late', 1, 'ค่าบริการรายเดือน มี.ค.', '1', 'เดือน', '1000.00', 'S7', { expenseCategory: 'services', ...inv('บริษัท คลาวด์โฮสต์ไทย จำกัด', '010556000345', 'CH-0315', '2026-03-15') })] },
  // ex-paid: 1,200.00 travel, paid by pv-ex in full (no tax is withheld on a reimbursement)
  { id: 'ex-paid', type: 'EX', companyId: VAT, date: '2026-10-08', partyId: 'emp-01', status: 'issued', header: {},
    lines: [line('ex-paid', 1, 'ค่าเดินทางไปประชุม', '1', 'ครั้ง', '1200.00', 'EX', { expenseCategory: 'transport' })] },
  { id: 'pv-ex', type: 'PV', companyId: VAT, date: '2026-10-14', partyId: 'emp-01', status: 'issued', header: { reference: 'จ่ายคืนค่าเดินทาง' }, lines: [],
    allocations: [{ targetId: 'ex-paid', targetType: 'EX', amount: '1200.00' }] },
  // non-VAT company: no approval policy, issued directly; the VAT of a vendor's receipt is cost
  { id: 'nex-1', type: 'EX', companyId: NV, date: '2026-10-09', partyId: 'nemp-01', status: 'issued', header: {},
    lines: [line('nex-1', 1, 'ค่าน้ำมันรถส่งของ', '1', 'ครั้ง', '800.00', 'S7', { expenseCategory: 'transport' })] },

  // ---- P3: payment vouchers and the 50 tawi they issue (WHT from the typed lines of the bills paid, and from the voucher's own lines) ----
  // pv-pay1: pb-1 paid in full (24,075.00 after pcn-1); RENT 5 % deduct of the net 22,500.00 = 1,125.00 -> cash 22,950.00, one WT
  { id: 'pv-pay1', type: 'PV', companyId: VAT, date: '2026-10-14', partyId: 'pv-01', status: 'issued', header: { reference: 'ชำระค่าเช่า ต.ค. 2569' }, lines: [],
    allocations: [{ targetId: 'pb-1', targetType: 'PB', amount: '24075.00' }] },
  // pv-multi: half of pb-2 (12,305.00 of 24,610.00: the services share, SVC 3 % of 9,000.00 = 270.00), 1,000.00 of pb-po (no typed line) and a transport line TRANS 1 % of 1,800.00 = 18.00 -> two WTs
  { id: 'pv-multi', type: 'PV', companyId: VAT, date: '2026-10-14', partyId: 'pv-03', status: 'issued', header: {},
    allocations: [{ targetId: 'pb-2', targetType: 'PB', amount: '12305.00' }, { targetId: 'pb-po', targetType: 'PB', amount: '1000.00' }],
    lines: [line('pv-multi', 1, 'ค่าขนส่งเอกสาร', '1', 'เที่ยว', '1800.00', 'EX', { expenseCategory: 'transport', whtTypeCode: 'TRANS' })] },
  // pv-gross: the freelance photographer, grossed up every time: income 5,154.64, the tax 154.64 is ours, cash = 5,000.00
  { id: 'pv-gross', type: 'PV', companyId: VAT, date: '2026-10-13', partyId: 'pv-09', status: 'issued', header: { whtMode: 'grossup_always' },
    lines: [line('pv-gross', 1, 'ค่าถ่ายภาพสินค้า', '1', 'งาน', '5000.00', 'EX', { itemId: 'EXP-05', expenseCategory: 'services', whtTypeCode: 'SVC' })] },
  // pv-foreign: a software service from Ireland, FOR-SVC grossed up (PND54); the service line feeds PP.36
  { id: 'pv-foreign', type: 'PV', companyId: VAT, date: '2026-10-13', partyId: 'pv-12', status: 'issued', header: { whtMode: 'grossup_always' },
    lines: [line('pv-foreign', 1, 'ค่าบริการซอฟต์แวร์ (ไอร์แลนด์)', '1', 'งาน', '10000.00', 'EX', { expenseCategory: 'services', whtTypeCode: 'FOR-SVC', pnd36: true })] },
  // pv-can: a voucher cancelled after issue - its certificate is cancelled with it
  { id: 'pv-can', type: 'PV', companyId: VAT, date: '2026-10-12', partyId: 'pv-09', status: 'cancelled', header: {},
    lines: [line('pv-can', 1, 'ค่าถ่ายภาพงานอีเวนต์', '1', 'งาน', '3000.00', 'EX', { itemId: 'EXP-05', expenseCategory: 'services', whtTypeCode: 'SVC' })] },
  // non-VAT company: npb-1 (1,070.00, the vendor's VAT is cost) paid in full, no tax withheld
  { id: 'npv-1', type: 'PV', companyId: NV, date: '2026-10-14', partyId: 'nv-03', status: 'issued', header: {}, lines: [],
    allocations: [{ targetId: 'npb-1', targetType: 'PB', amount: '1070.00' }] },
];
