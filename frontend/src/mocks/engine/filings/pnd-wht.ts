import { LIVE } from '@/domain/doc-types';
import type { FilingBlocker, FilingBox, FilingModel } from '@/domain/filings';
import type { IsoDate } from '@/domain/types';
import { isValidTin } from '@/domain/tin';
import { formatDateBE } from '@/lib/format';
import type { MockState } from '../../store';
import { MockError } from '../log';
import { fromSatang, toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { resolveRole } from '../posting';
import { freezeWht } from '../settlement';
import { whtTypeOf } from '../wht';
import { type DocLike, type Filing, PERIOD, type WhtRow, boxOf, chainBlockers, fnv, tie } from './pp30';

/** TX2: the withholding returns. [SP-R] the four returns, their routing (`header.form` of the certificate), the due day, the attachment columns and the payer's condition wording are mock rules, not ruled positions. */
export const PND_FORMS = ['PND2', 'PND3', 'PND53', 'PND54'] as const;
export type PndForm = (typeof PND_FORMS)[number];
export const isPnd = (f: string): f is PndForm => (PND_FORMS as readonly string[]).includes(f);
const NAME: Record<string, string> = { PND2: 'ภ.ง.ด.2', PND3: 'ภ.ง.ด.3', PND53: 'ภ.ง.ด.53', PND54: 'ภ.ง.ด.54', PP36: 'ภ.พ.36', PP30: 'ภ.พ.30' };
export const formName = (f: string): string => NAME[f] ?? f;
/** [SP-R] a ภ.ง.ด. is due on the 7th of the following month (e-filing is extended to the 15th; the mock keeps the paper date). */
export const pndDue = (p: string): IsoDate => { const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7)); return m === 12 ? `${y + 1}-01-07` : `${y}-${String(m + 1).padStart(2, '0')}-07`; };
const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
/** [SP-R] the payer's condition as the attachment prints it. */
const CONDITION: Record<string, string> = { deduct: 'หัก ณ ที่จ่าย', grossup_always: 'ออกให้ตลอดไป', grossup_once: 'ออกให้ครั้งเดียว' };
type Stored = MockState['docs'][number];

/** The row a certificate makes in its return: the payee as the voucher stored it, the figures, the payer's condition. Undefined = not a live certificate. */
export function whtRowOfWt(st: MockState, wt: Stored): WhtRow | undefined {
  if (wt.type !== 'WT' || !LIVE.includes(wt.status) || !wt.header.whtForm) return undefined;
  const pvId = st.links.find((l) => l.active && l.kind === 'issues' && l.to === wt.id)?.from ?? '';
  const pv = st.docs.find((d) => d.id === pvId), p = wt.party, code = wt.header.whtTypeCode ?? '';
  const f = pv?.whtFrozen?.lines.find((l) => l.code === code);
  return { id: wt.id, pvId, ...(wt.number ? { number: wt.number } : {}), date: wt.header.documentDate, ...(wt.header.partyId ? { partyId: wt.header.partyId } : {}), partyName: p?.name ?? '', tin: p?.taxId ?? '',
    branch: p?.branchCode ?? '', address: p?.address ?? '', entityKind: p?.entityKind ?? '', code, incomeType: wt.header.whtIncomeType ?? '', nameTh: f?.nameTh ?? '', rate: f?.rate ?? '', form: wt.header.whtForm,
    income: wt.totals.total, tax: wt.header.whtTax ?? '0.00', condition: pv?.header.whtMode ?? 'deduct' };
}
/** What the filing noticed: a payee or a figure moving changes the key. The number, the display name of the type and the rate text stay outside (the rate is in the tax). */
export const whtKey = (r: Omit<WhtRow, 'id' | 'pvId'>) => JSON.stringify([r.date, r.partyId ?? '', r.tin, r.branch, r.address, r.code, r.incomeType, r.form, r.income, r.tax, r.condition]);

/** The rows a voucher WOULD give for this header / lines / allocations / stored WHT (the lock compares them with what the return took). The payee is the voucher's stored party. */
export function wantedWhtRows(st: MockState, pv: DocLike & { whtFrozen?: Stored['whtFrozen'] }, next: { header: DocLike['header']; lines: DocLike['lines']; allocations?: Stored['allocations']; whtFrozen?: Stored['whtFrozen'] }): Omit<WhtRow, 'id' | 'pvId'>[] {
  if (pv.type !== 'PV' || !pv.party) return [];
  const f = next.whtFrozen ?? pv.whtFrozen ?? freezeWht(st, pv.companyId, { header: next.header, lines: next.lines, ...(next.allocations ? { allocations: next.allocations } : {}) }, pv.id);
  const p = pv.party;
  return f.lines.map((l) => ({ date: next.header.documentDate, ...(next.header.partyId ? { partyId: next.header.partyId } : {}), partyName: p.name ?? '', tin: p.taxId ?? '', branch: p.branchCode ?? '', address: p.address ?? '',
    entityKind: (p as { entityKind?: string }).entityKind ?? '', code: l.code, incomeType: whtTypeOf(st, l.code, p as never, next.header.documentDate).incomeType, nameTh: l.nameTh, rate: l.rate, form: l.form, income: l.income, tax: l.tax,
    condition: next.header.whtMode ?? 'deduct' }));
}

/** The live certificates of a form in a month (computed from the documents, I12). */
export function pndRows(st: MockState, companyId: string, form: PndForm, period: string): WhtRow[] {
  return st.docs.filter((d) => d.companyId === companyId && d.type === 'WT' && d.header.whtForm === form && d.header.documentDate.startsWith(period))
    .flatMap((d) => { const r = whtRowOfWt(st, d); return r ? [r] : []; }).sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? a.id).localeCompare(b.number ?? b.id));
}

const COLUMNS = [['no', 'ลำดับ'], ['tin', 'เลขประจำตัวผู้เสียภาษี'], ['name', 'ชื่อผู้มีเงินได้'], ['address', 'ที่อยู่'], ['incomeType', 'ประเภทเงินได้'], ['date', 'วันที่จ่าย'], ['income', 'จำนวนเงินที่จ่าย'], ['tax', 'ภาษีที่หัก'], ['condition', 'เงื่อนไข']] as const;
/** The attachment table of a return from its rows. */
export const pndAttachment = (rows: WhtRow[]): NonNullable<FilingModel['attachment']> => ({ columns: COLUMNS.map(([key, labelTh]) => ({ key, labelTh })),
  rows: rows.map((r, i) => ({ no: String(i + 1), tin: r.tin, name: r.partyName, address: r.address, incomeType: r.incomeType, date: formatDateBE(r.date), income: r.income, tax: r.tax, condition: CONDITION[r.condition] ?? r.condition })) });

/** Boxes from the rows: the number of payees (one per payee, by TIN or else by party), Σ income, Σ tax. */
export function pndBoxes(rows: WhtRow[]): FilingBox[] {
  const payees = new Set(rows.map((r) => r.tin || r.partyId || r.partyName)).size;
  const sum = (f: (r: WhtRow) => string) => rows.reduce((n, r) => n + sat(f(r)), 0);
  return [{ code: 'payees', labelTh: 'จำนวนผู้มีเงินได้ (ราย)', amount: String(payees), kind: 'count' }, { code: 'income', labelTh: 'เงินได้ที่จ่ายทั้งสิ้น', amount: fromSatang(sum((r) => r.income)) }, { code: 'tax', labelTh: 'ภาษีที่หักและนำส่งทั้งสิ้น', amount: fromSatang(sum((r) => r.tax)) }];
}

/** GL credit movement (credit - debit) of the form's WHT payable account for the vouchers of the month (by the voucher's document month), from voucher journals. 2131 / 2132 / 2135 / 2134 by the posting profile. */
export function whtGl(st: MockState, companyId: string, form: PndForm, period: string): number {
  const code = resolveRole(st, 'WhtPayable', { companyId, docType: 'PV', whtForm: form }).code;
  let n = 0;
  for (const j of st.journals) {
    const d = st.docs.find((x) => x.id === j.docId);
    if (!d || d.companyId !== companyId || d.type !== 'PV') continue;
    if (!d.header.documentDate.startsWith(period)) continue; // M1: a voucher's entries (a later cancel's reversal included) belong to its own month, like TX1's glMovement
    for (const e of j.preview.entries) for (const l of e.lines) if (l.accountCode === code) n += sat(l.credit) - sat(l.debit);
  }
  return n;
}
export const pndTies = (st: MockState, companyId: string, form: PndForm, period: string, boxes: FilingBox[]) => [tie('filing.tie.pndGl', boxOf(boxes, 'tax'), whtGl(st, companyId, form, period))];

export function pndBlockers(st: MockState, companyId: string, form: PndForm, period: string, rows: WhtRow[]): FilingBlocker[] {
  const out: FilingBlocker[] = [];
  const co = st.companies.find((c) => c.id === companyId);
  if (!co || !isValidTin(co.taxId)) out.push({ code: 'company_tin', labelTh: 'เลขประจำตัวผู้เสียภาษีของบริษัทไม่ถูกต้องหรือเป็นเลขสมมติ แก้ที่ตั้งค่าบริษัทก่อนยื่น', href: '/settings/company' });
  if (!rows.length) out.push({ code: 'no_documents', labelTh: `เดือน ${monthLabelTh(period)} ไม่มีหนังสือรับรองที่ต้องยื่น ${formName(form)}` });
  if (form !== 'PND54') for (const [key, r] of new Map(rows.filter((x) => !isValidTin(x.tin)).map((x) => [x.partyId ?? x.partyName, x]))) { // I10: a return names every payee by a real TIN (a foreign payee, ภ.ง.ด.54, has none)
    out.push({ code: 'payee_tin', labelTh: `ผู้รับเงิน ${r.partyName} ไม่มีเลขประจำตัวผู้เสียภาษี`, ...(r.partyId ? { href: `/master/vendors/${key}` } : {}) });
  }
  if (form === 'PND2') for (const r of rows.filter((x) => !x.incomeType)) out.push({ code: 'income_code', labelTh: `ใบรับรอง ${r.number ?? r.id} ไม่มีรหัสประเภทเงินได้ (ภ.ง.ด.2 ต้องมีทุกรายการ)` }); // TEAS 1 wht_batch.missing_income_code
  out.push(...chainBlockers(st, companyId, form, period, formName(form), (p) => `/tax/wht?tab=${form.toLowerCase()}&period=${p}`, (p) => pndRows(st, companyId, form, p).length > 0));
  return out;
}

/** The return of a month as it would be filed NOW; \`version\` fingerprints the rows so finalize refuses a preview that went stale. */
export function pndModel(st: MockState, companyId: string, form: PndForm, period: string): FilingModel {
  if (!PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const rows = pndRows(st, companyId, form, period), boxes = pndBoxes(rows);
  return { form, period, status: 'draft', boxes, tieOuts: pndTies(st, companyId, form, period, boxes), blockers: pndBlockers(st, companyId, form, period, rows), warnings: [], attachment: pndAttachment(rows),
    version: fnv(JSON.stringify(rows)), dueDate: pndDue(period), exports: form === 'PND54' ? ['pdf'] : ['rdprep-txt', 'pdf'] };
}
export const pndSnapshot = (st: MockState, companyId: string, form: PndForm, period: string): Pick<Filing, 'wht' | 'docs' | 'carryIn' | 'pp36'> => ({ wht: pndRows(st, companyId, form, period), docs: [], carryIn: '0.00', pp36: '0.00' });
