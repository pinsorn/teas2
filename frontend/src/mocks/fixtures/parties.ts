import type { PartySummary } from '@/domain/types';
import { tinCheckDigit } from '@/domain/tin';

/** `active` (default true) and `version` (default 1) belong to the master record, not to the snapshot a document keeps. */
export type SeedParty = PartySummary & { companyId: string; active?: boolean; version?: number };

/** Fictional TIN with a correct check digit. */
const tin = (first12: string) => first12 + tinCheckDigit(first12);
const corpTin = (n: number) => tin('0105' + String(5600000 + n * 13711).padStart(8, '0'));
const pad = (n: number) => String(n).padStart(2, '0');

const ADDR = ['12 ถนนสุขุมวิท กรุงเทพมหานคร 10110', '99/4 ถนนรัชดาภิเษก กรุงเทพมหานคร 10400', '55 ถนนนิมมานเหมินท์ เชียงใหม่ 50200',
  '7/8 ถนนมิตรภาพ ขอนแก่น 40000', '301 ถนนเพชรเกษม หาดใหญ่ สงขลา 90110', '18 ถนนสุขสวัสดิ์ สมุทรปราการ 10130'];

// [name, taxId | undefined, vatRegistered, paymentTermDays]
type Raw = [string, string | undefined, boolean, number];

const VAT_CUSTOMERS: Raw[] = [
  ['บริษัท นาวาพาณิชย์ จำกัด', '0105568024684', true, 30],
  ['บริษัท ปิ่นทองการพิมพ์ จำกัด', '0105565077124', true, 30],
  ['ห้างหุ้นส่วนจำกัด สมบูรณ์ค้าไม้', undefined, true, 15],
  ['บริษัท ศรีสยามเฟอร์นิเจอร์ จำกัด', corpTin(4), true, 45],
  ['บริษัท อรุณโภชนา จำกัด', corpTin(5), true, 30],
  ['บริษัท กรีนลีฟ เทรดดิ้ง จำกัด', corpTin(6), true, 60],
  ['บริษัท เจริญทรัพย์ลอจิสติกส์ จำกัด', corpTin(7), true, 30],
  ['บริษัท ไทยพัฒนาก่อสร้าง จำกัด', corpTin(8), true, 15],
  ['คุณวิชัย ใจดี', tin('310050012345'), false, 7],
  ['คุณพรทิพย์ สุขสวัสดิ์', tin('310050067890'), false, 7],
  ['Northwind Studio Pte. Ltd. (สิงคโปร์)', undefined, false, 30],
  ['กองทุนพัฒนาท้องถิ่นตัวอย่าง (หน่วยงานรัฐ)', tin('099400012345'), false, 60],
];
const VAT_VENDORS: Raw[] = [
  'บริษัท ภูพานกระดาษ จำกัด', 'บริษัท สยามอิงค์เจ็ท จำกัด', 'ห้างหุ้นส่วนจำกัด พิมพ์ดีแพ็คเกจ', 'บริษัท คลาวด์โฮสต์ไทย จำกัด',
  'บริษัท ฟรีแลนซ์พลัส จำกัด', 'บริษัท สตูดิโอแสงทอง จำกัด', 'บริษัท ขนส่งด่วนรวดเร็ว จำกัด', 'บริษัท อาคารสำนักงานปทุมวัน จำกัด',
  'บริษัท ไอทีซัพพอร์ตเซอร์วิส จำกัด', 'บริษัท เครื่องเขียนอเนกประสงค์ จำกัด',
].map((n, i): Raw => [n, corpTin(30 + i), true, 30]);

const NONVAT_CUSTOMERS: Raw[] = [
  'ร้านอาหารครัวริมคลอง', 'โรงเรียนอนุบาลดอกไม้', 'คุณสมชาย รักษ์ไทย', 'ตลาดสดเทศบาลนนทบุรี', 'ร้านกาแฟมุมสงบ',
  'บริษัท เอกชัยค้าส่ง จำกัด', 'คุณนิภา แสงจันทร์', 'โรงพยาบาลชุมชนบางกรวย',
].map((n, i): Raw => [n, i % 3 === 0 ? undefined : corpTin(60 + i), false, 15]);
const NONVAT_VENDORS: Raw[] = [
  'ฟาร์มข้าวสุพรรณ', 'สหกรณ์การเกษตรบางบัวทอง', 'ร้านวัสดุก่อสร้างทรัพย์เจริญ', 'บริษัท แพ็คเกจจิ้งไทย จำกัด',
  'ฟาร์มผักปลอดสารพิษ', 'ร้านก๊าซสุขใจ',
].map((n, i): Raw => [n, corpTin(80 + i), i % 2 === 0, 30]);

/** Individuals carry the title คุณ; Northwind Studio is the foreign payee; everyone else is a juristic person. */
const entityKindOf = (name: string): PartySummary['entityKind'] => (name.startsWith('คุณ') ? 'individual' : name.startsWith('Northwind') ? 'foreign' : 'juristic');

const BANKS = ['ธนาคารกรุงเทพ', 'ธนาคารกสิกรไทย', 'ธนาคารไทยพาณิชย์', 'ธนาคารกรุงไทย', 'ธนาคารกรุงศรีอยุธยา'];
const groupOf = (kind: 'customer' | 'vendor', name: string, i: number): string =>
  name.startsWith('Northwind') ? 'foreign' : name.includes('หน่วยงานรัฐ') ? 'government' : kind === 'customer' && i < 3 ? 'major' : 'general';

/** Vendors carry remittance details (fictional banks and numbers) for the first `withBank` of them. */
function build(companyId: string, prefix: string, kind: 'customer' | 'vendor', raws: Raw[], usual?: (i: number) => string[], withBank = 0): SeedParty[] {
  return raws.map(([name, taxId, vatRegistered, paymentTermDays], i) => ({
    companyId, id: `${prefix}-${pad(i + 1)}`, kind, code: `${kind === 'customer' ? 'C' : 'V'}${pad(i + 1)}`, name, taxId,
    entityKind: entityKindOf(name), ...(taxId ? { branchCode: '00000' } : {}), vatRegistered, address: ADDR[i % ADDR.length], paymentTermDays,
    ...(kind === 'vendor' && vatRegistered ? { defaultWhtTypeCode: 'SVC' } : {}),
    ...(usual ? { usualItemIds: usual(i) } : {}),
    partyGroup: groupOf(kind, name, i),
    contact: { email: `${kind === 'customer' ? 'ar' : 'ap'}${pad(i + 1)}@${companyId === 'co-vat' ? 'example.test' : 'example.invalid'}` },
    ...(kind === 'vendor' && i < withBank
      ? { bankAccount: { bankName: BANKS[i % BANKS.length], accountNo: `${100 + i}-${i % 9}-${String(40000 + i * 137).padStart(5, '0')}-${i % 7}`, accountName: name } } : {}),
  }));
}

/** Parties for the master-data screens, appended after the document seed's pools (documents never pick them: inactive, or a vendor). */
const extras = (): SeedParty[] => [
  { companyId: 'co-vat', id: 'pc-13', kind: 'customer', code: 'C13', name: 'บริษัท เลิกกิจการ ตัวอย่าง จำกัด', taxId: corpTin(13), branchCode: '00000', vatRegistered: true,
    address: ADDR[0], paymentTermDays: 30, entityKind: 'juristic', partyGroup: 'general', active: false, version: 1 },
  { companyId: 'co-nonvat', id: 'nc-09', kind: 'customer', code: 'C09', name: 'ร้านปิดตัวชั่วคราว', vatRegistered: false, address: ADDR[2], paymentTermDays: 7,
    entityKind: 'juristic', partyGroup: 'general', active: false, version: 1 },
  { companyId: 'co-vat', id: 'pv-12', kind: 'vendor', code: 'V12', name: 'Cloudberry Software Ltd. (ไอร์แลนด์)', vatRegistered: false, vatDRegistered: false,
    address: '1 Grand Canal Quay, Dublin, Ireland', paymentTermDays: 30, entityKind: 'foreign', partyGroup: 'foreign', defaultWhtTypeCode: 'FOR-SVC',
    contact: { email: 'billing@cloudberry.example.test' }, bankAccount: { bankName: 'Example Bank Ireland', accountNo: 'IE00 EXMP 9900 1234 5678 90', accountName: 'Cloudberry Software Ltd.' }, version: 1 },
  // FN3 netting: the printer pc-02 is also our vendor (the same company, linked both ways); AR and AP of the pair can be offset
  { companyId: 'co-vat', id: 'pv-11', kind: 'vendor', code: 'V11', name: 'บริษัท ปิ่นทองการพิมพ์ จำกัด (ผู้ขาย)', taxId: '0105565077124', branchCode: '00000', vatRegistered: true, address: ADDR[1],
    paymentTermDays: 30, entityKind: 'juristic', partyGroup: 'general', linkedPartyId: 'pc-02', contact: { email: 'ap11@example.test' }, version: 1 },
];

/** Party fixtures the master-data screens and tests name. `vendorForeign` is pv-12; pv-11 (FN3) is the vendor side of customer pc-02, linked both ways for netting. */
export const PARTY_FIXTURES = { customerVat: 'pc-01', customerIndividual: 'pc-09', customerInactive: 'pc-13', customerInactiveNonVat: 'nc-09', vendorForeign: 'pv-12' } as const;

/** pv-09 is the S3 payment-voucher payee (D-15): an individual who is not VAT-registered, paid 5,000.00 for a photo shoot with 3 % withheld. */
const photographer = (p: SeedParty): SeedParty => ({
  ...p, name: 'คุณอนันต์ ภาพดี (ช่างภาพอิสระ)', taxId: tin('310060011122'), entityKind: 'individual', vatRegistered: false, defaultWhtTypeCode: 'SVC', usualItemIds: ['EXP-05'],
});

export const vatParties = (): SeedParty[] => [
  ...build('co-vat', 'pc', 'customer', VAT_CUSTOMERS, (i) =>
    i === 0 ? ['SV-01'] : [`SV-${pad((i % 9) + 2)}`, `GD-${pad((i % 10) + 1)}`]).map((p) => (p.id === 'pc-02' ? { ...p, linkedPartyId: 'pv-11' } : p)),
  ...build('co-vat', 'pv', 'vendor', VAT_VENDORS, undefined, 8).map((p) => (p.id === 'pv-09' ? photographer(p) : p)),
  ...extras().filter((p) => p.companyId === 'co-vat'),
];
export const nonVatParties = (): SeedParty[] => [
  ...build('co-nonvat', 'nc', 'customer', NONVAT_CUSTOMERS, (i) => [`nv-GD-${pad((i % 8) + 1)}`]),
  ...build('co-nonvat', 'nv', 'vendor', NONVAT_VENDORS, undefined, 5),
  ...extras().filter((p) => p.companyId === 'co-nonvat'),
];
