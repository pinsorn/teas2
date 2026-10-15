import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaperModel } from '@/domain/types';
import { ReceiptPaper } from './ReceiptPaper';

const base: PaperModel = {
  titleTh: 'ใบเสร็จรับเงิน', titleEn: 'RECEIPT', copyLabel: 'ต้นฉบับ', number: 'RC-202610-0007', documentDate: '2026-10-14',
  seller: { name: 'บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด', address: '88/12 ถนนประดิพัทธ์ …', taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่' },
  buyer: { name: 'บริษัท นาวาพาณิชย์ จำกัด', address: '…', taxId: '0105568024684', branchLabel: 'สำนักงานใหญ่' },
  lines: [
    { no: 1, description: 'ใบกำกับภาษี TI-202601-0003 ลงวันที่ 13 ม.ค. 2569', qty: '', unit: '', unitPrice: '', amount: '1000.00', taxCode: 'EX', wht: '30.00' },
    { no: 2, description: 'ใบกำกับภาษี TI-202503-0003 ลงวันที่ 14 มี.ค. 2568', qty: '', unit: '', unitPrice: '', amount: '500.00', taxCode: 'EX' },
  ],
  totals: { gross: '0.00', discount: '0.00', net: '0.00', vat: '0.00', total: '1500.00', wht: '30.00', cash: '1470.00', amountInWords: 'หนึ่งพันห้าร้อยบาทถ้วน' },
  payment: 'โอนเงิน · กสิกรไทย กระแสรายวัน 012-3-45678-9',
  signatures: ['ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'],
};
const rows = (c: HTMLElement) => [...c.querySelectorAll('[data-probe="row"]')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));

describe('ReceiptPaper', () => {
  it('lists each settled invoice with its amount and WHT, and prints RECEIPT, the payment and the three server totals', () => {
    const { container } = render(<ReceiptPaper model={base} measure={() => 30} />);
    const page = container.querySelector('[data-paper-page]') as HTMLElement;
    expect(page.textContent).toContain('ใบเสร็จรับเงิน');
    expect(page.textContent).toContain('RECEIPT');
    const [first, second] = rows(page);
    expect(first.join('|')).toContain('TI-202601-0003');
    expect(first).toContain('1,000.00');
    expect(first).toContain('30.00');
    expect(second.join('|')).toContain('TI-202503-0003');
    expect(second).toContain('500.00');
    expect(second.at(-1)).toBe(''); // no WHT withheld on the second invoice: nothing printed, not "0.00"
    expect(within(page).getByText('โอนเงิน · กสิกรไทย กระแสรายวัน 012-3-45678-9')).toBeInTheDocument();
    for (const [label, value] of [['รับเงินสุทธิ', '1,470.00'], ['ภาษีถูกหัก ณ ที่จ่าย', '30.00'], ['รวมรับชำระ', '1,500.00']]) {
      expect(within(page).getAllByText(label).length).toBeGreaterThan(0);
      expect(page.textContent).toContain(value);
    }
    expect(page.textContent).toContain('หนึ่งพันห้าร้อยบาทถ้วน');
    expect(page.textContent).not.toContain('ภาษีมูลค่าเพิ่ม'); // a receipt carries no VAT rows
    expect(page.textContent).not.toContain('ได้รับยกเว้นภาษี'); // a settled invoice row is not a tax-exempt sale
  });
  it('totals come from the model: nothing is summed from the rows', () => {
    const odd = { ...base, totals: { ...base.totals, total: '7777.77', wht: '12.34', cash: '55.55' } };
    const { container } = render(<ReceiptPaper model={odd} measure={() => 30} />);
    const t = container.querySelector('.paper-ft')!.textContent!;
    expect(t).toContain('7,777.77');
    expect(t).toContain('12.34');
    expect(t).toContain('55.55');
    expect(t).not.toContain('1,500.00'); // the rows' sum is never offered
  });
  it('a non-VAT cash bill prints its lines with quantity and price', () => {
    const cash: PaperModel = { ...base, lines: [
      { no: 1, description: 'ค่าเช่าแผงชั่วคราวรายวัน', qty: '2', unit: 'วัน', unitPrice: '350.00', amount: '700.00', taxCode: 'EX' },
      { no: 2, description: 'ค่าไฟฟ้าแผง', qty: '1', unit: 'งาน', unitPrice: '150.00', amount: '150.00', taxCode: 'EX' }],
      totals: { ...base.totals, total: '850.00', wht: '0.00', cash: '850.00', amountInWords: 'แปดร้อยห้าสิบบาทถ้วน' } };
    const { container } = render(<ReceiptPaper model={cash} measure={() => 30} />);
    const [a] = rows(container);
    expect(a.join('|')).toContain('ค่าเช่าแผงชั่วคราวรายวัน');
    expect(a).toEqual(expect.arrayContaining(['2', 'วัน', '350.00', '700.00']));
    expect(container.textContent).toContain('แปดร้อยห้าสิบบาทถ้วน');
  });
  it('a cancelled receipt is stamped on every page and many settled invoices paginate with the footer on the last page only', () => {
    const many = { ...base, voidMark: { label: 'ยกเลิก', note: 'คีย์ผิด' }, lines: Array.from({ length: 60 }, (_, i) => ({ ...base.lines[1], no: i + 1, description: `ใบกำกับภาษี TI-${i + 1}` })) };
    const { container } = render(<ReceiptPaper model={many} measure={() => 30} />);
    const pages = container.querySelectorAll('[data-paper-page]');
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((p, i) => {
      expect(p.querySelector('[data-paper-void]')?.textContent).toContain('ยกเลิก');
      expect(p.textContent?.includes('รวมรับชำระ')).toBe(i === pages.length - 1);
    });
  });
});
