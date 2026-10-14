import type { IsoDate, Money } from '@/domain/types';

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export function formatDateBE(iso: IsoDate): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

export function formatMoney(m: Money): string {
  const neg = m.startsWith('-');
  const [i, f = ''] = m.replace('-', '').split('.');
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(f + '00').slice(0, 2)}`;
}

export const formatTHB = (m: Money) => (m.startsWith('-') ? `-฿${formatMoney(m).slice(1)}` : `฿${formatMoney(m)}`);

/** Today's local calendar date (YYYY-MM-DD). The one copy: editor default, copy-as-new and overdue maths all use it. */
export const todayIso = (d = new Date()): IsoDate =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
