import type { ItemSummary, TaxCode } from '@/domain/types';

export type SeedItem = ItemSummary & { companyId: string };
const pad = (n: number) => String(n).padStart(2, '0');

// [name, unit, unitPrice]
const VAT_SERVICES: [string, string, string][] = [
  ['ออกแบบอัตลักษณ์องค์กร', 'งาน', '60000.00'], ['ออกแบบเว็บไซต์', 'งาน', '85000.00'], ['ออกแบบบรรจุภัณฑ์', 'งาน', '35000.00'],
  ['ถ่ายภาพสินค้า', 'วัน', '12000.00'], ['ที่ปรึกษาการตลาดรายเดือน', 'เดือน', '25000.00'], ['ออกแบบสื่อสิ่งพิมพ์', 'งาน', '18000.00'],
  ['ผลิตวิดีโอโปรโมท', 'งาน', '48000.00'], ['ดูแลเว็บไซต์รายเดือน', 'เดือน', '6500.00'], ['ออกแบบอินโฟกราฟิก', 'ชิ้น', '9500.00'],
  ['อบรมเชิงปฏิบัติการ', 'วัน', '15000.00'],
];
const VAT_GOODS: [string, string, string][] = [
  ['นามบัตร 500 ใบ', 'กล่อง', '450.00'], ['โปสเตอร์ A2', 'แผ่น', '180.00'], ['แฟ้มเอกสารพิมพ์โลโก้', 'เล่ม', '65.00'],
  ['สติกเกอร์ฉลากสินค้า', 'ม้วน', '320.00'], ['ถุงกระดาษพิมพ์ลาย', 'ใบ', '12.50'], ['ปฏิทินตั้งโต๊ะ', 'ชุด', '95.00'],
  ['กล่องบรรจุภัณฑ์พรีเมียม', 'ใบ', '48.00'], ['ป้ายไวนิล 1x3 ม.', 'ผืน', '750.00'], ['เสื้อยืดสกรีนโลโก้', 'ตัว', '210.00'],
  ['สมุดโน้ตปกแข็ง', 'เล่ม', '85.00'],
];
const NV_ITEMS: [string, string, string, 'good' | 'service'][] = [
  ['ข้าวสารหอมมะลิ 5 กก.', 'ถุง', '185.00', 'good'], ['ข้าวสาร 15 กก.', 'ถุง', '420.00', 'good'], ['ข้าวเหนียว 1 กก.', 'ถุง', '48.00', 'good'],
  ['ข้าวกล้องหอมนิล 1 กก.', 'ถุง', '65.00', 'good'], ['น้ำพริกเผา', 'ขวด', '55.00', 'good'], ['ปลาร้าบอง', 'ขวด', '70.00', 'good'],
  ['ไข่เค็มสมุนไพร', 'ฟอง', '9.00', 'good'], ['ผักดองรวม', 'ถุง', '38.00', 'good'], ['บริการจัดเลี้ยงอาหารกล่อง', 'ชุด', '120.00', 'service'],
  ['บริการจัดเลี้ยงโต๊ะจีน', 'โต๊ะ', '8500.00', 'service'], ['บริการขนส่งแช่เย็น', 'เที่ยว', '1500.00', 'service'],
  ['ค่าบรรจุภัณฑ์พิเศษ', 'ชุด', '25.00', 'service'],
];

const SALES = { sales: true, purchase: false };
const mk = (companyId: string, id: string, code: string, name: string, kind: 'good' | 'service', unit: string, unitPrice: string,
  taxCode: TaxCode): SeedItem => ({ companyId, id, code, name, kind, unit, unitPrice, taxCode, usage: SALES, ...(kind === 'service' ? { whtTypeCode: 'SVC' } : {}) });
/** A purchase item: bought, never sold. `wht` is the income type the vendor's payment is withheld under (services only). */
const buy = (companyId: string, id: string, code: string, name: string, kind: 'good' | 'service', unit: string, unitPrice: string,
  taxCode: TaxCode, expenseCategory: string | undefined, wht?: string): SeedItem => ({
  companyId, id, code, name, kind, unit, unitPrice, taxCode, usage: { sales: false, purchase: true },
  ...(wht ? { whtTypeCode: wht } : {}), ...(expenseCategory ? { expenseCategory } : {}) });

export const vatItems = (): SeedItem[] => [
  ...VAT_SERVICES.map(([n, u, p], i) => mk('co-vat', `SV-${pad(i + 1)}`, `SV-${pad(i + 1)}`, n, 'service', u, p, 'S7')),
  ...VAT_GOODS.map(([n, u, p], i) => mk('co-vat', `GD-${pad(i + 1)}`, `GD-${pad(i + 1)}`, n, 'good', u, p, 'S7')),
  buy('co-vat', 'EXP-01', 'EXP-01', 'ค่าเช่าสำนักงาน', 'service', 'เดือน', '25000.00', 'S7', 'rent', 'RENT'),
  buy('co-vat', 'EXP-02', 'EXP-02', 'ค่าบริการทำความสะอาด', 'service', 'เดือน', '8500.00', 'S7', 'services', 'SVC'),
  buy('co-vat', 'EXP-03', 'EXP-03', 'ค่าโฆษณาออนไลน์', 'service', 'เดือน', '12000.00', 'S7', 'advertising', 'ADS'),
  buy('co-vat', 'EXP-04', 'EXP-04', 'ค่าขนส่ง', 'service', 'เที่ยว', '1800.00', 'S7', 'transport', 'TRANS'),
  buy('co-vat', 'EXP-05', 'EXP-05', 'ค่าถ่ายภาพสินค้า', 'service', 'งาน', '5000.00', 'S7', 'services', 'SVC'),
  buy('co-vat', 'EXP-06', 'EXP-06', 'กระดาษ A4', 'good', 'รีม', '115.00', 'S7', 'supplies'),
  // input VAT on entertainment is not recoverable: that lives on the category (recoverableVat false), the item stays S7
  buy('co-vat', 'EXP-07', 'EXP-07', 'ค่ารับรองลูกค้า', 'service', 'ครั้ง', '4500.00', 'S7', 'entertainment'),
  buy('co-vat', 'EXP-08', 'EXP-08', 'เครื่องคอมพิวเตอร์โน้ตบุ๊ก', 'good', 'เครื่อง', '32000.00', 'S7', 'capex-equipment'),
];
export const nonVatItems = (): SeedItem[] => {
  let g = 0, s = 0;
  return [
    ...NV_ITEMS.map(([n, u, p, k]) => {
      const code = k === 'good' ? `GD-${pad(++g)}` : `SV-${pad(++s)}`;
      return mk('co-nonvat', `nv-${code}`, code, n, k, u, p, 'EX');
    }),
    buy('co-nonvat', 'nv-EXP-01', 'EXP-01', 'ค่าเช่าแผงตลาด', 'service', 'เดือน', '3000.00', 'EX', 'rent', 'RENT'),
    buy('co-nonvat', 'nv-EXP-02', 'EXP-02', 'ข้าวเปลือก', 'good', 'กก.', '12.00', 'EX', 'cost-of-sales'),
    buy('co-nonvat', 'nv-EXP-03', 'EXP-03', 'ค่าก๊าซหุงต้ม', 'good', 'ถัง', '450.00', 'EX', undefined),
  ];
};
