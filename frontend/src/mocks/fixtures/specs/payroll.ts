import type { DocLine, PayItems } from '@/domain/types';
import type { SeedSpec } from '../seed-runner';

/** PY1 payroll runs seeded THROUGH the engine (D-23). The VAT company has five employees: emp-01..03 full-time, emp-05 left on 20 Sep (September is prorated 20 / 30), emp-04 joins on 15 Oct (October is 17 / 31).
 *  pr-2026-08 and pr-2026-09 are the regular runs; pr-bonus-09 is a SECOND September run (a bonus, no salary), issued after pr-2026-09 - so the SSO monthly cap, the incremental PIT and "a later run exists" are all live in the seed
 *  (pr-2026-08 and pr-2026-09 can no longer be revised or cancelled; pr-bonus-09 can). pr-2026-10 is the October draft. The non-VAT company has one issued run (npr-2026-09).
 *  The runs are issued, not paid: paying a run is PY2 (the `prPaid` fixture points at pr-2026-08, the run PY2 pays first). */
const SALARY: Record<string, string> = { 'emp-01': '120000.00', 'emp-02': '30000.00', 'emp-03': '22000.00', 'emp-04': '25000.00', 'emp-05': '28000.00', 'nemp-01': '15000.00', 'nemp-02': '12500.00', 'nemp-03': '18000.00' };
const row = (run: string, employeeId: string, pay: Partial<PayItems> = {}): DocLine =>
  ({ id: `${run}-${employeeId}`, description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', employeeId, pay: { salary: SALARY[employeeId], ...pay } });

export const PAYROLL_SPECS: SeedSpec[] = [
  { id: 'pr-2026-08', type: 'PR', companyId: 'co-vat', date: '2026-08-31', status: 'issued', header: { reference: 'ส.ค. 2569 รอบ 1' },
    lines: [row('pr-2026-08', 'emp-01', { overtime: '1200.00' }), row('pr-2026-08', 'emp-02'), row('pr-2026-08', 'emp-03'), row('pr-2026-08', 'emp-05')] },
  { id: 'pr-2026-09', type: 'PR', companyId: 'co-vat', date: '2026-09-30', status: 'issued', header: { reference: 'ก.ย. 2569 รอบ 1' },
    lines: [row('pr-2026-09', 'emp-01', { allowance: '1500.00' }), row('pr-2026-09', 'emp-02'), row('pr-2026-09', 'emp-03', { otherDeduction: '500.00' }), row('pr-2026-09', 'emp-05')] },
  { id: 'pr-bonus-09', type: 'PR', companyId: 'co-vat', date: '2026-09-30', status: 'issued', header: { reference: 'ก.ย. 2569 รอบ 2 (โบนัส)' },
    lines: [row('pr-bonus-09', 'emp-01', { salary: '0.00', bonus: '20000.00' }), row('pr-bonus-09', 'emp-02', { salary: '0.00', bonus: '10000.00' })] },
  { id: 'pr-2026-10', type: 'PR', companyId: 'co-vat', date: '2026-10-14', status: 'draft', header: { reference: 'ต.ค. 2569 รอบ 1' },
    lines: [row('pr-2026-10', 'emp-01'), row('pr-2026-10', 'emp-02'), row('pr-2026-10', 'emp-03'), row('pr-2026-10', 'emp-04')] },
  { id: 'npr-2026-09', type: 'PR', companyId: 'co-nonvat', date: '2026-09-30', status: 'issued', header: { reference: 'ก.ย. 2569 รอบ 1' },
    lines: [row('npr-2026-09', 'nemp-01'), row('npr-2026-09', 'nemp-02'), row('npr-2026-09', 'nemp-03')] },
];
