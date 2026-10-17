import type { CitLoss, CitYearData, CitYearPatch, CitYearView, FilingBlocker, FilingBox, FilingForm, FilingModel } from '@/domain/filings';
import { isValidTin } from '@/domain/tin';
import type { Actor, IsoDate, Money } from '@/domain/types';
import { CIT_RULES } from '../../fixtures/cit-year';
import type { MockState } from '../../store';
import { MockError, logAudit, stamp } from '../log';
import { fromSatang, toSatang } from '../money';
import { yearClosed } from '../periods';
import { balances, netProfit, plOf } from '../reports/profit-loss';
import { whtAllocations } from '../reports/wht-receivable';
import { type Filing, boxOf, fnv, tie } from './pp30';

/**
 * TX3a: the corporate income tax. ภ.ง.ด.50 (the year, period "YYYY") and ภ.ง.ด.51 (the half year of the same year, period "YYYY"). The fiscal year is the calendar year.
 * Net profit is the P&L engine's (reports/profit-loss.ts, I12); รายการที่ 2 lines 1-9 come from the account -> ภ.ง.ด.50 mapping; everything the rules add on top is computed here from
 * the frozen figures of the snapshot, so a finalized return can be re-derived and checked (citInvariants). No CIT journal is posted (ruling 8): the expense is the user's JV, shown as a tie-out.
 */
const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
export const YEAR = /^\d{4}$/;
export const CIT_FORMS = ['PND50', 'PND51'] as const;
export const isCit = (f: string): f is 'PND50' | 'PND51' => (CIT_FORMS as readonly string[]).includes(f);
/** Round half away from zero on a non-negative integer ratio. */
const pct = (satang: number, bp: number) => Math.floor((satang * bp + 5000) / 10000);

export type Ladder = readonly { upTo: string | null; rateBp: number }[];
export interface CitRules { sme: { maxPaidUpCapital: string; maxRevenue: string }; ladder: { sme: Ladder; standard: Ladder }; entertainment: { rateBp: number; cap: string }; donationRateBp: number; lossYears: number; prepaidRateBp: number; underEstimateBp: number; pnd50DueDays: number }
const R: CitRules = CIT_RULES;

// ---------------------------------------------------------------- the rules (pure, satang)

/** Ruling 4: an SME has paid-up capital <= 5 MB AND revenue <= 30 MB. */
export const isSme = (paidUp: number, revenue: number, r: CitRules = R): boolean => paidUp <= sat(r.sme.maxPaidUpCapital) && revenue <= sat(r.sme.maxRevenue);

export interface CitBand { from: Money; to: Money; rateBp: number; base: Money }
/** The tax on a taxable profit by the ladder; rounded once over the whole tax (half away from zero). A loss pays nothing. */
export function citTax(taxable: number, sme: boolean, ladder: Ladder = sme ? R.ladder.sme : R.ladder.standard): { tax: number; bands: CitBand[] } {
  if (taxable <= 0) return { tax: 0, bands: [] };
  const bands: CitBand[] = [];
  let from = 0, num = 0;
  for (const b of ladder) {
    if (taxable <= from) break;
    const to = b.upTo === null ? taxable : Math.min(taxable, sat(b.upTo)), base = to - from;
    num += base * b.rateBp; bands.push({ from: fromSatang(from), to: fromSatang(to), rateBp: b.rateBp, base: fromSatang(base) });
    from = to;
  }
  return { tax: Math.floor((num + 5000) / 10000), bands };
}

export interface LossRow { year: number; amount: Money; used: Money; status: 'used' | 'partly' | 'unused' | 'expired' }
/** Ruling 3 (I11): a loss of year Y is set off in years Y+1 .. Y+lossYears, oldest first, up to the profit; older ones are expired and the year itself or later cannot use it. */
export function lossSetOff(losses: CitLoss[], year: number, profit: number, years = R.lossYears): { rows: LossRow[]; used: number } {
  let avail = Math.max(profit, 0), used = 0;
  const rows = [...losses].sort((a, b) => a.year - b.year).map((l): LossRow => {
    const amt = sat(l.amount);
    if (year - l.year > years) return { year: l.year, amount: l.amount, used: '0.00', status: 'expired' };
    const u = l.year >= year ? 0 : Math.min(avail, amt);
    avail -= u; used += u;
    return { year: l.year, amount: l.amount, used: fromSatang(u), status: u === 0 ? 'unused' : u === amt ? 'used' : 'partly' };
  });
  return { rows, used };
}

/** Ruling 2 (กฎกระทรวง 143): entertainment is deductible up to the larger of 0.3 % of revenue and 0.3 % of paid-up capital, never above the cap. */
export const entertainmentLimit = (revenue: number, paidUp: number, e = R.entertainment): number => Math.min(sat(e.cap), Math.max(pct(Math.max(revenue, 0), e.rateBp), pct(Math.max(paidUp, 0), e.rateBp)));
/** Donations are deductible up to 2 % of the net profit; the rest is added back. */
export const donationExcess = (spent: number, profit: number, bp = R.donationRateBp): number => Math.max(0, spent - pct(Math.max(profit, 0), bp));

// ---------------------------------------------------------------- the books -> รายการที่ 2 lines 1-9

export interface PlMoney { revenue: Money; cost: Money; otherIncome: Money; otherExpense: Money; sga: Money; entertainment: Money; citExpense: Money; charity: Money; education: Money }
interface PlRead { pl: PlMoney; unmapped: { code: string; nameTh: string; amount: Money }[]; mapped: { charity: boolean; education: boolean }; net: number }
/** Ruling 1: the P&L accounts of the year (or its first `through`), each into the ภ.ง.ด.50 line its mapping names. An account with a balance and no mapping is listed, and stops the filing (line 9 would not be the P&L profit). */
export function readPl(st: MockState, companyId: string, year: number, through?: IsoDate): PlRead {
  const t = { revenue: 0, cost: 0, otherIncome: 0, otherExpense: 0, sga: 0, entertainment: 0, citExpense: 0, charity: 0, education: 0 };
  const unmapped: PlRead['unmapped'] = [];
  for (const [code, v] of plOf(st, companyId, balances(st, companyId, year, false, through))) {
    const a = st.accounts.find((x) => x.companyId === companyId && x.code === code), box = a?.pnd50Box ?? '';
    if (box === 'p50-revenue-direct') t.revenue -= v;
    else if (box.startsWith('p50-cogs-') || box.startsWith('p50-prod-')) t.cost += v;
    else if (box.startsWith('p50-other-income-')) t.otherIncome -= v;
    else if (box.startsWith('p50-other-expense-')) t.otherExpense += v;
    else if (box.startsWith('p50-sga-') || box === 'p50-income-tax') { // the CIT expense is a P&L expense, so line 9 is after it; it is added back at 8.1
      t.sga += v;
      if (box === 'p50-sga-entertainment') t.entertainment += v;
      else if (box === 'p50-sga-charity') t.charity += v;
      else if (box === 'p50-sga-education-sport') t.education += v;
      else if (box === 'p50-income-tax') t.citExpense += v;
    } else unmapped.push({ code, nameTh: a?.nameTh ?? code, amount: fromSatang(v) });
  }
  const has = (box: string) => st.accounts.some((a) => a.companyId === companyId && a.pnd50Box === box);
  return { pl: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fromSatang(v)])) as unknown as PlMoney, unmapped, mapped: { charity: has('p50-sga-charity'), education: has('p50-sga-education-sport') },
    net: netProfit(st, companyId, year, through) };
}

// ---------------------------------------------------------------- the ภ.ง.ด.50

export interface CitLine { code: string; line: 10 | 11 | 13 | 18 | 19; kind: 'computed' | 'user'; labelTh: string; amount: Money; basis: string; id?: string; by?: string; at?: string }
export interface WhtCredit { rcId: string; number: string; date: IsoDate; customer: string; target: string; certNumber: string; amount: Money }
/** Everything a finalized ภ.ง.ด.50 froze (ruling 9): the figures from the books, the user's adjustments with their reasons, the losses, the credits, the SME flag and the rules used. The boxes are derived from it. */
export interface CitSnapshot {
  year: number; paidUpCapital: Money; sme: boolean; rules: CitRules; pl: PlMoney; user: CitLine[]; losses: CitLoss[];
  /** the tax the finalized ภ.ง.ด.51 of the year paid, and the tax it estimated (the under-estimate check) */ pnd51: Money; pnd51EstimateTax?: Money;
  credits: WhtCredit[]; uncertified: WhtCredit[]; /** lines the mock could not compute (no account in the chart) */ skipped: ('18' | '19')[];
}
const sum = (xs: { amount: Money }[]) => xs.reduce((n, x) => n + sat(x.amount), 0);
const LOSS_LABEL: Record<LossRow['status'], string> = { used: 'ใช้หมด', partly: 'ใช้บางส่วน', unused: 'ยังไม่ได้ใช้', expired: 'หมดอายุ (เกิน 5 รอบบัญชี)' };

/** The whole return from the frozen figures (pure): the lines, the tax and the credits. The one function the draft, the finalize and the invariant all use. */
export function citDerive(s: CitSnapshot) {
  const r = s.rules, p = Object.fromEntries(Object.entries(s.pl).map(([k, v]) => [k, sat(v)])) as Record<keyof PlMoney, number>;
  const l3 = p.revenue - p.cost, l9 = l3 + p.otherIncome - p.otherExpense - p.sga;
  const u = (line: number) => s.user.filter((x) => x.line === line);
  const lim = entertainmentLimit(p.revenue, sat(s.paidUpCapital), r.entertainment), ent = Math.max(0, p.entertainment - lim);
  const computed11: CitLine[] = [
    { code: '8.1', line: 11, kind: 'computed', labelTh: 'ภาษีเงินได้นิติบุคคล (ม.65 ตรี (6))', amount: fromSatang(Math.max(p.citExpense, 0)), basis: `ยอดบัญชีภาษีเงินได้นิติบุคคลของปีนี้ ${s.pl.citExpense} บาท` },
    { code: '8.2', line: 11, kind: 'computed', labelTh: 'ค่ารับรองส่วนที่เกินเกณฑ์ (กฎกระทรวง 143)', amount: fromSatang(ent),
      basis: `ค่ารับรอง ${s.pl.entertainment} บาท เกินเพดาน ${fromSatang(lim)} บาท (มากกว่าของ ร้อยละ 0.3 ของรายได้ ${s.pl.revenue} และร้อยละ 0.3 ของทุนชำระแล้ว ${s.paidUpCapital} ไม่เกิน ${r.entertainment.cap})` },
  ];
  const l10 = sum(u(10)), l11 = sum(u(11)) + sum(computed11), l13 = sum(u(13));
  const l12 = l9 + l10 + l11, l14 = l12 - l13;
  const loss = lossSetOff(s.losses, s.year, l14, r.lossYears), l16 = l14 - loss.used;
  const don = (code: '18' | '19', labelTh: string, spent: number): CitLine => ({ code, line: Number(code) as 18 | 19, kind: 'computed', labelTh, amount: fromSatang(s.skipped.includes(code) ? 0 : donationExcess(spent, l16, r.donationRateBp)),
    basis: s.skipped.includes(code) ? 'ข้าม — ไม่มีบัญชีรายจ่ายประเภทนี้ในผังบัญชี' : `รายจ่าย ${fromSatang(spent)} บาท เกินร้อยละ 2 ของกำไรสุทธิหลังหักขาดทุน ${fromSatang(Math.max(l16, 0))} บาท` });
  const computed18 = [don('18', 'รายจ่ายเพื่อการกุศลสาธารณะส่วนที่เกินร้อยละ 2', p.charity), don('19', 'รายจ่ายเพื่อการศึกษาหรือการกีฬาส่วนที่เกินร้อยละ 2', p.education)];
  const l18 = sat(computed18[0].amount), l19 = sat(computed18[1].amount), l21 = l16 + l18 + l19;
  const { tax, bands } = citTax(l21, s.sme, s.sme ? r.ladder.sme : r.ladder.standard);
  const c51 = sat(s.pnd51), cWht = sum(s.credits), net = tax - c51 - cWht;
  const b = (code: string, labelTh: string, v: number): FilingBox => ({ code, labelTh, amount: fromSatang(v) });
  const boxes: FilingBox[] = [
    b('2.1', 'รายได้โดยตรงจากการประกอบกิจการ', p.revenue), b('2.2', 'หัก ต้นทุนขายหรือรายจ่ายเพื่อคำนวณกำไรขั้นต้น', p.cost), b('2.3', 'กำไรขั้นต้น/ขาดทุนขั้นต้น', l3), b('2.4', 'บวก รายได้อื่น', p.otherIncome),
    b('2.6', 'หัก รายจ่ายอื่น', p.otherExpense), b('2.8', 'หัก รายจ่ายในการขายและบริหาร', p.sga), b('2.9', 'กำไรสุทธิ/ขาดทุนสุทธิตามบัญชีกำไรขาดทุน', l9),
    b('2.10', 'บวก รายได้ที่ให้ถือเป็นรายได้ตามประมวลรัษฎากร', l10), b('2.11', 'บวก รายจ่ายที่ไม่ให้ถือเป็นรายจ่ายตามประมวลรัษฎากร', l11), b('2.13', 'หัก รายได้ที่ได้รับยกเว้นหรือรายจ่ายที่หักได้เพิ่มขึ้น', l13),
    b('2.15', 'หัก ขาดทุนสุทธิที่มีสิทธินำมาหักตามกฎหมาย', loss.used), b('2.18', 'บวก รายจ่ายเพื่อการกุศลสาธารณะส่วนที่เกินร้อยละ 2 ของกำไรสุทธิ', l18), b('2.19', 'บวก รายจ่ายเพื่อการศึกษาหรือการกีฬาส่วนที่เกินร้อยละ 2 ของกำไรสุทธิ', l19),
    b('2.21', 'กำไรสุทธิที่ต้องเสียภาษี/ขาดทุนสุทธิ', l21), b('tax', 'ภาษีเงินได้นิติบุคคลที่คำนวณได้', tax), b('credit51', 'หัก ภาษีที่ชำระไว้ตาม ภ.ง.ด.51', c51), b('creditWht', 'หัก ภาษีถูกหัก ณ ที่จ่าย (มีหนังสือรับรอง)', cWht),
    b('net', 'ภาษีที่ต้องชำระ (ติดลบ = ชำระเกิน)', net),
  ];
  return { boxes, lines: [...computed11, ...computed18, ...s.user], loss, bands, tax, net, taxable: l21 };
}

/** What the attachment prints: the SME test, the adjustments with their basis, the losses, the ladder bands, the certificates credited. */
export function citAttachment(s: CitSnapshot): NonNullable<FilingModel['attachment']> {
  const d = citDerive(s), row = (code: string, label: string, amount: string, basis: string) => ({ code, label, amount, basis });
  const money = (m: Money) => m;
  return { columns: [['code', 'รายการ'], ['label', 'ชื่อรายการ'], ['amount', 'จำนวนเงิน (บาท)'], ['basis', 'ที่มา / เหตุผล']].map(([key, labelTh]) => ({ key, labelTh })),
    rows: [
      row('SME', s.sme ? 'เข้าเกณฑ์ SME' : 'ไม่เข้าเกณฑ์ SME', '', `ทุนที่ชำระแล้ว ${s.paidUpCapital} บาท (เกณฑ์ไม่เกิน ${s.rules.sme.maxPaidUpCapital}) และรายได้ ${s.pl.revenue} บาท (เกณฑ์ไม่เกิน ${s.rules.sme.maxRevenue})`),
      ...d.lines.map((l) => row(l.code, `${l.labelTh} (บรรทัด ${l.line})`, money(l.amount), l.kind === 'user' ? `${l.basis} — ${l.by ?? ''}` : l.basis)),
      ...d.loss.rows.map((l) => row(`ขาดทุน ${l.year + 543}`, `ขาดทุนสะสมยกมา — ${LOSS_LABEL[l.status]}`, l.used, `ขาดทุน ${l.amount} บาท ใช้ได้ถึงรอบบัญชี ${l.year + s.rules.lossYears + 543}`)),
      ...d.bands.map((b) => row(`${b.rateBp / 100}%`, 'ขั้นอัตราภาษี', fromSatang(pct(sat(b.base), b.rateBp)), `กำไรสุทธิส่วน ${b.from} - ${b.to} บาท อัตราร้อยละ ${b.rateBp / 100}`)),
      ...s.credits.map((c) => row(`หัก ณ ที่จ่าย`, `${c.number} ${c.customer}`, c.amount, `หนังสือรับรองเลขที่ ${c.certNumber} (${c.target})`)),
    ] };
}

export function citWarnings(s: CitSnapshot): string[] {
  const w: string[] = [];
  for (const c of s.uncertified) w.push(`ยังไม่มีหนังสือรับรอง — เครดิตไม่ได้: ${c.number} ${c.customer} ${c.amount} บาท`);
  for (const k of s.skipped) w.push(`ไม่มีบัญชีรายจ่ายสำหรับบรรทัด ${k} ในผังบัญชี จึงไม่ได้คำนวณบรรทัดนี้`);
  const d = citDerive(s);
  if (s.pnd51EstimateTax !== undefined && d.tax > 0 && sat(s.pnd51EstimateTax) < pct(d.tax, s.rules.underEstimateBp)) {
    w.push(`ภาษีที่ประมาณไว้ใน ภ.ง.ด.51 (${s.pnd51EstimateTax} บาท) ต่ำกว่าภาษีที่คำนวณได้จริง (${fromSatang(d.tax)} บาท) เกินร้อยละ ${(10000 - s.rules.underEstimateBp) / 100} อาจต้องเสียเงินเพิ่ม`);
  }
  return w;
}

// ---------------------------------------------------------------- the ภ.ง.ด.51

export interface Pnd51Snapshot {
  year: number; paidUpCapital: Money; sme: boolean; rules: CitRules; mode: 'input' | 'h1x2'; estimateProfit: Money;
  /** months 1-6: the actual profit and revenue (revenue x 2 is the SME test's revenue) */ h1Profit: Money; h1Revenue: Money; credits: WhtCredit[]; uncertified: WhtCredit[];
}
export function pnd51Derive(s: Pnd51Snapshot) {
  const est = sat(s.estimateProfit), { tax: estimateTax, bands } = citTax(est, s.sme, s.sme ? s.rules.ladder.sme : s.rules.ladder.standard);
  const half = pct(estimateTax, s.rules.prepaidRateBp), wht = sum(s.credits), tax = Math.max(0, half - wht);
  const b = (code: string, labelTh: string, v: number): FilingBox => ({ code, labelTh, amount: fromSatang(v) });
  return { estimateTax, half, tax, bands, boxes: [b('estimate', s.mode === 'h1x2' ? 'ประมาณการกำไรสุทธิ (กำไรจริง 6 เดือนแรก x 2)' : 'ประมาณการกำไรสุทธิทั้งรอบบัญชี', est), b('estimateTax', 'ภาษีคำนวณจากกำไรที่ประมาณการ', estimateTax),
    b('half', 'ภาษีครึ่งหนึ่งของที่ประมาณการ', half), b('wht', 'หัก ภาษีถูกหัก ณ ที่จ่าย 6 เดือนแรก (มีหนังสือรับรอง)', wht), b('tax', 'ภาษีที่ต้องชำระ', tax)] };
}
export function pnd51Attachment(s: Pnd51Snapshot): NonNullable<FilingModel['attachment']> {
  const d = pnd51Derive(s), row = (code: string, label: string, amount: string, basis: string) => ({ code, label, amount, basis });
  return { columns: [['code', 'รายการ'], ['label', 'ชื่อรายการ'], ['amount', 'จำนวนเงิน (บาท)'], ['basis', 'ที่มา / เหตุผล']].map(([key, labelTh]) => ({ key, labelTh })),
    rows: [
      row('SME', s.sme ? 'เข้าเกณฑ์ SME' : 'ไม่เข้าเกณฑ์ SME', '', `ทุนที่ชำระแล้ว ${s.paidUpCapital} บาท และรายได้ 6 เดือนแรก ${s.h1Revenue} บาท x 2 (เกณฑ์ไม่เกิน ${s.rules.sme.maxRevenue})`),
      row('กำไร', s.mode === 'h1x2' ? 'กำไรจริง 6 เดือนแรก' : 'ประมาณการที่กรอก', s.mode === 'h1x2' ? s.h1Profit : s.estimateProfit, s.mode === 'h1x2' ? `กำไรจริง ${s.h1Profit} บาท x 2` : `กำไรจริง 6 เดือนแรก ${s.h1Profit} บาท (อ้างอิง)`),
      ...d.bands.map((x) => row(`${x.rateBp / 100}%`, 'ขั้นอัตราภาษี', fromSatang(pct(sat(x.base), x.rateBp)), `กำไรส่วน ${x.from} - ${x.to} บาท`)),
      ...s.credits.map((c) => row('หัก ณ ที่จ่าย', `${c.number} ${c.customer}`, c.amount, `หนังสือรับรองเลขที่ ${c.certNumber} (${c.target})`)),
    ] };
}
export const pnd51Warnings = (s: Pnd51Snapshot): string[] => s.uncertified.map((c) => `ยังไม่มีหนังสือรับรอง — เครดิตไม่ได้: ${c.number} ${c.customer} ${c.amount} บาท`);

// ---------------------------------------------------------------- the year data

const rowOf = (st: MockState, companyId: string, year: number) => st.citYears.find((y) => y.companyId === companyId && y.year === year);
const filingOf = (st: MockState, companyId: string, form: FilingForm, year: number) => st.filings.find((f) => f.companyId === companyId && f.form === form && f.period === String(year));
const yearsOf = (st: MockState, companyId: string) => [...new Set(st.periods.filter((p) => p.companyId === companyId).map((p) => Number(p.month.slice(0, 4))))];
function requireYear(st: MockState, companyId: string, period: string): number {
  if (!YEAR.test(period) || !yearsOf(st, companyId).includes(Number(period))) throw fail(422, 'filing.bad_period', 'ปีบัญชีไม่อยู่ในระบบ (รูปแบบ ปปปป ค.ศ.)');
  return Number(period);
}
const dataOf = (st: MockState, companyId: string, year: number): CitYearData & { exists: boolean } => {
  const r = rowOf(st, companyId, year);
  return r ? { year, paidUpCapital: r.paidUpCapital, losses: r.losses, adjustments: r.adjustments, ...(r.estimate ? { estimate: r.estimate } : {}), exists: true } : { year, paidUpCapital: '0.00', losses: [], adjustments: [], exists: false };
};
const EXIT = 'ยื่นแบบเพิ่มเติมนอกระบบ';
const locked = (form: 'ภ.ง.ด.50' | 'ภ.ง.ด.51', year: number) => fail(409, 'filing.locked', `${form} ปีบัญชี ${year + 543} ยื่นแล้ว แก้ข้อมูลของปีนี้ไม่ได้ ทางออก: ${EXIT}`);

export function citYearView(st: MockState, companyId: string, period: string): CitYearView {
  const year = requireYear(st, companyId, period), d = dataOf(st, companyId, year), { pl } = readPl(st, companyId, year), revenue = sat(pl.revenue);
  return { ...d, revenue: pl.revenue, netProfit: fromSatang(netProfit(st, companyId, year)), sme: isSme(sat(d.paidUpCapital), revenue), yearClosed: yearClosed(st, companyId, `${year}-12-31`),
    pnd50Filed: !!filingOf(st, companyId, 'PND50', year), pnd51Filed: !!filingOf(st, companyId, 'PND51', year) };
}
const MONEY_IN = /^-?\d{1,13}(\.\d{1,2})?$/;
const money = (v: unknown, what: string, o: { positive?: boolean; nonZero?: boolean } = {}): Money => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!MONEY_IN.test(s)) throw fail(422, 'validation.failed', `${what}ต้องเป็นจำนวนเงิน`);
  const n = toSatang(s);
  if ((o.positive && n < 0) || (o.nonZero && n === 0)) throw fail(422, 'validation.failed', o.nonZero ? `${what}ต้องไม่เป็นศูนย์` : `${what}ต้องไม่ติดลบ`);
  return fromSatang(n);
};
function mutable(st: MockState, companyId: string, period: string, estimate: boolean): { year: number; row: NonNullable<ReturnType<typeof rowOf>> } {
  const year = requireYear(st, companyId, period);
  if (filingOf(st, companyId, 'PND50', year)) throw locked('ภ.ง.ด.50', year);
  if (estimate && filingOf(st, companyId, 'PND51', year)) throw locked('ภ.ง.ด.51', year);
  let row = rowOf(st, companyId, year);
  if (!row) { row = { companyId, year, paidUpCapital: '0.00', losses: [], adjustments: [] }; st.citYears.push(row); }
  return { year, row };
}
/** Year data (capital, prior losses, the ภ.ง.ด.51 estimate): editable until the return that reads it is finalized; the capital and the estimate also freeze with the ภ.ง.ด.51. */
export function updateCitYear(st: MockState, companyId: string, period: string, patch: CitYearPatch, actor: Actor): CitYearView {
  const year = requireYear(st, companyId, period);
  const { row } = mutable(st, companyId, period, patch.paidUpCapital !== undefined || patch.estimate !== undefined);
  const before = { paidUpCapital: row.paidUpCapital, losses: row.losses, estimate: row.estimate };
  if (patch.paidUpCapital !== undefined) row.paidUpCapital = money(patch.paidUpCapital, 'ทุนที่ชำระแล้ว', { positive: true });
  if (patch.losses !== undefined) {
    if (!Array.isArray(patch.losses)) throw fail(422, 'validation.failed', 'รายการขาดทุนสะสมไม่ถูกต้อง');
    row.losses = patch.losses.map((l) => {
      if (!Number.isInteger(l.year) || l.year > year) throw fail(422, 'validation.failed', 'ปีของขาดทุนสะสมต้องเป็นปีก่อนหน้า');
      return { year: l.year, amount: money(l.amount, 'จำนวนขาดทุนสะสม', { positive: true, nonZero: true }) };
    });
  }
  if (patch.estimate !== undefined) {
    if (patch.estimate === null) delete row.estimate;
    else if (patch.estimate.mode === 'input') row.estimate = { mode: 'input', netProfit: money(patch.estimate.netProfit, 'ประมาณการกำไรสุทธิ') };
    else if (patch.estimate.mode === 'h1x2') row.estimate = { mode: 'h1x2' };
    else throw fail(422, 'validation.failed', 'วิธีประมาณการไม่ถูกต้อง');
  }
  logAudit(st, actor, companyId, 'cit.year.update', String(year), before, { paidUpCapital: row.paidUpCapital, losses: row.losses, estimate: row.estimate });
  return citYearView(st, companyId, period);
}

export interface AdjustmentInput { line?: unknown; amount?: unknown; reason?: unknown }
function adjustmentOf(b: AdjustmentInput): { line: 10 | 11 | 13; amount: Money; reason: string } {
  if (b.line !== 10 && b.line !== 11 && b.line !== 13) throw fail(422, 'validation.failed', 'รายการปรับปรุงต้องอยู่ที่บรรทัด 10, 11 หรือ 13 ของรายการที่ 2');
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) throw fail(422, 'cit.reason_required', 'ต้องระบุเหตุผลของรายการปรับปรุง');
  return { line: b.line, amount: money(b.amount, 'จำนวนเงิน', { nonZero: true }), reason };
}
/** User adjustments (ม.65 ทวิ / ตรี): signed, a reason each, on line 10 / 11 (added to the profit) or 13 (deducted); editable until the ภ.ง.ด.50 is finalized; every change is audited. */
export function saveCitAdjustment(st: MockState, companyId: string, period: string, b: AdjustmentInput, actor: Actor, id?: string): CitYearView {
  const { year, row } = mutable(st, companyId, period, false), v = adjustmentOf(b), at = stamp();
  if (id) {
    const a = row.adjustments.find((x) => x.id === id);
    if (!a) throw fail(404, 'cit.adjustment_not_found', 'ไม่พบรายการปรับปรุง');
    const before = { ...a };
    Object.assign(a, v, { at, by: actor.name });
    logAudit(st, actor, companyId, 'cit.adjustment.update', `${year}/${id}`, before, { ...a });
  } else {
    const n = row.adjustments.reduce((m, x) => Math.max(m, Number(x.id.replace(/^\D+/, '')) || 0), 0) + 1, a = { id: `cit-adj-${n}`, ...v, at, by: actor.name };
    row.adjustments.push(a);
    logAudit(st, actor, companyId, 'cit.adjustment.add', `${year}/${a.id}`, undefined, { ...a });
  }
  return citYearView(st, companyId, period);
}
export function removeCitAdjustment(st: MockState, companyId: string, period: string, id: string, actor: Actor): CitYearView {
  const { year, row } = mutable(st, companyId, period, false), i = row.adjustments.findIndex((x) => x.id === id);
  if (i < 0) throw fail(404, 'cit.adjustment_not_found', 'ไม่พบรายการปรับปรุง');
  const [gone] = row.adjustments.splice(i, 1);
  logAudit(st, actor, companyId, 'cit.adjustment.delete', `${year}/${id}`, { ...gone }, undefined);
  return citYearView(st, companyId, period);
}

// ---------------------------------------------------------------- the models

/** [SP-R] the ภ.ง.ด.50 is due 150 days after the year end; the ภ.ง.ด.51 on the last day of the second month after month 6 (31 August). */
const addDays = (iso: string, days: number): IsoDate => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const pnd50Due = (year: number): IsoDate => addDays(`${year}-12-31`, R.pnd50DueDays);
export const pnd51Due = (year: number): IsoDate => `${year}-08-31`;
export const citDue = (form: 'PND50' | 'PND51', period: string): IsoDate => (form === 'PND50' ? pnd50Due(Number(period)) : pnd51Due(Number(period)));

const credits = (st: MockState, companyId: string, year: number, lastMonth: number) => {
  const all = whtAllocations(st, companyId).filter((a) => a.date.startsWith(`${year}-`) && Number(a.date.slice(5, 7)) <= lastMonth)
    .map((a): WhtCredit => ({ rcId: a.rcId, number: a.number, date: a.date, customer: a.customer, target: a.target, certNumber: a.cert, amount: fromSatang(a.wht) }));
  return { credits: all.filter((c) => c.certNumber), uncertified: all.filter((c) => !c.certNumber) };
};
function sharedBlockers(st: MockState, companyId: string, d: ReturnType<typeof dataOf>, year: number): FilingBlocker[] {
  const out: FilingBlocker[] = [], co = st.companies.find((c) => c.id === companyId);
  if (!co || !isValidTin(co.taxId)) out.push({ code: 'company_tin', labelTh: 'เลขประจำตัวผู้เสียภาษีของบริษัทไม่ถูกต้องหรือเป็นเลขสมมติ แก้ที่ตั้งค่าบริษัทก่อนยืนยันแบบ', href: '/settings/company' });
  if (sat(d.paidUpCapital) <= 0) out.push({ code: 'paid_up_capital', labelTh: `ยังไม่ได้กรอกทุนที่ชำระแล้วของปีบัญชี ${year + 543} (ใช้ตัดสินสถานะ SME)` });
  return out;
}

export interface CitBuild { model: FilingModel; cit?: CitSnapshot; pnd51?: Pnd51Snapshot }
/** The return of a year as it would be filed NOW; \`version\` fingerprints the frozen figures so finalize refuses a preview that went stale. */
export function citBuild(st: MockState, companyId: string, form: 'PND50' | 'PND51', period: string): CitBuild {
  const year = requireYear(st, companyId, period), d = dataOf(st, companyId, year);
  const base = { form, period, status: 'draft' as const, exports: ['pdf' as const], dueDate: citDue(form, period) };
  if (form === 'PND50') {
    const { pl, unmapped, mapped } = readPl(st, companyId, year), c = credits(st, companyId, year, 12), f51 = filingOf(st, companyId, 'PND51', year);
    const paidUp = sat(d.paidUpCapital);
    const snap: CitSnapshot = { year, paidUpCapital: d.paidUpCapital, sme: isSme(paidUp, sat(pl.revenue)), rules: JSON.parse(JSON.stringify(R)) as CitRules, pl, losses: d.losses,
      user: d.adjustments.map((a) => ({ code: a.id, line: a.line, kind: 'user', labelTh: `รายการปรับปรุง (ผู้ใช้)`, amount: a.amount, basis: a.reason, id: a.id, by: a.by, at: a.at })),
      pnd51: f51 ? f51.boxes.find((b) => b.code === 'tax')!.amount : '0.00', ...(f51 ? { pnd51EstimateTax: f51.boxes.find((b) => b.code === 'estimateTax')!.amount } : {}), ...c,
      skipped: [...(mapped.charity ? [] : ['18' as const]), ...(mapped.education ? [] : ['19' as const])] };
    const x = citDerive(snap), blockers = sharedBlockers(st, companyId, d, year);
    if (!yearClosed(st, companyId, `${year}-12-31`)) blockers.push({ code: 'year_not_closed', labelTh: `ปีบัญชี ${year + 543} ยังไม่ได้ปิดบัญชีสิ้นปี ปิดบัญชีสิ้นปีก่อนจึงจะยืนยัน ภ.ง.ด.50 ได้`, href: `/accounting/period-close?year=${year}` });
    for (const u of unmapped) blockers.push({ code: 'unmapped_account', labelTh: `บัญชี ${u.code} ${u.nameTh} (ยอด ${u.amount} บาท) ยังไม่ได้ระบุช่อง ภ.ง.ด.50 กำไรสุทธิในแบบจึงไม่ตรงกับงบกำไรขาดทุน`, href: '/accounting/chart-of-accounts' });
    const model: FilingModel = { ...base, boxes: x.boxes, blockers, warnings: citWarnings(snap), attachment: citAttachment(snap), version: fnv(JSON.stringify(snap)),
      // ruling 8: no CIT journal; the expense the user booked (JV) vs the tax the return computes, shown amber and never blocking
      tieOuts: [tie('filing.tie.citGl', x.tax, Math.max(sat(pl.citExpense), 0))] };
    return { model, cit: snap };
  }
  const h1 = readPl(st, companyId, year, `${year}-06-30`), mode = d.estimate?.mode ?? 'h1x2', c = credits(st, companyId, year, 6);
  const h1Profit = fromSatang(h1.net), estimate = mode === 'h1x2' ? h1.net * 2 : sat(d.estimate?.netProfit);
  const snap: Pnd51Snapshot = { year, paidUpCapital: d.paidUpCapital, sme: isSme(sat(d.paidUpCapital), sat(h1.pl.revenue) * 2), rules: JSON.parse(JSON.stringify(R)) as CitRules, mode, estimateProfit: fromSatang(estimate), h1Profit, h1Revenue: h1.pl.revenue, ...c };
  const blockers = sharedBlockers(st, companyId, d, year);
  if (mode === 'input' && d.estimate?.netProfit === undefined) blockers.push({ code: 'estimate_missing', labelTh: 'ยังไม่ได้กรอกประมาณการกำไรสุทธิ' });
  if (mode === 'h1x2' && Array.from({ length: 6 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).some((m) => st.periods.find((p) => p.companyId === companyId && p.month === m)?.status !== 'closed')) {
    blockers.push({ code: 'h1_not_closed', labelTh: `วิธีกำไร 6 เดือนแรก x 2 ต้องปิดงวดบัญชีเดือน 1-6 ของปี ${year + 543} ให้ครบก่อน`, href: `/accounting/period-close?year=${year}` });
  }
  for (const u of h1.unmapped) blockers.push({ code: 'unmapped_account', labelTh: `บัญชี ${u.code} ${u.nameTh} (ยอด ${u.amount} บาท) ยังไม่ได้ระบุช่อง ภ.ง.ด.50`, href: '/accounting/chart-of-accounts' });
  const x = pnd51Derive(snap);
  return { model: { ...base, boxes: x.boxes, blockers, warnings: pnd51Warnings(snap), attachment: pnd51Attachment(snap), version: fnv(JSON.stringify(snap)), tieOuts: [] }, pnd51: snap };
}

/** A finalized return read from its frozen snapshot (never recomputed). */
export function citSnapshotModel(f: Filing): FilingModel {
  const warnings = f.cit ? citWarnings(f.cit) : f.pnd51 ? pnd51Warnings(f.pnd51) : [];
  const attachment = f.cit ? citAttachment(f.cit) : pnd51Attachment(f.pnd51!);
  return { form: f.form, period: f.period, status: 'finalized', boxes: f.boxes, tieOuts: f.tieOuts, blockers: [], warnings, attachment, finalizedAt: f.finalizedAt, finalizedBy: f.finalizedBy, company: f.company, version: 1, dueDate: f.dueDate, exports: ['pdf'] };
}

// ---------------------------------------------------------------- invariants

/** A finalized ภ.ง.ด.50 / 51 is what it froze: its boxes are exactly what its stored snapshot derives; for the ภ.ง.ด.50 the profit (line 2.9) is the P&L engine's profit of the year (I12), the year is still closed,
 *  the books still give the figures it took, and the credits are the finalized ภ.ง.ด.51 and the certificates it listed. */
export function citInvariants(st: MockState, f: Filing, w: string, out: string[]): void {
  const same = (a: FilingBox[], b: FilingBox[]) => JSON.stringify(a) === JSON.stringify(b);
  if (!YEAR.test(f.period)) { out.push(`${w}: its period is not a year`); return; }
  const year = Number(f.period);
  if (f.form === 'PND51') {
    if (!f.pnd51) out.push(`${w}: its snapshot is missing`);
    else if (!same(pnd51Derive(f.pnd51).boxes, f.boxes)) out.push(`${w}: the stored boxes are not what its stored snapshot gives`);
    return;
  }
  const s = f.cit;
  if (!s) { out.push(`${w}: its snapshot is missing`); return; }
  const x = citDerive(s);
  if (!same(x.boxes, f.boxes)) out.push(`${w}: the stored boxes are not what its stored snapshot gives`);
  if (!yearClosed(st, f.companyId, `${year}-12-31`)) out.push(`${w}: finalized but the fiscal year ${year} is not closed`);
  if (sat(f.boxes.find((b) => b.code === '2.9')?.amount) !== netProfit(st, f.companyId, year)) out.push(`${w}: line 2.9 is not the P&L net profit of ${year}`);
  const now = readPl(st, f.companyId, year);
  if (JSON.stringify(now.pl) !== JSON.stringify(s.pl)) out.push(`${w}: the books no longer give the figures it took`);
  const f51 = filingOf(st, f.companyId, 'PND51', year);
  if (sat(s.pnd51) !== (f51 ? boxOf(f51.boxes, 'tax') : 0)) out.push(`${w}: the ภ.ง.ด.51 credit ${s.pnd51} is not the finalized ภ.ง.ด.51's tax`);
  const live = new Map(credits(st, f.companyId, year, 12).credits.map((c) => [`${c.rcId}|${c.target}`, c]));
  for (const c of s.credits) { const l = live.get(`${c.rcId}|${c.target}`); if (!l || l.certNumber !== c.certNumber || l.amount !== c.amount) out.push(`${w}: credit ${c.number} no longer carries the certificate and tax it took`); }
  const t = f.tieOuts[0];
  if (f.tieOuts.length !== 1 || t.labelKey !== 'filing.tie.citGl' || sat(t.left) !== x.tax) out.push(`${w}: tie-out filing.tie.citGl is missing or not the stored tax`);
}
