import type { DocLine } from '@/domain/types';
import { createAmortisation, createRecurring, runSchedule } from '../../engine/schedules';
import { withFixedClock } from '../../engine/log';
import type { MockState } from '../../store';
import { USER } from '../documents';

/** AC4 schedules, seeded through the engine (D-23). The annual insurance bill (`pb-ins`, in ACCOUNTING_SPECS) is amortised over 12 months from 2026-07 with three runs done (July - September); the recurring
 *  templates are a monthly website-care TI and a monthly accrual JV (VAT company) and a monthly IV (non-VAT). Ids are explicit: the named fixtures and the tests refer to them. */
const jl = (n: number, accountCode: string, debit: string, credit: string, description: string): DocLine =>
  ({ id: `tpl-jv-l${n}`, description, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode, debit, credit });
const sl = (id: string, description: string, unit: string, unitPrice: string, taxCode: DocLine['taxCode']): DocLine => ({ id, description, qty: '1', unit, unitPrice, taxCode });

export function seedSchedules(st: MockState): void {
  withFixedClock('2026-07-01T11:00:00+07:00', () => {
    createAmortisation(st, 'co-vat', { name: 'เบี้ยประกันอัคคีภัยอาคาร', docId: 'pb-ins', lineId: 'pb-ins-l1', total: '12000.00', months: 12, startMonth: '2026-07', expenseAccount: '5120' }, USER, { id: 'sch-amort' });
    createRecurring(st, 'co-vat', { name: 'ดูแลเว็บไซต์รายเดือน', frequency: 'monthly', nextRun: '2026-11-01',
      template: { type: 'TI', header: { partyId: 'pc-04', notes: 'ค่าบริการดูแลเว็บไซต์ประจำเดือน' }, lines: [sl('tpl-ti-l1', 'ดูแลเว็บไซต์รายเดือน', 'เดือน', '8000.00', 'S7')] } }, USER, { id: 'sch-rec-ti' });
    createRecurring(st, 'co-vat', { name: 'ค้างจ่ายค่าบริการวิชาชีพรายเดือน', frequency: 'monthly', nextRun: '2026-10-31',
      template: { type: 'JV', header: { reference: 'ค้างจ่ายค่าบริการวิชาชีพ', autoReverse: true }, lines: [jl(1, '5120', '8000.00', '0.00', 'ค่าบริการวิชาชีพ (ค้างจ่าย)'), jl(2, '2120', '0.00', '8000.00', 'ค่าใช้จ่ายค้างจ่าย')] } }, USER, { id: 'sch-rec-jv' });
    createRecurring(st, 'co-nonvat', { name: 'ค่าบริการรายเดือน', frequency: 'monthly', nextRun: '2026-11-05',
      template: { type: 'IV', header: { partyId: 'nc-01' }, lines: [sl('tpl-iv-l1', 'ค่าบริการรายเดือน', 'เดือน', '3500.00', 'EX')] } }, USER, { id: 'nsch-rec-iv' });
  });
  for (const m of ['2026-07', '2026-08', '2026-09']) withFixedClock(`${m}-28T18:00:00+07:00`, () => { runSchedule(st, 'co-vat', 'sch-amort', USER, { month: m }); });
}
