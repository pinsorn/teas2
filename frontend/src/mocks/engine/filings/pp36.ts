import { LIVE } from '@/domain/doc-types';
import type { FilingBlocker, FilingBox, FilingModel } from '@/domain/filings';
import type { JournalEntryPreview } from '@/domain/types';
import { isValidTin } from '@/domain/tin';
import { formatDateBE } from '@/lib/format';
import type { MockState } from '../../store';
import { MockError, stamp } from '../log';
import { divRoundHalfAway, fromSatang, toSatang } from '../money';
import { isClosed, monthLabelTh } from '../periods';
import { resolveRole } from '../posting';
import { RATE_BP, computeDoc, vatBasisOf, vatOf } from '../vat';
import { type DocLike, type Filing, PERIOD, type Pp36Row, chainBlockers, dueDateOf, fnv, nextMonth } from './pp30';

/** TX2: the ภ.พ.36 (reverse-charge VAT on a service used in Thailand and paid to a foreign payee, I8). [SP-R] the base, the rate, the month-end posting date, the claim month and the layout are mock rules, not ruled positions. */
const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);

/** The row a voucher makes in its ภ.พ.36: the net of its `pnd36` lines (under a gross-up the base stays the line net [SP-R]). Undefined = not in one. A payee registered under VAT-D files no ภ.พ.36. `d` may be a PROPOSED body. */
export function pp36RowOf(st: MockState, d: DocLike): Pp36Row | undefined {
  if (d.type !== 'PV' || !LIVE.includes(d.status) || (d.party as { vatDRegistered?: boolean } | undefined)?.vatDRegistered) return undefined;
  const nets = computeDoc(d.lines, !!d.header.priceIncludesVat, vatBasisOf(st, d.companyId, 'PV')).lines;
  const base = d.lines.reduce((n, l, i) => n + (l.pnd36 ? sat(nets[i].net) : 0), 0);
  return base > 0 ? { id: d.id, ...(d.number ? { number: d.number } : {}), date: d.header.documentDate, ...(d.header.partyId ? { partyId: d.header.partyId } : {}), partyName: d.party?.name ?? '', base: fromSatang(base) } : undefined;
}
export const pp36Key = (r: Pp36Row) => JSON.stringify([r.date, r.partyId ?? '', r.base]);

/** The vouchers of the PAYMENT month (I8), computed from the documents. */
export const pp36Rows = (st: MockState, companyId: string, period: string): Pp36Row[] =>
  st.docs.filter((d) => d.companyId === companyId && d.type === 'PV' && d.header.documentDate.startsWith(period)).flatMap((d) => { const r = pp36RowOf(st, d); return r ? [r] : []; })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? a.id).localeCompare(b.number ?? b.id));

/** VAT = round(Σ base x the VAT rate) half away from zero, once over the month (G3). */
export const pp36Vat = (rows: Pp36Row[]): number => Number(divRoundHalfAway(BigInt(rows.reduce((n, r) => n + sat(r.base), 0)) * RATE_BP.S7, 10000n));
export function pp36Boxes(rows: Pp36Row[]): FilingBox[] {
  return [{ code: 'base', labelTh: 'มูลค่าบริการที่ต้องเสียภาษี', amount: fromSatang(rows.reduce((n, r) => n + sat(r.base), 0)) }, { code: 'vat', labelTh: 'ภาษีมูลค่าเพิ่มที่ต้องนำส่ง (ภ.พ.36)', amount: fromSatang(pp36Vat(rows)) }];
}
export const pp36Attachment = (rows: Pp36Row[]): NonNullable<FilingModel['attachment']> => ({
  columns: [['no', 'ลำดับ'], ['number', 'ใบสำคัญจ่าย'], ['date', 'วันที่จ่าย'], ['name', 'ผู้รับเงิน'], ['base', 'มูลค่าบริการ']].map(([key, labelTh]) => ({ key, labelTh })),
  rows: rows.map((r, i) => ({ no: String(i + 1), number: r.number ?? r.id, date: formatDateBE(r.date), name: r.partyName, base: r.base })) });

export const lastDayOf = (period: string): string => `${period}-${String(new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;

/** G3: the entry is dated the PAYMENT month's last day, never the day it is finalized. Input VAT of a VAT company (claimed in the next month's ภ.พ.30), else cost (InputVatUnclaimed). */
export function pp36Journal(st: MockState, companyId: string, period: string, vat: number): JournalEntryPreview[] {
  if (!vat) return [];
  const claims = vatOf(st, companyId), dr = resolveRole(st, claims ? 'InputVat' : 'InputVatUnclaimed', { companyId, docType: 'PV' }), cr = resolveRole(st, 'Pnd36VatPayable', { companyId, docType: 'PV' });
  const line = (r: typeof dr, debit: number, credit: number) => ({ accountCode: r.code, accountName: r.name, debit: fromSatang(debit), credit: fromSatang(credit), rule: `ภ.พ.36 เดือน ${monthLabelTh(period)}: ${r.rule}` });
  return [{ date: lastDayOf(period), kind: 'original', postedAt: stamp(), lines: [line(dr, vat, 0), line(cr, 0, vat)] }];
}

export function pp36Blockers(st: MockState, companyId: string, period: string, rows: Pp36Row[]): FilingBlocker[] {
  const out: FilingBlocker[] = [];
  const co = st.companies.find((c) => c.id === companyId);
  if (!co || !isValidTin(co.taxId)) out.push({ code: 'company_tin', labelTh: 'เลขประจำตัวผู้เสียภาษีของบริษัทไม่ถูกต้องหรือเป็นเลขสมมติ แก้ที่ตั้งค่าบริษัทก่อนยื่น', href: '/settings/company' });
  if (!rows.length) out.push({ code: 'no_documents', labelTh: `เดือน ${monthLabelTh(period)} ไม่มีใบสำคัญจ่ายที่ต้องยื่น ภ.พ.36` });
  if (isClosed(st, companyId, lastDayOf(period))) out.push({ code: 'period_closed', labelTh: `งวดบัญชี ${monthLabelTh(period)} ปิดแล้ว ภ.พ.36 ลงบัญชีวันสิ้นเดือน เปิดงวดบัญชีก่อนยืนยัน`, href: '/accounting/periods' });
  if (vatOf(st, companyId) && st.filings.some((f) => f.companyId === companyId && f.form === 'PP30' && f.period === nextMonth(period))) { // the VAT is claimed in the next month's ภ.พ.30: if that is filed it would never be claimed
    out.push({ code: 'claim_month_filed', labelTh: `ภ.พ.30 เดือน ${monthLabelTh(nextMonth(period))} ยื่นแล้ว ภาษีจาก ภ.พ.36 จะไม่ถูกนำไปเครดิต`, href: `/tax/vat?period=${nextMonth(period)}` });
  }
  out.push(...chainBlockers(st, companyId, 'PP36', period, 'ภ.พ.36', (p) => `/tax/wht?tab=pp36&period=${p}`, (p) => pp36Rows(st, companyId, p).length > 0));
  return out;
}

export function pp36Model(st: MockState, companyId: string, period: string): FilingModel {
  if (!PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const rows = pp36Rows(st, companyId, period), boxes = pp36Boxes(rows);
  const warnings = vatOf(st, companyId) ? [`ภาษีนี้เครดิตเป็นภาษีซื้อใน ภ.พ.30 เดือน ${monthLabelTh(nextMonth(period))} (ยื่นและชำระภาษีเดือนถัดไป)`] : ['บริษัทไม่ได้จดภาษีมูลค่าเพิ่ม ภาษีนี้เป็นต้นทุน ไม่เครดิตใน ภ.พ.30'];
  return { form: 'PP36', period, status: 'draft', boxes, tieOuts: [], blockers: pp36Blockers(st, companyId, period, rows), warnings, attachment: pp36Attachment(rows), version: fnv(JSON.stringify(rows)), dueDate: dueDateOf(period), exports: ['pdf'] };
}
export const pp36Snapshot = (st: MockState, companyId: string, period: string): Pick<Filing, 'p36' | 'docs' | 'carryIn' | 'pp36' | 'journal' | 'claims'> =>
  ({ p36: pp36Rows(st, companyId, period), docs: [], carryIn: '0.00', pp36: '0.00', journal: pp36Journal(st, companyId, period, pp36Vat(pp36Rows(st, companyId, period))), claims: vatOf(st, companyId) });
