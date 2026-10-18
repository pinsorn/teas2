import { docViewHref } from '@/descriptors';
import type { ReportModel, ReportRow } from '@/domain/reports';
import type { Actor, AuditEntry } from '@/domain/types';
import type { MockState } from '../../store';
import { diffFlat } from '../log';

export interface AuditParams { from?: string; to?: string; actor?: string; command?: string; target?: string }

/** The business clock of the mock is Bangkok time: an entry's instant as `yyyy-mm-dd hh:mm:ss` there. */
const local = (iso: string) => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
const who = (a: Actor) => (a.kind === 'agent' ? `agent ของ ${a.ownerName ?? a.name}` : a.name);
/** Record kinds that have a page of their own. */
const RECORD_PAGE: Record<string, string> = { customer: '/master/customers', vendor: '/master/vendors', item: '/master/items', 'bank-account': '/finance/bank-accounts', schedule: '/accounting/schedules' };

/** Where an entry's target opens: its document, or its master record; none for a target that has no page (a month, a form, a login). */
function targetHref(st: MockState, companyId: string, a: AuditEntry): string | undefined {
  if (!a.target) return undefined;
  const d = st.docs.find((x) => x.companyId === companyId && x.id === a.target);
  if (d) return docViewHref(d.type, d.id);
  const page = a.command.startsWith('record.') ? RECORD_PAGE[a.command.split('.')[1]] : undefined;
  return page ? `${page}/${a.target}` : undefined;
}

/** ReportModel `audit-log` (RP3 ruling 3): every audit entry of the company, newest first. An entry is one row; under it one row per CHANGED field (before / after), each carrying the entry id so the CSV stays one flat table.
 *  Filters: `from` / `to` (the entry's business date), `actor` (user / agent, or part of the name), `command` and `target` (part of the text). Read-only: nothing here, or anywhere, edits or deletes an entry (invariant: ids and time only go forward). */
export function auditLog(st: MockState, companyId: string, p: AuditParams = {}): ReportModel {
  const q = (v?: string) => v?.trim().toLowerCase() ?? '';
  const actor = q(p.actor), command = q(p.command), target = q(p.target);
  const mine = st.audit.filter((a) => a.companyId === companyId)
    .filter((a) => (!p.from || local(a.at).slice(0, 10) >= p.from) && (!p.to || local(a.at).slice(0, 10) <= p.to)
      && (!actor || a.actor.kind === actor || a.actor.name.toLowerCase().includes(actor) || a.actor.id.toLowerCase() === actor)
      && (!command || a.command.toLowerCase().includes(command)) && (!target || (a.target ?? '').toLowerCase().includes(target)))
    .map((a, i) => ({ a, i })).sort((x, y) => y.a.at.localeCompare(x.a.at) || y.i - x.i).map(({ a }) => a); // newest first; the later write wins a tie
  const rows: ReportRow[] = [];
  for (const a of mine) {
    const href = targetHref(st, companyId, a);
    rows.push({ level: 0, kind: 'row', ...(href ? { links: { target: href } } : {}),
      cells: { id: a.id, at: local(a.at), actor: who(a.actor), command: a.command, target: a.target ?? '', result: a.result, client: a.client ?? '', ip: a.ip ?? '', traceId: a.traceId ?? '' } });
    for (const c of diffFlat(a.before, a.after)) rows.push({ level: 1, kind: 'row', cells: { id: a.id, field: c.path || '-', before: c.before ?? '', after: c.after ?? '' } });
  }
  const col = (key: string, labelKey = `reports.audit.log.${key}`) => ({ key, labelKey });
  return { kind: 'audit-log', titleKey: 'reports.audit.log.title', params: { ...p },
    columns: [col('id'), col('at'), col('actor'), col('command'), col('target'), col('result'), col('client'), col('ip'), col('traceId'), col('field'), col('before'), col('after')], rows };
}

/** ReportModel `reopen-history` (RP3 ruling 5): every reopen of a period (`periods[].reopened[]`) and of a closed year (`yearCloses[].reopened`) of the company, newest first, with the period / year, the reason, who and when. */
export function reopenHistory(st: MockState, companyId: string, p: Record<string, string> = {}): ReportModel {
  const all = [
    ...st.periods.filter((x) => x.companyId === companyId).flatMap((x) => (x.reopened ?? []).map((r) => ({ ...r, scope: 'งวด', period: x.month }))),
    ...st.yearCloses.filter((y) => y.companyId === companyId && y.reopened).map((y) => ({ ...y.reopened!, scope: 'ปีบัญชี', period: String(y.year + 543) })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const col = (key: string) => ({ key, labelKey: `reports.audit.reopen.${key}` });
  return { kind: 'reopen-history', titleKey: 'reports.audit.reopen.title', params: { ...p }, columns: [col('at'), col('scope'), col('period'), col('reason'), col('actor')],
    rows: all.map((r) => ({ level: 0, kind: 'row', cells: { at: local(r.at), scope: r.scope, period: r.period, reason: r.reason, actor: who(r.by) } })) };
}
