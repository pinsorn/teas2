import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaperModel } from '@/domain/types';
import { WhtCertificatePaper } from './WhtCertificatePaper';

const base: PaperModel = {
  titleTh: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย', titleEn: 'WITHHOLDING TAX CERTIFICATE', copyLabel: 'ต้นฉบับ', number: 'WT-202610-0001', documentDate: '2026-10-14', partyLabel: 'ผู้ถูกหักภาษี ณ ที่จ่าย',
  seller: { name: 'บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด', address: '88/12 ถนนประดิพัทธ์ …', taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่' },
  buyer: { name: 'คุณอนันต์ ภาพดี (ช่างภาพอิสระ)', address: '7/8 ถนนมิตรภาพ ขอนแก่น 40000', taxId: '3100600111224', branchLabel: 'สำนักงานใหญ่' },
  lines: [{ no: 1, description: '40(8) ค่าบริการ', qty: '1', unit: 'รายการ', unitPrice: '5000.00', amount: '5000.00', taxCode: 'EX' }],
  totals: { gross: '5000.00', discount: '0.00', net: '5000.00', vat: '0.00', total: '5000.00', wht: '150.00', amountInWords: 'หนึ่งร้อยห้าสิบบาทถ้วน' },
  certificate: { form: 'PND3', incomeType: '40(8)', incomeLabel: '40(8) ค่าบริการ', paidOn: '2026-10-14', income: '5000.00', tax: '150.00', taxInWords: 'หนึ่งร้อยห้าสิบบาทถ้วน', condition: 'withhold', voucher: 'PV-202610-0001' },
  signatures: ['ผู้จ่ายเงิน', 'ผู้มีอำนาจลงนาม'],
};
const checked = (el: Element) => [...el.querySelectorAll('[data-checked="true"]')].map((c) => c.parentElement!.textContent!.replace('✓', '').trim());

describe('WhtCertificatePaper (50 ทวิ)', () => {
  it('prints two copies on one print, each with payer, payee, the ticked return, income row, tax, words and condition', () => {
    const { container } = render(<WhtCertificatePaper model={base} />);
    const pages = [...container.querySelectorAll('[data-paper-page]')];
    expect(pages).toHaveLength(2);
    expect(pages[0].textContent).toContain('ฉบับที่ 1');
    expect(pages[1].textContent).toContain('ฉบับที่ 2');
    for (const p of pages) {
      expect(p.textContent).toContain('บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด');
      expect(p.textContent).toContain('0105569012345');
      expect(p.textContent).toContain('3100600111224');
      expect(p.textContent).toContain('7/8 ถนนมิตรภาพ');
      expect(p.querySelector('[data-field="number"]')!.textContent).toBe('WT-202610-0001');
      expect(checked(p)).toEqual(['(4) ภ.ง.ด.3', '(1) หัก ณ ที่จ่าย']); // the return and the payer's condition
      expect(p.querySelector('[data-field="income-row"]')!.textContent).toContain('40(8) ค่าบริการ');
      expect(p.querySelector('[data-field="income-row"]')!.textContent).toContain('5,000.00');
      expect(p.querySelector('[data-field="tax-total"]')!.textContent).toBe('150.00');
      expect(p.textContent).toContain('(หนึ่งร้อยห้าสิบบาทถ้วน)');
      expect(p.querySelector('[data-field="sequence"]')!.textContent).toContain('ลำดับที่'); // [SP-R]: the box exists, the number is not known at issue
    }
  });
  it('the return and the condition follow the model: PND53 / gross-up forever; PND54 / once', () => {
    const a = render(<WhtCertificatePaper model={{ ...base, certificate: { ...base.certificate!, form: 'PND53', condition: 'forever' } }} />);
    expect(checked(a.container.querySelector('[data-paper-page]')!)).toEqual(['(7) ภ.ง.ด.53', '(2) ออกให้ตลอดไป']);
    const b = render(<WhtCertificatePaper model={{ ...base, certificate: { ...base.certificate!, form: 'PND54', condition: 'once' } }} />);
    expect(checked(b.container.querySelector('[data-paper-page]')!)).toEqual(['ภ.ง.ด.54 (จ่ายต่างประเทศ)', '(3) ออกให้ครั้งเดียว']);
  });
  it('a cancelled certificate carries the void stamp on both copies', () => {
    const { container } = render(<WhtCertificatePaper model={{ ...base, voidMark: { label: 'ยกเลิก', note: 'ยกเลิกตามใบสำคัญจ่าย' } }} />);
    expect(container.querySelectorAll('[data-paper-void]')).toHaveLength(2);
  });
});
