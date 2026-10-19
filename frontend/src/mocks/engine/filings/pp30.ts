import { CREDIT_NOTES, LIVE } from '@/domain/doc-types';
import type { FilingBlocker, FilingBox, FilingForm, FilingModel } from '@/domain/filings';
import type { ReportColumn, ReportModel, ReportRow, TieOut } from '@/domain/reports';
import type { Allocation, DocHeader, DocLine, DocStatus, DocType, IsoDate, JournalEntryPreview, Money, WhtFrozen } from '@/domain/types';
import { docEditHref, docViewHref } from '@/descriptors';
import { formatDateBE } from '@/lib/format';
import { isValidTin } from '@/domain/tin';
import type { MockState } from '../../store';
import { MockError, stamp, today } from '../log';
import { fromSatang, toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { type AccountingRole, resolveRole } from '../posting';
import { claimPeriodOf, exForfeited, isRecoverable } from '../purchase-vat';
import { computeDoc, vatOf } from '../vat';
import { pp36Rows } from './pp36';
import type { CitSnapshot, Pnd51Snapshot } from './cit';

/** A document as the ภ.พ.30 took it: the figures the filing froze, per document (ruling 1). `out` rows come from TI / CN / DN (a CN / DN is signed), `in` rows from the vendor documents (PB / PCN / PDN, and an EX line with its vendor tax invoice).
 *  For an `in` row `base7` is the claimed base and `vat` the RECOVERABLE VAT only. A cancelled document keeps a row of zeros (ยกเลิก 0.00, A.9). */
export interface Pp30Doc {
  id: string; kind: 'out' | 'in'; type: DocType; number?: string; date: IsoDate; partyName?: string; tin?: string; branch?: string; description: string; state: 'live' | 'cancelled';
  base7: Money; base0: Money; baseEx: Money; vat: Money; claimPeriod?: string; vendorDocDate?: string; forfeit?: boolean;
  /** M6: an input row's paper, frozen with it: the number printed on the vendor's own tax invoice / note, and for an expense claim one entry per vendor tax invoice (the register prints one row each). */
  vendorDocNo?: string; invoices?: Pp30Invoice[];
}
/** TX2: a ภ.ง.ด. attachment row as the return took it from one certificate (WT) and its voucher (PV): the payee as the voucher stored it, the income type, the figures, the payer's condition. */
export interface WhtRow {
  id: string; pvId: string; number?: string; date: IsoDate; partyId?: string; partyName: string; tin: string; branch: string; address: string; entityKind: string;
  code: string; incomeType: string; nameTh: string; rate: string; form: string; income: Money; tax: Money; condition: string;
}
/** TX2: a voucher behind a ภ.พ.36: the service base (Σ net of its `pnd36` lines) it gave. */
export interface Pp36Row { id: string; number?: string; date: IsoDate; partyId?: string; partyName: string; base: Money }
export interface Pp30Invoice { number: string; date: IsoDate; name: string; tin: string; base7: Money; vat: Money }
/** PY3: one employee as a payroll return filed them (copied from the stored slips of the runs it took). `pit` is the ภ.ง.ด.1 / ภ.ง.ด.1ก figure, `wageBase` the สปส.1-10 one (ceiling / floor as the slip stored them); `ob` = the opening-balance part of a ภ.ง.ด.1ก row. */
export interface PayrollRow { employeeId: string; name: string; nationalId: string; income: Money; pit?: Money; wageBase?: Money; sso: Money; ssoEmployer: Money; ob?: { income: Money; pit: Money; sso: Money } }
export interface PayrollSnap { runs: { id: string; number: string; revision: number }[]; rows: PayrollRow[]; /** สปส.1-10: the contribution rate (basis points) the stored slips used, written in the file header (PY3a) */ rateBp?: number; /* required on SSO1-10 (the invariant reports its absence) */ /** ภ.ง.ด.1ก: the finalized ภ.ง.ด.1 months of the year it added up */ months?: string[] }
/** A finalized filing: the boxes, the tie-outs and the exact documents, all frozen at finalize. */
export interface Filing {
  companyId: string; form: FilingForm; period: string; status: 'finalized'; boxes: FilingBox[]; tieOuts: TieOut[]; docs: Pp30Doc[]; carryIn: Money; pp36: Money; finalizedAt: string; finalizedBy: string; dueDate: IsoDate;
  /** TX2: ภ.ง.ด. rows / ภ.พ.36 rows / the ภ.พ.36 journal entry (dated the payment month's last day, G3) / whether its VAT is claimable input VAT (a VAT company) - all frozen at finalize; `docs` is the ภ.พ.30 list and is [] for these */
  wht?: WhtRow[]; p36?: Pp36Row[]; journal?: JournalEntryPreview[]; claims?: boolean;
  /** TX3a: a ภ.ง.ด.50 / 51 is its frozen snapshot (the books' figures, the adjustments with their basis, the credits, the SME flag, the rules used); `docs` is [] for these */
  cit?: CitSnapshot; pnd51?: Pnd51Snapshot;
  /** PY3: a payroll return (ภ.ง.ด.1 / ภ.ง.ด.1ก / สปส.1-10) is its frozen snapshot: the runs it took, one row per employee copied from their stored slips, and (ภ.ง.ด.1ก) the opening-balance part and the ภ.ง.ด.1 months it took */
  payroll?: PayrollSnap;
  /** PY3a M1: fingerprint of what no other invariant re-derives (company as filed, due date, period, form, who and when); the invariant recomputes it */ fp: number;
  /** M2: who filed, as the company was at finalize (the file and the page read this, never the master now); a payroll return also freezes the SSO employer account (PY3) */ company: { taxId: string; branchCode: string; legalNameTh: string; ssoEmployerAccountNo?: string; /** ST1a M2: what the employee 50 ทวิ prints of the payer, frozen with the rest (fingerprinted) */ address?: string; legalNameEn?: string; phone?: string };
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

export type DocLike = { id: string; type: DocType; companyId: string; number?: string; status: DocStatus; header: DocHeader; lines: DocLine[]; party?: { name?: string; taxId?: string; branchCode?: string; address?: string }; allocations?: Allocation[]; whtFrozen?: WhtFrozen };

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
  const groups = new Map<string, Pp30Invoice & { b: number; v: number }>(); // an expense claim: one entry per vendor tax invoice, from the lines that claim
  if (d.type === 'EX') d.lines.forEach((l, i) => {
    const x = l.vendorInvoice;
    if (!x || !claim[i] || sat(rs[i].vat) === 0) return;
    const g = groups.get(`${x.vendorTin}|${x.number}|${x.date}`) ?? { number: x.number, date: x.date, name: x.vendorName, tin: x.vendorTin, base7: zero, vat: zero, b: 0, v: 0 };
    g.b += l.taxCode === 'S7' ? sat(rs[i].net) : 0; g.v += sat(rs[i].vat);
    groups.set(`${x.vendorTin}|${x.number}|${x.date}`, g);
  });
  const invoices = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number)).map(({ b, v, ...g }) => ({ ...g, base7: fromSatang(k * b), vat: fromSatang(k * v) }));
  return { ...base, tin: tins, kind: 'in', state: 'live', description: d.lines[0]?.description ?? '', base7: fromSatang(k * claimedBase), base0: zero, baseEx: zero, vat: fromSatang(k * vat),
    claimPeriod: claimPeriodOf(d.type, h), ...(h.vendorDocDate ? { vendorDocDate: h.vendorDocDate } : {}), forfeit: !!h.inputVatForfeited, ...(h.vendorDocNumber ? { vendorDocNo: h.vendorDocNumber } : {}), ...(invoices.length ? { invoices } : {}) };
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

/** The ภ.พ.30 boxes from a document list, numbered as the official form (TX4; https://www.rd.go.th/fileadmin/tax_pdf/vat/2568/pp30_010968.pdf): 1 total sales, 2 zero-rated, 3 exempt, 4 taxable (= 1 - 2 - 3), 5 output VAT, 6 purchases with the right to claim, 7 input VAT,
 *  8 tax payable this month (5 > 7: 5 - 7), 9 tax overpaid this month (5 < 7: 7 - 5), 10 overpaid brought forward, 11 net payable (8 - 10 when 8 > 10), 12 net overpaid (10 - 8, or 9 + 10) = what is CARRIED to the next month.
 *  [SP-R] An excess is carried by default (refund vs carry is the company's election). */
export function pp30Boxes(docs: Pp30Doc[], carryIn: number, pp36: number, period: string): FilingBox[] {
  const sum = (kind: Pp30Doc['kind'], f: (d: Pp30Doc) => string) => docs.filter((d) => d.kind === kind).reduce((n, d) => n + sat(f(d)), 0);
  const b2 = sum('out', (d) => d.base0), b3 = sum('out', (d) => d.baseEx), b4 = sum('out', (d) => d.base7), b5 = sum('out', (d) => d.vat);
  const b6 = sum('in', (d) => d.base7), b7 = sum('in', (d) => d.vat) + pp36;
  const own = b5 - b7, net = own - carryIn;
  const out = { reportKind: 'vat-output-register' as const, params: { period } }, inn = { reportKind: 'vat-input-register' as const, params: { period } };
  const box = (code: string, labelTh: string, v: number, source?: FilingBox['source']): FilingBox => ({ code, labelTh, amount: fromSatang(v), ...(source ? { source } : {}) });
  return [box('1', 'ยอดขายรวม', b2 + b3 + b4, out), box('2', 'ยอดขายอัตราร้อยละ 0', b2, out), box('3', 'ยอดขายที่ได้รับยกเว้น', b3, out), box('4', 'ยอดขายที่ต้องเสียภาษี', b4, out), box('5', 'ภาษีขาย', b5, out),
    box('6', 'ยอดซื้อที่มีสิทธิ์นำภาษีซื้อมาหัก', b6, inn), box('7', 'ภาษีซื้อ', b7, inn), box('8', 'ภาษีที่ต้องชำระเดือนนี้', Math.max(own, 0)), box('9', 'ภาษีที่ชำระเกินเดือนนี้', Math.max(-own, 0)),
    box('10', 'ภาษีที่ชำระเกินยกมา', carryIn), box('11', 'ภาษีสุทธิที่ต้องชำระ', Math.max(net, 0)), box('12', 'ภาษีสุทธิที่ชำระเกิน', Math.max(-net, 0))];
}
export const boxOf = (boxes: FilingBox[], code: string): number => sat(boxes.find((b) => b.code === code)?.amount);

/** TX2c D1: the closing of a finalized month's VAT, posted on the finalize day: output VAT (box 5) and input VAT (box 7, the ภ.พ.36 part included: it sits in 1170 since its payment month) leave their accounts; the carry brought in (box 10) is used;
 *  the net goes to VAT payable (box 11), or (an excess) to VAT carried forward (box 12). Read from the STORED boxes 5, 7, 10 only. Signed: a negative amount posts on the other side. */
export const pp30Net = (boxes: FilingBox[]): number => boxOf(boxes, '5') - boxOf(boxes, '7') - boxOf(boxes, '10');
/** Balance proof: Σ signed debits = b5 - b7 - b10 - n = 0 by the definition of n. Two lines on VatCarryForward (box 10 used, box 12 carried) are intended: never net them. */
export function pp30Netting(st: MockState, companyId: string, period: string, boxes: FilingBox[], date: IsoDate): JournalEntryPreview[] {
  const n = pp30Net(boxes);
  const legs: [AccountingRole, string, number][] = [ // [role, box label, signed DEBIT]
    ['OutputVat', '5', boxOf(boxes, '5')],
    ['InputVat', '7', -boxOf(boxes, '7')],
    ['VatCarryForward', '10', -boxOf(boxes, '10')],
    n >= 0 ? ['VatPayable', '11', -n] : ['VatCarryForward', '12', -n],
  ];
  const lines = legs.filter(([, , v]) => v !== 0).map(([role, box, v]) => {
    const r = resolveRole(st, role, { companyId, docType: 'JV' });
    return { accountCode: r.code, accountName: r.name, debit: fromSatang(Math.max(v, 0)), credit: fromSatang(Math.max(-v, 0)), rule: `ภ.พ.30 เดือน ${monthLabelTh(period)} ช่อง ${box}: ${r.rule}` };
  });
  return lines.length ? [{ date, kind: 'original', postedAt: stamp(), lines }] : [];
}

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
  for (const e of [...st.bankJournals.filter((b) => b.companyId === companyId).flatMap((b) => b.entries), ...st.settlements.filter((s) => s.companyId === companyId).flatMap((s) => s.journal), ...st.filings.filter((f) => f.companyId === companyId && f.form !== 'PP30').flatMap((f) => f.journal ?? [])]) if (e.date.startsWith(period)) total += net(e.lines);
  return sign * total;
}

/** ภ.พ.36 self-assessed VAT claimable in the ภ.พ.30 of `period` (G2): the VAT of the finalized ภ.พ.36 of the PAYMENT month before it. [SP-R] ม.82/4 / ม.83/6: the ภ.พ.36 is filed and paid the month after the payment, and the VAT is input VAT of the month it is paid.
 *  A ภ.พ.36 of a company outside VAT (`claims` false) is cost (InputVatUnclaimed) and enters no ภ.พ.30. Each ภ.พ.36 is read by exactly one claim month. */
export const pp36VatOf = (st: MockState, companyId: string, period: string): number =>
  st.filings.filter((f) => f.companyId === companyId && f.form === 'PP36' && f.claims && f.period === prevMonth(period)).reduce((n, f) => n + boxOf(f.boxes, 'vat'), 0);
/** The ภ.พ.36 VAT booked into 1170 in `period` (the payment month) that the ภ.พ.30 of `period` does not claim (it claims next month): the named reconciling line of the input GL tie-out. */
export const pp36BookedIn = (st: MockState, companyId: string, period: string): number =>
  st.filings.filter((f) => f.companyId === companyId && f.form === 'PP36' && f.claims && f.period === period).reduce((n, f) => n + boxOf(f.boxes, 'vat'), 0);

export const tie = (labelKey: string, left: number, right: number, reconciling: { labelTh: string; amount: number }[] = []): TieOut => ({ labelKey, left: fromSatang(left), right: fromSatang(right),
  diff: fromSatang(left - right + reconciling.reduce((n, r) => n + r.amount, 0)), ...(reconciling.length ? { reconciling: reconciling.map((r) => ({ labelTh: r.labelTh, amount: fromSatang(r.amount) })) } : {}) });
/** The reconciling line for a ภ.พ.36 booked in `period`: the ledger holds `amount` that the month's return does not claim, so the sum adds it on the return's side (negative: it is on the ledger side). */
export const pp36Line = (period: string, amount: number) => (amount ? [{ labelTh: `ภ.พ.36 เดือน ${monthLabelTh(period)} (ลงบัญชีเดือนนี้ ขอเครดิตใน ภ.พ.30 เดือนถัดไป)`, amount }] : []);

// ---------------------------------------------------------------- the registers (reports)

const MONEY: ReportColumn['kind'] = 'money';
const reg = (kind: 'vat-output-register' | 'vat-input-register', titleKey: string, docs: Pp30Doc[], params: Record<string, string>, tieOuts: TieOut[]): ReportModel => {
  const out = kind === 'vat-output-register';
  const columns: ReportColumn[] = [{ key: 'date', labelKey: 'filing.reg.date', kind: 'date' }, { key: 'number', labelKey: 'filing.reg.number' }, { key: 'party', labelKey: 'filing.reg.party' }, { key: 'tin', labelKey: 'filing.reg.tin' }, { key: 'branch', labelKey: 'filing.reg.branch' },
    { key: 'description', labelKey: 'filing.reg.description' }, ...(out
      ? [{ key: 'base7', labelKey: 'filing.reg.base7', kind: MONEY, align: 'end' as const }, { key: 'base0', labelKey: 'filing.reg.base0', kind: MONEY, align: 'end' as const }, { key: 'baseEx', labelKey: 'filing.reg.baseEx', kind: MONEY, align: 'end' as const }]
      : [{ key: 'base7', labelKey: 'filing.reg.claimedBase', kind: MONEY, align: 'end' as const }]), { key: 'vat', labelKey: 'filing.reg.vat', kind: MONEY, align: 'end' as const }];
  const mine = docs.filter((d) => d.kind === (out ? 'out' : 'in'));
  const row = (d: Pp30Doc, c: Partial<ReportRow['cells']>): ReportRow => ({ level: 0, kind: 'row', href: docViewHref(d.type, d.id), cells: { date: d.date, number: d.number ?? d.id, party: d.partyName ?? '', tin: d.tin ?? '', branch: d.branch ?? '', description: d.description, base7: d.base7, base0: d.base0, baseEx: d.baseEx, vat: d.vat, ...c } });
  // M6: the input register is the buyer's list of VENDOR tax invoices: the vendor's number and date (ours only when the paper was not recorded), and an expense claim gives one row per vendor invoice
  const rows: ReportRow[] = mine.flatMap((d) => (out ? [row(d, {})] : d.invoices?.length
    ? d.invoices.map((v) => row(d, { date: v.date, number: v.number, party: v.name, tin: v.tin, branch: '', base7: v.base7, vat: v.vat }))
    : [row(d, { date: d.vendorDocDate ?? d.date, number: d.vendorDocNo ?? d.number ?? d.id })]));
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
export const fnv = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

/** The month the company's chain of ภ.พ.30 starts at: its FIRST finalized one (ruling 4: months before it are before TEAS took over filing). */
export const chainStart = (st: MockState, companyId: string, form: FilingForm = 'PP30'): string | undefined =>
  st.filings.filter((f) => f.companyId === companyId && f.form === form).map((f) => f.period).sort()[0];
const filedIn = (st: MockState, companyId: string, period: string, form: FilingForm = 'PP30') => st.filings.find((f) => f.companyId === companyId && f.form === form && f.period === period);
/** The blockers every monthly form shares (ruling 4): a month still open (B1a), a month before the form's chain, a previous month of the same form not finalized. `href` opens that form's page for a month. */
export function chainBlockers(st: MockState, companyId: string, form: FilingForm, period: string, name: string, href: (p: string) => string, owed?: (p: string) => boolean): FilingBlocker[] {
  const out: FilingBlocker[] = [];
  if (period >= today().slice(0, 7)) out.push({ code: 'period_not_ended', labelTh: `เดือน ${monthLabelTh(period)} ยังไม่สิ้นเดือน ยืนยันแบบ ${name} ได้หลังสิ้นเดือน` }); // B1a: a month still open would be filed before its last document
  const start = chainStart(st, companyId, form);
  if (start && period < start) out.push({ code: 'before_chain', labelTh: `งวดนี้อยู่ก่อนงวดแรกที่ยื่นในระบบ (${monthLabelTh(start)})` });
  else if (start && period > start) {
    // a monthly form owes the month before it; a form whose months can be empty (WHT, ภ.พ.36: `owed`) owes the first earlier month of the chain that HAS documents and is not finalized
    let p = owed ? start : prevMonth(period);
    for (; p < period; p = nextMonth(p)) if ((!owed || owed(p)) && !filedIn(st, companyId, p, form)) { out.push({ code: 'previous_open', labelTh: `ยังไม่ได้ยืนยันแบบ ${name} เดือน ${monthLabelTh(p)}`, href: href(p) }); break; }
  }
  return out;
}

export function blockersOf(st: MockState, companyId: string, period: string): FilingBlocker[] {
  const out: FilingBlocker[] = [];
  const co = st.companies.find((c) => c.id === companyId);
  if (!co || !isValidTin(co.taxId)) out.push({ code: 'company_tin', labelTh: 'เลขประจำตัวผู้เสียภาษีของบริษัทไม่ถูกต้องหรือเป็นเลขสมมติ แก้ที่ตั้งค่าบริษัทก่อนยื่น', href: '/settings/company' });
  for (const d of st.docs.filter((x) => x.companyId === companyId && OUT.includes(x.type) && DRAFTISH.includes(x.status) && x.header.documentDate.startsWith(period)).sort((a, b) => a.header.documentDate.localeCompare(b.header.documentDate) || a.id.localeCompare(b.id))) {
    out.push({ code: 'draft_document', labelTh: `${d.type} ฉบับร่างลงวันที่ ${formatDateBE(d.header.documentDate)} ยังไม่ได้ออก`, href: docEditHref(d.type, d.id) });
  }
  if (pp36Rows(st, companyId, period).length && !filedIn(st, companyId, period, 'PP36')) { // H1: the ภ.พ.36 is due the 7th, the ภ.พ.30 the 15th; filed the other way round its VAT could never be claimed
    out.push({ code: 'pp36_open', labelTh: `ยังไม่ได้ยืนยันแบบ ภ.พ.36 เดือน ${monthLabelTh(period)}`, href: `/tax/wht?tab=pp36&period=${period}` });
  }
  out.push(...chainBlockers(st, companyId, 'PP30', period, 'ภ.พ.30', (p) => `/tax/vat?period=${p}`));
  return out;
}

/** The ภ.พ.30 of a month AS IT WOULD BE FILED NOW (always computed; `getFiling` in index.ts reads a finalized one from its snapshot). `version` fingerprints the documents and boxes, so finalize refuses a preview that went stale. */
export function pp30Model(st: MockState, companyId: string, period: string): FilingModel {
  requireVat(st, companyId);
  if (!PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const docs = pp30Docs(st, companyId, period), prev = filedIn(st, companyId, prevMonth(period));
  const carryIn = prev ? boxOf(prev.boxes, '12') : 0, pp36 = pp36VatOf(st, companyId, period);
  const boxes = pp30Boxes(docs, carryIn, pp36, period);
  const warnings = boxOf(boxes, '12') > 0 ? ['ภาษีชำระเกิน ยกไปหักในเดือนถัดไป (ค่าเริ่มต้น ขอคืนเป็นเงินต้องทำนอกระบบนี้)'] : [];
  const base: FilingModel = { form: 'PP30', period, status: 'draft', boxes, tieOuts: [], blockers: blockersOf(st, companyId, period), warnings, version: fnv(JSON.stringify([docs, carryIn, pp36])), dueDate: dueDateOf(period), exports: ['rdprep-txt', 'pdf'] };
  const tieOuts = [
    tie('filing.tie.outputGl', boxOf(boxes, '5'), glMovement(st, companyId, '2151', period)),
    tie('filing.tie.inputGl', boxOf(boxes, '7') - pp36, glMovement(st, companyId, '1170', period), pp36Line(period, pp36BookedIn(st, companyId, period))),
    tie('filing.tie.outputRegister', boxOf(boxes, '5'), sat(reg('vat-output-register', '', docs, {}, []).rows.find((r) => r.kind === 'total')?.cells.vat)),
    tie('filing.tie.inputRegister', boxOf(boxes, '7') - pp36, sat(reg('vat-input-register', '', docs, {}, []).rows.find((r) => r.kind === 'total')?.cells.vat)),
  ];
  return { ...base, tieOuts };
}
const getModel = (st: MockState, companyId: string, period: string): FilingModel => {
  const f = filedIn(st, companyId, period);
  return f ? { form: 'PP30', period, status: 'finalized', boxes: f.boxes, tieOuts: f.tieOuts, blockers: [], warnings: [], finalizedAt: f.finalizedAt, finalizedBy: f.finalizedBy, company: f.company, version: 1, dueDate: f.dueDate, exports: ['rdprep-txt', 'pdf'] } : pp30Model(st, companyId, period);
};
export { getModel as getPp30, dueDateOf };
