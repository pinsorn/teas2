import { DESCRIPTORS } from '@/descriptors';
import { LIVE, isTypeAvailable } from '@/domain/doc-types';
import type { Actor, DocSummary, DocType, HomeAgentDigest, HomeAlert, HomeApproval, HomeDeadline, HomeKpis } from '@/domain/types';
import type { MockState } from '../store';
import { approvalRequiredOf, refuseSelfApproval } from './approval';
import { checklistOf } from './close';
import { getFiling, unfiledForms } from './filings';
import { boxOf, getPp30, prevMonth } from './filings/pp30';
import { formName } from './filings/pnd1';
import { today } from './log';
import { fromSatang, toSatang } from './money';
import { glBalance } from './reconcile';
import { apAging } from './reports/ap-aging';
import { arAging } from './reports/ar-aging';
import { numberGaps } from './reports/number-gaps';
import { payoutOf } from './settlement';
import { vatThresholdWatch } from './vat-threshold';

/** HC1: every Home figure is read from the engine that owns it (RP2 aging, the journal, the ภ.พ.30, RP3, TX3, AC6, the approval engine); nothing is re-summed or re-implemented here. */
type Stored = MockState['docs'][number];
const mine = (st: MockState, companyId: string) => st.docs.filter((d) => d.companyId === companyId && !d.header.obBatchId); // an opening item is shown through its batch
const readable = (st: MockState, companyId: string, perms: string[]) => mine(st, companyId).filter((d) => perms.includes(`doc.${d.type}.read`) && isTypeAvailable(d.type, st.companies.find((c) => c.id === companyId)?.vatRegistered ?? false));

const summary = (d: Stored): DocSummary => ({
  id: d.id, type: d.type, number: d.number, status: d.status, documentDate: d.header.documentDate, partyName: d.party?.name ?? '', total: d.totals.total,
  outstanding: d.outstanding, dueDate: d.header.dueDate, createdByAgent: d.createdBy.kind === 'agent',
});
const days = (later: string, earlier: string) => Math.round((Date.parse(`${later.slice(0, 10)}T00:00:00Z`) - Date.parse(`${earlier.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
const agingTotal = (m: { rows: { kind: string; cells: Record<string, string> }[] }) => m.rows.find((r) => r.kind === 'total')?.cells.total ?? '0.00';

export function homeKpis(st: MockState, companyId: string): HomeKpis {
  const asOf = today(), month = asOf.slice(0, 7);
  const codes = [...new Set(st.bankAccounts.filter((b) => b.companyId === companyId).map((b) => b.accountCode))];
  const vat = st.companies.find((c) => c.id === companyId)?.vatRegistered;
  const boxes = vat ? getPp30(st, companyId, month).boxes : [];
  return {
    cash: fromSatang(codes.reduce((n, c) => n + glBalance(st, companyId, c, asOf), 0)),
    ar: agingTotal(arAging(st, companyId, { asOf })),
    ap: agingTotal(apAging(st, companyId, { asOf })),
    vatThisMonth: vat ? fromSatang(boxOf(boxes, '5') - boxOf(boxes, '7')) : null,
  };
}

/** Pending documents whose FROZEN policy wants approval and that this actor may approve (the right, and the frozen self-approval rule: the same refusal the approve command raises). */
export function homeApprovals(st: MockState, companyId: string, perms: string[], actor: Actor): HomeApproval[] {
  const out: HomeApproval[] = [];
  for (const d of mine(st, companyId)) {
    if (d.status !== 'pending' || !d.approval || !perms.includes(`doc.${d.type}.approve`)) continue;
    if (!approvalRequiredOf(st, d, payoutOf(st, companyId, d))) continue;
    try { refuseSelfApproval(st, d, actor); } catch { continue; }
    const agent = d.createdBy.kind === 'agent';
    out.push({
      id: d.id, type: d.type, number: d.number, partyName: d.party?.name ?? '', total: d.totals.total, version: d.version,
      requester: d.approval.submittedBy.name, ageDays: Math.max(0, days(today(), d.approval.submittedAt)),
      ...(agent ? { reason: 'agent', ...(d.agentReportId ? { agentReportId: d.agentReportId } : {}) } : {}),
    });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id));
}

export const homeDrafts = (st: MockState, companyId: string, perms: string[]): DocSummary[] =>
  readable(st, companyId, perms).filter((d) => d.status === 'draft').map(summary);

/** TI / IV / PB / EX with something outstanding and a due date before today. */
export const homeOverdue = (st: MockState, companyId: string, perms: string[]): DocSummary[] =>
  readable(st, companyId, perms)
    .filter((d) => (['TI', 'IV', 'PB', 'EX'] as DocType[]).includes(d.type) && (d.status === 'issued' || d.status === 'partly_settled') && toSatang(d.outstanding ?? '0.00') > 0 && !!d.header.dueDate && d.header.dueDate < today())
    .map(summary);

/** The returns of the last ended month that are owed and not finalized, with the due date the filing itself states. */
export function homeDeadlines(st: MockState, companyId: string): HomeDeadline[] {
  const period = prevMonth(today().slice(0, 7)), out: HomeDeadline[] = [];
  for (const form of unfiledForms(st, companyId, period)) {
    try { out.push({ form: formName(form), due: getFiling(st, companyId, form, period).dueDate }); } catch { /* a form with no model yet is not listed */ }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.form.localeCompare(b.form));
}

export const homeBank = (st: MockState, companyId: string): number => st.bankLines.filter((l) => l.companyId === companyId && l.status === 'unmatched').length;

export function homeAgent(st: MockState, companyId: string, perms: string[]): HomeAgentDigest {
  const a = readable(st, companyId, perms).filter((d) => d.createdBy.kind === 'agent' && !['cancelled', 'replaced'].includes(d.status));
  return { posted: a.filter((d) => d.status !== 'draft').length, waiting: a.filter((d) => d.status === 'draft').length };
}

/** Each alert needs the right of the report / screen it opens; a role without any gets none (and the section is not queried). */
export function homeAlerts(st: MockState, companyId: string, perms: string[]): HomeAlert[] {
  const out: HomeAlert[] = [], now = today();
  if (perms.includes('audit.read')) {
    const rows = numberGaps(st, companyId, { onlyProblems: 'true' }).rows.filter((r) => r.level === 1);
    const dup = rows.filter((r) => r.cells.state === 'เลขซ้ำ').length, gap = rows.filter((r) => r.cells.state !== 'เลขซ้ำ' && ['เลขขาด', 'ตัวนับไม่ตรง', 'เลขผิดรูปแบบ'].includes(r.cells.state)).length;
    if (gap) out.push({ code: 'number_gaps', count: gap, href: '/reports/audit?tab=gaps', severity: 'warning' });
    if (dup) out.push({ code: 'number_duplicates', count: dup, href: '/reports/audit?tab=gaps', severity: 'danger' });
  }
  if (perms.includes('tax.read')) {
    const w = vatThresholdWatch(st, companyId);
    if (w && w.level !== 'ok') out.push({ code: 'vat_threshold', count: 1, href: '/tax/summary', severity: w.level === 'danger' ? 'danger' : 'warning', percent: w.percent });
  }
  if (perms.includes('doc.PB.read')) {
    const n = mine(st, companyId).filter((d) => d.type === 'PB' && d.header.complete === false && LIVE.includes(d.status)).length;
    if (n) out.push({ code: 'pb_incomplete', count: n, href: '/purchases/bills', severity: 'warning' });
  }
  const old = mine(st, companyId).filter((d) => d.status === 'draft' && perms.includes(`doc.${d.type}.create`) && days(now, d.header.documentDate) > 30);
  if (old.length) out.push({ code: 'old_drafts', count: old.length, href: DESCRIPTORS[old[0].type]?.basePath ?? '/', severity: 'warning' });
  if (perms.includes('doc.DP.read')) {
    const n = checklistOf(st, companyId, prevMonth(now.slice(0, 7))).find((i) => i.code === 'depreciation_not_run')?.count ?? 0;
    if (n) out.push({ code: 'depreciation_due', count: n, href: '/accounting/depreciation-runs/new', severity: 'warning' });
  }
  return out;
}
