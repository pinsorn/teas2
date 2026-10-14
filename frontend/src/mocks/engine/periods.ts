import type { IsoDate, Lock } from '@/domain/types';
import type { MockState } from '../store';
import { today } from './log';

export interface Period { companyId: string; month: string; status: 'open' | 'closed'; closedAt?: string; reopened?: { at: string; reason: string }[] }

const MONTHS_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
/** "2026-03" -> "มี.ค. 2569" */
export const monthLabelTh = (month: string) => `${MONTHS_TH[Number(month.slice(5, 7)) - 1]} ${Number(month.slice(0, 4)) + 543}`;

const find = (st: MockState, companyId: string, month: string) => st.periods.find((p) => p.companyId === companyId && p.month === month);
/** A month with no period row is open. */
export const isClosed = (st: MockState, companyId: string, date: IsoDate): boolean => find(st, companyId, date.slice(0, 7))?.status === 'closed';

/** First day of the earliest open month >= today's month (where a late reversal / correction posts), or today. */
export const firstOpenDate = (st: MockState, companyId: string): IsoDate => {
  const t = today();
  let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  for (let i = 0; i < 120; i++, m === 12 ? (y++, m = 1) : m++) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    if (find(st, companyId, month)?.status !== 'closed') return `${month}-01`;
  }
  return t;
};

/** The lock a document dated in a closed month reads with (SP0 §7.5): informative, it never blocks a correction or a cancel. */
export function periodLock(st: MockState, companyId: string, date: IsoDate): Lock | undefined {
  if (!isClosed(st, companyId, date)) return undefined;
  return {
    kind: 'period', reason: `งวดบัญชี ${monthLabelTh(date.slice(0, 7))} ปิดแล้ว`,
    exits: ['แก้ไขย้อนหลัง (รายการกลับและรายการใหม่ลงบัญชีในงวดที่เปิดอยู่)', 'เปิดงวดบัญชีอีกครั้ง'],
  };
}
