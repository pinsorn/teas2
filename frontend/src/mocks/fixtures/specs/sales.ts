import type { Allocation, DocHeader, DocLine, MarkKey } from '@/domain/types';
import { cancel } from '../../engine/commands';
import { closeRemainder, setMark } from '../../engine/marks';
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
/** A receipt of the non-VAT company settling part / all of one invoice. Every seeded receipt names the account it posts to (a correction's reissue keeps it). */
const BANK = { VAT: 'ba-kbank', NV: 'nba-kbank' };
const pay = (id: string, party: string, date: string, iv: string, amount: string): SeedSpec =>
  ({ id, type: 'RC', companyId: NV, date, partyId: party, status: 'issued', lines: [], header: { paymentMethod: 'transfer', bankAccountId: BANK.NV },
    allocations: [{ targetId: iv, targetType: 'IV', amount }] as Allocation[] });
/** S4 receipt of the VAT company: transfer into the main account. */
const rc = (id: string, party: string, date: string, allocations: Allocation[], header: Partial<DocHeader> = {}): SeedSpec =>
  ({ id, type: 'RC', companyId: VAT, date, partyId: party, status: 'issued', lines: [], header: { paymentMethod: 'transfer', bankAccountId: BANK.VAT, ...header }, allocations });

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

  // ---- S2: sales orders and delivery orders ----
  { id: 'so-d1', type: 'SO', companyId: VAT, date: '2026-10-10', partyId: 'pc-02', status: 'draft', header: due('2026-10-31'),
    lines: [line('so-d1', 1, 'ออกแบบบรรจุภัณฑ์', '1', 'งาน', '35000.00')] },
  { id: 'so-part', type: 'SO', companyId: VAT, date: '2026-10-10', partyId: 'pc-04', status: 'issued', header: due('2026-10-31'), // 30 units ordered, 10 delivered
    lines: [line('so-part', 1, 'โปสเตอร์ A2', '20', 'แผ่น', '180.00'), line('so-part', 2, 'ปฏิทินตั้งโต๊ะ', '10', 'ชุด', '95.00')] },
  { id: 'do-part', type: 'DO', companyId: VAT, date: '2026-10-11', status: 'issued', lines: [], convertFrom: { id: 'so-part', lines: [{ sourceLineId: 'so-part-l1', qty: '10' }] } },
  { id: 'so-closed', type: 'SO', companyId: VAT, date: '2026-10-10', partyId: 'pc-08', status: 'issued', header: due('2026-10-25'),
    lines: [line('so-closed', 1, 'นามบัตร 500 ใบ', '10', 'กล่อง', '450.00'), line('so-closed', 2, 'แฟ้มเอกสารพิมพ์โลโก้', '5', 'เล่ม', '65.00')],
    after: (st) => { closeRemainder(st, 'so-closed', st.docs.find((d) => d.id === 'so-closed')!.version, 'ลูกค้าขอยกเลิกส่วนที่เหลือ', USER); } },
  // so-u1 is an existing seed SO (one line of 2 เดือน): delivered in full
  { id: 'do-dlv', type: 'DO', companyId: VAT, date: '2026-10-12', status: 'issued', lines: [], convertFrom: { id: 'so-u1', lines: [{ sourceLineId: 'so-u1-l1', qty: '2' }] },
    after: mark('do-dlv', 'delivered') },
  { id: 'nso-1', type: 'SO', companyId: NV, date: '2026-10-08', status: 'issued', lines: [], header: due('2026-10-20'),
    convertFrom: { id: 'nqt-2', lines: [{ sourceLineId: 'nqt-2-l1', qty: '20' }, { sourceLineId: 'nqt-2-l2', qty: '40' }] } },
  { id: 'ndo-1', type: 'DO', companyId: NV, date: '2026-10-09', status: 'issued', lines: [], convertFrom: { id: 'nso-1', lines: [{ sourceLineId: 'nso-1-l1', qty: '20' }, { sourceLineId: 'nso-1-l2', qty: '40' }] },
    after: mark('ndo-1', 'delivered') },

  // ---- S3: non-VAT invoices (IV, L-class, no VAT whatever the tax code) and billing statements (BL) ----
  { id: 'iv-d1', type: 'IV', companyId: NV, date: '2026-10-12', partyId: 'nc-01', status: 'draft', header: due('2026-10-27'),
    lines: [line('iv-d1', 1, 'บริการจัดเลี้ยงอาหารกล่อง', '20', 'ชุด', '120.00', 'EX')] },
  { id: 'iv-1', type: 'IV', companyId: NV, date: '2026-10-01', partyId: 'nc-01', status: 'issued', header: due('2026-10-16'),
    lines: [line('iv-1', 1, 'บริการจัดเลี้ยงอาหารกล่อง', '40', 'ชุด', '120.00', 'EX')] },
  { id: 'iv-2', type: 'IV', companyId: NV, date: '2026-10-02', partyId: 'nc-03', status: 'issued', header: due('2026-10-17'), // an S7 code on a non-VAT company: VAT stays 0.00 (I1)
    lines: [line('iv-2', 1, 'ค่าที่ปรึกษาด้านบัญชี', '1', 'งาน', '2500.00', 'S7')] },
  { id: 'iv-3', type: 'IV', companyId: NV, date: '2026-10-03', partyId: 'nc-06', status: 'issued', header: due('2026-10-18'),
    lines: [line('iv-3', 1, 'ข้าวสารหอมมะลิ 5 กก.', '30', 'ถุง', '185.00', 'EX'), line('iv-3', 2, 'น้ำพริกเผา', '12', 'ขวด', '55.00', 'EX')] },
  { id: 'iv-4', type: 'IV', companyId: NV, date: '2026-10-05', partyId: 'nc-01', status: 'issued', header: due('2026-10-20'),
    lines: [line('iv-4', 1, 'บริการจัดเลี้ยงงานเลี้ยงรุ่น', '10', 'โต๊ะ', '300.00', 'EX')] },
  { id: 'iv-p1', type: 'IV', companyId: NV, date: '2026-09-20', partyId: 'nc-02', status: 'issued', header: { ...due('2026-10-05'), dimensions: { project: 'P-A' } }, // 8,000.00, 3,000.00 received, overdue
    lines: [line('iv-p1', 1, 'ค่าอาหารกลางวันนักเรียน (ภาคเรียน)', '2', 'งวด', '4000.00', 'EX')] },
  { id: 'iv-p2', type: 'IV', companyId: NV, date: '2026-09-22', partyId: 'nc-04', status: 'issued', header: { ...due('2026-10-07'), dimensions: { project: 'P-B' } }, // 6,000.00, 2,500.00 received, overdue
    lines: [line('iv-p2', 1, 'ค่าเช่าแผงตลาดประจำเดือน', '1', 'เดือน', '6000.00', 'EX')] },
  pay('rc-ivp1', 'nc-02', '2026-09-25', 'iv-p1', '3000.00'),
  pay('rc-ivp2', 'nc-04', '2026-09-28', 'iv-p2', '2500.00'),
  { id: 'iv-s1', type: 'IV', companyId: NV, date: '2026-09-18', partyId: 'nc-05', status: 'issued', header: { ...due('2026-10-03'), dimensions: { project: 'P-A' } }, // RP1: three invoices carry a project, so the reports have dimension columns to show
    lines: [line('iv-s1', 1, 'เมล็ดกาแฟคั่ว 1 กก.', '5', 'ถุง', '400.00', 'EX')] },
  pay('rc-ivs1', 'nc-05', '2026-09-24', 'iv-s1', '2000.00'),
  { id: 'iv-s2', type: 'IV', companyId: NV, date: '2026-09-19', partyId: 'nc-02', status: 'issued', header: due('2026-10-04'),
    lines: [line('iv-s2', 1, 'ค่าอาหารว่างประชุมผู้ปกครอง', '3', 'ชุด', '500.00', 'EX')] },
  pay('rc-ivs2', 'nc-02', '2026-09-26', 'iv-s2', '1500.00'),
  { id: 'iv-can', type: 'IV', companyId: NV, date: '2026-09-30', partyId: 'nc-03', status: 'cancelled', header: due('2026-10-15'),
    lines: [line('iv-can', 1, 'ค่าที่ปรึกษาด้านบัญชี', '1', 'งาน', '900.00', 'EX')] },
  // billing statements: the grouped amounts are the targets' outstanding at issue (server-read); a BL posts nothing
  { id: 'nbl-1', type: 'BL', companyId: NV, date: '2026-10-06', partyId: 'nc-01', status: 'issued', header: due('2026-10-21'), lines: [],
    allocations: [{ targetId: 'iv-1', targetType: 'IV', amount: '0.00' }, { targetId: 'iv-4', targetType: 'IV', amount: '0.00' }] },
  { id: 'bl-1', type: 'BL', companyId: VAT, date: '2026-10-10', partyId: 'pc-01', status: 'issued', header: due('2026-10-31'), lines: [],
    allocations: [{ targetId: 'spike-60', targetType: 'TI', amount: '0.00' }, { targetId: 'ti-057', targetType: 'TI', amount: '0.00' }] },

  // ---- S4: receipts. The VAT company settles invoices only; the non-VAT company may also sell over the counter (cash bill) ----
  // rc-multi settles pc-01's two OTHER open invoices (the BL-grouped ti-057 / spike-60): rcTargetsA / rcTargetsB stay untouched for the e2e that settles them.
  rc('rc-multi', 'pc-01', '2026-10-12', [
    { targetId: 'ti-057', targetType: 'TI', amount: '1000.00', wht: '30.00', whtTypeCode: 'SVC', certNumber: 'ท.2569/0451' }, // [SP-R] mock WHT type, not a ruled rate
    { targetId: 'spike-60', targetType: 'TI', amount: '500.00' }]),
  rc('rc-nocert', 'pc-06', '2026-10-13', [{ targetId: 'ti-037', targetType: 'TI', amount: '10000.00', wht: '300.00', whtTypeCode: 'SVC' }]), // withheld, no certificate yet (TX2 chase list)
  rc('rc-dep', 'pc-08', '2026-10-13', [], { depositAmount: '5000.00' }), // paid in advance: nothing to allocate
  // ---- S5: credit and debit notes, through the engine. Each names the seeded invoice it adjusts (a TI nothing else touches: not the fixture invoices of S1-S4) ----
  { id: 'cn-ret', type: 'CN', companyId: VAT, date: '2026-10-09', partyId: 'pc-06', status: 'issued', header: { refDocId: 'ti-056', reasonCode: 'RETURN' }, // 8,000.00 off line 1, 4 of line 2's 10 units back
    lines: [{ ...line('cn-ret', 1, 'ลดราคาค่าบริการตามใบกำกับภาษีเดิม', '1', 'งาน', '8000.00'), sourceLineId: 'ti-056-l1' },
      { ...line('cn-ret', 2, 'รับคืนสินค้า 4 หน่วย', '4', 'หน่วย', '95.00'), sourceLineId: 'ti-056-l2' }] },
  { id: 'dn-1', type: 'DN', companyId: VAT, date: '2026-10-10', partyId: 'pc-12', status: 'issued', header: { refDocId: 'ti-047', reasonCode: 'PRICE_INCREASE' },
    lines: [{ ...line('dn-1', 1, 'ปรับราคาค่าบริการเพิ่มตามสัญญา', '1', 'งาน', '500.00'), sourceLineId: 'ti-047-l1' }] },
  { id: 'cn-full', type: 'CN', companyId: VAT, date: '2026-10-11', partyId: 'pc-07', status: 'issued', header: { refDocId: 'ti-046', reasonCode: 'OTHER', reasonText: 'ลูกค้ายกเลิกสัญญา ลดหนี้เต็มจำนวน' }, // an unpaid invoice credited to 0.00: it stays issued
    lines: [{ ...line('cn-full', 1, 'ลดหนี้เต็มจำนวน รายการที่ 1', '1', 'งาน', '6500.00'), discountPct: '10', sourceLineId: 'ti-046-l1' },
      { ...line('cn-full', 2, 'ลดหนี้เต็มจำนวน รายการที่ 2', '10', 'หน่วย', '48.00'), discountPct: '10', sourceLineId: 'ti-046-l2' }] },
  { id: 'nrc-cash', type: 'RC', companyId: NV, date: '2026-10-13', partyId: 'nc-04', status: 'issued', header: { paymentMethod: 'transfer', bankAccountId: BANK.NV },
    lines: [line('nrc-cash', 1, 'ค่าเช่าแผงชั่วคราวรายวัน', '2', 'วัน', '350.00', 'EX'), line('nrc-cash', 2, 'ค่าไฟฟ้าแผง', '1', 'งาน', '150.00', 'EX')] },
  // TX3b G1: five wholesale cash bills (Mar-Jul 2026) take the non-VAT company's last 12 months of sales to 1,530,000.00 = 85.00 % of the 1,800,000.00 threshold
  ...[['03', 'nc-01'], ['04', 'nc-02'], ['05', 'nc-03'], ['06', 'nc-05'], ['07', 'nc-06']].map(([m, party]): SeedSpec =>
    ({ id: `nrc-w${m}`, type: 'RC', companyId: NV, date: `2026-${m}-10`, partyId: party, status: 'issued', header: { paymentMethod: 'transfer', bankAccountId: BANK.NV }, lines: [line(`nrc-w${m}`, 1, 'ขายส่งสินค้าเงินสด', '1', 'งาน', '299028.00', 'EX')] })),
];
