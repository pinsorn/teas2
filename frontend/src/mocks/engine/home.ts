import { DESCRIPTORS } from '@/descriptors';
import { LIVE, isTypeAvailable } from '@/domain/doc-types';
import type { FilingForm } from '@/domain/filings';
import type { Actor, DocSummary, DocType, HomeAgentDigest, HomeAlert, HomeApproval, HomeDeadline, HomeKpis } from '@/domain/types';
import type { MockState } from '../store';
import { approvalRequiredOf, refuseSelfApproval } from './approval';
import { checklistOf } from './close';
import { getFiling } from './filings';
import { PND_FORMS, pndRows } from './filings/pnd-wht';
import { deriveRows, runsOf } from './filings/pnd1';
import { pp36Rows } from './filings/pp36';
import { isFiledPeriod } from './purchase-vat';
import { monthLabelTh } from './periods';
import { reportPermission } from '@/domain/reports';
import { vatRegisterRight } from './reports';
import { boxOf, getPp30, nextMonth, prevMonth } from './filings/pp30';
import { formName } from './filings/pnd1';
import { stamp, today } from './log';
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

/** Each tile needs the right of the engine that owns it; a tile the role may not see is null (like the non-VAT tile). */
export function homeKpis(st: MockState, companyId: string, perms: string[]): HomeKpis {
  const asOf = today(), month = asOf.slice(0, 7);
  const codes = st.accounts.filter((a) => a.companyId === companyId && a.postable && (a.subClass === 'cash' || a.subClass === 'bank')).map((a) => a.code);
  const vat = st.companies.find((c) => c.id === companyId)?.vatRegistered;
  // the VAT registers' own gate: tax.read, and the filing preview right for a month not yet filed
  const vatOk = !!vat && perms.includes(reportPermission('vat-output-register')) && !vatRegisterRight(st, companyId, 'vat-output-register', perms, month);
  const arap = perms.includes('report.arap.read');
  const boxes = vatOk ? getPp30(st, companyId, month).boxes : [];
  return {
    cash: perms.includes('bank.read') || perms.includes('ledger.read') ? fromSatang(codes.reduce((n, c) => n + glBalance(st, companyId, c, asOf), 0)) : null,
    ar: arap ? agingTotal(arAging(st, companyId, { asOf })) : null,
    ap: arap ? agingTotal(apAging(st, companyId, { asOf })) : null,
    vatThisMonth: vatOk ? fromSatang(boxOf(boxes, '5') - boxOf(boxes, '7')) : null,
  };
}

/** Pending documents whose FROZEN policy wants approval and that this actor may approve (the right, the right to read, and the frozen self-approval rule: the same refusal the approve command raises),
 *  plus the drafts an agent made, for whoever may issue them (a link to the document, never an inline action: HC2 narrows this to the human route). */
export function homeApprovals(st: MockState, companyId: string, perms: string[], actor: Actor): HomeApproval[] {
  const out: HomeApproval[] = [], vat = st.companies.find((c) => c.id === companyId)?.vatRegistered ?? false;
  for (const d of mine(st, companyId)) {
    if (!isTypeAvailable(d.type, vat) || !perms.includes(`doc.${d.type}.read`)) continue;
    if (d.status === 'draft' && d.createdBy.kind === 'agent' && perms.includes(`doc.${d.type}.issue`)) {
      out.push({ id: d.id, type: d.type, number: d.number, partyName: d.party?.name ?? '', total: d.totals.total, version: d.version, requester: d.createdBy.name,
        ageDays: Math.max(0, days(today(), d.header.documentDate)), reason: 'agent', ...(d.agentReportId ? { agentReportId: d.agentReportId } : {}) });
      continue;
    }
    if (d.status !== 'pending' || !d.approval || !perms.includes(`doc.${d.type}.approve`)) continue;
    if (!approvalRequiredOf(st, d, payoutOf(st, companyId, d))) continue;
    try { refuseSelfApproval(st, d, actor); } catch { continue; }
    out.push({
      id: d.id, type: d.type, number: d.number, partyName: d.party?.name ?? '', total: d.totals.total, version: d.version,
      requester: d.approval.submittedBy.name, ageDays: Math.max(0, days(today(), d.approval.submittedAt)),
    });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id));
}

/** The signed-in user's own drafts; the drafts an agent made are the inbox's (reason 'agent'). */
export const homeDrafts = (st: MockState, companyId: string, perms: string[], actor: Actor): DocSummary[] =>
  readable(st, companyId, perms).filter((d) => d.status === 'draft' && d.createdBy.kind === 'user' && d.createdBy.id === actor.id).map(summary);

/** TI / IV / PB / EX with something outstanding and a due date before today. */
export const homeOverdue = (st: MockState, companyId: string, perms: string[]): DocSummary[] =>
  readable(st, companyId, perms)
    .filter((d) => (['TI', 'IV', 'PB', 'EX'] as DocType[]).includes(d.type) && (d.status === 'issued' || d.status === 'partly_settled') && toSatang(d.outstanding ?? '0.00') > 0 && !!d.header.dueDate && d.header.dueDate < today())
    .map(summary);

/** Per form, the owed periods AFTER the form's latest finalized period (earlier ones are settled history; the filing chain), up to last month; a form never finalized starts at the company's first month with activity. Overdue first, labelled with the month. */
export function homeDeadlines(st: MockState, companyId: string): HomeDeadline[] {
  const last = prevMonth(today().slice(0, 7)), out: HomeDeadline[] = [];
  const first = mine(st, companyId).filter((d) => d.status !== 'draft').map((d) => d.header.documentDate.slice(0, 7)).sort()[0];
  const vat = !!st.companies.find((c) => c.id === companyId)?.vatRegistered;
  const latest = (f: FilingForm) => st.filings.filter((x) => x.companyId === companyId && x.form === f).map((x) => x.period).sort().at(-1);
  for (let m = first ?? last; m <= last; m = nextMonth(m)) {
    const owed: FilingForm[] = [];
    if (vat) owed.push('PP30');
    for (const f of PND_FORMS) if (pndRows(st, companyId, f, m).length) owed.push(f);
    if (pp36Rows(st, companyId, m).length) owed.push('PP36');
    if (runsOf(st, companyId, m).length) { owed.push('PND1'); if (deriveRows(runsOf(st, companyId, m), 'sso').length) owed.push('SSO1-10'); }
    for (const form of owed) {
      if (isFiledPeriod(st, companyId, m, form) || m < (latest(form) ?? '')) continue;
      try { out.push({ form: `${formName(form)} ${monthLabelTh(m)}`, due: getFiling(st, companyId, form, m).dueDate }); } catch { /* a form with no model yet is not listed */ }
    }
  }
  const now = today();
  return out.sort((a, b) => Number(b.due < now) - Number(a.due < now) || a.due.localeCompare(b.due) || a.form.localeCompare(b.form));
}

export const homeBank = (st: MockState, companyId: string): number => st.bankLines.filter((l) => l.companyId === companyId && l.status === 'unmatched').length;

/** The Bangkok (+07:00) calendar date of an ISO instant. */
const bangkokDate = (iso: string): string => new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);

/** posted = agent documents issued today, waiting = agent drafts and documents pending approval. "Today" is ONE clock domain: the Bangkok date of `issuedAt` against the Bangkok date of `stamp()` now (the clock issue() writes with), never the mock today and never a UTC slice. */
export function homeAgent(st: MockState, companyId: string, perms: string[]): HomeAgentDigest {
  const a = readable(st, companyId, perms).filter((d) => d.createdBy.kind === 'agent'), now = bangkokDate(stamp());
  return { posted: a.filter((d) => LIVE.includes(d.status) && !!d.issuedAt && bangkokDate(d.issuedAt) === now).length, waiting: a.filter((d) => d.status === 'draft' || d.status === 'pending').length };
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
