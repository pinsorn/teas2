import { docViewHref } from '@/descriptors';
import { formatDateBE } from '@/lib/format';
import { ADJUSTS, LIVE } from '@/domain/doc-types';
import type { Actor, AssetData, Disposal, DocHeader, DocLine, DocOpening, DocTotals, DocType, DpData, DpRow, FaCodes, FaSource, IsoDate, JournalLinePreview, Lock, Money, PartySummary } from '@/domain/types';
import type { MockState } from '../store';
import { approvalRequired } from './approval';
import { allocate, approveAndIssue, correctionReversal, createDraft, dateGuards, issue, newId, placed, publicDoc, put, setJournal, stableJson } from './commands';
import { payoutOf } from './settlement';
import { bahtText } from './bahtText';
import { ledgerFor } from './ledger';
import { MockError, isPinned, logActivity, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { nextDay } from './opening';
import { isClosed, monthLabelTh, yearClosed } from './periods';
import { resolveRole } from './posting';
import { categoryOf, isRecoverable } from './purchase-vat';
import { addMonths, lastDayOf, validDate } from './schedules';
import { computeDoc, vatBasisOf, vatOf } from './vat';

// AC5: fixed assets (FA) and depreciation runs (DP). An FA comes from a source that already posted its cost (a PB / PV capex line, or an opening-balance asset row): registering it posts NOTHING. Everything that drives the
// numbers is FROZEN when the asset is registered (CLAUDE.md freeze rule): cost, salvage, life, start, class, opening accumulated and the four account codes. A DP stores its own per-asset rows and posts exactly those.

type Stored = MockState['docs'][number];
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const sat = (m: string | undefined): number => { try { return toSatang(m ?? '0.00'); } catch { return NaN; } };
const MAX_LIFE = 600;

// ---------------------------------------------------------------- the monthly amount

/** Round half away from zero for n / d with n >= 0 (integer satang, no floats). */
const rd = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));
const monthIdx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const daysIn = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
type Terms = Pick<AssetData, 'cost' | 'salvage' | 'lifeMonths' | 'startDate'>;

/** What `month` depreciates (satang), given what the asset has already accumulated: straight line, `round((cost - salvage) / life)` a month; the start month is prorated by the days from the start date to month end
 *  (15 Aug of 31 days = 17 days); the closing month (the life's last, 1st-of-month start; the month after it otherwise) takes the remainder; never beyond cost - salvage - accumulated.
 *  `throughDay`: depreciate only up to that day of the month (the disposal month, prorated to the disposal date). */
export function monthAmount(a: Terms, month: string, accumulated: number, throughDay?: number): number {
  const cost = sat(a.cost), salvage = sat(a.salvage), cap = cost - salvage - accumulated;
  if (!(cap > 0)) return 0;
  const idx = monthIdx(month) - monthIdx(a.startDate.slice(0, 7));
  if (idx < 0) return 0;
  const startDay = Number(a.startDate.slice(8, 10)), dim = daysIn(month), last = startDay === 1 ? a.lifeMonths - 1 : a.lifeMonths;
  if (idx > last) return cap;
  const base = idx === last ? cap : rd(cost - salvage, a.lifeMonths);
  const from = idx === 0 ? startDay : 1, to = Math.min(throughDay ?? dim, dim);
  if (to < from) return 0;
  const days = to - from + 1;
  return Math.min(days === dim ? base : rd(base * days, dim), cap);
}

/** What `month` depreciates for an asset whose first run is `month` (= depFrom) after a late registration: every month from catchUpFrom through `month`, each by `monthAmount` on what the earlier ones accumulated (AC7a). Otherwise just the month.
 *  `throughDay`: only the last month, up to that day (a disposal). `catchUp` is set when more than the month itself is in the amount (`months` counts the run month). */
export function dueIn(a: Terms & { depFrom: string; catchUpFrom?: string }, month: string, accumulated: number, throughDay?: number): { amount: number; catchUp?: { from: string; months: number } } {
  const from = a.catchUpFrom && month === a.depFrom ? a.catchUpFrom : month;
  let amount = 0;
  for (let m = from; m <= month; m = addMonths(m, 1)) amount += monthAmount(a, m, accumulated + amount, m === month ? throughDay : undefined);
  return { amount, ...(from < month ? { catchUp: { from, months: monthIdx(month) - monthIdx(from) + 1 } } : {}) };
}
/** The first month an asset depreciates in, and its catch-up: the natural month, unless a live run already covers it - then the month after the latest run, with the natural month as `catchUpFrom`. */
const firstMonths = (st: MockState, companyId: string, natural: string): { depFrom: string; catchUpFrom?: string } => {
  const latest = liveDps(st, companyId).at(-1);
  return latest && natural <= latest.dp!.month ? { depFrom: addMonths(latest.dp!.month, 1), catchUpFrom: natural } : { depFrom: natural };
};

// ---------------------------------------------------------------- reading

const docOf = (st: MockState, id: string | undefined) => (id ? st.docs.find((d) => d.id === id) : undefined);
export const liveFas = (st: MockState, companyId: string): Stored[] => st.docs.filter((d) => d.companyId === companyId && d.type === 'FA' && LIVE.includes(d.status) && !!d.asset);
export const liveDps = (st: MockState, companyId: string): Stored[] => st.docs.filter((d) => d.companyId === companyId && d.type === 'DP' && LIVE.includes(d.status) && !!d.dp).sort((a, b) => a.dp!.month.localeCompare(b.dp!.month));
const sameSource = (a: FaSource, b: FaSource) => a.docId === b.docId && (a.kind === 'bill' ? b.kind === 'bill' && a.lineId === b.lineId : b.kind === 'ob' && a.rowId === b.rowId);
export const faOfSource = (st: MockState, companyId: string, source: FaSource): Stored | undefined => liveFas(st, companyId).find((f) => sameSource(f.asset!.source, source));
const plainTotals = (m: Money): DocTotals => ({ gross: m, discount: '0.00', net: m, vat: '0.00', total: m, amountInWords: bahtText(m) });

// ---------------------------------------------------------------- sources

interface Resolved { name: string; cost: number; assetClass: string; startDate?: IsoDate; lifeMonths?: number; opening: number; depFrom?: string; docDate: IsoDate; number: string; party?: PartySummary; partyId?: string; codes: Partial<FaCodes> }
/** Live PCN / PDN on a bill line (they move what the bill capitalised): the cost of the asset would be ambiguous. */
const notesOn = (st: MockState, billId: string, lineId: string) =>
  st.docs.filter((n) => (n.type === 'PCN' || n.type === 'PDN') && LIVE.includes(n.status) && n.header.refDocId === billId && n.lines.some((l) => l.sourceLineId === lineId));

/** What a source posted for the asset: a PB capex line the way the bill capitalised it (the VAT only when it could not be claimed), a PV's own capex line (VAT is cost), or an opening-balance asset row. */
function resolveSource(st: MockState, companyId: string, source: FaSource): Resolved {
  const bad = (m: string) => fail(422, 'fa.source_invalid', m);
  const d = docOf(st, source?.docId);
  if (!d || d.companyId !== companyId || !LIVE.includes(d.status)) throw bad('ต้องเลือกรายการจากบันทึกซื้อ (PB) ใบสำคัญจ่าย (PV) หรือยอดยกมาที่ออกแล้วและยังไม่ถูกยกเลิก');
  if (source.kind === 'ob') {
    const row = d.type === 'OB' && !d.header.obBatchId ? d.opening?.assets.find((a) => a.id === source.rowId) : undefined;
    if (!row) throw bad('ไม่พบรายการสินทรัพย์ในยอดยกมา');
    const cut = d.header.documentDate, from = nextDay(cut).slice(0, 7), start = row.acquired.slice(0, 7);
    return { name: row.name, cost: sat(row.cost), assetClass: row.assetClass, startDate: row.acquired, lifeMonths: row.lifeMonths, opening: sat(row.accumulated), depFrom: from > start ? from : start, docDate: cut, number: d.number ?? d.id,
      codes: { cost: d.opening?.codes?.[`FixedAsset:${row.assetClass}`], accumulated: d.opening?.codes?.[`AccumulatedDepreciation:${row.assetClass}`] } };
  }
  const i = d.type === 'PB' || d.type === 'PV' ? d.lines.findIndex((l) => l.id === source.lineId) : -1;
  const cat = i >= 0 ? categoryOf(st, companyId, d.lines[i]) : undefined;
  if (i < 0 || !cat?.capex || !cat.assetClass) throw bad('ลงทะเบียนสินทรัพย์ได้เฉพาะรายการหมวดซื้อสินทรัพย์ในบันทึกซื้อ (PB) หรือใบสำคัญจ่าย (PV) ที่ออกแล้ว');
  const r = computeDoc(d.lines, !!d.header.priceIncludesVat, vatBasisOf(st, companyId, d.type)).lines[i], l = d.lines[i];
  const cost = d.type === 'PB' && isRecoverable(st, companyId, l, d.header.inputVatForfeited) ? sat(r.net) : sat(r.net) + sat(r.vat);
  return { name: l.description, cost, assetClass: cat.assetClass, opening: 0, docDate: d.header.documentDate, number: d.number ?? d.id, ...(d.party ? { party: d.party } : {}), ...(d.header.partyId ? { partyId: d.header.partyId } : {}), codes: {} };
}

export interface UnregisteredRow { source: FaSource; docNumber: string; docType: 'PB' | 'PV' | 'OB'; description: string; assetClass: string; cost: Money; date: IsoDate; partyName?: string; accumulated?: Money; lifeMonths?: number }
/** The capex lines and opening-balance asset rows no live asset has been made from yet ("ยังไม่ได้ลงทะเบียน"), newest first. */
export function unregisteredCapex(st: MockState, companyId: string): UnregisteredRow[] {
  const out: UnregisteredRow[] = [];
  for (const d of st.docs) {
    if (d.companyId !== companyId || !LIVE.includes(d.status)) continue;
    if (d.type === 'OB' && !d.header.obBatchId) {
      for (const a of d.opening?.assets ?? []) if (a.id && !faOfSource(st, companyId, { kind: 'ob', docId: d.id, rowId: a.id })) {
        out.push({ source: { kind: 'ob', docId: d.id, rowId: a.id }, docNumber: d.number ?? d.id, docType: 'OB', description: a.name, assetClass: a.assetClass, cost: fromSatang(sat(a.cost)), accumulated: fromSatang(sat(a.accumulated)), lifeMonths: a.lifeMonths, date: a.acquired });
      }
    } else if (d.type === 'PB' || d.type === 'PV') {
      for (const l of d.lines) {
        const source: FaSource = { kind: 'bill', docId: d.id, lineId: l.id };
        if (!categoryOf(st, companyId, l)?.capex || faOfSource(st, companyId, source) || notesOn(st, d.id, l.id).length) continue;
        try { const r = resolveSource(st, companyId, source); out.push({ source, docNumber: d.number ?? d.id, docType: d.type, description: l.description, assetClass: r.assetClass, cost: fromSatang(r.cost), date: d.header.documentDate, ...(d.party ? { partyName: d.party.name } : {}) }); } catch { /* not a usable source */ }
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.docNumber.localeCompare(b.docNumber));
}

// ---------------------------------------------------------------- registering

export interface ActivateInput { source: FaSource; name?: string; salvage?: Money; lifeMonths?: number; startDate?: IsoDate }
/** The terms an asset needs to be sane. Returns the cleaned figures (satang) or refuses. */
function checkTerms(cost: number, opening: number, name: string, salvageIn: string | undefined, life: unknown, start: unknown): { salvage: number; life: number; start: IsoDate } {
  const bad = (m: string) => fail(422, 'fa.invalid', m);
  if (!name.trim()) throw bad('ต้องตั้งชื่อสินทรัพย์');
  const salvage = sat(salvageIn ?? '0.00');
  if (!Number.isFinite(salvage) || salvage < 0 || salvage >= cost) throw bad('มูลค่าซาก (salvage) ต้องไม่ติดลบและน้อยกว่าราคาทุน');
  if (typeof life !== 'number' || !Number.isInteger(life) || life < 1 || life > MAX_LIFE) throw bad(`อายุการใช้งานต้องเป็นจำนวนเดือนเต็ม 1 ถึง ${MAX_LIFE}`);
  if (!validDate(start)) throw bad('วันที่เริ่มใช้งานไม่ถูกต้อง');
  if (opening + salvage > cost) throw bad('ค่าเสื่อมราคาสะสมยกมารวมมูลค่าซากต้องไม่เกินราคาทุน');
  return { salvage, life, start };
}

/** resume ruling: a bill's asset cannot be in service before its bill (an opening row's depreciation starts the month after the cut-off by construction). */
const beforeSource = (r: Resolved, kind: FaSource['kind'], start: IsoDate) => {
  if (kind === 'bill' && start < r.docDate) throw fail(422, 'fa.before_source', `วันที่เริ่มใช้งานต้องไม่ก่อนวันที่ของเอกสารที่ซื้อ (${r.docDate}) ทางออก: ใช้วันที่ ${r.docDate} หรือหลังจากนั้น`);
};
const roleCode = (st: MockState, companyId: string, role: Parameters<typeof resolveRole>[1], extra: Partial<Parameters<typeof resolveRole>[2]> = {}) => resolveRole(st, role, { companyId, docType: 'FA', ...extra }).code;

/** Registers an asset from its source. No journal: the source already debited the cost (and an opening batch the accumulated depreciation). `opts.date`: the registration date (the business date unless a seed replays history). */
export function activateAsset(st: MockState, companyId: string, input: ActivateInput, actor: Actor, opts?: { id?: string; date?: IsoDate }): Stored {
  const r = resolveSource(st, companyId, input.source);
  const taken = faOfSource(st, companyId, input.source);
  if (taken) throw fail(409, 'fa.source_taken', `รายการนี้ลงทะเบียนเป็นสินทรัพย์ ${taken.number} แล้ว ทางออก: ยกเลิกสินทรัพย์นั้นก่อน (ทำได้เมื่อยังไม่มีค่าเสื่อมราคาหรือการจำหน่าย)`);
  if (input.source.kind === 'bill' && notesOn(st, input.source.docId, input.source.lineId).length) throw fail(422, 'fa.source_noted', 'รายการนี้มีใบลดหนี้/ใบเพิ่มหนี้จากผู้ขายอยู่ ราคาทุนจึงไม่แน่นอน ทางออก: ยกเลิกใบลดหนี้/ใบเพิ่มหนี้ก่อนลงทะเบียน');
  const name = (input.name ?? r.name), life = input.source.kind === 'ob' ? input.lifeMonths ?? r.lifeMonths : input.lifeMonths;
  const t = checkTerms(r.cost, r.opening, name, input.salvage, life, input.source.kind === 'ob' ? r.startDate : input.startDate);
  beforeSource(r, input.source.kind, t.start);
  const first = firstMonths(st, companyId, r.depFrom ?? t.start.slice(0, 7));
  const cls = r.assetClass;
  const codes: FaCodes = { cost: r.codes.cost ?? roleCode(st, companyId, 'FixedAsset', { assetClass: cls }), accumulated: r.codes.accumulated ?? roleCode(st, companyId, 'AccumulatedDepreciation', { assetClass: cls }),
    expense: roleCode(st, companyId, 'DepreciationExpense'), gain: roleCode(st, companyId, 'DisposalGainLoss', { outcome: 'gain' }), loss: roleCode(st, companyId, 'DisposalGainLoss', { outcome: 'loss' }) };
  const at = stamp(), id = opts?.id ?? newId(st, 'FA'), date = opts?.date ?? today(), cost = fromSatang(r.cost);
  const asset: AssetData = { name: name.trim(), assetClass: cls, cost, salvage: fromSatang(t.salvage), lifeMonths: t.life, method: 'straight_line', startDate: t.start, ...first, opening: fromSatang(r.opening),
    source: input.source, codes, accumulated: fromSatang(r.opening), nbv: fromSatang(r.cost - r.opening) };
  const d: Stored = { companyId, id, type: 'FA', number: allocate(st, companyId, 'FA', date), status: 'issued', correctionClass: 'L', revision: 0, version: 1,
    header: { documentDate: date, reference: r.number, ...(r.partyId ? { partyId: r.partyId } : {}) }, ...(r.party ? { party: r.party } : {}), lines: [], totals: plainTotals(cost), locks: [], createdBy: actor, issuedAt: at, asset };
  st.docs.push(d);
  st.revisions.push({ docId: id, revision: 0, at, actor, snapshot: publicDoc(d), diff: [] });
  logActivity(st, id, actor, 'issue', `ลงทะเบียนจาก ${r.number}`);
  logAudit(st, actor, companyId, 'fa.activate', id, undefined, { number: d.number, cost, source: input.source });
  return d;
}

// ---------------------------------------------------------------- depreciation runs

const validMonth = (m: unknown): m is string => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
/** What a live asset has accumulated: the opening figure, every live run's row for it and the disposal-month partial. `exclude`: a run being recomputed (its own row does not count). */
export function accumulatedOf(st: MockState, fa: Stored, exclude?: string): number {
  const rows = st.docs.filter((d) => d.type === 'DP' && d.companyId === fa.companyId && LIVE.includes(d.status) && d.id !== exclude).flatMap((d) => d.dp?.rows ?? []).filter((r) => r.assetId === fa.id);
  return sat(fa.asset!.opening) + rows.reduce((n, r) => n + sat(r.amount), 0) + sat(fa.asset!.disposed?.partial);
}
/** Brings the stored running figures of an asset (accumulated, net book value) in line with its live rows. Every command that moves them calls it. */
export function refreshFa(st: MockState, faId: string): void {
  const fa = docOf(st, faId);
  if (!fa?.asset) return;
  const acc = accumulatedOf(st, fa);
  put(st, { ...fa, version: fa.version + 1, asset: { ...fa.asset, accumulated: fromSatang(acc), nbv: fromSatang(sat(fa.asset.cost) - acc) } });
}

/** The first month in [from, to) no live run covers. */
const uncoveredMonth = (st: MockState, companyId: string, from: string, to: string): string | undefined => {
  const have = new Set(liveDps(st, companyId).map((d) => d.dp!.month));
  for (let m = from; m < to; m = addMonths(m, 1)) if (!have.has(m)) return m;
  return undefined;
};

export interface DpPlan { month: string; date: IsoDate; rows: DpRow[]; total: Money; problem?: MockError }
/** The run of `month` as it would be written now: one row per live asset that depreciates in it, and the first thing that refuses it. `reviseId`: a run being recomputed (judged without its own rows and without the "already run" / order guards). */
export function planDepreciation(st: MockState, companyId: string, month: string, reviseId?: string): DpPlan {
  if (!validMonth(month)) throw fail(422, 'dp.invalid', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const date = lastDayOf(month), rows: DpRow[] = [];
  let problem: MockError | undefined;
  const live = liveDps(st, companyId), latest = live[live.length - 1];
  if (!reviseId) {
    if (live.some((d) => d.dp!.month === month)) problem = fail(409, 'dp.already_run', `งวด ${monthLabelTh(month)} คิดค่าเสื่อมราคาแล้ว คิดซ้ำไม่ได้ (ถ้าต้องการคิดใหม่ ให้ยกเลิกหรือแก้ไขรายการของงวดนั้นก่อน ทำได้เฉพาะงวดล่าสุด)`);
    else if (latest && month !== addMonths(latest.dp!.month, 1)) problem = fail(422, 'dp.out_of_order', `ต้องคิดค่าเสื่อมราคาตามลำดับต่อเนื่อง งวดถัดไปคือ ${monthLabelTh(addMonths(latest.dp!.month, 1))}`);
  }
  if (!problem && date > today()) problem = fail(422, 'dp.not_due', `งวด ${monthLabelTh(month)} ยังไม่สิ้นสุด (คิดค่าเสื่อมราคาได้เมื่อพ้นสิ้นเดือน ระบบไม่ลงรายการล่วงหน้า)`);
  if (!isPinned() && yearClosed(st, companyId, date)) problem = fail(422, 'period.year_closed', `ปีบัญชี ${Number(month.slice(0, 4)) + 543} ปิดแล้ว คิดค่าเสื่อมราคางวด ${monthLabelTh(month)} ไม่ได้ ทางออก: เปิดปีบัญชีอีกครั้ง (หน้าปิดงวดบัญชี)`);
  if (!problem && !isPinned() && isClosed(st, companyId, date)) problem = fail(422, 'period.closed', `งวดบัญชี ${monthLabelTh(month)} ปิดแล้ว ทางออก: เปิดงวดบัญชีอีกครั้ง (หน้าปิดงวด) แล้วคิดค่าเสื่อมราคา`);
  for (const fa of liveFas(st, companyId).sort((a, b) => (a.number ?? '').localeCompare(b.number ?? ''))) {
    const a = fa.asset!;
    if (a.disposed || a.depFrom > month) continue;
    const gap = uncoveredMonth(st, companyId, a.depFrom, month);
    if (gap && !problem) problem = fail(409, 'dp.asset_behind', `สินทรัพย์ ${fa.number} ${a.name} ยังไม่มีค่าเสื่อมราคางวด ${monthLabelTh(gap)} ทางออก: คิดค่าเสื่อมราคางวดนั้นก่อน (เปิดงวดบัญชีอีกครั้งถ้างวดนั้นปิดแล้ว)`);
    const { amount, catchUp } = dueIn(a, month, accumulatedOf(st, fa, reviseId));
    if (amount > 0) rows.push({ assetId: fa.id, assetNumber: fa.number, name: a.name, assetClass: a.assetClass, amount: fromSatang(amount), expenseCode: a.codes.expense, accumulatedCode: a.codes.accumulated, ...(catchUp ? { catchUp } : {}) });
  }
  return { month, date, rows, total: fromSatang(rows.reduce((n, r) => n + sat(r.amount), 0)), ...(problem ? { problem } : {}) };
}
export const previewDepreciation = planDepreciation;
/** The month a person most likely runs next: the one after the latest live run; with none, the earliest month an asset depreciates from (or the month before today). */
export function suggestMonth(st: MockState, companyId: string): string {
  const live = liveDps(st, companyId);
  if (live.length) return addMonths(live[live.length - 1].dp!.month, 1);
  const from = liveFas(st, companyId).map((f) => f.asset!.depFrom).sort()[0];
  return from ?? addMonths(today().slice(0, 7), -1);
}

const nameOf = (st: MockState, companyId: string, code: string) => st.accounts.find((a) => a.companyId === companyId && a.code === code)?.nameTh ?? code;
/** The journal lines of a run: the expense per expense account, the accumulated depreciation per account. Straight from the stored rows. */
export function dpEntryLines(st: MockState, companyId: string, dp: { dp?: DpData }): JournalLinePreview[] {
  const sum = (key: 'expenseCode' | 'accumulatedCode') => { const m = new Map<string, number>(); for (const r of dp.dp?.rows ?? []) m.set(r[key], (m.get(r[key]) ?? 0) + sat(r.amount)); return [...m].sort(([a], [b]) => a.localeCompare(b)); };
  const rule = `ค่าเสื่อมราคา ${dp.dp ? monthLabelTh(dp.dp.month) : ''}`.trim();
  const line = (code: string, n: number, dr: boolean): JournalLinePreview => ({ accountCode: code, accountName: nameOf(st, companyId, code), debit: dr ? fromSatang(n) : '0.00', credit: dr ? '0.00' : fromSatang(n), rule });
  return [...sum('expenseCode').map(([c, n]) => line(c, n, true)), ...sum('accumulatedCode').map(([c, n]) => line(c, n, false))];
}

/** Writes the run of `month`: an issued DP with its frozen rows, and the entry for exactly those rows. */
export function runDepreciation(st: MockState, companyId: string, month: string, actor: Actor, opts?: { id?: string }): Stored {
  const p = planDepreciation(st, companyId, month);
  if (p.problem) throw p.problem;
  const at = stamp(), id = opts?.id ?? newId(st, 'DP');
  const d: Stored = { companyId, id, type: 'DP', number: allocate(st, companyId, 'DP', p.date), status: 'issued', correctionClass: 'L', revision: 0, version: 1,
    header: { documentDate: p.date, reference: `ค่าเสื่อมราคา ${monthLabelTh(month)}` }, lines: [], totals: plainTotals(p.total), locks: [], createdBy: actor, issuedAt: at, dp: { month, rows: p.rows } };
  st.docs.push(d);
  setJournal(st, id, ledgerFor(st, d));
  st.revisions.push({ docId: id, revision: 0, at, actor, snapshot: publicDoc(d), diff: [] });
  for (const r of p.rows) refreshFa(st, r.assetId);
  logActivity(st, id, actor, 'issue', `${p.rows.length} สินทรัพย์ รวม ${p.total}`);
  logAudit(st, actor, companyId, 'dp.run', id, undefined, { month, total: p.total, assets: p.rows.length });
  return d;
}

/** A run a later disposal stands on (the disposal froze its accumulated incl. this run's row) is neither cancelled nor recomputed. Exit: undo the disposal. */
function refuseRunUnderDisposal(st: MockState, d: Stored): void {
  const sold = liveFas(st, d.companyId).find((f) => f.asset!.disposed && f.asset!.disposed.date.slice(0, 7) > d.dp!.month);
  if (sold) throw fail(409, 'dp.has_disposal', `สินทรัพย์ ${sold.number} จำหน่ายแล้วโดยอาศัยค่าเสื่อมราคางวดนี้ ทางออก: ยกเลิกการจำหน่ายก่อน`);
}

/** "แก้ไข" a run (only the latest live one): recomputed from the frozen asset data as it is now, the old entry reversed and the new one posted. */
export function reviseDp(st: MockState, id: string, actor: Actor): Stored {
  const d = docOf(st, id);
  if (!d || d.type !== 'DP' || !d.dp) throw fail(404, 'doc.not_found', 'ไม่พบเอกสาร');
  if (!LIVE.includes(d.status)) throw fail(409, 'doc.not_revisable', 'แก้ไขได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  const live = liveDps(st, d.companyId), latest = live[live.length - 1];
  if (latest.id !== d.id) throw fail(409, 'dp.not_latest', `แก้ไขหรือยกเลิกได้เฉพาะรายการค่าเสื่อมราคางวดล่าสุด (${monthLabelTh(latest.dp!.month)}) ย้อนงวดหลังก่อน`);
  refuseRunUnderDisposal(st, d);
  const p = planDepreciation(st, d.companyId, d.dp.month, d.id);
  if (p.problem) throw p.problem;
  const was = d.dp.rows.map((r) => r.assetId), next: Stored = { ...d, dp: { month: d.dp.month, rows: p.rows }, totals: plainTotals(p.total), revision: d.revision + 1, version: d.version + 1 };
  put(st, next);
  const prev = st.journals.find((j) => j.docId === id)?.preview.entries ?? [], last = prev[prev.length - 1], fresh = ledgerFor(st, next).entries[0];
  setJournal(st, id, { entries: [...prev, ...(last && last.kind !== 'reversal' ? [correctionReversal(st, d.companyId, last)] : []), ...(fresh ? [placed(st, d.companyId, { ...fresh, kind: 'correction' as const, postedAt: stamp() })] : [])] });
  for (const a of new Set([...was, ...p.rows.map((r) => r.assetId)])) refreshFa(st, a);
  st.revisions.push({ docId: id, revision: next.revision, at: stamp(), actor, reason: 'คำนวณค่าเสื่อมราคาใหม่', snapshot: publicDoc(next), diff: [] });
  logActivity(st, id, actor, 'revise', 'คำนวณค่าเสื่อมราคาใหม่');
  logAudit(st, actor, d.companyId, 'dp.revise', id, { total: d.totals.total }, { total: p.total });
  return next;
}

// ---------------------------------------------------------------- hooks called by the document commands

/** Before `cancel`: a run only while it is the latest (and no later disposal stands on it); an asset only while it has no run row and no disposal. */
export function beforeAssetCancel(st: MockState, d: Stored): void {
  if (d.type === 'DP' && d.dp) {
    const live = liveDps(st, d.companyId), latest = live[live.length - 1];
    if (latest && latest.id !== d.id) throw fail(409, 'dp.not_latest', `แก้ไขหรือยกเลิกได้เฉพาะรายการค่าเสื่อมราคางวดล่าสุด (${monthLabelTh(latest.dp!.month)}) ย้อนงวดหลังก่อน`);
    refuseRunUnderDisposal(st, d);
  }
  if (d.type === 'FA' && d.asset) {
    if (d.asset.disposed) throw fail(409, 'fa.has_disposal', 'สินทรัพย์นี้จำหน่ายแล้ว ยกเลิกไม่ได้ ทางออก: ยกเลิกการจำหน่าย (ยกเลิกใบกำกับภาษีขาย หรือกดยกเลิกการตัดจำหน่าย) ก่อน');
    const run = liveDps(st, d.companyId).find((x) => x.dp!.rows.some((r) => r.assetId === d.id));
    if (run) throw fail(409, 'fa.has_depreciation', `สินทรัพย์นี้มีค่าเสื่อมราคาลงบัญชีแล้ว (งวด ${monthLabelTh(run.dp!.month)}) ยกเลิกไม่ได้ ทางออก: ยกเลิกรายการค่าเสื่อมราคาจากงวดล่าสุดย้อนกลับมา`);
  }
}
/** After `cancel`: a cancelled run gives its rows back to the assets. */
export function afterAssetCancel(st: MockState, d: Stored): void {
  if (d.type === 'DP') for (const r of d.dp?.rows ?? []) refreshFa(st, r.assetId);
}

// ---------------------------------------------------------------- disposal

/** The disposal entry, from the frozen figures alone. [AR or nothing, proceeds + VAT] [AccumulatedDepreciation, accumulated incl. the partial] [DepreciationExpense, partial / AccumulatedDepreciation, partial: the disposal month's depreciation]
 *  [loss] [FixedAsset, cost] [OutputVat] [gain]: it removes exactly the frozen cost and accumulated, and balances because gain / loss = proceeds - NBV. */
export function disposalEntryLines(st: MockState, companyId: string, p: Disposal & { faNumber?: string }, partyName?: string): JournalLinePreview[] {
  const rule = `จำหน่ายสินทรัพย์ ${p.faNumber ?? p.name}`, out: JournalLinePreview[] = [];
  const add = (code: string | undefined, dr: number, cr: number, party?: string) => { if (code && (dr || cr)) out.push({ accountCode: code, accountName: nameOf(st, companyId, code), debit: fromSatang(dr), credit: fromSatang(cr), rule, ...(party ? { partyName: party } : {}) }); };
  const proceeds = sat(p.proceeds), vat = sat(p.vat), gl = sat(p.gainLoss);
  if (p.kind === 'sale') add(p.codes.ar, proceeds + vat, 0, partyName);
  add(p.codes.accumulated, sat(p.accumulated), 0);
  add(p.codes.expense, sat(p.partial), 0); add(p.codes.accumulated, 0, sat(p.partial));
  if (p.outcome === 'loss') add(p.codes.loss, gl, 0);
  add(p.codes.cost, 0, sat(p.cost));
  add(p.codes.vat, 0, vat);
  if (p.outcome === 'gain') add(p.codes.gain, 0, gl);
  return out;
}

/** Would the sale invoice of a disposal (proceeds + VAT) need approval under the company's TI / IV policy? The handler asks before disposing, so a caller without `.approve` is refused up front. */
export function saleNeedsApproval(st: MockState, companyId: string, proceeds: Money | undefined): boolean {
  const vatReg = vatOf(st, companyId), p = sat(proceeds);
  return p > 0 && approvalRequired(st, companyId, vatReg ? 'TI' : 'IV', computeDoc([{ id: 'x', description: 'x', qty: '1', unit: 'x', unitPrice: fromSatang(p), taxCode: vatReg ? 'S7' : 'EX' }], false, vatReg).totals.total);
}

export interface DisposeInput { date: IsoDate; kind: 'sale' | 'write_off'; proceeds?: Money; buyerId?: string }
/** Disposal by sale (a tax invoice / invoice to the buyer through the normal issue path, in the same command) or write-off (an entry on the asset itself). Everything it stores is frozen at this moment. */
export function disposeAsset(st: MockState, companyId: string, id: string, input: DisposeInput, actor: Actor): Stored {
  const fa = docOf(st, id);
  if (!fa || fa.companyId !== companyId || fa.type !== 'FA' || !fa.asset || !LIVE.includes(fa.status)) throw fail(404, 'doc.not_found', 'ไม่พบสินทรัพย์');
  const a = fa.asset, bad = (m: string) => fail(422, 'fa.invalid', m);
  if (a.disposed) throw fail(409, 'fa.already_disposed', `สินทรัพย์นี้จำหน่ายแล้ว (${a.disposed.date}) ทางออก: ยกเลิกการจำหน่ายก่อนจึงจำหน่ายใหม่ได้`);
  if (input.kind !== 'sale' && input.kind !== 'write_off') throw bad('ประเภทการจำหน่ายไม่ถูกต้อง');
  if (!validDate(input.date)) throw bad('วันที่จำหน่ายไม่ถูกต้อง');
  const sale = input.kind === 'sale', date = input.date, month = date.slice(0, 7), proceeds = sale ? sat(input.proceeds) : 0;
  const buyer = sale ? st.parties.find((p) => p.id === input.buyerId && p.companyId === companyId && p.kind === 'customer' && p.active !== false) : undefined;
  if (sale && !(proceeds > 0)) throw bad('ราคาขายต้องมากกว่า 0');
  if (sale && !buyer) throw bad('ต้องเลือกผู้ซื้อ (ลูกค้า) ของบริษัทนี้');
  if (date < a.startDate || month < (a.catchUpFrom ?? a.depFrom)) throw fail(422, 'fa.dispose_date', `วันที่จำหน่ายต้องไม่ก่อนวันที่เริ่มใช้งาน (${a.startDate})`);
  dateGuards(st, companyId, date); // not in the future, in an open month
  const gap = uncoveredMonth(st, companyId, a.depFrom, month);
  if (gap) throw fail(409, 'fa.dp_missing', `ต้องคิดค่าเสื่อมราคาทุกงวดก่อนเดือนที่จำหน่ายให้ครบ ทางออก: คิดค่าเสื่อมราคางวด ${monthLabelTh(gap)} ก่อน`);
  const later = liveDps(st, companyId).find((d) => d.dp!.month >= month);
  if (later) throw fail(409, 'fa.dp_after', `มีค่าเสื่อมราคางวด ${monthLabelTh(later.dp!.month)} ลงบัญชีแล้ว (เดือนที่จำหน่ายหรือหลังจากนั้น) ทางออก: ยกเลิกรายการค่าเสื่อมราคาจากงวดล่าสุดย้อนกลับมาถึงงวดนั้น`);
  const before = accumulatedOf(st, fa), partial = dueIn(a, month, before, Number(date.slice(8, 10))).amount, acc = before + partial, nbv = sat(a.cost) - acc;
  const vatReg = vatOf(st, companyId), type = vatReg ? 'TI' : 'IV';
  const line: DocLine | undefined = sale ? { id: `${fa.id}-sale`, description: `ขายสินทรัพย์ ${fa.number} ${a.name}`, qty: '1', unit: 'รายการ', unitPrice: fromSatang(proceeds), taxCode: vatReg ? 'S7' : 'EX' } : undefined;
  const vat = line ? sat(computeDoc([line], false, vatReg).totals.vat) : 0, diff = proceeds - nbv;
  const disposed: Disposal = { date, kind: input.kind, name: a.name, cost: a.cost, accumulated: fromSatang(acc), partial: fromSatang(partial), nbv: fromSatang(nbv), outcome: diff > 0 ? 'gain' : diff < 0 ? 'loss' : 'none', gainLoss: fromSatang(Math.abs(diff)),
    codes: { ...a.codes, ...(sale ? { ar: roleCode(st, companyId, 'AR'), vat: roleCode(st, companyId, 'OutputVat') } : {}) }, ...(sale ? { proceeds: fromSatang(proceeds), vat: fromSatang(vat), buyerId: buyer!.id } : {}) };
  const snap = structuredClone(st), at = stamp();
  try {
    let tiId: string | undefined;
    if (line) {
      const draft = createDraft(st, companyId, type, { header: { documentDate: date, partyId: buyer!.id, priceIncludesVat: false, reference: fa.number, disposal: { ...disposed, faId: fa.id, ...(fa.number ? { faNumber: fa.number } : {}) } }, lines: [line] }, actor, `fa-dispose-${fa.id}-${fa.version}`);
      const ti = approvalRequired(st, companyId, type, payoutOf(st, companyId, draft)) ? approveAndIssue(st, draft.id, draft.version, actor) : issue(st, draft.id, draft.version, actor);
      if (ti.totals.vat !== fromSatang(vat) || sat(ti.totals.total) !== proceeds + vat) throw fail(500, 'engine.invariant', 'disposal invoice differs from the frozen figures');
      tiId = ti.id;
    } else {
      const entry = placed(st, companyId, { date, kind: 'original', postedAt: at, lines: disposalEntryLines(st, companyId, { ...disposed, faNumber: fa.number }) });
      setJournal(st, fa.id, { entries: [...(st.journals.find((j) => j.docId === fa.id)?.preview.entries ?? []), entry] });
    }
    const cur = docOf(st, fa.id)!;
    put(st, { ...cur, version: cur.version + 1, asset: { ...cur.asset!, disposed: { ...disposed, ...(tiId ? { tiId } : {}) } } });
    refreshFa(st, fa.id);
    logActivity(st, fa.id, actor, 'dispose', sale ? `ขาย ${input.proceeds} บาท` : 'ตัดจำหน่าย');
    logAudit(st, actor, companyId, 'fa.dispose', fa.id, undefined, { kind: input.kind, date, nbv: fromSatang(nbv), outcome: disposed.outcome, gainLoss: disposed.gainLoss, tiId });
  } catch (e) { Object.assign(st, snap); throw e; }
  return docOf(st, fa.id)!;
}

/** Undoes a write-off (a sale is undone by cancelling its invoice). Not while a run for the disposal month or later stands. */
export function reverseDisposal(st: MockState, companyId: string, id: string, actor: Actor): Stored {
  const fa = docOf(st, id), d = fa?.asset?.disposed;
  if (!fa || fa.companyId !== companyId || !fa.asset || !LIVE.includes(fa.status)) throw fail(404, 'doc.not_found', 'ไม่พบสินทรัพย์');
  if (!d) throw fail(409, 'fa.not_disposed', 'สินทรัพย์นี้ยังไม่ได้จำหน่าย');
  if (d.kind === 'sale') throw fail(409, 'fa.use_invoice', `สินทรัพย์นี้จำหน่ายโดยการขาย ทางออก: ยกเลิกใบกำกับภาษี/ใบแจ้งหนี้ขายสินทรัพย์เพื่อยกเลิกการจำหน่าย`);
  refuseUndoWhileRun(st, fa);
  const prev = st.journals.find((j) => j.docId === id)?.preview.entries ?? [], last = prev[prev.length - 1];
  if (last && last.kind !== 'reversal') setJournal(st, id, { entries: [...prev, correctionReversal(st, companyId, last)] });
  const { disposed: _d, ...rest } = fa.asset; void _d;
  put(st, { ...fa, version: fa.version + 1, asset: rest });
  refreshFa(st, id);
  logActivity(st, id, actor, 'undispose', 'ยกเลิกการตัดจำหน่าย');
  logAudit(st, actor, companyId, 'fa.undispose', id, { date: d.date }, undefined);
  return docOf(st, id)!;
}
const refuseUndoWhileRun = (st: MockState, fa: Stored) => {
  const month = fa.asset!.disposed!.date.slice(0, 7), later = liveDps(st, fa.companyId).find((d) => d.dp!.month >= month);
  if (later) throw fail(409, 'fa.dp_after', `มีค่าเสื่อมราคางวด ${monthLabelTh(later.dp!.month)} ลงบัญชีแล้ว (เดือนที่จำหน่ายหรือหลังจากนั้น) ยกเลิกการจำหน่ายไม่ได้ ทางออก: ยกเลิกรายการค่าเสื่อมราคาจากงวดล่าสุดย้อนกลับมาถึงงวดนั้นก่อน`);
};

/** Before `cancel` of a disposal invoice: its asset comes back, which no run for the disposal month or later may contradict. */
export function beforeDisposalTiCancel(st: MockState, ti: Stored): void {
  const fa = ti.header.disposal ? docOf(st, ti.header.disposal.faId) : undefined;
  if (fa?.asset?.disposed?.tiId === ti.id) refuseUndoWhileRun(st, fa);
}
/** After `cancel` of a disposal invoice (its journal is reversed by the cancel itself): the asset is live again. */
export function onDisposalTiCancelled(st: MockState, ti: Stored, actor: Actor): void {
  const fa = ti.header.disposal ? docOf(st, ti.header.disposal.faId) : undefined;
  if (!fa?.asset?.disposed || fa.asset.disposed.tiId !== ti.id) return;
  const { disposed: _d, ...rest } = fa.asset; void _d;
  put(st, { ...fa, version: fa.version + 1, asset: rest });
  refreshFa(st, fa.id);
  logActivity(st, fa.id, actor, 'undispose', `ยกเลิก ${ti.number}`);
  logAudit(st, actor, fa.companyId, 'fa.undispose', fa.id, { date: fa.asset.disposed.date, tiId: ti.id }, undefined);
}
/** The invoice of a disposal is the disposal: a fiscal correction (cancel + reissue) would un-dispose the asset and re-post without it. Exit: cancel it and dispose again. */
export function refuseDisposalCorrection(d: { header: DocHeader }): void {
  if (d.header.disposal) throw fail(422, 'fa.disposal_locked', 'ใบกำกับภาษี/ใบแจ้งหนี้นี้เกิดจากการขายสินทรัพย์ แก้ไขยอดหรือออกใหม่ไม่ได้ ทางออก: ยกเลิกเอกสารนี้ (การจำหน่ายจะถูกยกเลิกด้วย) แล้วจำหน่ายสินทรัพย์ใหม่');
}
/** No credit / debit note on a disposal invoice (it would change the proceeds the asset's gain or loss was frozen on). */
export function refuseDisposalNote(st: MockState, type: DocType, header: DocHeader): void {
  const ref = ADJUSTS[type] === 'TI' ? docOf(st, header.refDocId) : undefined;
  if (ref?.header.disposal) throw fail(422, 'fa.disposal_note', 'ใบกำกับภาษีนี้เกิดจากการขายสินทรัพย์ ออกใบลดหนี้/ใบเพิ่มหนี้ไม่ได้ ทางออก: ยกเลิกใบกำกับภาษีนี้แล้วจำหน่ายสินทรัพย์ใหม่');
}

// ---------------------------------------------------------------- source locks (called from the document commands)

const lineKey = (l: DocLine | undefined) => (l ? JSON.stringify([l.qty, l.unitPrice, l.discountPct ?? '', l.taxCode, l.itemId ?? '', l.expenseCategory ?? '', l.vatOverride ?? '']) : 'gone');
const assetsOn = (st: MockState, docId: string) => st.docs.filter((x) => x.type === 'FA' && LIVE.includes(x.status) && x.asset?.source.docId === docId);
const locked = (fa: Stored, what: string) => fail(409, 'fa.source_locked', `รายการนี้ลงทะเบียนเป็นสินทรัพย์ ${fa.number} แล้ว — ${what} ทางออก: ยกเลิกสินทรัพย์ ${fa.number} ก่อน (ถ้ามีค่าเสื่อมราคาหรือการจำหน่าย ให้ยกเลิกรายการเหล่านั้นก่อน)`);

/** A PB / PV with a live asset made from one of its lines: cancel is refused; a revision may not change that line's money, account or category (or the bill's price basis and dates, which decide the cost). `next` = what the revision would make it. */
export function refuseAssetSource(st: MockState, d: { id: string; type: DocType; header: DocHeader; lines: DocLine[] }, next?: { header: DocHeader; lines: DocLine[] }): void {
  if (d.type !== 'PB' && d.type !== 'PV') return;
  for (const fa of assetsOn(st, d.id)) {
    const src = fa.asset!.source;
    if (src.kind !== 'bill') continue;
    const same = !!next && lineKey(d.lines.find((l) => l.id === src.lineId)) === lineKey(next.lines.find((l) => l.id === src.lineId)) && !!next.header.priceIncludesVat === !!d.header.priceIncludesVat
      && next.header.documentDate === d.header.documentDate && (next.header.vendorDocDate ?? '') === (d.header.vendorDocDate ?? '');
    if (!same) throw locked(fa, next ? 'แก้ไขยอด บัญชี หมวด หรือวันที่ของรายการที่ลงทะเบียนไม่ได้' : 'ยกเลิกเอกสารนี้ไม่ได้');
  }
}
/** A credit / debit note on a bill line a live asset stands on would move the cost the asset froze. */
export function refuseAssetNote(st: MockState, d: { type: DocType; header: DocHeader; lines: DocLine[] }): void {
  if ((d.type !== 'PCN' && d.type !== 'PDN') || !d.header.refDocId) return;
  const ids = new Set(d.lines.map((l) => l.sourceLineId).filter(Boolean));
  const fa = assetsOn(st, d.header.refDocId).find((f) => f.asset!.source.kind === 'bill' && ids.has(f.asset!.source.lineId));
  if (fa) throw locked(fa, 'ออกหรือแก้ไขใบลดหนี้/ใบเพิ่มหนี้ของรายการที่ลงทะเบียนไม่ได้');
}
const OB_KEYS = ['cost', 'accumulated', 'acquired', 'lifeMonths', 'assetClass'] as const;
/** An opening-balance batch with a live asset made from one of its rows: cancel is refused; a revision keeps the cut-off and that row (same id) with the same cost, accumulated, acquisition date, life and class. Names and notes stay free. */
export function refuseObAssets(st: MockState, d: { id: string; header: DocHeader; opening?: DocOpening }, next?: { header: DocHeader; opening?: DocOpening }): void {
  for (const fa of assetsOn(st, d.id)) {
    const src = fa.asset!.source;
    if (src.kind !== 'ob') continue;
    const was = d.opening?.assets.find((a) => a.id === src.rowId), now = next?.opening?.assets.find((a) => a.id === src.rowId);
    const same = !!next && !!was && !!now && next.header.documentDate === d.header.documentDate && OB_KEYS.every((k) => (k === 'cost' || k === 'accumulated' ? sat(was[k]) === sat(now[k]) : was[k] === now[k]));
    if (!same) throw locked(fa, next ? 'แก้ไขสินทรัพย์รายการนี้หรือวันตัดยอดของยอดยกมาไม่ได้' : 'ยกเลิกยอดยกมานี้ไม่ได้');
  }
}
/** The banner a source (PB / PV / opening batch) reads with while a live asset stands on it. Derived at read, never stored. */
export function assetLock(st: MockState, d: { id?: string; type?: DocType; status: string }): Lock | undefined {
  if (!d.id || !LIVE.includes(d.status as never)) return undefined;
  if (d.type === 'FA' || d.type === 'DP') return assetOwnLock(st, d.id);
  if (d.type !== 'PB' && d.type !== 'PV' && d.type !== 'OB') return undefined;
  const fa = assetsOn(st, d.id)[0];
  return fa ? { kind: 'asset', reason: `ใช้ลงทะเบียนสินทรัพย์ ${fa.number} ${fa.asset!.name} แล้ว`, exits: [`ยกเลิกสินทรัพย์ ${fa.number} ก่อน`], ...(docViewHref('FA', fa.id) ? { href: docViewHref('FA', fa.id) } : {}) } : undefined;
}

/** The lock an asset (a disposal, or a run row stands on it) and a depreciation run (a later run stands on it) read with: ruling 2 / 3 - the reason and the way out, derived at read. */
function assetOwnLock(st: MockState, id: string): Lock | undefined {
  const d = docOf(st, id);
  if (!d) return undefined;
  const live = liveDps(st, d.companyId), latest = live[live.length - 1], monthOf = (x: Stored) => monthLabelTh(x.dp!.month);
  if (d.type === 'DP') {
    if (!latest || latest.id === d.id) return undefined;
    return { kind: 'asset', reason: `มีค่าเสื่อมราคางวดหลังจากงวดนี้ลงบัญชีแล้ว (ล่าสุด ${monthOf(latest)}) แก้ไขหรือยกเลิกได้เฉพาะงวดล่าสุด`, exits: [`ยกเลิกรายการค่าเสื่อมราคางวด ${monthOf(latest)} ก่อน`], ...(docViewHref('DP', latest.id) ? { href: docViewHref('DP', latest.id) } : {}) };
  }
  const a = d.asset;
  if (!a) return undefined;
  if (a.disposed) {
    const ti = docOf(st, a.disposed.tiId);
    return { kind: 'asset', reason: `จำหน่ายแล้ว (${a.disposed.kind === 'sale' ? 'ขาย' : 'ตัดจำหน่าย'} ${formatDateBE(a.disposed.date)}) ยกเลิกสินทรัพย์หรือแก้ราคาซาก อายุ วันที่เริ่มใช้ไม่ได้`,
      exits: [a.disposed.kind === 'sale' ? `ยกเลิก${ti?.type === 'IV' ? 'ใบแจ้งหนี้' : 'ใบกำกับภาษี'}ขายสินทรัพย์ ${ti?.number ?? ''}`.trim() : 'ยกเลิกการตัดจำหน่าย (ปุ่มด้านล่าง)'], ...(ti && docViewHref(ti.type, ti.id) ? { href: docViewHref(ti.type, ti.id) } : {}) };
  }
  const runs = live.filter((x) => x.dp!.rows.some((r) => r.assetId === id));
  if (!runs.length) return undefined;
  return { kind: 'asset', reason: `มีค่าเสื่อมราคาลงบัญชีแล้ว ${runs.length} งวด (ล่าสุด ${monthOf(runs[runs.length - 1])}) ยกเลิกสินทรัพย์หรือแก้ราคาซาก อายุ วันที่เริ่มใช้ไม่ได้`, exits: [`ยกเลิกรายการค่าเสื่อมราคาจากงวด ${monthOf(latest)} ย้อนกลับมา`], ...(docViewHref('DP', latest.id) ? { href: docViewHref('DP', latest.id) } : {}) };
}

// ---------------------------------------------------------------- editing an asset

export interface AssetPatch { name?: string; salvage?: Money; lifeMonths?: number; startDate?: IsoDate }
/** Edits what the asset froze, until a run or a disposal stands on it (then only the name): salvage, life and (a bill's asset) the start date. Cost, class and codes never change. */
export function reviseAsset(st: MockState, companyId: string, id: string, patch: AssetPatch, actor: Actor): Stored {
  const fa = docOf(st, id), a = fa?.asset;
  if (!fa || !a || fa.companyId !== companyId || !LIVE.includes(fa.status)) throw fail(404, 'doc.not_found', 'ไม่พบสินทรัพย์');
  const money = patch.salvage !== undefined || patch.lifeMonths !== undefined || patch.startDate !== undefined;
  if (money && (a.disposed || liveDps(st, companyId).some((x) => x.dp!.rows.some((r) => r.assetId === id)))) {
    throw fail(409, 'fa.locked', 'สินทรัพย์นี้มีค่าเสื่อมราคาหรือการจำหน่ายแล้ว แก้ราคาซาก อายุ หรือวันที่เริ่มใช้งานไม่ได้ ทางออก: ยกเลิกรายการค่าเสื่อมราคา (จากงวดล่าสุด) หรือการจำหน่ายก่อน');
  }
  const name = patch.name ?? a.name, fromOb = a.source.kind === 'ob';
  if (fromOb && patch.startDate !== undefined && patch.startDate !== a.startDate) throw fail(422, 'fa.invalid', 'วันที่เริ่มใช้งานของสินทรัพย์จากยอดยกมาแก้ไม่ได้ (มาจากวันที่ได้มา)');
  const t = checkTerms(sat(a.cost), sat(a.opening), name, patch.salvage ?? a.salvage, patch.lifeMonths ?? a.lifeMonths, patch.startDate ?? a.startDate);
  if (!fromOb) beforeSource(resolveSource(st, companyId, a.source), 'bill', t.start);
  const { catchUpFrom: _c, ...kept } = a; void _c;
  const first = fromOb || !money ? { depFrom: a.depFrom, ...(a.catchUpFrom ? { catchUpFrom: a.catchUpFrom } : {}) } : firstMonths(st, companyId, t.start.slice(0, 7)); // only a money change (no rows yet) re-derives the months
  const next: Stored = { ...fa, revision: fa.revision + 1, version: fa.version + 1, asset: { ...kept, name: name.trim(), salvage: fromSatang(t.salvage), lifeMonths: t.life, startDate: t.start, ...first } };
  put(st, next);
  st.revisions.push({ docId: id, revision: next.revision, at: stamp(), actor, snapshot: publicDoc(next), diff: [] });
  logActivity(st, id, actor, 'revise', 'แก้ไขเงื่อนไขสินทรัพย์');
  logAudit(st, actor, companyId, 'fa.revise', id, { salvage: a.salvage, lifeMonths: a.lifeMonths, startDate: a.startDate }, { salvage: next.asset!.salvage, lifeMonths: t.life, startDate: t.start });
  return next;
}

// ---------------------------------------------------------------- invariants

/** AC5 invariants (ruling 5). Per asset: accumulated = opening + Σ live run rows + the disposal partial, never beyond cost - salvage; cost is what its source posted; one live asset per source and the source is live.
 *  Per class: GL(accumulated depreciation) = Σ accumulated of live, undisposed assets + what an opening batch posted for rows no asset covers. Per run: its journal is its stored rows (with the frozen codes of the assets), months are consecutive and dated at the month end,
 *  no row for a disposed (in or before that month) or not-yet-started asset. A disposal: the entry (on the sale invoice or on the asset) is exactly the frozen figures - it removes the frozen cost and accumulated, and balances - the invoice is live and linked both ways, its VAT is the frozen VAT
 *  (there is no output VAT register in the mock yet: the invoice's own VAT line is what the register will read), every run before the disposal month exists (and no run row of the asset stands for that month or later). A live asset's own journal nets to zero. */
export function assetInvariants(st: MockState): string[] {
  const out: string[] = [];
  const entries = (id: string) => st.journals.find((j) => j.docId === id)?.preview.entries ?? [];
  const current = (id: string) => { const e = entries(id); const last = e[e.length - 1]; return last && last.kind !== 'reversal' ? last : undefined; };
  const sig = (ls: { accountCode: string; debit: string; credit: string }[]) => ls.map((l) => `${l.accountCode}|${sat(l.debit)}|${sat(l.credit)}`).join(',');
  const live = (id: string | undefined) => { const d = docOf(st, id); return d && LIVE.includes(d.status) ? d : undefined; };
  const fas = st.docs.filter((d) => d.type === 'FA' && LIVE.includes(d.status) && d.asset);
  const seen = new Map<string, string[]>();
  for (const fa of fas) {
    const a = fa.asset!, cost = sat(a.cost), salvage = sat(a.salvage), co = fa.companyId;
    if (!(cost > 0) || !(salvage >= 0) || salvage >= cost || !Number.isInteger(a.lifeMonths) || a.lifeMonths < 1 || !validDate(a.startDate) || sat(fa.totals.total) !== cost) out.push(`${fa.id}: asset terms are not sane (cost ${a.cost}, salvage ${a.salvage}, life ${a.lifeMonths}, start ${a.startDate})`);
    const k = a.source.kind === 'bill' ? `${co}|${a.source.docId}|${a.source.lineId}` : `${co}|${a.source.docId}|${a.source.rowId}`;
    seen.set(k, [...(seen.get(k) ?? []), fa.id]);
    try { const r = resolveSource(st, co, a.source); if (a.source.kind === 'bill' && a.startDate < r.docDate) out.push(`${fa.id}: in service ${a.startDate}, before its source document (${r.docDate})`);
      const natural = r.depFrom ?? a.startDate.slice(0, 7), first = a.catchUpFrom ?? a.depFrom; // AC7a: an asset starts at its natural month, or (registered after a run covered it) catches that month up in the run at depFrom
      if (first !== natural) out.push(`${fa.id}: ${a.catchUpFrom ? 'catch-up month' : 'depreciation start'} ${first} is not the natural first month ${natural} of its source`);
      if (a.catchUpFrom && a.catchUpFrom > a.depFrom) out.push(`${fa.id}: catch-up month ${a.catchUpFrom} is after the month it starts depreciating (${a.depFrom})`);
      if (r.cost !== cost || r.opening !== sat(a.opening)) out.push(`${fa.id}: cost ${a.cost} / opening ${a.opening} are not what its source posted (${fromSatang(r.cost)} / ${fromSatang(r.opening)})`); } catch { out.push(`${fa.id}: source ${a.source.docId} is not live (or the line / row is gone)`); }
    const acc = accumulatedOf(st, fa);
    if (acc !== sat(a.accumulated) || cost - acc !== sat(a.nbv)) out.push(`${fa.id}: accumulated ${a.accumulated} / NBV ${a.nbv} but opening + live run rows + disposal partial is ${fromSatang(acc)} / ${fromSatang(cost - acc)}`);
    if (acc > cost - salvage) out.push(`${fa.id}: accumulated ${fromSatang(acc)} is beyond cost - salvage ${fromSatang(cost - salvage)}`);
    const d = a.disposed;
    if (!d) { // a live asset's own journal (a write-off that was undone) nets to zero, account by account
      const net = new Map<string, number>();
      for (const e of entries(fa.id)) for (const l of e.lines) net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + sat(l.debit) - sat(l.credit));
      if ([...net.values()].some((v) => v !== 0)) out.push(`${fa.id}: live asset carries a journal entry that does not net to zero`);
      continue;
    }
    const month = d.date.slice(0, 7), gap = uncoveredMonth(st, co, a.depFrom, month);
    if (gap) out.push(`${fa.id}: disposed in ${month} but ${gap}, before the disposal month, has no live run`);
    const before = acc - sat(d.partial), diff = sat(d.proceeds) - (cost - acc);
    if (d.cost !== a.cost || sat(d.accumulated) !== acc || sat(d.nbv) !== cost - acc || sat(d.partial) !== dueIn(a, month, before, Number(d.date.slice(8, 10))).amount
      || d.gainLoss !== fromSatang(Math.abs(diff)) || d.outcome !== (diff > 0 ? 'gain' : diff < 0 ? 'loss' : 'none')) out.push(`${fa.id}: disposal figures are not cost / accumulated / NBV / gain-loss of the asset at ${d.date}`);
    const want = sig(disposalEntryLines(st, co, { ...d, faNumber: fa.number }));
    if (d.kind === 'write_off') { const e = current(fa.id); if (!e || sig(e.lines) !== want) out.push(`${fa.id}: disposal entry is not the frozen disposal (cost ${d.cost}, accumulated ${d.accumulated})`); continue; }
    const ti = live(d.tiId);
    if (!ti || (ti.type !== 'TI' && ti.type !== 'IV') || ti.header.disposal?.faId !== fa.id || ti.companyId !== co) { out.push(`${fa.id}: disposal invoice ${d.tiId} is not a live invoice made for this asset`); continue; }
    const e = current(ti.id);
    if (!e || sig(e.lines) !== want) out.push(`${fa.id}: disposal entry (on ${ti.number}) is not the frozen disposal (cost ${d.cost}, accumulated ${d.accumulated}, VAT ${d.vat})`);
    if (ti.totals.vat !== d.vat || ti.totals.net !== d.proceeds || sat(e?.lines.find((l) => l.accountCode === d.codes.vat)?.credit ?? '0.00') !== sat(d.vat)) out.push(`${fa.id}: disposal VAT ${d.vat} is not the invoice's VAT ${ti.totals.vat} (or its output-VAT line)`);
  }
  for (const [k, ids] of seen) if (ids.length > 1) out.push(`${k}: more than one live asset (${ids.join(', ')})`);
  for (const ti of st.docs) if ((ti.type === 'TI' || ti.type === 'IV') && ti.header.disposal && LIVE.includes(ti.status)) {
    const fa = docOf(st, ti.header.disposal.faId);
    if (!fa?.asset?.disposed || fa.asset.disposed.tiId !== ti.id || !LIVE.includes(fa.status)) out.push(`${ti.id}: disposal invoice for ${ti.header.disposal.faId}, which is not an asset disposed through it`);
    else { const { tiId: _t, ...frozen } = fa.asset.disposed, { faId: _f, faNumber: _n, ...hd } = ti.header.disposal; void _t; void _f; void _n; if (stableJson(frozen) !== stableJson(hd)) out.push(`${ti.id}: header.disposal is not the disposal frozen on asset ${fa.number}`); }
  }
  for (const dp of st.docs.filter((d) => d.type === 'DP' && LIVE.includes(d.status) && d.dp)) {
    const p = dp.dp!, co = dp.companyId, rows = p.rows;
    if (dp.header.documentDate !== lastDayOf(p.month)) out.push(`${dp.id}: run dated ${dp.header.documentDate}, not the month end of ${p.month}`);
    rows.forEach((r) => {
      const fa = docOf(st, r.assetId), a = fa?.asset;
      if (!fa || !a || fa.companyId !== co || !LIVE.includes(fa.status)) { out.push(`${dp.id}: row for ${r.assetId}, which is not a live asset of the company`); return; }
      if (a.codes.expense !== r.expenseCode || a.codes.accumulated !== r.accumulatedCode || a.assetClass !== r.assetClass) out.push(`${dp.id}: row for ${fa.number} does not carry the frozen codes of the asset`);
      if (!(sat(r.amount) > 0)) out.push(`${dp.id}: row for ${fa.number} has no amount`);
      if (a.depFrom > p.month) out.push(`${dp.id}: row for ${fa.number} is before the month it starts depreciating (${a.depFrom})`);
      if (r.catchUp && !(a.catchUpFrom && p.month === a.depFrom)) out.push(`${dp.id}: catch-up on a row that is not the first (catch-up) row of ${fa.number}`);
      if (a.catchUpFrom && p.month === a.depFrom) { // the first row: what the frozen terms add up to from the natural month, and how it says so
        const want = dueIn(a, p.month, sat(a.opening));
        if (sat(r.amount) !== want.amount) out.push(`${dp.id}: catch-up row for ${fa.number} is ${r.amount} but the frozen terms give ${fromSatang(want.amount)}`);
        if (JSON.stringify(r.catchUp) !== JSON.stringify(want.catchUp)) out.push(`${dp.id}: catch-up marker of ${fa.number} is ${JSON.stringify(r.catchUp)}, the frozen terms give ${JSON.stringify(want.catchUp)}`);
      }
      if (a.disposed && a.disposed.date.slice(0, 7) <= p.month) out.push(`${dp.id}: row for ${fa.number}, which was disposed of in or before ${p.month} (its disposal carries the disposal month's depreciation)`);
    });
    const sum = rows.reduce((n, r) => n + sat(r.amount), 0);
    if (sat(dp.totals.total) !== sum) out.push(`${dp.id}: run total ${dp.totals.total} is not its rows' sum ${fromSatang(sum)}`);
    const e = current(dp.id), want = sig(dpEntryLines(st, co, dp));
    if (sum === 0 ? !!e && e.lines.length > 0 : !e || sig(e.lines) !== want) out.push(`${dp.id}: run journal is not its rows`);
  }
  for (const c of st.companies) {
    const months = liveDps(st, c.id).map((d) => d.dp!.month);
    months.forEach((m, i) => { if (i > 0 && m !== addMonths(months[i - 1], 1)) out.push(`${c.id}: live runs are not consecutive months (${m} follows ${months[i - 1]})`); });
    const mine = new Set(st.docs.filter((d) => d.companyId === c.id).map((d) => d.id)), gl = new Map<string, number>(), exp = new Map<string, number>();
    for (const a of st.accounts) if (a.companyId === c.id && a.subClass === 'accumulated-depreciation') { gl.set(a.code, 0); exp.set(a.code, 0); }
    for (const j of st.journals) if (mine.has(j.docId)) for (const e of j.preview.entries) for (const l of e.lines) if (gl.has(l.accountCode)) gl.set(l.accountCode, gl.get(l.accountCode)! + sat(l.credit) - sat(l.debit));
    for (const fa of liveFas(st, c.id)) if (!fa.asset!.disposed) exp.set(fa.asset!.codes.accumulated, (exp.get(fa.asset!.codes.accumulated) ?? 0) + accumulatedOf(st, fa));
    for (const ob of st.docs.filter((d) => d.companyId === c.id && d.type === 'OB' && !d.header.obBatchId && LIVE.includes(d.status)))
      for (const r of ob.opening?.assets ?? []) { const code = ob.opening?.codes?.[`AccumulatedDepreciation:${r.assetClass}`]; if (code && r.id && !faOfSource(st, c.id, { kind: 'ob', docId: ob.id, rowId: r.id })) exp.set(code, (exp.get(code) ?? 0) + sat(r.accumulated)); }
    for (const [code, v] of gl) if (v !== (exp.get(code) ?? 0)) out.push(`${c.id}: GL ${code} ${fromSatang(v)} but the live assets accumulated ${fromSatang(exp.get(code) ?? 0)}`);
    for (const [code, v] of exp) if (!gl.has(code) && v !== 0) out.push(`${c.id}: assets accumulate on ${code}, which is not an accumulated-depreciation account`);
  }
  return out;
}

export { addMonths };
