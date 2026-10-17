import { docViewHref } from '@/descriptors';
import type { ReportModel, ReportRow } from '@/domain/reports';
import type { MockState } from '../../store';
import { today } from '../log';
import { fromSatang } from '../money';
import { whtAllocations } from './wht-receivable';

/** หนังสือรับรองหัก ณ ที่จ่ายที่ยังไม่ได้รับ (TX2b): the receipt allocations that withheld tax and carry no certificate number, oldest first, each linking to its receipt (where the number is typed
 *  late: a paper-only edit, TX2 ruling 7). The list shrinks as numbers are entered; its length is the hub tab's badge. */
export function missingWhtCert(st: MockState, companyId: string): ReportModel {
  const now = today(), list = whtAllocations(st, companyId).filter((a) => !a.cert);
  const rows: ReportRow[] = list.map((a) => ({ level: 0, kind: 'row', cells: { receipt: a.number, date: a.date, customer: a.customer, target: a.target, wht: fromSatang(a.wht), age: String(Math.round((Date.parse(`${now}T00:00:00Z`) - Date.parse(`${a.date}T00:00:00Z`)) / 86_400_000)) }, href: docViewHref('RC', a.rcId)! }));
  const t = (key: string) => ({ key, labelKey: `reports.missingCert.${key}` });
  return {
    kind: 'missing-wht-cert', titleKey: 'reports.missingCert.title', params: {},
    columns: [{ ...t('receipt'), kind: 'text' }, { ...t('date'), kind: 'date' }, { ...t('customer'), kind: 'text' }, { ...t('target'), kind: 'text' }, { ...t('wht'), kind: 'money', align: 'end' }, { ...t('age'), kind: 'qty', align: 'end' }],
    rows,
  };
}
