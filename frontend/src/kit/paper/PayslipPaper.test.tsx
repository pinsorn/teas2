import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PaperModel, PayslipPaperModel } from '@/domain/types';
import { PayslipPaper } from './PayslipPaper';

const slip = (n: number, over: Partial<PayslipPaperModel> = {}): PayslipPaperModel => ({
  employeeId: `emp-0${n}`, name: `พนักงาน ${n}`, nationalId: 'X-XXXX-XXXX0-03-4', period: 'ก.ย. 2569', payDate: '2026-09-30', daysInMonth: 30,
  income: [{ label: 'เงินเดือน', amount: '30000.00' }, { label: 'โบนัส', amount: '1500.00' }],
  deductions: [{ label: 'ภาษีเงินได้หัก ณ ที่จ่าย (มาตรา 50(1))', amount: '2111.11' }, { label: 'ประกันสังคม', amount: '875.00' }, { label: 'รายการหักอื่น', amount: '500.00' }],
  gross: '31500.00', totalDeductions: '3486.11', net: `${28013 + n}.89`, netInWords: `สองหมื่นแปดพันสิบ${n}บาทแปดสิบเก้าสตางค์`, ssoEmployer: '875.00',
  ytd: { income: '91500.00', pit: '6333.33', sso: '2625.00' }, note: 'หนังสือรับรองตามมาตรา 50 ทวิ ออกให้ปีละครั้ง (ภ.ง.ด.1ก)', ...over,
});
const model = (slips: PayslipPaperModel[], over: Partial<PaperModel> = {}): PaperModel => ({
  titleTh: 'ใบจ่ายเงินเดือน', titleEn: 'PAYSLIP', copyLabel: 'ต้นฉบับ', number: 'PR-202609-0001', documentDate: '2026-09-30', reference: 'ก.ย. 2569 รอบ 1',
  seller: { name: 'บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด', address: '88/12 ถนนประดิพัทธ์', taxId: '0105569012345', branchLabel: 'สำนักงานใหญ่ (00000)' }, buyer: { name: '-', address: '' },
  lines: [], totals: { gross: '0.00', discount: '0.00', net: '0.00', vat: '0.00', total: '0.00', amountInWords: '' }, signatures: ['ผู้จ่ายเงิน', 'ผู้รับเงิน'], payslips: slips, ...over,
});

describe('PayslipPaper (PY2): one A5 slip per employee, every figure from the model', () => {
  it('prints one sheet per slip with the net and its words exactly as the model says', () => {
    const { container } = render(<PayslipPaper model={model([slip(1), slip(2), slip(3)])} />);
    const sheets = container.querySelectorAll('[data-payslip]');
    expect(sheets).toHaveLength(3);
    sheets.forEach((el, i) => {
      const s = [slip(1), slip(2), slip(3)][i];
      expect(el.textContent).toContain(s.name);
      expect(el.textContent).toContain(`${28013 + i + 1}.89`.replace(/(\d)(\d{3})\./, '$1,$2.'));
      expect(el.textContent).toContain(s.netInWords);
    });
  });

  it('shows the company, the masked national id, the period, the pay date, the items, the deductions and the year to date', () => {
    render(<PayslipPaper model={model([slip(1)])} />);
    const el = screen.getByText('พนักงาน 1').closest('[data-payslip]') as HTMLElement;
    const text = el.textContent ?? '';
    for (const t of ['บริษัท มะลิวัลย์ ดีไซน์ เวิร์คส์ จำกัด', '0105569012345', 'X-XXXX-XXXX0-03-4', 'ก.ย. 2569', '30 ก.ย. 2569', 'เงินเดือน', 'โบนัส', 'รายการหักอื่น', 'ประกันสังคม', 'PR-202609-0001', '31,500.00', '91,500.00', '6,333.33', '2,625.00', '875.00', 'มาตรา 50 ทวิ'])
      expect(text, t).toContain(t);
    expect(within(el).getByText('ผู้รับเงิน')).toBeTruthy();
  });

  it('a single slip is printed on request (the drawer\'s print); nothing else is rendered', () => {
    const { container } = render(<PayslipPaper model={model([slip(1), slip(2)])} only="emp-02" />);
    const sheets = container.querySelectorAll('[data-payslip]');
    expect(sheets).toHaveLength(1);
    expect(sheets[0].getAttribute('data-payslip')).toBe('emp-02');
  });

  it('is A5 at print (a named page) and scrolls sideways inside its container on a narrow screen; the stamp of a cancelled run is on every slip', () => {
    const { container } = render(<PayslipPaper model={model([slip(1), slip(2)], { voidMark: { label: 'ยกเลิก' } })} />);
    expect(container.querySelector('style')).toBeNull(); // PY3 m6: the A5 page rules live in paper.css, not in an inline <style>
    expect(readFileSync(join(process.cwd(), 'src/kit/paper/paper.css'), 'utf8')).toMatch(/@page\s+payslip\s*\{[^}]*size:\s*A5/);
    expect(container.querySelector('.overflow-x-auto')).not.toBeNull();
    expect(container.querySelectorAll('[data-paper-void]')).toHaveLength(2);
  });

  it('the proration is on the slip and an employee with no national id prints without one', () => {
    render(<PayslipPaper model={model([slip(1, { proratedDays: 20, daysInMonth: 30, nationalId: undefined, income: [{ label: 'เงินเดือน (20/30 วัน)', amount: '18666.67' }] })])} />);
    expect(screen.getAllByText(/20\/30 วัน/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/X-XXXX/)).toBeNull();
  });
});
