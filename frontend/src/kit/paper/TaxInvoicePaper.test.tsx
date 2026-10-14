import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaperModel } from '@/domain/types';
import { TaxInvoicePaper } from './TaxInvoicePaper';

const model = (n: number): PaperModel => ({
  titleTh: 'ใบกำกับภาษี', titleEn: 'TAX INVOICE', copyLabel: 'ต้นฉบับ', number: 'TI-202610-0001', documentDate: '2026-10-14',
  seller: { name: 'บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด', address: '88/12 ถนนประดิพัทธ์ …', taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่' },
  buyer: { name: 'บริษัท นาวาพาณิชย์ จำกัด', address: '…', taxId: '0105568024684', branchLabel: 'สำนักงานใหญ่' },
  lines: Array.from({ length: n }, (_, i) => ({ no: i + 1, description: `รายการ ${i + 1}`, qty: '1', unit: 'งาน', unitPrice: '100.00', amount: '100.00', taxCode: 'S7' as const })),
  totals: { gross: '100.00', discount: '0.00', net: '100.00', vat: '7.00', total: '107.00', amountInWords: 'หนึ่งร้อยเจ็ดบาทถ้วน' },
  vatLines: [{ label: 'ภาษีมูลค่าเพิ่ม 7%', amount: '7.00' }],
  signatures: ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'],
});

describe('TaxInvoicePaper (ม.86/4)', () => {
  it('shows the statutory elements', () => {
    render(<TaxInvoicePaper model={model(1)} measure={() => 30} />);
    for (const t of ['ใบกำกับภาษี', '0105569012345', '0105568024684', 'สำนักงานใหญ่', 'TI-202610-0001', '14 ต.ค. 2569', 'ภาษีมูลค่าเพิ่ม', 'หนึ่งร้อยเจ็ดบาทถ้วน']) {
      expect(screen.getAllByText(new RegExp(t)).length).toBeGreaterThan(0);
    }
  });
  it('60 lines: several pages, header on every page, signatures only on the last, page x/y', () => {
    const { container } = render(<TaxInvoicePaper model={model(60)} measure={() => 30} />);
    const pages = container.querySelectorAll('[data-paper-page]');
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((p, i) => {
      expect(p.textContent).toContain('ใบกำกับภาษี');
      expect(p.textContent).toContain(`หน้า ${i + 1}/${pages.length}`);
      expect(p.textContent?.includes('ผู้มีอำนาจลงนาม')).toBe(i === pages.length - 1);
    });
  });
  it('marks data-paper-ready once paginated', () => {
    const { container } = render(<TaxInvoicePaper model={model(1)} measure={() => 30} />);
    expect(container.querySelector('[data-paper-ready="true"]')).not.toBeNull();
  });
  it('a void original is stamped on every page and the replacement wording is on every page', () => {
    const m = { ...model(60), voidMark: { label: 'ถูกแทนที่', note: 'ออกแทนด้วยเลขที่ TI-2' }, replacementNote: 'ยกเลิกและออกแทนฉบับเดิม เลขที่ TI-1 ลงวันที่ 1 ต.ค. 2569' };
    const { container } = render(<TaxInvoicePaper model={m} measure={() => 30} />);
    const pages = container.querySelectorAll('[data-paper-page]');
    pages.forEach((p) => {
      expect(p.querySelector('[data-paper-void]')?.textContent).toContain('ถูกแทนที่');
      expect(p.textContent).toContain('ยกเลิกและออกแทนฉบับเดิม เลขที่ TI-1');
    });
  });
  it('prints the server VAT lines and no rate of its own', () => {
    render(<TaxInvoicePaper model={{ ...model(1), vatLines: [{ label: 'ยอดขายอัตราร้อยละ 0', amount: '100.00' }, { label: 'ภาษีมูลค่าเพิ่ม', amount: '0.00' }] }} measure={() => 30} />);
    expect(screen.getByText('ยอดขายอัตราร้อยละ 0')).toBeInTheDocument();
    expect(screen.queryByText(/7%/)).toBeNull();
  });
  it('an untouched original has no stamp', () => {
    const { container } = render(<TaxInvoicePaper model={model(1)} measure={() => 30} />);
    expect(container.querySelector('[data-paper-void]')).toBeNull();
  });
});
