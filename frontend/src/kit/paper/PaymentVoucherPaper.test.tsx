import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaperModel } from '@/domain/types';
import { PaymentVoucherPaper } from './PaymentVoucherPaper';

const base: PaperModel = {
  titleTh: 'ใบสำคัญจ่าย', titleEn: 'PAYMENT VOUCHER', copyLabel: 'ต้นฉบับ', number: 'PV-202610-0001', documentDate: '2026-10-14', partyLabel: 'ผู้รับเงิน',
  seller: { name: 'บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด', address: '88/12 ถนนประดิพัทธ์ …', taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่' },
  buyer: { name: 'บริษัท ภูพานกระดาษ จำกัด', address: '…', taxId: '0105569000011', branchLabel: 'สำนักงานใหญ่' },
  lines: [
    { no: 1, description: 'บันทึกซื้อ PB-202610-0001 (เอกสารผู้ขาย INV-2026-1007) ลงวันที่ 6 ต.ค. 2569', qty: '', unit: '', unitPrice: '', amount: '24075.00', taxCode: 'EX' },
    { no: 2, description: 'ค่าขนส่งเอกสาร', qty: '1', unit: 'เที่ยว', unitPrice: '1800.00', amount: '1800.00', taxCode: 'EX' },
  ],
  totals: { gross: '0.00', discount: '0.00', net: '1800.00', vat: '0.00', total: '25875.00', wht: '1143.00', cash: '24732.00', amountInWords: 'สองหมื่นห้าพันแปดร้อยเจ็ดสิบห้าบาทถ้วน' },
  whtLines: [{ label: 'ค่าเช่า 5% (ฐาน 22,500.00)', base: '22500.00', tax: '1125.00' }, { label: 'ค่าขนส่ง 1% (ฐาน 1,800.00)', base: '1800.00', tax: '18.00' }],
  payment: 'โอนเงิน · กสิกรไทย กระแสรายวัน 012-3-45678-9',
  signatures: ['ผู้จัดทำ', 'ผู้ตรวจ', 'ผู้อนุมัติ', 'ผู้รับเงิน'],
};
const rows = (c: HTMLElement) => [...c.querySelectorAll('[data-probe="row"]')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));

describe('PaymentVoucherPaper', () => {
  it('lists the settled bill and the own line, the WHT per type, the payment, and the server totals - reworded for money paid out', () => {
    const { container } = render(<PaymentVoucherPaper model={base} measure={() => 30} />);
    const page = container.querySelector('[data-paper-page]') as HTMLElement;
    expect(page.textContent).toContain('ใบสำคัญจ่าย');
    expect(page.textContent).toContain('PAYMENT VOUCHER');
    const [first, second] = rows(page);
    expect(first.join('|')).toContain('PB-202610-0001');
    expect(first).toContain('24,075.00');
    expect(second).toEqual(expect.arrayContaining(['1', 'เที่ยว', '1,800.00']));
    expect(first).toHaveLength(6); // no WHT column on a voucher
    for (const [label, value] of [['จ่ายเงินสุทธิ', '24,732.00'], ['ภาษีหัก ณ ที่จ่าย', '1,143.00'], ['รวมจ่ายชำระ', '25,875.00'], ['ค่าเช่า 5% (ฐาน 22,500.00)', '1,125.00'], ['ค่าขนส่ง 1% (ฐาน 1,800.00)', '18.00']]) {
      expect(within(page).getAllByText(label).length).toBeGreaterThan(0);
      expect(page.textContent).toContain(value);
    }
    expect(within(page).getByText('วิธีจ่ายเงิน')).toBeInTheDocument();
    expect(within(page).getByText('ผู้รับเงิน', { selector: '.paper-box-h' })).toBeInTheDocument();
    for (const s of base.signatures) expect(within(page).getAllByText(s).length).toBeGreaterThan(0);
    expect(page.textContent).not.toContain('ภาษีมูลค่าเพิ่ม');
    expect(page.textContent).not.toContain('ได้รับยกเว้นภาษี'); // an own line is not a tax-exempt sale
  });
  it('totals come from the model: nothing is summed from the rows', () => {
    const odd = { ...base, totals: { ...base.totals, total: '7777.77', wht: '12.34', cash: '55.55' } };
    const { container } = render(<PaymentVoucherPaper model={odd} measure={() => 30} />);
    const t = container.querySelector('.paper-ft')!.textContent!;
    expect(t).toContain('7,777.77');
    expect(t).toContain('12.34');
    expect(t).toContain('55.55');
    expect(t).not.toContain('25,875.00');
  });
});
