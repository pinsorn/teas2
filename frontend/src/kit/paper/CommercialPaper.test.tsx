import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaperModel } from '@/domain/types';
import { CommercialPaper } from './CommercialPaper';

const model = (n: number, over: Partial<PaperModel> = {}): PaperModel => ({
  titleTh: 'ใบเสนอราคา', titleEn: 'QUOTATION', copyLabel: 'ต้นฉบับ', number: 'QT-202610-0001', documentDate: '2026-10-14', dueDate: '2026-11-13', dueLabel: 'ยืนราคาถึง',
  seller: { name: 'ร้านข้าวหอมมะลิ', address: '12 ถนนสุขุมวิท', taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่' },
  buyer: { name: 'โรงเรียนอนุบาลดอกไม้', address: '9 ซอยต้นไม้' },
  lines: Array.from({ length: n }, (_, i) => ({ no: i + 1, description: `รายการ ${i + 1}`, qty: '1', unit: 'ถุง', unitPrice: '100.00', amount: '100.00', taxCode: 'EX' as const })),
  totals: { gross: '100.00', discount: '0.00', net: '100.00', vat: '0.00', total: '100.00', amountInWords: 'หนึ่งร้อยบาทถ้วน' },
  signatures: ['ผู้เสนอราคา', 'ผู้อนุมัติ', 'ลูกค้ายืนยันสั่งซื้อ'], ...over,
});

describe('CommercialPaper (QT SO DO BL IV PO)', () => {
  it('prints the title, the due label and the signature row of the model', () => {
    const { container } = render(<CommercialPaper model={model(1)} measure={() => 30} />);
    expect(container.querySelector('h2')?.textContent).toBe('ใบเสนอราคา');
    expect(screen.getByText('QUOTATION')).toBeInTheDocument();
    expect(screen.getByText('ยืนราคาถึง')).toBeInTheDocument();
    for (const s of ['ผู้เสนอราคา', 'ผู้อนุมัติ', 'ลูกค้ายืนยันสั่งซื้อ']) expect(screen.getByText(s)).toBeInTheDocument();
  });
  it('non-VAT model renders no VAT row and never the word "ใบกำกับภาษี"', () => {
    const { container } = render(<CommercialPaper model={model(2)} measure={() => 30} />);
    expect(container.textContent).not.toContain('ภาษีมูลค่าเพิ่ม');
    expect(container.textContent).not.toContain('ใบกำกับภาษี');
    expect(container.textContent).not.toContain('มูลค่าก่อนภาษี');
    expect(container.textContent).toContain('หนึ่งร้อยบาทถ้วน');
  });
  it('a VAT model prints the server VAT lines in order after the net row', () => {
    const { container } = render(<CommercialPaper model={model(1, { vatLines: [{ label: 'ภาษีมูลค่าเพิ่ม 7%', amount: '7.00' }] })} measure={() => 30} />);
    const rows = [...container.querySelectorAll('.paper-tot tr')].map((r) => r.textContent);
    expect(rows.at(-2)).toContain('มูลค่าก่อนภาษี');
    expect(rows.at(-1)).toContain('ภาษีมูลค่าเพิ่ม 7%');
  });
  it('revisionLabel prints on every page', () => {
    const { container } = render(<CommercialPaper model={model(60, { revisionLabel: 'ฉบับแก้ไขครั้งที่ 2' })} measure={() => 30} />);
    const pages = container.querySelectorAll('[data-paper-page]');
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((p) => expect(p.textContent).toContain('ฉบับแก้ไขครั้งที่ 2'));
  });
  it('no revisionLabel, no revision wording', () => {
    const { container } = render(<CommercialPaper model={model(1)} measure={() => 30} />);
    expect(container.textContent).not.toContain('ฉบับแก้ไขครั้งที่');
  });
});
