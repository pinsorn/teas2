import { CREDIT_NOTES, LIVE } from '@/domain/doc-types';
import type { FilingBlocker, FilingBox, FilingForm, FilingModel } from '@/domain/filings';
import type { ReportColumn, ReportModel, ReportRow, TieOut } from '@/domain/reports';
import type { DocHeader, DocLine, DocStatus, DocType, IsoDate, Money } from '@/domain/types';
import { docEditHref, docViewHref } from '@/descriptors';
import { formatDateBE } from '@/lib/format';
import { isValidTin } from '@/domain/tin';
import type { MockState } from '../../store';
import { MockError } from '../log';
import { fromSatang, toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { claimPeriodOf, exForfeited, isRecoverable } from '../purchase-vat';
import { computeDoc, vatOf } from '../vat';

/** A document as the ภ.พ.30 took it: the figures the filing froze, per document (ruling 1). `out` rows come from TI / CN / DN (a CN / DN is signed), `in` rows from the vendor documents (PB / PCN / PDN, and an EX line with its vendor tax invoice).
 *  For an `in` row `base7` is the claimed base and `vat` the RECOVERABLE VAT only. A cancelled document keeps a row of zeros (ยกเลิก 0.00, A.9). */
export interface Pp30Doc {
  id: string; kind: 'out' | 'in'; type: DocType; number?: string; date: IsoDate; partyName?: string; tin?: string; branch?: string; description: string; state: 'live' | 'cancelled';
  base7: Money; base0: Money; baseEx: Money; vat: Money; claimPeriod?: string; vendorDocDate?: string; forfeit?: boolean;
}
/** A finalized filing: the boxes, the tie-outs and the exact documents, all frozen at finalize. */
export interface Filing {
  companyId: string; form: FilingForm; period: string; status: 'finalized'; boxes: FilingBox[]; tieOuts: TieOut[]; docs: Pp30Doc[]; carryIn: Money; pp36: Money; finalizedAt: string; finalizedBy: string; dueDate: IsoDate;
}

const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const OUT: DocType[] = ['TI', 'CN', 'DN'];
const IN: DocType[] = ['PB', 'PCN', 'PDN', 'EX'];
const DRAFTISH: DocStatus[] = ['draft', 'pending', 'approved'];
export const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const prevMonth = (p: string): string => { const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7)); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
export const nextMonth = (p: string): string => { const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7)); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
/** [SP-R] the ภ.พ.30 is due on the 15th of the following month (e-filing is extended to the 23rd; the mock keeps the paper date, which Home's deadline card also uses). */
const dueDateOf = (p: string): IsoDate => { const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7)); return m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, '0')}-15`; };

export type DocLike = { id: string; type: DocType; companyId: string; number?: string; status: DocStatus; header: DocHeader; lines: DocLine[]; party?: { name?: string; taxId?: string; branchCode?: string } };

/** The row a document makes in the ภ.พ.30 (undefined = it is not in one). `d.header` / `d.lines` may be a PROPOSED body (the filing lock compares it with what the filing took). */
export function pp30RowOf(st: MockState, d: DocLike): Pp30Doc | undefined {
  const out = OUT.includes(d.type), inn = IN.includes(d.type);
  if (!out && !inn) return undefined;
  const live = LIVE.includes(d.status), cancelled = d.status === 'cancelled' || d.status === 'replaced';
  if (!live && !(cancelled && out)) return undefined; // a cancelled vendor document claims nothing and is not listed
  const h = d.header, zero = '0.00';
  const base = { id: d.id, kind: out ? 'out' as const : 'in' as const, type: d.type, number: d.number, date: h.documentDate, partyName: d.party?.name, tin: d.party?.taxId, branch: d.party?.branchCode };
  if (out && cancelled) return { ...base, description: 'ยกเลิก', state: 'cancelled', base7: zero, base0: zero, baseEx: zero, vat: zero };
  const k = CREDIT_NOTES.includes(d.type) ? -1 : 1;
  const rs = computeDoc(d.lines, !!h.priceIncludesVat, true).lines; // our own VAT status is enforced elsewhere (I1): a non-VAT company has no filing at all
  if (out) {
    const sum = (code: DocLine['taxCode']) => d.lines.reduce((n, l, i) => n + (l.taxCode === code ? sat(rs[i].net) : 0), 0);
    const description = h.disposal ? `ขายสินทรัพย์ ${h.disposal.faNumber ?? h.disposal.faId}` : d.lines[0]?.description ?? '';
    return { ...base, description, state: 'live', base7: fromSatang(k * sum('S7')), base0: fromSatang(k * sum('Z0')), baseEx: fromSatang(k * sum('EX')), vat: fromSatang(k * rs.reduce((n, r) => n + sat(r.vat), 0)) };
  }
  const claim = d.lines.map((l) => isRecoverable(st, d.companyId, l, d.type === 'EX' ? exForfeited(h, l) : h.inputVatForfeited));
  const vat = d.lines.reduce((n, l, i) => n + (claim[i] ? sat(rs[i].vat) : 0), 0);
  const claimedBase = d.lines.reduce((n, l, i) => n + (claim[i] && l.taxCode === 'S7' ? sat(rs[i].net) : 0), 0);
  const tins = d.type === 'EX' ? [...new Set(d.lines.filter((_, i) => claim[i] && sat(rs[i].vat) !== 0).map((l) => l.vendorInvoice?.vendorTin ?? ''))].sort().join(',') : base.tin; // an expense claim's vendor is on its lines
  return { ...base, tin: tins, kind: 'in', state: 'live', description: d.lines[0]?.description ?? '', base7: fromSatang(k * claimedBase), base0: zero, baseEx: zero, vat: fromSatang(k * vat),
    claimPeriod: claimPeriodOf(d.type, h), ...(h.vendorDocDate ? { vendorDocDate: h.vendorDocDate } : {}), forfeit: !!h.inputVatForfeited };
}

/** The documents of a month, computed from the live document set (I12): TI / CN / DN by document month, the vendor documents by claim period. An input row exists only when it claims VAT. */
export function pp30Docs(st: MockState, companyId: string, period: string): Pp30Doc[] {
  const rows = st.docs.filter((d) => d.companyId === companyId).flatMap((d) => {
    const r = pp30RowOf(st, d);
    if (!r) return [];
    return (r.kind === 'out' ? r.date.slice(0, 7) === period : r.claimPeriod === period && sat(r.vat) !== 0) ? [r] : [];
  });
  return rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1) || a.date.localeCompare(b.date) || (a.number ?? a.id).localeCompare(b.number ?? b.id));
}

/** The ภ.พ.30 boxes from a document list. [SP-R] layout (the official form's field numbers are SP-R / SP4.8): 1 total sales, 2 zero-rated, 3 exempt, 4 taxable (= 1 - 2 - 3), 5 output VAT, 6 purchases with the right to claim, 7 input VAT,
 *  8 tax payable, 9 tax overpaid, 10 overpaid brought forward, 11 the net. [SP-R] An excess is CARRIED to the next month by default (refund vs carry is the company's election). */
export function pp30Boxes(docs: Pp30Doc[], carryIn: number, pp36: number, period: string): FilingBox[] {
  const sum = (kind: Pp30Doc['kind'], f: (d: Pp30Doc) => string) => docs.filter((d) => d.kind === kind).reduce((n, d) => n + sat(f(d)), 0);
  const b2 = sum('out', (d) => d.base0), b3 = sum('out', (d) => d.baseEx), b4 = sum('out', (d) => d.base7), b5 = sum('out', (d) => d.vat);
  const b6 = sum('in', (d) => d.base7), b7 = sum('in', (d) => d.vat) + pp36;
  const net = b5 - b7 - carryIn;
  const out = { reportKind: 'vat-output-register' as const, params: { period } }, inn = { reportKind: 'vat-input-register' as const, params: { period } };
  const box = (code: string, labelTh: string, v: number, source?: FilingBox['source']): FilingBox => ({ code, labelTh, amount: fromSatang(v), ...(source ? { source } : {}) });
  return [box('1', 'ยอดขายรวม', b2 + b3 + b4, out), box('2', 'ยอดขายอัตราร้อยละ 0', b2, out), box('3', 'ยอดขายที่ได้รับยกเว้น', b3, out), box('4', 'ยอดขายที่ต้องเสียภาษี', b4, out), box('5', 'ภาษีขาย', b5, out),
    box('6', 'ยอดซื้อที่มีสิทธิ์นำภาษีซื้อมาหัก', b6, inn), box('7', 'ภาษีซื้อ', b7, inn), box('8', 'ภาษีที่ต้องชำระ', Math.max(net, 0)), box('9', 'ภาษีที่ชำระเกิน', Math.max(-net, 0)),
    box('10', 'ภาษีชำระเกินยกมา', carryIn), box('11', net >= 0 ? 'ภาษีสุทธิที่ต้องชำระ' : 'ภาษีสุทธิที่ชำระเกิน', Math.abs(net))];
}
export const boxOf = (boxes: FilingBox[], code: string): number => sat(boxes.find((b) => b.code === code)?.amount);

// ---------------------------------------------------------------- the ledger side of the tie-outs

/** The movement of GL `account` attributed to `period`: an entry of a TI / CN / DN counts in the month of its DOCUMENT (a cancel's reversal posted later nets out in the month it belongs to), a vendor document in its CLAIM period,
 *  everything else (a JV, a bank journal, a settlement) by its own date. An opening balance is a carried balance, not the period's VAT [SP-R]. Output = credit - debit; input = debit - credit. */
export function glMovement(st: MockState, companyId: string, account: '2151' | '1170', period: string): number {
  const sign = account === '2151' ? -1 : 1;
  const net = (lines: { accountCode: string; debit: string; credit: string }[]) => lines.filter((l) => l.accountCode === account).reduce((n, l) => n + sat(l.debit) - sat(l.credit), 0);
  const kinds = account === '2151' ? OUT : IN;
  let total = 0;
  for (const j of st.journals) {
    const d = st.docs.find((x) => x.id === j.docId);
    if (!d || d.companyId !== companyId || d.type === 'OB') continue;
    for (const e of j.preview.entries) if ((kinds.includes(d.type) ? (account === '2151' ? d.header.documentDate.slice(0, 7) : claimPeriodOf(d.type, d.header)) : e.date.slice(0, 7)) === period) total += net(e.lines);
  }
  for (const e of [...st.bankJournals.filter((b) => b.companyId === companyId).flatMap((b) => b.entries), ...st.settlements.filter((s) => s.companyId === companyId).flatMap((s) => s.journal)]) if (e.date.startsWith(period)) total += net(e.lines);
  return sign * total;
}

/** ภ.พ.36 self-assessed VAT of the period's finalized PP36 (G2): none exists until TX2 files it. */
export const pp36VatOf = (st: MockState, companyId: string, period: string): number =>
  st.filings.filter((f) => f.companyId === companyId && f.form === 'PP36' && f.period === period).reduce((n, f) => n + boxOf(f.boxes, 'vat'), 0);

const tie = (labelKey: string, left: number, right: number): TieOut => ({ labelKey, left: fromSatang(left), right: fromSatang(right), diff: fromSatang(left - right) });

// ---------------------------------------------------------------- the registers (reports)

const MONEY: ReportColumn['kind'] = 'money';
const reg = (kind: 'vat-output-register' | 'vat-input-register', titleKey: string, docs: Pp30Doc[], params: Record<string, string>, tieOuts: TieOut[]): ReportModel => {
  const out = kind === 'vat-output-register';
  const columns: ReportColumn[] = [{ key: 'date', labelKey: 'filing.reg.date', kind: 'date' }, { key: 'number', labelKey: 'filing.reg.number' }, { key: 'party', labelKey: 'filing.reg.party' }, { key: 'tin', labelKey: 'filing.reg.tin' }, { key: 'branch', labelKey: 'filing.reg.branch' },
    { key: 'description', labelKey: 'filing.reg.description' }, ...(out
      ? [{ key: 'base7', labelKey: 'filing.reg.base7', kind: MONEY, align: 'end' as const }, { key: 'base0', labelKey: 'filing.reg.base0', kind: MONEY, align: 'end' as const }, { key: 'baseEx', labelKey: 'filing.reg.baseEx', kind: MONEY, align: 'end' as const }]
      : [{ key: 'base7', labelKey: 'filing.reg.claimedBase', kind: MONEY, align: 'end' as const }]), { key: 'vat', labelKey: 'filing.reg.vat', kind: MONEY, align: 'end' as const }];
  const mine = docs.filter((d) => d.kind === (out ? 'out' : 'in'));
  const rows: ReportRow[] = mine.map((d) => ({ level: 0, kind: 'row', href: docViewHref(d.type, d.id), cells: { date: d.date, number: d.number ?? d.id, party: d.partyName ?? '', tin: d.tin ?? '', branch: d.branch ?? '', description: d.description, base7: d.base7, base0: d.base0, baseEx: d.baseEx, vat: d.vat } }));
  const t = (f: (d: Pp30Doc) => string) => fromSatang(mine.reduce((n, d) => n + sat(f(d)), 0));
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { base7: t((d) => d.base7), base0: t((d) => d.base0), baseEx: t((d) => d.baseEx), vat: t((d) => d.vat) } });
  return { kind, titleKey, params, columns, rows, tieOuts };
};
const periodOf = (p: Record<string, string>): string => {
  const period = p.period ?? '';
  if (!PERIOD.test(period)) throw fail(422, 'report.bad_param', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  return period;
};
/** A finalized month reads its snapshot; any other month is computed. */
export const filingDocs = (st: MockState, companyId: string, period: string): Pp30Doc[] =>
  st.filings.find((f) => f.companyId === companyId && f.form === 'PP30' && f.period === period)?.docs ?? pp30Docs(st, companyId, period);
export const registerReport = (kind: 'vat-output-register' | 'vat-input-register', st: MockState, companyId: string, p: Record<string, string>): ReportModel => {
  requireVat(st, companyId);
  const period = periodOf(p), m = getModel(st, companyId, period);
  const ties = m.tieOuts.filter((x) => x.labelKey.endsWith(kind === 'vat-output-register' ? 'outputGl' : 'inputGl'));
  return reg(kind, kind === 'vat-output-register' ? 'reports.vatOutput.title' : 'reports.vatInput.title', filingDocs(st, companyId, period), { period }, ties);
};

// ---------------------------------------------------------------- the model

export function requireVat(st: MockState, companyId: string): void {
  if (!vatOf(st, companyId)) throw fail(404, 'filing.not_available', 'บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม จึงไม่มีแบบ ภ.พ.30');
}
const fnv = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

/** The month the company's chain of ภ.พ.30 starts at: its FIRST finalized one (ruling 4: months before it are before TEAS took over filing). */
export const chainStart = (st: MockState, companyId: string): string | undefined =>
  st.filings.filter((f) => f.companyId === companyId && f.form === 'PP30').map((f) => f.period).sort()[0];
const filedIn = (st: MockState, companyId: string, period: string) => st.filings.find((f) => f.companyId === companyId && f.form === 'PP30' && f.period === period);

export function blockersOf(st: MockState, companyId: string, period: string): FilingBlocker[] {
  const out: FilingBlocker[] = [];
  const co = st.companies.find((c) => c.id === companyId);
  if (!co || !isValidTin(co.taxId)) out.push({ code: 'company_tin', labelTh: 'เลขประจำตัวผู้เสียภาษีของบริษัทไม่ถูกต้องหรือเป็นเลขสมมติ แก้ที่ตั้งค่าบริษัทก่อนยื่น', href: '/settings/company' });
  for (const d of st.docs.filter((x) => x.companyId === companyId && OUT.includes(x.type) && DRAFTISH.includes(x.status) && x.header.documentDate.startsWith(period)).sort((a, b) => a.header.documentDate.localeCompare(b.header.documentDate) || a.id.localeCompare(b.id))) {
    out.push({ code: 'draft_document', labelTh: `${d.type} ฉบับร่างลงวันที่ ${formatDateBE(d.header.documentDate)} ยังไม่ได้ออก`, href: docEditHref(d.type, d.id) });
  }
  const start = chainStart(st, companyId);
  if (start && period < start) out.push({ code: 'before_chain', labelTh: `งวดนี้อยู่ก่อนงวดแรกที่ยื่นในระบบ (${monthLabelTh(start)})` });
  else if (start && period > start && !filedIn(st, companyId, prevMonth(period))) out.push({ code: 'previous_open', labelTh: `ยังไม่ได้ยืนยันแบบ ภ.พ.30 เดือน ${monthLabelTh(prevMonth(period))}`, href: `/tax/vat?period=${prevMonth(period)}` });
  return out;
}

/** The ภ.พ.30 of a month AS IT WOULD BE FILED NOW (always computed; `getFiling` in index.ts reads a finalized one from its snapshot). `version` fingerprints the documents and boxes, so finalize refuses a preview that went stale. */
export function pp30Model(st: MockState, companyId: string, period: string): FilingModel {
  requireVat(st, companyId);
  if (!PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const docs = pp30Docs(st, companyId, period), prev = filedIn(st, companyId, prevMonth(period));
  const carryIn = prev ? boxOf(prev.boxes, '9') : 0, pp36 = pp36VatOf(st, companyId, period);
  const boxes = pp30Boxes(docs, carryIn, pp36, period);
  const warnings = boxOf(boxes, '9') > 0 ? ['ภาษีชำระเกิน ยกไปหักในเดือนถัดไป (ค่าเริ่มต้น ขอคืนเป็นเงินต้องทำนอกระบบนี้)'] : [];
  const base: FilingModel = { form: 'PP30', period, status: 'draft', boxes, tieOuts: [], blockers: blockersOf(st, companyId, period), warnings, version: fnv(JSON.stringify([docs, carryIn, pp36])), dueDate: dueDateOf(period), exports: ['rdprep-txt', 'pdf'] };
  const tieOuts = [
    tie('filing.tie.outputGl', boxOf(boxes, '5'), glMovement(st, companyId, '2151', period)),
    tie('filing.tie.inputGl', boxOf(boxes, '7') - pp36, glMovement(st, companyId, '1170', period)),
    tie('filing.tie.outputRegister', boxOf(boxes, '5'), sat(reg('vat-output-register', '', docs, {}, []).rows.find((r) => r.kind === 'total')?.cells.vat)),
    tie('filing.tie.inputRegister', boxOf(boxes, '7') - pp36, sat(reg('vat-input-register', '', docs, {}, []).rows.find((r) => r.kind === 'total')?.cells.vat)),
  ];
  return { ...base, tieOuts };
}
const getModel = (st: MockState, companyId: string, period: string): FilingModel => {
  const f = filedIn(st, companyId, period);
  return f ? { form: 'PP30', period, status: 'finalized', boxes: f.boxes, tieOuts: f.tieOuts, blockers: [], warnings: [], finalizedAt: f.finalizedAt, finalizedBy: f.finalizedBy, version: 1, dueDate: f.dueDate, exports: ['rdprep-txt', 'pdf'] } : pp30Model(st, companyId, period);
};
export { getModel as getPp30, dueDateOf };
