import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaperModel } from '@/domain/types';
import { AdjustmentNotePaper } from './AdjustmentNotePaper';

const base: PaperModel = {
  titleTh: 'ใบลดหนี้', titleEn: 'CREDIT NOTE', copyLabel: 'ต้นฉบับ', number: 'CN-202610-0003', documentDate: '2026-10-14',
  seller: { name: 'บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด', address: '88/12 ถนนประดิพัทธ์ …', taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่' },
  buyer: { name: 'บริษัท นาวาพาณิชย์ จำกัด', address: '…', taxId: '0105568024684', branchLabel: 'สำนักงานใหญ่' },
  lines: [{ no: 1, description: 'รับคืนสินค้า 4 หน่วย', qty: '4', unit: 'หน่วย', unitPrice: '95.00', amount: '380.00', taxCode: 'S7' }],
  totals: { gross: '380.00', discount: '0.00', net: '380.00', vat: '26.60', total: '406.60', amountInWords: 'สี่ร้อยหกบาทหกสิบสตางค์' },
  vatLines: [{ label: 'ภาษีมูลค่าเพิ่ม 7%', amount: '26.60' }],
  adjusts: { number: 'TI-202605-0005', date: '2026-05-26', originalNet: '48950.00', correctNet: '48570.00', diffNet: '380.00', reason: 'รับคืนสินค้า / สินค้าชำรุด' },
  signatures: ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'],
};
const first = (c: HTMLElement) => c.querySelector('[data-paper-page]') as HTMLElement;

describe('AdjustmentNotePaper (ม.86/10)', () => {
  it('prints the title, the invoice adjusted, the reason as Thai text, and the original / correct / difference values from the model', () => {
    const { container } = render(<AdjustmentNotePaper model={base} measure={() => 30} />);
    const page = first(container);
    expect(page.textContent).toContain('ใบลดหนี้');
    expect(page.textContent).toContain('CREDIT NOTE');
    const box = within(page).getByLabelText('อ้างอิงใบกำกับภาษีเดิม');
    expect(box.textContent).toContain('TI-202605-0005');
    expect(box.textContent).toContain('26 พ.ค. 2569');
    expect(box.textContent).toContain('รับคืนสินค้า / สินค้าชำรุด');
    for (const [label, value] of [['มูลค่าตามใบกำกับภาษีเดิม', '48,950.00'], ['มูลค่าที่ถูกต้อง', '48,570.00'], ['ผลต่าง', '380.00']]) {
      expect(box.textContent).toContain(label);
      expect(box.textContent).toContain(value);
    }
    expect(page.textContent).toContain('26.60'); // VAT on the difference: the document's own
    expect(page.textContent).not.toMatch(/RETURN|PRICE_REDUCTION/); // never a raw code
    expect(page.textContent).toContain('0105568024684'); // the buyer's tax identity
    expect(page.textContent).toContain('0105569012345'); // and the seller's
  });
  it('nothing is summed on the client: the difference is the model\'s even when it does not equal original - correct', () => {
    const odd = { ...base, adjusts: { ...base.adjusts!, correctNet: '1.11', diffNet: '123.45' } };
    const { container } = render(<AdjustmentNotePaper model={odd} measure={() => 30} />);
    const box = within(first(container)).getByLabelText('อ้างอิงใบกำกับภาษีเดิม');
    expect(box.textContent).toContain('123.45');
    expect(box.textContent).toContain('1.11');
    expect(box.textContent).not.toContain('48,570.00'); // neither original - difference nor original - correct is worked out here
    expect(box.textContent).not.toContain('380.00');
  });
  it('the reference block repeats on every page of a long note', () => {
    const many = { ...base, lines: Array.from({ length: 60 }, (_, i) => ({ ...base.lines[0], no: i + 1 })) };
    const { container } = render(<AdjustmentNotePaper model={many} measure={() => 30} />);
    const pages = container.querySelectorAll('[data-paper-page]');
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((p) => expect(within(p as HTMLElement).getByLabelText('อ้างอิงใบกำกับภาษีเดิม')).toBeInTheDocument());
  });
});
