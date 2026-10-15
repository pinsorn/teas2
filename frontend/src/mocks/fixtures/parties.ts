import type { PartySummary } from '@/domain/types';
import { tinCheckDigit } from '@/domain/tin';

export type SeedParty = PartySummary & { companyId: string };

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

function build(companyId: string, prefix: string, kind: 'customer' | 'vendor', raws: Raw[], usual?: (i: number) => string[]): SeedParty[] {
  return raws.map(([name, taxId, vatRegistered, paymentTermDays], i) => ({
    companyId, id: `${prefix}-${pad(i + 1)}`, kind, code: `${kind === 'customer' ? 'C' : 'V'}${pad(i + 1)}`, name, taxId,
    entityKind: entityKindOf(name), ...(taxId ? { branchCode: '00000' } : {}), vatRegistered, address: ADDR[i % ADDR.length], paymentTermDays,
    ...(kind === 'vendor' && vatRegistered ? { defaultWhtTypeCode: 'SVC' } : {}),
    ...(usual ? { usualItemIds: usual(i) } : {}),
  }));
}

export const vatParties = (): SeedParty[] => [
  ...build('co-vat', 'pc', 'customer', VAT_CUSTOMERS, (i) =>
    i === 0 ? ['SV-01'] : [`SV-${pad((i % 9) + 2)}`, `GD-${pad((i % 10) + 1)}`]),
  ...build('co-vat', 'pv', 'vendor', VAT_VENDORS),
];
export const nonVatParties = (): SeedParty[] => [
  ...build('co-nonvat', 'nc', 'customer', NONVAT_CUSTOMERS, (i) => [`nv-GD-${pad((i % 8) + 1)}`]),
  ...build('co-nonvat', 'nv', 'vendor', NONVAT_VENDORS),
];
