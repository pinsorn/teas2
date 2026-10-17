import type { Actor, ChecklistItem, IsoDate, Lock } from '@/domain/types';
import type { MockState } from '../store';
import { MockError, today } from './log';

/** `closedBy`, `acknowledged` (the warnings the closer accepted, frozen) and every `reopened` row are AC6's. */
export interface Period { companyId: string; month: string; status: 'open' | 'closed'; closedAt?: string; closedBy?: Actor; acknowledged?: ChecklistItem[]; reopened?: { at: string; reason: string; by: Actor }[] }

const MONTHS_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
/** "2026-03" -> "มี.ค. 2569" */
export const monthLabelTh = (month: string) => `${MONTHS_TH[Number(month.slice(5, 7)) - 1]} ${Number(month.slice(0, 4)) + 543}`;

const find = (st: MockState, companyId: string, month: string) => st.periods.find((p) => p.companyId === companyId && p.month === month);
/** A month with no period row is open. */
export const isClosed = (st: MockState, companyId: string, date: IsoDate): boolean => find(st, companyId, date.slice(0, 7))?.status === 'closed';

/** AC6: a fiscal year with a live closing entry is final - nothing is posted, corrected or reversed into it (the exit is to reopen the year). */
export const yearClosed = (st: MockState, companyId: string, date: IsoDate): boolean => st.yearCloses.some((y) => y.companyId === companyId && !y.reopened && y.year === Number(date.slice(0, 4)));
export function refuseYearClosed(st: MockState, companyId: string, date: IsoDate): void {
  if (yearClosed(st, companyId, date)) throw new MockError(422, 'period.year_closed', `ปีบัญชี ${Number(date.slice(0, 4)) + 543} ปิดแล้ว ลงรายการ แก้ไข หรือกลับรายการที่ลงวันที่ ${date} ไม่ได้ ทางออก: เปิดปีบัญชีอีกครั้ง (หน้าปิดงวดบัญชี)`);
}

/** AC6: a document in a closed year (its date, or any entry it posted that is not a reversal) is not cancelled, revised, reversed or reissued: the F4 late correction ("แก้ไขย้อนหลัง") stays for closed MONTHS of an open year only. */
export function refuseClosedYearEntry(st: MockState, d: { id: string; companyId: string; header: { documentDate: IsoDate } }): void {
  for (const date of [d.header.documentDate, ...(st.journals.find((j) => j.docId === d.id)?.preview.entries.filter((e) => e.kind !== 'reversal').map((e) => e.date) ?? [])]) refuseYearClosed(st, d.companyId, date);
}

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
