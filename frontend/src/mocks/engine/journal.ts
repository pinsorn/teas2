import { DESCRIPTORS, docViewHref } from '@/descriptors';
import { LIVE } from '@/domain/doc-types';
import type { ReportModel, ReportRow } from '@/domain/reports';
import type { Actor, DocHeader, DocLine, DocTotals, IsoDate, JournalEntryPreview, JournalLinePreview, Lock, MissingItem } from '@/domain/types';
import { formatDateBE } from '@/lib/format';
import type { MockState } from '../store';
import { bahtText } from './bahtText';
import { allocate, cancel, correctionReversal, dateGuards, getDoc, newId, placed, publicDoc, put, setJournal } from './commands';
import { ledgerFor } from './ledger';
import { MockError, isPinned, logActivity, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { firstOpenDate, isClosed, monthLabelTh } from './periods';
import { controlExit } from './reconcile';
import { beforeRunReversed, cancelSchedulesOf, lastDayOf, onRunReversed, refuseRunFinal, refuseScheduleSource, runLockOf } from './schedules';

// AC1: journal vouchers (JV), their reversal, auto-reversing accruals, and the general journal. A JV posts its account lines verbatim; the account / control-account rules are
// the money guards, kept in one place so issue, revise, compute and the invariants all judge the same thing.

type Stored = MockState['docs'][number];
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const SYSTEM: Actor = { kind: 'user', id: 'system', name: 'ระบบ (กลับรายการอัตโนมัติ)' };
const JV_RULE = 'ใบสำคัญทั่วไป';

/** A money string in satang; NaN for text that is not money (the caller reports it, it never becomes 0). */
const satOf = (m: string | undefined): number => { try { return toSatang(m ?? '0.00'); } catch { return NaN; } };
/** A line the editor left empty (no account, no amount) is not a line. */
export const isUsed = (l: DocLine): boolean => !!l.accountCode || satOf(l.debit) !== 0 || satOf(l.credit) !== 0;
const accountOf = (st: MockState, companyId: string, code: string) => st.accounts.find((a) => a.companyId === companyId && a.code === code);

// ---------------------------------------------------------------- the lines

/** The journal lines of a JV, verbatim and in order. */
export function jvEntryLines(st: MockState, companyId: string, lines: DocLine[]): JournalLinePreview[] {
  return lines.filter((l) => isUsed(l) && !!l.accountCode).map((l) => {
    const party = l.partyId ? st.parties.find((p) => p.id === l.partyId && p.companyId === companyId)?.name : undefined;
    return {
      accountCode: l.accountCode!, accountName: accountOf(st, companyId, l.accountCode!)?.nameTh ?? l.accountCode!,
      debit: fromSatang(satOf(l.debit) || 0), credit: fromSatang(satOf(l.credit) || 0), rule: l.description.trim() ? `${JV_RULE}: ${l.description.trim()}` : JV_RULE,
      ...(party ? { partyName: party } : {}), ...(l.dimensions && Object.keys(l.dimensions).length ? { dimensions: l.dimensions } : {}),
    };
  });
}
/** Σ debit, Σ credit and their difference (satang, as the server states them; the grid never sums). */
const sums = (lines: DocLine[]) => lines.filter(isUsed).reduce((a, l) => ({ dr: a.dr + (satOf(l.debit) || 0), cr: a.cr + (satOf(l.credit) || 0) }), { dr: 0, cr: 0 });
export function jvBalance(lines: DocLine[]): { debit: string; credit: string; diff: string } {
  const { dr, cr } = sums(lines);
  return { debit: fromSatang(dr), credit: fromSatang(cr), diff: fromSatang(Math.abs(dr - cr)) };
}
export function jvTotals(lines: DocLine[]): DocTotals {
  const total = fromSatang(sums(lines).dr);
  return { gross: total, discount: '0.00', net: total, vat: '0.00', total, amountInWords: bahtText(total) };
}
/** The per-line figures `compute` returns: the amount of whichever side the line is on. */
export function jvCalc(lines: DocLine[]): { lines: { id: string; net: string; vat: string; total: string }[] } {
  return { lines: lines.map((l) => { const a = fromSatang(Math.max(satOf(l.debit) || 0, satOf(l.credit) || 0)); return { id: l.id, net: a, vat: '0.00', total: a }; }) };
}

/** What a JV still lacks to be issued: lines with an account and ONE side, and Dr = Cr (with the difference in the message). */
export function jvMissing(lines: DocLine[]): MissingItem[] {
  const out: MissingItem[] = [];
  const used = lines.filter(isUsed);
  if (used.length < 2) out.push({ field: 'lines', message: 'ต้องมีรายการบัญชีอย่างน้อย 2 รายการ (เดบิตและเครดิต)' });
  used.forEach((l, i) => {
    const n = i + 1, dr = satOf(l.debit), cr = satOf(l.credit);
    if (!l.accountCode) out.push({ field: 'lines', message: `รายการที่ ${n}: ต้องเลือกบัญชี` });
    if (Number.isNaN(dr) || Number.isNaN(cr) || dr < 0 || cr < 0) out.push({ field: 'lines', message: `รายการที่ ${n}: จำนวนเงินไม่ถูกต้อง` });
    else if ((dr > 0) === (cr > 0)) out.push({ field: 'lines', message: `รายการที่ ${n}: ต้องระบุเดบิตหรือเครดิตอย่างใดอย่างหนึ่ง` });
  });
  const { dr, cr } = sums(lines);
  if (dr !== cr) out.push({ field: 'lines', message: `ยอดเดบิตและเครดิตไม่เท่ากัน (ต่าง ${fromSatang(Math.abs(dr - cr))})` });
  return out;
}

/** The first account problem of a JV's lines: unknown / not postable / inactive (`ledger.account_invalid`), or one a document owns (`ledger.control_account`, naming the document or screen to use). */
export function jvAccountProblem(st: MockState, companyId: string, lines: DocLine[]): MockError | undefined {
  for (const l of lines.filter((x) => isUsed(x) && !!x.accountCode)) {
    const a = accountOf(st, companyId, l.accountCode!);
    if (!a || !a.postable || (a as { active?: boolean }).active === false) return fail(422, 'ledger.account_invalid', `บัญชี ${l.accountCode} ใช้ลงรายการไม่ได้ (ไม่มีในผังบัญชีของบริษัท เป็นบัญชีหมวด หรือปิดใช้งานแล้ว)`);
    const exit = controlExit(st, companyId, a.code, 'jv');
    if (exit) return fail(422, 'ledger.control_account', `บัญชี ${a.code} ${a.nameTh} ลงจากใบสำคัญทั่วไปไม่ได้ — ${exit}`);
    if (l.partyId && !st.parties.some((p) => p.id === l.partyId && p.companyId === companyId)) return fail(422, 'ledger.party_invalid', `ไม่พบคู่ค้าของรายการบัญชี ${a.code}`);
  }
  return undefined;
}

export const nextMonthStart = (date: IsoDate): IsoDate => {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const autoClosed = (st: MockState, companyId: string, date: IsoDate) => {
  const next = nextMonthStart(date);
  return !isPinned() && isClosed(st, companyId, next)
    ? fail(422, 'ledger.auto_reverse_closed', `งวดบัญชี ${monthLabelTh(next.slice(0, 7))} ปิดแล้ว สร้างรายการกลับอัตโนมัติไม่ได้ ปิดตัวเลือก "กลับรายการอัตโนมัติ" หรือขอเปิดงวดอีกครั้ง`) : undefined;
};
/** Everything that refuses a JV before anything is written (issue, compute): its accounts, and the month its auto-reversal would post in. Not a JV: nothing. */
export function journalProblem(st: MockState, companyId: string, type: string, body: { header: DocHeader; lines: DocLine[] }): MockError | undefined {
  if (type !== 'JV') return undefined;
  return jvAccountProblem(st, companyId, body.lines) ?? (body.header.autoReverse && body.header.documentDate ? autoClosed(st, companyId, body.header.documentDate) : undefined);
}

// ---------------------------------------------------------------- reversals

const reversalsOf = (st: MockState, id: string) => st.docs.filter((x) => x.type === 'JV' && x.header.reversalOf === id && LIVE.includes(x.status));
/** The person's own reversal of a JV (not the system's auto-reversal). */
export const userReversalOf = (st: MockState, id: string): Stored | undefined => reversalsOf(st, id).find((x) => !x.header.autoReversal);
export const autoReversalOf = (st: MockState, id: string): Stored | undefined => reversalsOf(st, id).find((x) => x.header.autoReversal);

const mirror = (lines: DocLine[]): DocLine[] => lines.filter(isUsed).map((l) => ({ ...l, id: `${l.id}-r`, description: `กลับรายการ: ${l.description}`, debit: l.credit ?? '0.00', credit: l.debit ?? '0.00' }));

/** Writes a reversing JV of `orig`: an issued document of its own (number, journal entry with postedAt, an `adjusts` link, activity). The caller has judged the date. */
function postReversal(st: MockState, orig: Stored, o: { date: IsoDate; actor: Actor; auto?: boolean; reason?: string; id?: string }): Stored {
  const at = stamp(), lines = mirror(orig.lines);
  const id = o.id && !st.docs.some((x) => x.id === o.id) ? o.id : newId(st, 'JV');
  const header: DocHeader = { documentDate: o.date, reference: `กลับรายการ ${orig.number ?? orig.id}`, ...(o.reason ? { notes: o.reason } : {}), reversalOf: orig.id, ...(o.auto ? { autoReversal: true as const } : {}) };
  const d: Stored = { companyId: orig.companyId, id, type: 'JV', number: allocate(st, orig.companyId, 'JV', o.date), status: 'issued', correctionClass: 'L', revision: 0, version: 1,
    header, lines, totals: jvTotals(lines), locks: [], createdBy: o.actor, issuedAt: at };
  st.docs.push(d);
  setJournal(st, id, ledgerFor(st, d));
  st.links.push({ companyId: orig.companyId, from: id, to: orig.id, kind: 'adjusts', amount: d.totals.total, active: true });
  st.revisions.push({ docId: id, revision: 0, at, actor: o.actor, snapshot: publicDoc(d), diff: [] });
  logActivity(st, id, o.actor, 'issue', `${o.auto ? 'กลับรายการอัตโนมัติ' : 'กลับรายการ'} ${orig.number ?? orig.id}`);
  logActivity(st, orig.id, o.actor, 'reverse', d.number);
  logAudit(st, o.actor, orig.companyId, o.auto ? 'doc.auto_reverse' : 'doc.reverse', orig.id, undefined, { reversal: id, number: d.number, date: o.date });
  return d;
}

/** "กลับรายการ" (ruling 2): reverses a JV's entry with a reversing JV dated `max(original date, first open date)` (a later open date may be chosen, never a future one). A document's entry is refused: its own cancel / correction keeps its subledger right. */
export function reverseJv(st: MockState, id: string, actor: Actor, opts?: { date?: IsoDate; reason?: string; id?: string }): Stored {
  const d = getDoc(st, id);
  if (d.type !== 'JV') throw fail(422, 'ledger.reverse_document', `กลับรายการได้เฉพาะใบสำคัญทั่วไป (JV) รายการบัญชีของเอกสารนี้แก้ที่ตัวเอกสาร — ยกเลิกหรือแก้ไขเอกสาร ${d.number ?? d.id}`);
  if (!LIVE.includes(d.status)) throw fail(409, 'doc.not_reversible', 'กลับรายการได้เฉพาะใบสำคัญที่ออกแล้วและยังไม่ถูกยกเลิก');
  if (d.header.autoReversal) throw fail(422, 'ledger.reverse_document', `ใบกลับรายการอัตโนมัติ ${d.number} เปลี่ยนตามใบสำคัญต้นทาง — ยกเลิกหรือแก้ไขใบสำคัญต้นทาง ${getDoc(st, d.header.reversalOf!).number}`);
  const have = reversalsOf(st, id)[0];
  if (have) throw fail(409, 'ledger.already_reversed', `ใบสำคัญนี้กลับรายการแล้วโดย ${have.number} กลับรายการซ้ำไม่ได้`);
  refuseScheduleSource(st, d); // AC4: a live amortisation run on one of its lines - undoing the debit under the schedule is as final as cancelling it (the exit: stop / reverse the schedule)
  if (st.docs.find((x) => x.id === d.header.reversalOf)?.header.scheduleId) throw fail(409, 'schedule.run_reversal_final', `ใบกลับรายการ ${d.number} เป็นของงวดที่ตัดจ่ายตามตาราง กลับรายการซ้ำไม่ได้ ทางออก: รันงวดนั้นใหม่จากหน้าตารางตัดจ่าย`);
  const open = firstOpenDate(st, d.companyId), floor = d.header.documentDate > open ? d.header.documentDate : open, date = opts?.date ?? floor;
  if (date < floor) throw fail(422, 'ledger.reverse_date', `วันที่กลับรายการต้องไม่ก่อน ${floor} (วันที่ของใบสำคัญเดิม หรือวันแรกของงวดที่เปิดอยู่)`);
  const run = !!d.header.scheduleId; // AC4: a schedule's run is dated the last day of its month (maybe not yet over): its reversal may carry that date, no later
  if (run) { beforeRunReversed(st, d); const cap = lastDayOf(d.header.scheduleMonth ?? date.slice(0, 7)) > today() ? lastDayOf(d.header.scheduleMonth ?? date.slice(0, 7)) : today(); if (date > cap) throw fail(422, 'ledger.reverse_date', `วันที่กลับรายการต้องไม่หลัง ${cap}`); if (!isPinned() && isClosed(st, d.companyId, date)) throw fail(422, 'period.closed', `งวดบัญชี ${monthLabelTh(date.slice(0, 7))} ปิดแล้ว กลับรายการลงวันที่ในงวดนี้ไม่ได้`); } else dateGuards(st, d.companyId, date); // not in the future, in an open month
  const r = postReversal(st, d, { date, actor, ...(opts?.reason ? { reason: opts.reason } : {}), ...(opts?.id ? { id: opts.id } : {}) });
  if (run) onRunReversed(st, d, actor); else cancelSchedulesOf(st, d, actor); // no live run (the reversal was allowed): the schedules sourced from this JV go with it
  return r;
}

/** Issue of an accrual with `autoReverse` (ruling 3): the system's reversal, dated day 1 of the next month (a future date, allowed for the system only), created in the same command. */
export function postAutoReversal(st: MockState, jv: Stored): Stored {
  return postReversal(st, jv, { date: nextMonthStart(jv.header.documentDate), actor: SYSTEM, auto: true, id: `${jv.id}-auto` });
}

const cancelAuto = (st: MockState, auto: Stored, actor: Actor) => cancel(st, auto.id, auto.version, 'OTHER', 'ยกเลิกตามใบสำคัญต้นทาง', actor, { system: true });

/** Revise / cancel of an accrual keeps its pending auto-reversal in step: turned off or the accrual gone = cancelled; turned on = created; changed lines or date = revised in place (reverse + repost), so the pair always nets to zero. */
export function syncAutoReversal(st: MockState, jv: Stored, actor: Actor): void {
  const auto = autoReversalOf(st, jv.id), want = LIVE.includes(jv.status) && !!jv.header.autoReverse;
  if (auto && !want) { cancelAuto(st, auto, actor); return; }
  if (!auto && want) { postAutoReversal(st, jv); return; }
  if (!auto || !want) return;
  const lines = mirror(jv.lines), date = nextMonthStart(jv.header.documentDate);
  if (date === auto.header.documentDate && JSON.stringify(lines.map((l) => [l.accountCode, l.debit, l.credit])) === JSON.stringify(auto.lines.map((l) => [l.accountCode, l.debit, l.credit]))) return;
  const next: Stored = { ...auto, header: { ...auto.header, documentDate: date }, lines, totals: jvTotals(lines), revision: auto.revision + 1, version: auto.version + 1 };
  put(st, next);
  const prev = st.journals.find((j) => j.docId === auto.id)?.preview.entries ?? [], live = prev[prev.length - 1], fresh = ledgerFor(st, next).entries[0];
  setJournal(st, auto.id, { entries: [...prev, ...(live && live.kind !== 'reversal' ? [correctionReversal(st, auto.companyId, live)] : []),
    ...(fresh ? [placed(st, auto.companyId, { ...fresh, kind: 'correction' as const, postedAt: stamp() })] : [])] });
  st.revisions.push({ docId: auto.id, revision: next.revision, at: stamp(), actor: SYSTEM, reason: `ตามใบสำคัญต้นทาง ${jv.number}`, snapshot: publicDoc(next), diff: [] });
  logActivity(st, auto.id, SYSTEM, 'revise', `ตามใบสำคัญต้นทาง ${jv.number}`);
}

/** The guards every revise / cancel of a JV meets. A reversal (the person's or the system's) is final: the mirror must stay exact. A JV the person reversed is final too. */
function refuseFinal(st: MockState, d: Stored, system: boolean): void {
  if (!system) refuseRunFinal(st, d); // AC4: a schedule's run is reversed, never revised or cancelled
  if (d.header.reversalOf && !system) {
    const orig = st.docs.find((x) => x.id === d.header.reversalOf);
    throw fail(409, 'ledger.reversal_final', d.header.autoReversal
      ? `ใบกลับรายการอัตโนมัติ ${d.number} เปลี่ยนตามใบสำคัญต้นทาง ${orig?.number ?? ''} แก้ไขหรือยกเลิกที่ใบต้นทาง`
      : `ใบกลับรายการ ${d.number} แก้ไขหรือยกเลิกไม่ได้ ถ้าต้องการยกเลิกผลของใบนี้ ให้กลับรายการใบนี้อีกครั้ง`);
  }
  const rev = userReversalOf(st, d.id);
  if (rev) throw fail(409, 'ledger.reversed_final', `ใบสำคัญนี้ถูกกลับรายการโดย ${rev.number} แล้ว ถือเป็นอันสิ้นสุด แก้ไขหรือยกเลิกไม่ได้`);
}
export function refuseJvRevise(st: MockState, d: Stored, body: { header: DocHeader; lines: DocLine[] }): void {
  refuseFinal(st, d, false);
  const bad = jvAccountProblem(st, d.companyId, body.lines);
  if (bad) throw bad;
  if (body.header.autoReverse && (!d.header.autoReverse || body.header.documentDate !== d.header.documentDate)) { const c = autoClosed(st, d.companyId, body.header.documentDate); if (c) throw c; }
}
/** Cancel of a JV: final once reversed; its pending auto-reversal is cancelled first (so no dependent link remains). */
export function beforeJvCancel(st: MockState, d: Stored, actor: Actor, system: boolean): void {
  refuseFinal(st, d, system);
  const auto = autoReversalOf(st, d.id);
  if (auto && !system) cancelAuto(st, auto, actor);
}

/** The lock a JV reads with when it is final (shown as the banner; the engine refuses through `refuseFinal`): one the person reversed, and the system's own auto-reversal (it follows its accrual). */
export function jvLock(st: MockState, d: { id?: string; type?: string; status: string; header: DocHeader }): Lock | undefined {
  if (d.type !== 'JV' || !d.id || !LIVE.includes(d.status as never)) return undefined;
  const href = (x?: Stored) => (x ? docViewHref('JV', x.id) : undefined);
  const rev = userReversalOf(st, d.id);
  if (rev) return { kind: 'reversal', reason: `กลับรายการแล้วโดย ${rev.number} ลงวันที่ ${formatDateBE(rev.header.documentDate)} — ใบสำคัญนี้สิ้นสุดแล้ว แก้ไขหรือยกเลิกไม่ได้`, exits: [], ...(href(rev) ? { href: href(rev) } : {}) };
  if (d.header.reversalOf && !d.header.autoReversal) { // a person's reversal is final too: its way out is to reverse it (once)
    const o = st.docs.find((x) => x.id === d.header.reversalOf);
    return { kind: 'reversal', reason: `ใบกลับรายการ${o ? ` ของ ${o.number}` : ''} แก้ไขหรือยกเลิกไม่ได้ ถ้าต้องการยกเลิกผลของใบนี้ ให้กลับรายการใบนี้อีกครั้ง`, exits: ['กลับรายการใบนี้'] };
  }
  const orig = d.header.autoReversal && d.header.reversalOf ? st.docs.find((x) => x.id === d.header.reversalOf) : undefined;
  if (!orig && d.header.scheduleId) return runLockOf(st, d);
  if (orig) return { kind: 'reversal', reason: `ใบกลับรายการอัตโนมัติของ ${orig.number} เปลี่ยนตามใบสำคัญต้นทาง แก้ไขหรือยกเลิกที่ใบต้นทาง`, exits: [], ...(href(orig) ? { href: href(orig) } : {}) };
  return undefined;
}

// ---------------------------------------------------------------- invariants

/** `party` false: the journal-equals-lines check ignores the party (the master record may be renamed after posting); the reversal mirror still compares it. */
const sig = (ls: { accountCode?: string; debit?: string; credit?: string; partyId?: string; partyName?: string }[], party = true) => ls.map((l) => `${l.accountCode}|${satOf(l.debit)}|${satOf(l.credit)}${party ? `|${l.partyName ?? l.partyId ?? ''}` : ''}`).join(',');

/** AC1 invariants of the journal vouchers: no line on an account a document owns, the journal IS the lines, a reversal is the exact mirror of a live original (one live reversal each), and an accrual with
 *  `autoReverse` has its one live system reversal dated day 1 of the next month - so the pair nets to zero. */
export function jvInvariants(st: MockState): string[] {
  const out: string[] = [];
  for (const d of st.docs) {
    if (d.type !== 'JV' || d.status === 'draft' || d.status === 'pending' || d.status === 'approved') continue;
    const live = LIVE.includes(d.status), used = d.lines.filter(isUsed);
    for (const l of used) {
      const exit = l.accountCode ? controlExit(st, d.companyId, l.accountCode, 'jv') : undefined;
      if (exit) out.push(`${d.id}: JV line on controlled account ${l.accountCode} (${exit})`);
    }
    if (!live) continue;
    const { dr, cr } = sums(d.lines);
    if (dr !== cr) out.push(`${d.id}: JV lines do not balance (Dr ${fromSatang(dr)} / Cr ${fromSatang(cr)})`);
    if (fromSatang(dr) !== d.totals.total) out.push(`${d.id}: JV total ${d.totals.total} is not its lines' debit ${fromSatang(dr)}`);
    const es = st.journals.find((j) => j.docId === d.id)?.preview.entries ?? [], cur = [...es].reverse().find((e) => e.kind !== 'reversal');
    if (!cur || sig(cur.lines, false) !== sig(jvEntryLines(st, d.companyId, used), false)) out.push(`${d.id}: JV journal is not its lines`);
    if (d.header.reversalOf) {
      const o = st.docs.find((x) => x.id === d.header.reversalOf);
      if (!o || o.type !== 'JV' || o.companyId !== d.companyId || !LIVE.includes(o.status)) { out.push(`${d.id}: reversal of ${d.header.reversalOf}, which is not a live JV of its company`); continue; }
      if (sig(used) !== sig(o.lines.filter(isUsed).map((l) => ({ ...l, debit: l.credit, credit: l.debit })))) out.push(`${d.id}: JV reversal is not the exact mirror of ${o.id}`);
      const links = st.links.filter((l) => l.active && l.kind === 'adjusts' && l.from === d.id);
      if (links.length !== 1 || links[0].to !== o.id) out.push(`${d.id}: JV reversal needs exactly one active adjusts link to ${o.id}`);
      if (reversalsOf(st, o.id).length > 1) out.push(`${o.id}: JV reversed more than once`);
      if (d.header.autoReversal && (!o.header.autoReverse || d.header.documentDate !== nextMonthStart(o.header.documentDate))) out.push(`${d.id}: system reversal is not day 1 of the month after an autoReverse accrual (${o.id})`);
    }
    if (d.header.autoReverse && !d.header.reversalOf && reversalsOf(st, d.id).filter((x) => x.header.autoReversal).length !== 1) out.push(`${d.id}: accrual with autoReverse has no live auto-reversal (the pair must net to zero)`);
  }
  return out;
}

// ---------------------------------------------------------------- the general journal

interface Source { type: string; label: string; href?: string; entries: JournalEntryPreview[] }
/** Every journal entry of the company with where it came from: documents (incl. JV), the reconciliation's own journals and settlement records. */
function sources(st: MockState, companyId: string): Source[] {
  const out: Source[] = [];
  const mine = new Map(st.docs.filter((d) => d.companyId === companyId).map((d) => [d.id, d]));
  for (const j of st.journals) {
    const d = mine.get(j.docId);
    if (d) out.push({ type: d.type, label: `${d.number ?? d.id} · ${DESCRIPTORS[d.type]?.titleTh ?? d.type}`, href: docViewHref(d.type, d.id), entries: j.preview.entries });
  }
  for (const j of st.bankJournals) if (j.companyId === companyId) out.push({ type: 'BANK', label: `${j.id} · ${j.label}`, href: `/finance/bank-accounts/${j.accountId}${j.lineId ? `?line=${j.lineId}` : ''}`, entries: j.entries });
  for (const s of st.settlements) if (s.companyId === companyId) out.push({ type: 'STL', label: `${s.id.toUpperCase()} · หักกลบ/ปรับปรุงการชำระ`, href: `/finance/settlements/${s.id}`, entries: s.journal });
  return out;
}

export interface GjParams { from?: string; to?: string; account?: string; source?: string }
/** ReportModel `general-journal` (ruling 5): every entry of the company in date order, each with its source link and its lines. Filters: date range, account (code or part of it), source type (a document type, STL or BANK). The tie-out is Σ debit = Σ credit over the entries shown, never forced. */
export function generalJournal(st: MockState, companyId: string, p: GjParams): ReportModel {
  const rows: ReportRow[] = [];
  const all = sources(st, companyId).flatMap((s) => s.entries.map((e) => ({ s, e })))
    .filter(({ s, e }) => (!p.source || s.type === p.source) && (!p.from || e.date >= p.from) && (!p.to || e.date <= p.to) && (!p.account || e.lines.some((l) => l.accountCode.startsWith(p.account!))))
    .sort((a, b) => a.e.date.localeCompare(b.e.date) || (a.e.postedAt ?? '').localeCompare(b.e.postedAt ?? '') || a.s.label.localeCompare(b.s.label));
  let dr = 0, cr = 0, shownDr = 0, shownCr = 0;
  for (const { s, e } of all) {
    const kind = e.kind === 'reversal' ? ' (กลับรายการ)' : e.kind === 'correction' ? ' (แก้ไข)' : '';
    rows.push({ level: 0, kind: 'group', cells: { entry: `${s.label}${kind}`, date: e.date, rule: e.late ? 'แก้ไขย้อนหลัง' : '', debit: '', credit: '' }, ...(s.href ? { href: s.href } : {}) });
    for (const l of e.lines) {
      dr += toSatang(l.debit); cr += toSatang(l.credit);
      if (p.account && !l.accountCode.startsWith(p.account)) continue;
      shownDr += toSatang(l.debit); shownCr += toSatang(l.credit);
      rows.push({ level: 1, kind: 'row', cells: { entry: `${l.accountCode} ${l.accountName}${l.partyName ? ` · ${l.partyName}` : ''}`, date: '', rule: l.rule, debit: toSatang(l.debit) ? l.debit : '', credit: toSatang(l.credit) ? l.credit : '' } });
    }
  }
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { entry: '', date: '', rule: '', debit: fromSatang(shownDr), credit: fromSatang(shownCr) } });
  return {
    kind: 'general-journal', titleKey: 'reports.gj.title', params: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) as Record<string, string>,
    columns: [
      { key: 'entry', labelKey: 'reports.gj.entry', kind: 'text' }, { key: 'date', labelKey: 'reports.gj.date', kind: 'date' },
      { key: 'rule', labelKey: 'reports.gj.rule', kind: 'text' }, { key: 'debit', labelKey: 'reports.tb.debit', kind: 'money', align: 'end' }, { key: 'credit', labelKey: 'reports.tb.credit', kind: 'money', align: 'end' },
    ],
    rows,
    tieOuts: [{ labelKey: 'reports.gj.balanced', left: fromSatang(dr), right: fromSatang(cr), diff: fromSatang(dr - cr) }],
  };
}
