import { LIVE, isTypeAvailable } from '@/domain/doc-types';
import type { Actor, DocHeader, DocLine, DocType, IsoDate, Lock, Money, ScheduleFrequency, ScheduleRecord, SchedulePlanRow } from '@/domain/types';
import type { MockState } from '../store';
import { allocate, createDraft, newId, publicDoc, setJournal } from './commands';
import { isUsed, jvAccountProblem, jvMissing, jvTotals, userReversalOf } from './journal';
import { ledgerFor } from './ledger';
import { MockError, logActivity, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { isClosed, monthLabelTh } from './periods';
import { resolveRole } from './posting';
import { categoryOf } from './purchase-vat';
import { controlExit } from './reconcile';
import { computeDoc } from './vat';

// AC4: schedules. Recurring = a frozen copy of a template that makes DRAFTS (§5.9). Amortisation = a prepaid / deferred amount spread over months, FROZEN at creation (total, months, start, both accounts, the plan
// table); each run posts a system JV and nothing is re-derived from the source document or the chart afterwards (CLAUDE.md freeze rule).

type Stored = MockState['docs'][number];
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const MAX_MONTHS = 120;
export const RECURRING_TYPES: DocType[] = ['QT', 'TI', 'IV', 'PB', 'JV'];
const STEP: Record<ScheduleFrequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
const sat = (m: string | undefined): number => { try { return toSatang(m ?? '0.00'); } catch { return NaN; } };

// ---------------------------------------------------------------- dates and the plan

export const validDate = (d: unknown): d is IsoDate => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const validMonth = (m: unknown): m is string => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const daysIn = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
export const lastDayOf = (month: string): IsoDate => `${month}-${pad(daysIn(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1))}`;
export const addMonths = (month: string, n: number): string => {
  const t = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
/** The next run of a recurring schedule: `step` months on, on the schedule's day of month, clamped to the month end (31 Jan -> 28 Feb -> 31 Mar). */
const advance = (date: IsoDate, freq: ScheduleFrequency, day: number): IsoDate => {
  const month = addMonths(date.slice(0, 7), STEP[freq]);
  return `${month}-${pad(Math.min(day, daysIn(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1)))}`;
};

/** The plan table: months 1..n-1 get round(total / months), the last month the residue, so the plan sums to the total exactly. A month of nothing (or less) is refused. */
export function planOf(total: Money, months: number, startMonth: string): SchedulePlanRow[] {
  const t = sat(total);
  if (!Number.isFinite(t) || t <= 0) throw fail(422, 'schedule.invalid', 'ยอดที่ตัดจ่ายต้องมากกว่าศูนย์');
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw fail(422, 'schedule.invalid', `จำนวนงวดต้องเป็นจำนวนเต็ม 1 ถึง ${MAX_MONTHS}`);
  if (!validMonth(startMonth)) throw fail(422, 'schedule.invalid', 'เดือนที่เริ่มตัดจ่ายไม่ถูกต้อง');
  const each = Math.round(t / months), last = t - each * (months - 1);
  if (each <= 0 || last <= 0) throw fail(422, 'schedule.invalid', `ยอด ${total} น้อยเกินไปที่จะแบ่ง ${months} งวด (บางงวดไม่มียอด)`);
  return Array.from({ length: months }, (_, i) => ({ month: addMonths(startMonth, i), amount: fromSatang(i === months - 1 ? last : each) }));
}

// ---------------------------------------------------------------- reading

export function scheduleOf(st: MockState, companyId: string, id: string): ScheduleRecord {
  const s = st.schedules.find((x) => x.id === id && x.companyId === companyId);
  if (!s) throw fail(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
  return s;
}
const docOf = (st: MockState, id: string | undefined) => (id ? st.docs.find((d) => d.id === id) : undefined);
/** The runs that count: their JV is there, live, and nobody reversed it. */
export const liveRuns = (st: MockState, s: ScheduleRecord) => s.runs.filter((r) => r.resultDocId && !r.reversed && LIVE.includes(docOf(st, r.resultDocId)?.status as never));
/** `active` follows the facts: not stopped, and (recurring) `endAfter` not reached / (amortisation) a month left to run. */
export function refresh(st: MockState, s: ScheduleRecord): void {
  if (s.kind === 'amortisation') {
    const k = liveRuns(st, s).length, n = s.plan!.length;
    s.nextRun = lastDayOf(s.plan![Math.min(k, n - 1)].month);
    s.active = !s.stopped && k < n;
  } else s.active = !s.stopped && !(s.endAfter && s.runs.length >= s.endAfter);
}
const touch = (s: ScheduleRecord) => { s.version += 1; };

// ---------------------------------------------------------------- sources

/** What a bill / JV line posted: the account and the amount (satang) that account got from it. A PB line goes where its category / item rule sends it; a capex line is an asset, never a prepaid. */
function sourceLine(st: MockState, d: Stored, lineId: string): { account: string; amount: number } | undefined {
  const i = d.lines.findIndex((l) => l.id === lineId);
  if (i < 0) return undefined;
  const l = d.lines[i];
  if (d.type === 'JV') { // a reversal, an accrual the system reverses itself, or a JV somebody reversed has no debit left to spread
    if (d.header.reversalOf || d.header.autoReverse || userReversalOf(st, d.id)) return undefined;
    const dr = sat(l.debit); return l.accountCode && dr > 0 ? { account: l.accountCode, amount: dr } : undefined;
  }
  if (d.type !== 'PB') return undefined;
  const cat = categoryOf(st, d.companyId, l);
  if (cat?.capex) return undefined;
  try {
    const account = resolveRole(st, 'Expense', { companyId: d.companyId, docType: 'PB', itemId: l.itemId, expenseCategory: cat?.code ?? l.expenseCategory, dimensions: l.dimensions }).code;
    return { account, amount: toSatang(computeDoc(d.lines, !!d.header.priceIncludesVat, true).lines[i].net) };
  } catch { return undefined; }
}
const isPrepaid = (st: MockState, companyId: string, code: string) =>
  st.accounts.find((a) => a.companyId === companyId && a.code === code)?.subClass === 'prepayment' && !controlExit(st, companyId, code, 'jv');
const liveOnLine = (st: MockState, docId: string, lineId: string | undefined) =>
  st.schedules.filter((s) => s.kind === 'amortisation' && !s.stopped && s.source?.docId === docId && s.source.lineId === lineId);
const accountLine = (code: string): DocLine => ({ id: 'x', description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode: code, debit: '1.00', credit: '0.00' });

export interface AmortInput { name: string; docId: string; lineId: string; total: Money; months: number; startMonth: string; expenseAccount: string }
export function createAmortisation(st: MockState, companyId: string, input: AmortInput, actor: Actor, opts?: { id?: string }): ScheduleRecord {
  const name = (input.name ?? '').trim();
  if (!name) throw fail(422, 'schedule.invalid', 'ต้องตั้งชื่อตารางตัดจ่าย');
  const plan = planOf(input.total, input.months, input.startMonth);
  const src = st.docs.find((d) => d.id === input.docId && d.companyId === companyId);
  const line = src && LIVE.includes(src.status) ? sourceLine(st, src, input.lineId) : undefined;
  if (!src || !line || !isPrepaid(st, companyId, line.account)) throw fail(422, 'schedule.source_invalid', 'ตัดจ่ายได้เฉพาะรายการในใบแจ้งหนี้ซื้อ (PB) หรือใบสำคัญทั่วไป (JV) ที่ออกแล้วและลงบัญชีค่าใช้จ่ายจ่ายล่วงหน้า (1150 หรือบัญชีหมวดเดียวกัน)');
  if (sat(input.total) > line.amount) throw fail(422, 'schedule.over_source', `ยอดตัดจ่ายเกินยอดของรายการต้นทาง (${fromSatang(line.amount)})`);
  const taken = liveOnLine(st, src.id, input.lineId)[0];
  if (taken) throw fail(409, 'schedule.source_taken', `รายการนี้มีตารางตัดจ่าย "${taken.name}" อยู่แล้ว หยุดตารางนั้นก่อนจึงตั้งใหม่ได้`);
  if (input.expenseAccount === line.account) throw fail(422, 'ledger.account_invalid', 'บัญชีค่าใช้จ่ายต้องไม่ใช่บัญชีค่าใช้จ่ายจ่ายล่วงหน้าเดียวกัน');
  const bad = jvAccountProblem(st, companyId, [accountLine(input.expenseAccount)]);
  if (bad) throw bad;
  const at = stamp(), id = opts?.id ?? nextId(st);
  const s: ScheduleRecord = { id, companyId, version: 1, kind: 'amortisation', name, active: true, frequency: 'monthly', nextRun: lastDayOf(plan[0].month), total: fromSatang(sat(input.total)), months: plan.length,
    startMonth: input.startMonth, expenseAccount: input.expenseAccount, prepaidAccount: line.account, plan, source: { docId: src.id, lineId: input.lineId }, runs: [], createdAt: at, createdBy: actor };
  st.schedules.push(s);
  return s;
}
const nextId = (st: MockState) => { let n = st.schedules.length + 1; while (st.schedules.some((s) => s.id === `sch-${n}`)) n++; return `sch-${n}`; };

// ---------------------------------------------------------------- recurring

type Template = NonNullable<ScheduleRecord['template']>;
/** The template is what the document SAYS about its content: who, what, how much. Dates, vendor paperwork and links belong to one document, not to a series. */
export function templateOf(d: { type: DocType; header: Partial<DocHeader>; lines: DocLine[] }): Template {
  const h = d.header;
  const header: Template['header'] = { ...(h.partyId ? { partyId: h.partyId } : {}), ...(h.reference ? { reference: h.reference } : {}), ...(h.notes ? { notes: h.notes } : {}),
    ...(h.dimensions ? { dimensions: { ...h.dimensions } } : {}), ...(h.priceIncludesVat !== undefined ? { priceIncludesVat: h.priceIncludesVat } : {}), ...(d.type === 'JV' && h.autoReverse ? { autoReverse: true } : {}) };
  return { type: d.type, header, lines: structuredClone(d.lines).map(({ sourceLineId: _s, vatOverride: _v, ...l }) => (void _s, void _v, l)) };
}
export interface RecurringInput { name: string; frequency: ScheduleFrequency; nextRun: IsoDate; endAfter?: number; docId?: string; template?: { type: DocType; header: Partial<DocHeader>; lines: DocLine[] } }
export function createRecurring(st: MockState, companyId: string, input: RecurringInput, actor: Actor, opts?: { id?: string }): ScheduleRecord {
  const name = (input.name ?? '').trim();
  if (!name) throw fail(422, 'schedule.invalid', 'ต้องตั้งชื่อรายการซ้ำ');
  if (!(input.frequency in STEP)) throw fail(422, 'schedule.invalid', 'ความถี่ไม่ถูกต้อง');
  if (!validDate(input.nextRun)) throw fail(422, 'schedule.invalid', 'วันที่รันครั้งถัดไปไม่ถูกต้อง');
  if (input.endAfter !== undefined && (!Number.isInteger(input.endAfter) || input.endAfter < 1)) throw fail(422, 'schedule.invalid', 'จำนวนครั้งต้องเป็นจำนวนเต็มตั้งแต่ 1');
  const src = input.docId ? st.docs.find((d) => d.id === input.docId && d.companyId === companyId) : undefined;
  if (input.docId && !src) throw fail(404, 'doc.not_found', 'ไม่พบเอกสารต้นแบบ');
  const template = templateOf(src ?? input.template ?? (() => { throw fail(422, 'schedule.invalid', 'ต้องระบุเอกสารต้นแบบ'); })());
  checkTemplate(st, companyId, template, name, false);
  const at = stamp(), id = opts?.id ?? nextId(st);
  const s: ScheduleRecord = { id, companyId, version: 1, kind: 'recurring', name, active: true, frequency: input.frequency, nextRun: input.nextRun, day: Number(input.nextRun.slice(8, 10)),
    ...(input.endAfter !== undefined ? { endAfter: input.endAfter } : {}), template, ...(src ? { source: { docId: src.id } } : {}), runs: [], createdAt: at, createdBy: actor };
  st.schedules.push(s);
  return s;
}
/** The template must be usable now: its type exists for this company, a JV obeys the JV rules, and (at run) its party / items / accounts are still there and active. */
function checkTemplate(st: MockState, companyId: string, t: Template, name: string, atRun: boolean): void {
  const co = st.companies.find((c) => c.id === companyId);
  if (!RECURRING_TYPES.includes(t.type)) throw fail(422, 'schedule.invalid', `ตั้งรายการซ้ำจากเอกสารประเภท ${t.type} ไม่ได้`);
  if (!isTypeAvailable(t.type, !!co?.vatRegistered)) throw fail(422, 'doc.type_not_available', t.type === 'TI' ? 'บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม' : 'บริษัทที่จดทะเบียน VAT ใช้ใบกำกับภาษีแทนใบแจ้งหนี้');
  if (t.type === 'JV') {
    const m = jvMissing(t.lines);
    if (m.length) throw fail(422, 'doc.incomplete', m.map((x) => x.message).join('; '));
    const bad = jvAccountProblem(st, companyId, t.lines);
    if (bad) throw atRun ? fail(bad.status, bad.code, `${bad.title} — ${EDITOR(name)}`) : bad;
  }
  if (!atRun) return;
  const p = t.header.partyId ? st.parties.find((x) => x.id === t.header.partyId && x.companyId === companyId) : undefined;
  if (t.header.partyId && (!p || p.active === false)) throw fail(422, 'schedule.template_invalid', `คู่ค้าของแม่แบบ${p ? ` "${p.name}" ปิดใช้งานแล้ว` : 'ไม่มีอยู่แล้ว'} — ${EDITOR(name)}`);
  for (const l of t.lines) {
    const it = l.itemId ? st.items.find((x) => x.id === l.itemId && x.companyId === companyId) : undefined;
    if (l.itemId && (!it || it.active === false)) throw fail(422, 'schedule.template_invalid', `รายการสินค้า/บริการ "${l.description}" ของแม่แบบ${it ? 'ปิดใช้งานแล้ว' : 'ไม่มีอยู่แล้ว'} — ${EDITOR(name)}`);
  }
}
const EDITOR = (name: string) => `ทางออก: แก้ไขแม่แบบที่หน้ารายการซ้ำ "${name}" (กด "แก้ไขแม่แบบ" แล้วคัดลอกจากเอกสารที่ใช้ได้) หรือหยุดรายการซ้ำนี้`;

// ---------------------------------------------------------------- editing, stopping

export function updateSchedule(st: MockState, companyId: string, id: string, v: Record<string, unknown>): ScheduleRecord {
  const s = scheduleOf(st, companyId, id);
  const name = typeof v.name === 'string' ? v.name.trim() : s.name;
  if (!name) throw fail(422, 'schedule.invalid', 'ต้องตั้งชื่อ');
  s.name = name;
  if (s.kind === 'recurring') {
    if (v.frequency !== undefined) { if (!((v.frequency as string) in STEP)) throw fail(422, 'schedule.invalid', 'ความถี่ไม่ถูกต้อง'); s.frequency = v.frequency as ScheduleFrequency; }
    if (v.nextRun !== undefined && v.nextRun !== s.nextRun) { if (!validDate(v.nextRun)) throw fail(422, 'schedule.invalid', 'วันที่รันครั้งถัดไปไม่ถูกต้อง'); s.nextRun = v.nextRun; s.day = Number(v.nextRun.slice(8, 10)); }
    if ('endAfter' in v) { if (v.endAfter === undefined || v.endAfter === null || v.endAfter === '') delete s.endAfter; else if (Number.isInteger(v.endAfter) && (v.endAfter as number) >= 1) s.endAfter = v.endAfter as number; else throw fail(422, 'schedule.invalid', 'จำนวนครั้งต้องเป็นจำนวนเต็มตั้งแต่ 1'); }
    if (typeof v.templateDocId === 'string' && v.templateDocId.trim()) { // "แก้ไขแม่แบบ": a fresh frozen copy of another document of the same type
      const q = v.templateDocId.trim(), d = st.docs.find((x) => x.companyId === companyId && (x.id === q || x.number === q));
      if (!d || d.type !== s.template!.type) throw fail(422, 'schedule.invalid', `ไม่พบเอกสารประเภท ${s.template!.type} เลขที่ ${q}`);
      const t = templateOf(d); checkTemplate(st, companyId, t, s.name, true); s.template = t; s.source = { docId: d.id };
    }
    refresh(st, s);
  }
  touch(s);
  return s; // the record route audits create / update
}

/** Marks a schedule stopped (the remaining balance stays on the prepaid account). No audit: the caller audits. */
export function markStopped(st: MockState, s: ScheduleRecord, actor: Actor, reason?: string): void {
  if (s.stopped) return;
  s.stopped = { at: stamp(), by: actor, ...(reason ? { reason } : {}) };
  refresh(st, s); touch(s);
}
export function stopSchedule(st: MockState, companyId: string, id: string, actor: Actor, reason?: string): ScheduleRecord {
  const s = scheduleOf(st, companyId, id);
  if (s.stopped) return s;
  markStopped(st, s, actor, reason?.trim() || undefined);
  logAudit(st, actor, companyId, 'schedule.stop', id, { active: true }, { active: false, reason: s.stopped!.reason, remaining: s.kind === 'amortisation' ? remainingOf(st, s) : undefined });
  return s;
}
export function resumeSchedule(st: MockState, s: ScheduleRecord): void {
  if (s.kind !== 'recurring' || (s.endAfter && s.runs.length >= s.endAfter)) throw fail(409, 'schedule.stopped_final', 'ตารางที่หยุดหรือเสร็จแล้วเปิดใหม่ไม่ได้ ให้ตั้งตารางใหม่จากเอกสารต้นทาง');
  delete s.stopped; refresh(st, s); touch(s);
}
/** What the schedule has not yet taken out of the prepaid account (satang-exact string). */
export const remainingOf = (st: MockState, s: ScheduleRecord): Money => fromSatang(sat(s.total) - liveRuns(st, s).reduce((n, r) => n + sat(r.amount), 0));

// ---------------------------------------------------------------- running

export function runSchedule(st: MockState, companyId: string, id: string, actor: Actor, opts?: { month?: string }): ScheduleRecord {
  const s = scheduleOf(st, companyId, id);
  if (s.stopped) throw fail(409, 'schedule.stopped', `ตาราง "${s.name}" หยุดแล้ว${s.stopped.reason ? ` (${s.stopped.reason})` : ''} รันไม่ได้`);
  if (s.kind === 'recurring') return runRecurring(st, s, actor);
  const live = liveRuns(st, s), n = s.plan!.length;
  if (opts?.month && live.some((r) => r.month === opts.month)) throw fail(409, 'schedule.already_run', `งวด ${monthLabelTh(opts.month)} ตัดจ่ายแล้ว ตัดซ้ำไม่ได้ (ถ้าต้องการตัดใหม่ ให้กลับรายการใบสำคัญของงวดนั้นก่อน)`);
  if (live.length >= n) throw fail(409, 'schedule.done', `ตาราง "${s.name}" ตัดจ่ายครบทุกงวดแล้ว`);
  const row = s.plan![live.length];
  if (opts?.month && opts.month !== row.month) throw fail(422, 'schedule.out_of_order', `ต้องตัดจ่ายตามลำดับ งวดถัดไปคือ ${monthLabelTh(row.month)}`);
  if (row.month > today().slice(0, 7)) throw fail(422, 'schedule.not_due', `งวด ${monthLabelTh(row.month)} ยังไม่ถึงกำหนด (ตัดจ่ายได้ตั้งแต่เดือนนั้น)`);
  const date = lastDayOf(row.month);
  if (isClosed(st, companyId, date)) throw fail(422, 'period.closed', `งวดบัญชี ${monthLabelTh(row.month)} ปิดแล้ว ตัดจ่ายงวดนี้ไม่ได้ ทางออก: เปิดงวดบัญชีอีกครั้ง (หน้าปิดงวด) แล้วรันใหม่ งวดนี้จะแสดงเป็นรายการที่ยังไม่ได้ตัด`);
  const lines = runLines(s, row);
  const bad = jvAccountProblem(st, companyId, lines);
  if (bad) throw bad;
  const jv = postRun(st, s, row, date, lines, actor);
  s.runs.push({ at: date, month: row.month, resultDocId: jv.id, amount: row.amount });
  refresh(st, s); touch(s);
  logAudit(st, actor, companyId, 'schedule.run', s.id, undefined, { month: row.month, amount: row.amount, doc: jv.id });
  return s;
}
const runLines = (s: ScheduleRecord, row: SchedulePlanRow): DocLine[] => {
  const d = `ตัดจ่าย ${s.name} ${monthLabelTh(row.month)}`;
  const l = (n: number, accountCode: string, debit: string, credit: string): DocLine => ({ id: `${s.id}-${row.month}-l${n}`, description: d, qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', accountCode, debit, credit });
  return [l(1, s.expenseAccount!, row.amount, '0.00'), l(2, s.prepaidAccount!, '0.00', row.amount)];
};
/** The system JV of a run: an issued document of its own (number, journal entry with postedAt), linked to its schedule by `header.scheduleId`. */
function postRun(st: MockState, s: ScheduleRecord, row: SchedulePlanRow, date: IsoDate, lines: DocLine[], actor: Actor): Stored {
  const at = stamp(), id = newId(st, 'JV');
  const d: Stored = { companyId: s.companyId, id, type: 'JV', number: allocate(st, s.companyId, 'JV', date), status: 'issued', correctionClass: 'L', revision: 0, version: 1,
    header: { documentDate: date, reference: `ตัดจ่าย ${s.name} ${monthLabelTh(row.month)}`, scheduleId: s.id, scheduleMonth: row.month }, lines, totals: jvTotals(lines), locks: [], createdBy: actor, issuedAt: at };
  st.docs.push(d);
  setJournal(st, id, ledgerFor(st, d));
  st.revisions.push({ docId: id, revision: 0, at, actor, snapshot: publicDoc(d), diff: [] });
  logActivity(st, id, actor, 'issue', `ตัดจ่ายตามตาราง ${s.name} งวด ${monthLabelTh(row.month)}`);
  logAudit(st, actor, s.companyId, 'doc.issue', id, undefined, { type: 'JV', schedule: s.id });
  return d;
}

function runRecurring(st: MockState, s: ScheduleRecord, actor: Actor): ScheduleRecord {
  if (s.endAfter && s.runs.length >= s.endAfter) throw fail(409, 'schedule.done', `ตาราง "${s.name}" รันครบ ${s.endAfter} ครั้งแล้ว`);
  if (isClosed(st, s.companyId, s.nextRun)) throw fail(422, 'period.closed', `งวดบัญชี ${monthLabelTh(s.nextRun.slice(0, 7))} ปิดแล้ว สร้างฉบับร่างลงวันที่ ${s.nextRun} ไม่ได้ ทางออก: เปิดงวดบัญชีอีกครั้ง หรือแก้วันที่รันครั้งถัดไปของรายการซ้ำนี้`);
  const t = s.template!;
  checkTemplate(st, s.companyId, t, s.name, true);
  const draft = createDraft(st, s.companyId, t.type, { header: { ...structuredClone(t.header), documentDate: s.nextRun }, lines: structuredClone(t.lines) }, actor, `sched-${s.id}-${s.runs.length + 1}`);
  logActivity(st, draft.id, actor, 'schedule', `สร้างจากรายการซ้ำ "${s.name}"`);
  s.runs.push({ at: s.nextRun, resultDocId: draft.id });
  s.nextRun = advance(s.nextRun, s.frequency, s.day ?? Number(s.nextRun.slice(8, 10)));
  refresh(st, s); touch(s);
  logAudit(st, actor, s.companyId, 'schedule.run', s.id, undefined, { draft: draft.id, nextRun: s.nextRun });
  return s;
}

// ---------------------------------------------------------------- locks and hooks (called from the document commands)

const liveSchedulesOn = (st: MockState, docId: string) => st.schedules.filter((s) => s.kind === 'amortisation' && s.source?.docId === docId && liveRuns(st, s).length > 0);
const scheduleHref = (s: ScheduleRecord) => `/accounting/schedules/${s.id}`;
const exitOf = (s: ScheduleRecord) => `หยุด/กลับรายการตารางตัดจ่าย ${s.name}`;

/** The lock a source PB / JV reads with while a schedule has a live run on it. Derived at read, never stored. */
export function scheduleLock(st: MockState, d: { id?: string; status: string }): Lock | undefined {
  if (!d.id || !LIVE.includes(d.status as never)) return undefined;
  const s = liveSchedulesOn(st, d.id)[0];
  return s ? { kind: 'schedule', reason: `มีการตัดจ่ายตามตาราง "${s.name}" แล้ว ${liveRuns(st, s).length} งวด`, exits: [exitOf(s)], href: scheduleHref(s) } : undefined;
}
const lineKey = (l: DocLine | undefined) => (l ? JSON.stringify([l.qty, l.unitPrice, l.discountPct ?? '', l.taxCode, l.itemId ?? '', l.expenseCategory ?? '', l.accountCode ?? '', l.debit ?? '', l.credit ?? '', l.vatOverride ?? '']) : 'gone');

/** Ruling 3: while a schedule has a live run on a line of this document, the document cannot be cancelled (no `next`) nor have that line's money, account or date revised (`next` = what the revision would make it). */
export function refuseScheduleSource(st: MockState, d: { id: string; header: DocHeader; lines: DocLine[]; priceIncludesVat?: boolean }, next?: { header: DocHeader; lines: DocLine[] }): void {
  for (const s of liveSchedulesOn(st, d.id)) {
    const was = d.lines.find((l) => l.id === s.source!.lineId), now = next?.lines.find((l) => l.id === s.source!.lineId);
    const same = next && lineKey(was) === lineKey(now) && next.header.documentDate === d.header.documentDate && !!next.header.priceIncludesVat === !!d.header.priceIncludesVat;
    if (same) continue;
    throw fail(409, 'schedule.source_locked', `มีการตัดจ่ายตามตาราง "${s.name}" แล้ว ${liveRuns(st, s).length} งวด — ${next ? 'แก้ไขยอด บัญชี หรือวันที่ของรายการที่ตัดจ่ายไม่ได้' : 'ยกเลิกหรือกลับรายการเอกสารนี้ไม่ได้'} ทางออก: ${exitOf(s)}`);
  }
}
/** The source document was cancelled: its schedules (none has a live run, the cancel was allowed) are cancelled with it. */
export function cancelSchedulesOf(st: MockState, d: { id: string; companyId: string }, actor: Actor): void {
  for (const s of st.schedules.filter((x) => x.kind === 'amortisation' && !x.stopped && x.companyId === d.companyId && x.source?.docId === d.id)) {
    markStopped(st, s, actor, 'ยกเลิกเอกสารต้นทาง');
    logAudit(st, actor, d.companyId, 'schedule.stop', s.id, { active: true }, { active: false, reason: s.stopped!.reason });
  }
}
/** A run JV is the system's: it is reversed (กลับรายการ), never revised or cancelled. `jvLock` shows the banner. */
export function runLockOf(st: MockState, d: { header: DocHeader }): Lock | undefined {
  const s = d.header.scheduleId ? st.schedules.find((x) => x.id === d.header.scheduleId) : undefined;
  return s ? { kind: 'reversal', reason: `ใบสำคัญตัดจ่ายตามตาราง "${s.name}" งวด ${monthLabelTh(d.header.scheduleMonth ?? '')} แก้ไขหรือยกเลิกโดยตรงไม่ได้`, exits: ['กลับรายการ'] } : undefined;
}
export function refuseRunFinal(st: MockState, d: Stored): void {
  const l = runLockOf(st, d);
  if (l) throw fail(409, 'schedule.run_final', `${l.reason} ทางออก: กลับรายการ (แล้วรันงวดนั้นใหม่ได้)`);
}
/** Reversing a run: only the latest live run (so the live runs stay a prefix of the plan). */
export function beforeRunReversed(st: MockState, jv: Stored): void {
  const s = jv.header.scheduleId ? st.schedules.find((x) => x.id === jv.header.scheduleId) : undefined;
  if (!s) return;
  const live = liveRuns(st, s), last = live[live.length - 1];
  if (last && last.resultDocId !== jv.id) throw fail(409, 'schedule.run_not_last', `กลับรายการได้เฉพาะงวดล่าสุด (${monthLabelTh(last.month!)}) กลับรายการงวดหลังก่อน`);
}
export function onRunReversed(st: MockState, jv: Stored, actor: Actor): void {
  const s = jv.header.scheduleId ? st.schedules.find((x) => x.id === jv.header.scheduleId) : undefined;
  const run = s?.runs.find((r) => r.resultDocId === jv.id && !r.reversed);
  if (!s || !run) return;
  run.reversed = true; refresh(st, s); touch(s);
  logAudit(st, actor, s.companyId, 'schedule.run_reversed', s.id, undefined, { month: run.month, doc: jv.id });
}

// ---------------------------------------------------------------- invariants

/** AC4 invariants (ruling 5): the plan sums to the total; each live run JV is its plan row and linked to its schedule; one live run per month; the runs are a prefix of the plan; the prepaid account moved by exactly the live runs
 *  and never below -total; a done schedule has every month run; one live schedule per source line. */
export function scheduleInvariants(st: MockState): string[] {
  const out: string[] = [];
  for (const s of st.schedules) {
    if (s.kind === 'recurring') {
      if (!s.template || !RECURRING_TYPES.includes(s.template.type)) out.push(`${s.id}: recurring schedule without a usable template`);
      if (s.endAfter && s.runs.length > s.endAfter) out.push(`${s.id}: ${s.runs.length} runs exceed endAfter ${s.endAfter}`);
      if (s.template?.type === 'JV') for (const l of s.template.lines.filter(isUsed)) { const x = l.accountCode ? controlExit(st, s.companyId, l.accountCode, 'jv') : undefined; if (x) out.push(`${s.id}: JV template on controlled account ${l.accountCode}`); }
      if (s.active !== (!s.stopped && !(s.endAfter && s.runs.length >= s.endAfter))) out.push(`${s.id}: active flag disagrees with stopped / endAfter`);
      continue;
    }
    const plan = s.plan ?? [];
    if (!plan.length || plan.length !== s.months) out.push(`${s.id}: plan has ${plan.length} rows for ${s.months} months`);
    if (plan.reduce((n, r) => n + sat(r.amount), 0) !== sat(s.total)) out.push(`${s.id}: plan does not sum to the total ${s.total}`);
    plan.forEach((r, i) => { if (r.month !== addMonths(s.startMonth!, i) || !(sat(r.amount) > 0)) out.push(`${s.id}: plan row ${i + 1} is not month ${addMonths(s.startMonth!, i)} with an amount`); });
    for (const code of [s.expenseAccount, s.prepaidAccount]) if (!st.accounts.some((a) => a.companyId === s.companyId && a.code === code)) out.push(`${s.id}: account ${code} is not in the company's chart`);
    const live = liveRuns(st, s), seen = new Set<string>();
    live.forEach((r, i) => {
      const jv = docOf(st, r.resultDocId)!, row = plan.find((p) => p.month === r.month);
      if (!row) { out.push(`${s.id}: run ${r.resultDocId} is for month ${r.month}, which is not in the plan`); return; }
      if (seen.has(r.month!)) out.push(`${s.id}: two live runs for plan month ${r.month}`);
      seen.add(r.month!);
      if (r.month !== plan[i]?.month) out.push(`${s.id}: live runs are not a prefix of the plan (run ${i + 1} is ${r.month}, expected ${plan[i]?.month})`);
      if (jv.type !== 'JV' || jv.companyId !== s.companyId) out.push(`${s.id}: run ${jv.id} is not a JV of the company`);
      if (jv.header.scheduleId !== s.id || jv.header.scheduleMonth !== r.month) out.push(`${jv.id}: run JV is not linked to schedule ${s.id} month ${r.month}`);
      if (jv.header.documentDate !== lastDayOf(r.month!)) out.push(`${jv.id}: run JV date ${jv.header.documentDate} is not the last day of ${r.month}`);
      const ls = jv.lines.filter(isUsed);
      if (ls.length !== 2 || ls[0].accountCode !== s.expenseAccount || sat(ls[0].debit) !== sat(row.amount) || sat(ls[0].credit) !== 0 || ls[1].accountCode !== s.prepaidAccount || sat(ls[1].credit) !== sat(row.amount) || sat(ls[1].debit) !== 0 || sat(r.amount) !== sat(row.amount)) out.push(`${jv.id}: run JV is not its plan row (${row.amount} ${s.expenseAccount} / ${s.prepaidAccount})`);
    });
    for (const jv of st.docs.filter((d) => d.header.scheduleId === s.id && LIVE.includes(d.status) && !userReversalOf(st, d.id))) if (!live.some((r) => r.resultDocId === jv.id)) out.push(`${jv.id}: JV claims schedule ${s.id} but is not one of its live runs`);
    // the prepaid account moved by exactly the live runs: the run JVs and their reversals, over every entry they ever posted
    const ids = new Set(st.docs.filter((d) => d.header.scheduleId === s.id || (d.header.reversalOf && docOf(st, d.header.reversalOf)?.header.scheduleId === s.id)).map((d) => d.id));
    const net = st.journals.filter((j) => ids.has(j.docId)).flatMap((j) => j.preview.entries).flatMap((e) => e.lines).filter((l) => l.accountCode === s.prepaidAccount).reduce((n, l) => n + sat(l.debit) - sat(l.credit), 0);
    const taken = live.reduce((n, r) => n + sat(r.amount), 0);
    if (net !== -taken) out.push(`${s.id}: account ${s.prepaidAccount} moved by ${fromSatang(net)}, the live runs say ${fromSatang(-taken)}`);
    if (net < -sat(s.total)) out.push(`${s.id}: account ${s.prepaidAccount} moved below -${s.total}`);
    if (s.active !== (!s.stopped && live.length < plan.length)) out.push(`${s.id}: active flag disagrees with the runs`);
    if (!s.active && !s.stopped && live.length !== plan.length) out.push(`${s.id}: schedule is done but ${plan.length - live.length} months are not run`);
    const src = docOf(st, s.source?.docId);
    if (!src || src.companyId !== s.companyId) out.push(`${s.id}: source ${s.source?.docId} is not a document of the company`);
    else if (live.length && !LIVE.includes(src.status)) out.push(`${s.id}: source ${src.id} is ${src.status} under a live run`);
    else if (live.length && src.type === 'JV' && userReversalOf(st, src.id)) out.push(`${s.id}: source JV ${src.id} is reversed under a live run`);
    if (!s.stopped && st.schedules.some((o) => o !== s && o.kind === 'amortisation' && !o.stopped && o.source?.docId === s.source?.docId && o.source?.lineId === s.source?.lineId)) out.push(`${s.id}: another live schedule on source ${s.source?.docId} line ${s.source?.lineId}`);
  }
  return out;
}
