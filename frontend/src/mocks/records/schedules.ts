import type { RecordRow } from '@/domain/records';
import type { Actor, ScheduleRecord } from '@/domain/types';
import { createAmortisation, createRecurring, liveRuns, markStopped, remainingOf, resumeSchedule, scheduleOf, templateBody, updateSchedule, validDate } from '../engine/schedules';
import type { MockState } from '../store';
import type { RecordKindImpl } from './registry';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const FREQ = ['monthly', 'quarterly', 'yearly'];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const accountName = (st: MockState, co: string, code?: string) => st.accounts.find((a) => a.companyId === co && a.code === code)?.nameTh;

/** A schedule as the API returns it: the stored record (frozen figures, plan, template) plus what the screens read - each plan month with the run behind it, the runs with their document numbers, the balance still on the prepaid account. Display names are looked up, never stored back. */
export function toRow(st: MockState, s: ScheduleRecord): RecordRow {
  const co = s.companyId, live = liveRuns(st, s), numberOf = (id?: string) => st.docs.find((d) => d.id === id)?.number;
  const { companyId: _c, ...rest } = s; void _c;
  const base = { ...structuredClone(rest), code: s.id, inUse: s.runs.length > 0 };
  if (s.kind === 'recurring') {
    const p = s.template?.header.partyId ? st.parties.find((x) => x.id === s.template!.header.partyId && x.companyId === co) : undefined;
    const { companyId: _pc, ...ref } = p ?? ({} as NonNullable<typeof p>); void _pc;
    return { ...base, runs: s.runs.map((r) => ({ ...r, number: numberOf(r.resultDocId), docType: s.template?.type })), templateParty: s.template?.partyName ?? p?.name ?? null, ...(p ? { templatePartyRef: ref } : {}), runsDone: s.runs.length,
      ...(s.source ? { sourceNumber: numberOf(s.source.docId) ?? null } : {}) } as RecordRow;
  }
  const src = st.docs.find((d) => d.id === s.source?.docId);
  const plan = s.plan!.map((r, i) => {
    const run = s.runs.find((x) => x.month === r.month && !x.reversed && x.resultDocId && live.includes(x));
    return { ...r, status: run ? 'run' : i === live.length && !s.stopped ? 'next' : 'pending', ...(run ? { docId: run.resultDocId, number: numberOf(run.resultDocId) } : {}) };
  });
  return { ...base, plan, runs: s.runs.map((r) => ({ ...r, number: numberOf(r.resultDocId), docType: 'JV' })), runsDone: live.length, remaining: remainingOf(st, s), done: !s.stopped && live.length === s.plan!.length,
    sourceNumber: src?.number ?? null, sourceType: src?.type ?? null, sourceLine: src?.lines.find((l) => l.id === s.source?.lineId)?.description ?? null,
    expenseAccountName: accountName(st, co, s.expenseAccount) ?? null, prepaidAccountName: accountName(st, co, s.prepaidAccount) ?? null } as RecordRow;
}

export const scheduleImpl: RecordKindImpl = {
  perms: { read: 'ledger.read', manage: 'ledger.schedule.manage' },
  rows: (st, companyId) => st.schedules.filter((s) => s.companyId === companyId).map((s) => toRow(st, s)),

  /** The shape of the request (the rules - the source line, the accounts, the template - are the engine's and refuse with their own codes). An amortisation is frozen at creation: only its name edits afterwards. */
  validate(v, st, companyId, id) {
    const e: Record<string, string[]> = {};
    const add = (k: string, m: string) => { (e[k] ??= []).push(m); };
    if (!str(v.name)) add('name', 'ต้องตั้งชื่อ');
    const prev = id ? scheduleOf(st, companyId, id) : undefined;
    const kind = prev?.kind ?? str(v.kind);
    if (!prev && kind !== 'recurring' && kind !== 'amortisation') { add('kind', 'ต้องระบุชนิด (รายการซ้ำ หรือ ตารางตัดจ่าย)'); return e; }
    if (kind === 'recurring') {
      if (!prev || v.frequency !== undefined) if (!FREQ.includes(String(v.frequency))) add('frequency', 'ต้องเลือกความถี่');
      if ((!prev || v.nextRun !== undefined) && !validDate(v.nextRun)) add('nextRun', 'วันที่รันครั้งถัดไปไม่ถูกต้อง');
      if (v.endAfter !== undefined && v.endAfter !== null && v.endAfter !== '' && !(Number.isInteger(v.endAfter) && (v.endAfter as number) >= 1)) add('endAfter', 'จำนวนครั้งต้องเป็นจำนวนเต็มตั้งแต่ 1');
      if (!prev && !str(v.docId)) add('docId', 'ต้องระบุเอกสารต้นแบบ');
      if (prev && v.template !== undefined && Object.keys(e).length === 0) { // the template body: what a draft of this type needs before it can be issued, as the editor's own field errors (the engine re-checks)
        try { for (const m of templateBody(st, prev.companyId, prev, v.template).missing) add(m.field, m.message); } catch { /* a malformed body: the engine refuses it with its own code */ }
      }
    } else if (!prev) {
      if (!str(v.docId)) add('docId', 'ต้องระบุเอกสารต้นทาง');
      if (!str(v.lineId)) add('lineId', 'ต้องเลือกรายการต้นทาง');
      if (!/^\d+(\.\d{1,2})?$/.test(String(v.total ?? ''))) add('total', 'ยอดที่ตัดจ่ายไม่ถูกต้อง');
      if (!Number.isInteger(v.months) || (v.months as number) < 1 || (v.months as number) > 120) add('months', 'จำนวนงวดต้องเป็นจำนวนเต็ม 1 ถึง 120');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v.startMonth ?? ''))) add('startMonth', 'เดือนที่เริ่มตัดจ่ายไม่ถูกต้อง');
      if (!str(v.expenseAccount)) add('expenseAccount', 'ต้องเลือกบัญชีค่าใช้จ่าย');
    }
    return e;
  },

  create(st, companyId, v) {
    const name = str(v.name)!;
    const s = v.kind === 'recurring'
      ? createRecurring(st, companyId, { name, frequency: v.frequency as 'monthly', nextRun: v.nextRun as string, ...(typeof v.endAfter === 'number' ? { endAfter: v.endAfter } : {}), docId: str(v.docId) }, ACTOR)
      : createAmortisation(st, companyId, { name, docId: str(v.docId)!, lineId: str(v.lineId)!, total: String(v.total), months: v.months as number, startMonth: str(v.startMonth)!, expenseAccount: str(v.expenseAccount)! }, ACTOR);
    return toRow(st, s);
  },

  update(st, companyId, id, v) {
    return toRow(st, updateSchedule(st, companyId, id, v, ACTOR));
  },

  /** Deactivate = stop (the remaining balance stays on the prepaid account); only a recurring schedule that was stopped may be switched on again. */
  setActive(st, companyId, id, active) {
    const s = scheduleOf(st, companyId, id);
    if (active) resumeSchedule(st, s); else markStopped(st, s, ACTOR);
    return toRow(st, s);
  },
};
