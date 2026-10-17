import { DESCRIPTORS } from '@/descriptors';
import { GROUP_OF } from '@/records/accounts';
import type { Actor, ChecklistItem, IsoDate, JournalEntryPreview, JournalLinePreview, Money, PeriodMonth, PeriodsView } from '@/domain/types';
import type { MockState } from '../store';
import { liveDps, planDepreciation } from './assets';
import { companyEntries, reversalOf } from './ledger';
import { MockError, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { buildOb, liveBatches } from './opening';
import { type Period, monthLabelTh, yearClosed } from './periods';
import { liveRuns } from './schedules';
import { chainStart } from './filings';
import { vatOf } from './vat';

// AC6: closing a month (a checklist the server computes; blocking items refuse, warnings need an acknowledgement that is frozen on the period) and the year-end closing entry. The month rules: closed months are a prefix
// (close in order, reopen only the latest closed month of an open year). The year rules: the closing entry sweeps every revenue / expense account of the year into 3300, then 3300 into 3200; the invariant
// lives on that entry itself (not on a change of 3200, which dividends and other journals also move).

const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const sat = (m: string) => toSatang(m);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LABEL: Record<ChecklistItem['code'], string> = {
  drafts_in_month: 'เอกสารฉบับร่างที่ยังไม่ออกในงวดนี้', unreconciled_bank_lines: 'รายการเดินบัญชีธนาคารที่ยังไม่กระทบยอด', depreciation_not_run: 'ยังไม่ได้คิดค่าเสื่อมราคาของงวดนี้ (สินทรัพย์ที่ต้องคิด)',
  schedules_not_run: 'รายการตัดจ่ายตามตารางที่ยังไม่ได้รัน', filings_not_finalized: 'แบบยื่นภาษีของงวดนี้ที่ยังไม่ยืนยัน', ob_difference_open: 'ยอดยกมามีผลต่างค้างที่ 3900 (ส่วนเกินทุนยอดยกมา)',
};
const rows = (st: MockState, companyId: string): Period[] => st.periods.filter((p) => p.companyId === companyId).sort((a, b) => a.month.localeCompare(b.month));
const rowOf = (st: MockState, companyId: string, month: string): Period => {
  const p = MONTH.test(month) ? st.periods.find((x) => x.companyId === companyId && x.month === month) : undefined;
  if (!p) throw fail(404, 'period.not_found', `ไม่พบงวดบัญชี ${month}`);
  return p;
};

// ---------------------------------------------------------------- the checklist

export function checklistOf(st: MockState, companyId: string, month: string): ChecklistItem[] {
  if (!MONTH.test(month)) throw fail(422, 'period.invalid', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const drafts = st.docs.filter((d) => d.companyId === companyId && ['draft', 'pending', 'approved'].includes(d.status) && d.header.documentDate.startsWith(month));
  const bank = st.bankLines.filter((l) => l.companyId === companyId && l.date.startsWith(month) && l.status === 'unmatched').length;
  const dep = liveDps(st, companyId).some((d) => d.dp!.month === month) ? 0 : planDepreciation(st, companyId, month).rows.length; // what the run of the month would write: an asset with nothing to depreciate (sold, fully depreciated) needs none
  const sched = st.schedules.filter((s) => s.companyId === companyId && s.kind === 'amortisation' && !s.stopped).reduce((n, s) => {
    const ran = new Set(liveRuns(st, s).map((r) => r.month));
    return n + (s.plan ?? []).filter((r) => r.month <= month && !ran.has(r.month)).length;
  }, 0);
  const start = chainStart(st, companyId); // TX1: from the company's first finalized ภ.พ.30 on, every month's is owed (months before it are before TEAS took over filing)
  const filing = vatOf(st, companyId) && start !== undefined && month >= start && !st.filings.some((f) => f.companyId === companyId && f.form === 'PP30' && f.period === month) ? 1 : 0;
  const ob = liveBatches(st, companyId).filter((d) => buildOb(st, companyId, d).check.plug !== '0.00').length;
  const item = (code: ChecklistItem['code'], severity: ChecklistItem['severity'], count: number, href: string, note?: string): ChecklistItem => ({ code, severity, count, labelTh: LABEL[code], href, ...(note ? { note } : {}) });
  return [
    item('drafts_in_month', 'warning', drafts.length, (drafts[0] && DESCRIPTORS[drafts[0].type]?.basePath) || '/'),
    item('unreconciled_bank_lines', 'warning', bank, '/finance/bank-accounts'),
    item('depreciation_not_run', 'blocking', dep, '/accounting/depreciation-runs/new'),
    item('schedules_not_run', 'warning', sched, '/accounting/schedules'),
    item('filings_not_finalized', 'warning', filing, `/tax/vat?period=${month}`),
    item('ob_difference_open', 'warning', ob, '/accounting/opening-balances'),
  ];
}
const said = (items: ChecklistItem[]) => items.map((i) => `${i.labelTh} ${i.count} รายการ (ทางออก: ${i.href})`).join('; ');

// ---------------------------------------------------------------- months

/** Close `month`: in order, never with a blocking item, and with the warnings acknowledged: `acknowledge` is the list the closer saw ({code, count}) and must be exactly the current warnings (a warning that appeared or changed since is not accepted); stored on the period as they were. */
export function closePeriod(st: MockState, companyId: string, month: string, actor: Actor, o?: { acknowledge?: { code: string; count: number }[] }): Period {
  const p = rowOf(st, companyId, month);
  if (p.status === 'closed') throw fail(409, 'period.already_closed', `งวดบัญชี ${monthLabelTh(month)} ปิดแล้ว`);
  const first = rows(st, companyId).find((x) => x.status === 'open')!;
  if (first.month < month) throw fail(422, 'period.order', `ต้องปิดงวดบัญชีตามลำดับ ปิดงวด ${monthLabelTh(first.month)} ก่อน`);
  const items = checklistOf(st, companyId, month).filter((i) => i.count > 0);
  const blocking = items.filter((i) => i.severity === 'blocking'), warnings = items.filter((i) => i.severity === 'warning');
  if (blocking.length) throw fail(422, 'period.blocked', `ปิดงวดบัญชี ${monthLabelTh(month)} ไม่ได้: ${said(blocking)}`);
  const key = (l: { code: string; count: number }[]) => l.map((i) => `${i.code}:${i.count}`).sort().join(',');
  if ((warnings.length || o?.acknowledge?.length) && key(o?.acknowledge ?? []) !== key(warnings)) throw fail(422, 'period.warnings', `ปิดงวดบัญชี ${monthLabelTh(month)} ต้องรับทราบข้อควรระวังก่อน: ${said(warnings)}`);
  p.status = 'closed'; p.closedAt = stamp(); p.closedBy = actor; p.acknowledged = warnings;
  logAudit(st, actor, companyId, 'period.close', month, { status: 'open' }, { status: 'closed', acknowledged: warnings.map((w) => `${w.code}:${w.count}`) });
  return p;
}

/** Reopen the latest closed month of an open year, with a reason; the history keeps every reopen. */
export function reopenPeriod(st: MockState, companyId: string, month: string, actor: Actor, reason: string): Period {
  const p = rowOf(st, companyId, month);
  if (p.status !== 'closed') throw fail(409, 'period.not_closed', `งวดบัญชี ${monthLabelTh(month)} ยังเปิดอยู่`);
  if (!reason?.trim()) throw fail(422, 'period.reason_required', 'ต้องระบุเหตุผลที่เปิดงวดบัญชี');
  if (yearClosed(st, companyId, `${month}-01`)) throw fail(422, 'period.year_closed', `งวดบัญชี ${monthLabelTh(month)} อยู่ในปีบัญชี ${Number(month.slice(0, 4)) + 543} ที่ปิดแล้ว ทางออก: เปิดปีบัญชีอีกครั้งก่อน`);
  const last = rows(st, companyId).filter((x) => x.status === 'closed').at(-1)!;
  if (last.month > month) throw fail(422, 'period.reopen_order', `เปิดงวดย้อนหลังได้ครั้งละงวดล่าสุดเท่านั้น เปิดงวด ${monthLabelTh(last.month)} ก่อน`);
  (p.reopened ??= []).push({ at: stamp(), reason: reason.trim(), by: actor });
  p.status = 'open'; delete p.closedAt; delete p.closedBy; delete p.acknowledged;
  logAudit(st, actor, companyId, 'period.reopen', month, { status: 'closed' }, { status: 'open', reason: reason.trim() });
  return p;
}

// ---------------------------------------------------------------- the year

/** The closing entry of a fiscal year (one live per company-year). `journal` is its entry, and its reversal after a reopen; the entry's lines are frozen at close. */
export interface YearClose {
  id: string; companyId: string; year: number; date: IsoDate; closedAt: string; closedBy: Actor;
  /** Σ revenue - Σ expense of the year at close (negative = loss), the figure the 3200 line carries. */ net: Money;
  journal: JournalEntryPreview[]; reopened?: { at: string; reason: string; by: Actor };
}
export const liveYearClose = (st: MockState, companyId: string, year: number): YearClose | undefined => st.yearCloses.find((y) => y.companyId === companyId && y.year === year && !y.reopened);
const accountName = (st: MockState, companyId: string, code: string) => st.accounts.find((a) => a.companyId === companyId && a.code === code)?.nameTh ?? code;
const isPl = (st: MockState, companyId: string, code: string) => { const a = st.accounts.find((x) => x.companyId === companyId && x.code === code); return !!a && ['revenue', 'expense'].includes(GROUP_OF[a.class]); };
/** Σ debit - Σ credit (satang) per account of the entries dated in `year`; `closing` false leaves the year-end entries out (what they close). */
function balances(st: MockState, companyId: string, year: number, closing: boolean): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of companyEntries(st, companyId, closing)) if (e.date.startsWith(`${year}-`)) for (const l of e.lines) m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + sat(l.debit) - sat(l.credit));
  return m;
}
const plOf = (st: MockState, companyId: string, m: Map<string, number>): [string, number][] => [...m].filter(([c, v]) => v !== 0 && isPl(st, companyId, c)).sort(([a], [b]) => a.localeCompare(b));
const equityCode = (st: MockState, companyId: string, sub: 'current-year' | 'retained') => st.accounts.find((a) => a.companyId === companyId && a.subClass === sub && a.postable)!.code;

/** The closing entry as the books stand: each revenue / expense account to 0, the sum into 3300, and 3300 into 3200 for the net. */
function closingLines(st: MockState, companyId: string, year: number): { lines: JournalLinePreview[]; net: number } {
  const pl = plOf(st, companyId, balances(st, companyId, year, false));
  const line = (code: string, dr: number, cr: number, rule: string): JournalLinePreview => ({ accountCode: code, accountName: accountName(st, companyId, code), debit: fromSatang(dr), credit: fromSatang(cr), rule });
  const lines = pl.map(([code, v]) => line(code, Math.max(-v, 0), Math.max(v, 0), 'ปิดบัญชีสิ้นปี: ปิดบัญชีรายได้/ค่าใช้จ่ายเข้าบัญชีกำไรขาดทุน'));
  const dr = pl.filter(([, v]) => v < 0).reduce((n, [, v]) => n - v, 0), cr = pl.filter(([, v]) => v > 0).reduce((n, [, v]) => n + v, 0); // lines' Dr (revenue closed) and Cr (expense closed)
  const s = equityCode(st, companyId, 'current-year'), r = equityCode(st, companyId, 'retained'), net = dr - cr;
  if (cr) lines.push(line(s, cr, 0, 'ปิดบัญชีสิ้นปี: ค่าใช้จ่ายรวม'));
  if (dr) lines.push(line(s, 0, dr, 'ปิดบัญชีสิ้นปี: รายได้รวม'));
  if (net) lines.push(line(s, Math.max(net, 0), Math.max(-net, 0), 'ปิดบัญชีสิ้นปี: โอนกำไร(ขาดทุน)สุทธิ'), line(r, Math.max(-net, 0), Math.max(net, 0), 'ปิดบัญชีสิ้นปี: โอนกำไร(ขาดทุน)สุทธิเข้ากำไรสะสม'));
  return { lines, net };
}

export function closeYear(st: MockState, companyId: string, year: number, actor: Actor): YearClose {
  const ms = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  if (!Number.isInteger(year) || ms.some((m) => !st.periods.some((p) => p.companyId === companyId && p.month === m))) throw fail(404, 'period.not_found', `ไม่พบปีบัญชี ${year}`);
  if (liveYearClose(st, companyId, year)) throw fail(409, 'period.year_closed', `ปีบัญชี ${year + 543} ปิดแล้ว`);
  const open = ms.find((m) => st.periods.find((p) => p.companyId === companyId && p.month === m)!.status !== 'closed');
  if (open) throw fail(422, 'period.year_months_open', `ปิดปีบัญชี ${year + 543} ไม่ได้ ต้องปิดครบ 12 งวดก่อน (ยังเปิดอยู่: ${monthLabelTh(open)})`);
  const date = `${year}-12-31`;
  if (date > today()) throw fail(422, 'period.year_not_ended', `ปีบัญชี ${year + 543} ยังไม่สิ้นสุด (ปิดบัญชีสิ้นปีได้เมื่อพ้น ${date})`);
  const prior = [...new Set(st.periods.filter((p) => p.companyId === companyId && Number(p.month.slice(0, 4)) < year).map((p) => Number(p.month.slice(0, 4))))].sort().find((y) => !liveYearClose(st, companyId, y));
  if (prior) throw fail(422, 'period.year_order', `ปิดปีบัญชี ${year + 543} ไม่ได้ ปีบัญชี ${prior + 543} ยังไม่ได้ปิดบัญชีสิ้นปี ทางออก: ปิดปีบัญชี ${prior + 543} ก่อน`);
  const { lines, net } = closingLines(st, companyId, year), at = stamp();
  const y: YearClose = { id: `yc-${companyId}-${year}-${st.yearCloses.filter((x) => x.companyId === companyId && x.year === year).length + 1}`, companyId, year, date, closedAt: at, closedBy: actor, net: fromSatang(net),
    journal: [{ date, kind: 'original', postedAt: at, lines }] };
  st.yearCloses.push(y);
  logAudit(st, actor, companyId, 'period.year_close', String(year), undefined, { id: y.id, net: y.net, lines: lines.length });
  return y;
}

/** Reverse the closing entry (a reversal dated the year's last day, with its own postedAt): the year's revenue / expense balances are back exactly. */
export function reopenYear(st: MockState, companyId: string, year: number, actor: Actor, reason: string): YearClose {
  const y = liveYearClose(st, companyId, year);
  if (!y) throw fail(409, 'period.year_not_closed', `ปีบัญชี ${year + 543} ยังไม่ได้ปิด`);
  if (!reason?.trim()) throw fail(422, 'period.reason_required', 'ต้องระบุเหตุผลที่เปิดปีบัญชี');
  const later = st.yearCloses.filter((x) => x.companyId === companyId && x.year > year && !x.reopened).map((x) => x.year).sort()[0];
  if (later) throw fail(422, 'period.year_order', `เปิดปีบัญชี ${year + 543} ไม่ได้ ปีบัญชี ${later + 543} ยังปิดอยู่ ทางออก: เปิดปีบัญชี ${later + 543} ก่อน`);
  const at = stamp();
  y.journal.push(reversalOf(y.journal[0], y.date, at));
  y.reopened = { at, reason: reason.trim(), by: actor };
  logAudit(st, actor, companyId, 'period.year_reopen', String(year), { id: y.id }, { reason: reason.trim() });
  return y;
}

// ---------------------------------------------------------------- the screen

export function periodsView(st: MockState, companyId: string, year: number): PeriodsView {
  const all = rows(st, companyId), yc = liveYearClose(st, companyId, year);
  const months: PeriodMonth[] = all.filter((p) => p.month.startsWith(`${year}-`)).map((p) => ({ month: p.month, status: p.status, ...(p.closedAt ? { closedAt: p.closedAt } : {}), ...(p.closedBy ? { closedBy: p.closedBy.name } : {}),
    acknowledged: p.acknowledged ?? [], reopened: (p.reopened ?? []).map((r) => ({ ...r, by: r.by.name })), inClosedYear: yearClosed(st, companyId, `${p.month}-01`) }));
  const lastClosed = all.filter((p) => p.status === 'closed').at(-1);
  const hist = st.yearCloses.filter((y) => y.companyId === companyId && y.year === year && y.reopened).map((y) => ({ ...y.reopened!, by: y.reopened!.by.name }));
  return {
    year, years: [...new Set(all.map((p) => Number(p.month.slice(0, 4))))], months, yearReopened: hist,
    ...(yc ? { yearClose: { id: yc.id, year, date: yc.date, closedAt: yc.closedAt, closedBy: yc.closedBy.name, net: yc.net, lines: yc.journal[0].lines } } : {}),
    next: {
      ...(all.find((p) => p.status === 'open') ? { close: all.find((p) => p.status === 'open')!.month } : {}),
      ...(lastClosed && !yearClosed(st, companyId, `${lastClosed.month}-01`) ? { reopen: lastClosed.month } : {}),
      closeYear: !yc && months.length === 12 && months.every((m) => m.status === 'closed') && `${year}-12-31` <= today(), reopenYear: !!yc,
    },
  };
}

// ---------------------------------------------------------------- invariants

const mirrorOk = (a: JournalLinePreview[], b: JournalLinePreview[]) => a.length === b.length && a.every((l, i) => b[i].accountCode === l.accountCode && sat(b[i].debit) === sat(l.credit) && sat(b[i].credit) === sat(l.debit));

/** AC6 invariants of the year-end closing entries: one live per company-year; dated the last day, with its twelve months closed; its line per revenue / expense account is minus that account's balance of the year from the
 *  other entries, and nothing else is swept; 3300 nets to nothing over the year (the entry balancing is the generic journal check: Dr = Cr there, and with every line judged here it implies 3300 nets to zero inside it); the 3200 line is Σ revenue - Σ expense; once it stands every revenue / expense account of the year is 0; a reopened one is
 *  reversed by its exact mirror on the same day. */
export function closeInvariants(st: MockState): string[] {
  const out: string[] = [];
  for (const y of st.yearCloses) {
    const co = y.companyId, at = `${y.id}`, e = y.journal[0];
    if (!e) { out.push(`${at}: closing entry is missing`); continue; }
    if (e.date !== `${y.year}-12-31` || y.date !== e.date) out.push(`${at}: closing entry dated ${e.date}, not the last day of ${y.year}`);
    if (y.reopened) {
      const r = y.journal[1];
      if (y.journal.length !== 2 || r?.kind !== 'reversal' || r.date !== e.date || !mirrorOk(e.lines, r.lines)) out.push(`${at}: reopened but its reversal is not the exact mirror of the closing entry on ${e.date}`);
      continue;
    }
    if (y.journal.length !== 1) out.push(`${at}: live closing entry with ${y.journal.length} entries`);
    for (let m = 1; m <= 12; m++) { const month = `${y.year}-${String(m).padStart(2, '0')}`; if (st.periods.find((p) => p.companyId === co && p.month === month)?.status !== 'closed') out.push(`${at}: closed year but month ${month} is not closed`); }
    const base = plOf(st, co, balances(st, co, y.year, false)), net = base.reduce((n, [, v]) => n - v, 0), lineNet = (code: string) => e.lines.filter((l) => l.accountCode === code).reduce((n, l) => n + sat(l.debit) - sat(l.credit), 0);
    for (const [code, v] of base) if (lineNet(code) !== -v) out.push(`${at}: closing line of ${code} is ${fromSatang(lineNet(code))} (Dr - Cr) but the year's balance of ${code} from the other entries is ${fromSatang(v)}`);
    const s = equityCode(st, co, 'current-year'), r = equityCode(st, co, 'retained'), swept = new Set(base.map(([c]) => c));
    for (const l of e.lines) if (!swept.has(l.accountCode) && l.accountCode !== s && l.accountCode !== r) out.push(`${at}: closing entry touches ${l.accountCode}, which has no balance to sweep`);
    if (-lineNet(r) !== net) out.push(`${at}: 3200 (${r}) line is ${fromSatang(-lineNet(r))} but Σ revenue - Σ expense of ${y.year} is ${fromSatang(net)}`);
    if (sat(y.net) !== net) out.push(`${at}: recorded net ${y.net} is not Σ revenue - Σ expense ${fromSatang(net)}`);
    const after = balances(st, co, y.year, true);
    for (const [code, v] of plOf(st, co, after)) out.push(`${at}: ${code} still has a balance of ${fromSatang(v)} for ${y.year} after the year-end close`);
    if ((after.get(s) ?? 0) !== 0) out.push(`${at}: 3300 (${s}) has a balance of ${fromSatang(after.get(s)!)} for ${y.year} after the year-end close`);
  }
  for (const [k, n] of Object.entries(st.yearCloses.filter((y) => !y.reopened).reduce<Record<string, number>>((a, y) => ({ ...a, [`${y.companyId} ${y.year}`]: (a[`${y.companyId} ${y.year}`] ?? 0) + 1 }), {}))) if (n > 1) out.push(`${k}: more than one live closing entry`);
  return out;
}
