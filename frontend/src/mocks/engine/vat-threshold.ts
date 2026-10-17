import { LIVE } from '@/domain/doc-types';
import type { VatThresholdWatch } from '@/domain/reports';
import type { MockState } from '../store';
import { today } from './log';
import { fromSatang, toSatang } from './money';

/** [SP-R] the revenue above which a business must register for VAT (ม.85/1): 1,800,000.00 baht in any 12 months. */
export const VAT_THRESHOLD = '1800000.00';
/** [SP-R] the warning starts at 80 % of it. */
const WARN_PCT = 80;
const MESSAGE = { ok: '', warning: 'ใกล้เกณฑ์ต้องจดทะเบียนภาษีมูลค่าเพิ่ม', danger: 'เกินเกณฑ์ ต้องจดทะเบียนภาษีมูลค่าเพิ่มภายใน 30 วัน' } as const; // [SP-R] the 30 days

/** Integer satang against the threshold, so 79.99 / 80.00 / 100.00 % are exact. */
export const thresholdLevel = (revenue: number): VatThresholdWatch['level'] => {
  const limit = toSatang(VAT_THRESHOLD);
  return revenue >= limit ? 'danger' : revenue * 100 >= limit * WARN_PCT ? 'warning' : 'ok';
};

const addMonths = (month: string, n: number) => { const t = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const lastDay = (month: string) => `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;

/** Sales revenue (before VAT) dated in a range: live TI / IV / RC cash bills (a receipt with no allocation sells for cash), less credit notes, plus debit notes. */
export function salesRevenue(st: MockState, companyId: string, from: string, to: string): number {
  let n = 0;
  for (const d of st.docs) {
    if (d.companyId !== companyId || !LIVE.includes(d.status) || d.header.documentDate < from || d.header.documentDate > to) continue;
    const net = toSatang(d.totals.net);
    if (d.type === 'TI' || d.type === 'IV' || d.type === 'DN') n += net;
    else if (d.type === 'RC' && !d.allocations?.length) n += net;
    else if (d.type === 'CN') n -= net;
  }
  return n;
}

/** G1: the last 12 months (ending the current month) of a company that is NOT VAT-registered against the threshold; null for a VAT company (it has registered already). */
export function vatThresholdWatch(st: MockState, companyId: string, asOf = today()): VatThresholdWatch | null {
  if (st.companies.find((c) => c.id === companyId)?.vatRegistered !== false) return null;
  const month = asOf.slice(0, 7), from = `${addMonths(month, -11)}-01`, to = lastDay(month);
  const revenue = salesRevenue(st, companyId, from, to), level = thresholdLevel(revenue);
  return { revenue: fromSatang(revenue), threshold: VAT_THRESHOLD, percent: (Math.floor((revenue * 10000) / toSatang(VAT_THRESHOLD)) / 100).toFixed(2), level, messageTh: MESSAGE[level], from, to };
}
