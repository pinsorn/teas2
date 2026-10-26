import { LIVE } from '@/domain/doc-types';
import type { Actor, JournalPreview } from '@/domain/types';
import type { AgentReport, ReportCheck } from '@/records/connect';
import { policyOf } from '../records/connect';
import { AGENT } from '../fixtures/documents';
import type { MockState } from '../store';
import { createDraft } from './commands';
import { MockError, logAudit, stamp, today, withFixedClock } from './log';
import { isClosed } from './periods';
import { ledgerFor, traceResolutions } from './ledger';
import { fromSatang, toSatang } from './money';
import type { Resolved } from './posting';

/** SP0 §8.2-§8.4 (HC2). `reviewDraft` is the agent's `review(document)` call: the report (totals and tax from the server, the journal with the rules, the §8.3 checks, the route under the policy IN FORCE, the token expiry)
 *  is computed ONCE here and STORED. Reading it never recomputes: a later policy or party-history change cannot rewrite what the human was shown. */
type Stored = MockState['docs'][number];
export type StoredReport = AgentReport & { companyId: string };

const DAY = 86_400_000;
const dayNo = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY;
const TOKEN_MINUTES = 15; // §8.2: the review token lives 15 minutes
const T_BUYER = ['TI', 'IV', 'CN', 'DN'];

/** §8.4: auto only for Auto-if-clean, a clean report (no error, no warning) and a total within the cap; a cancel / reissue is never auto. */
export function routeOf(policy: { mode: string; cap: string }, o: { action?: 'create' | 'cancel' | 'reissue'; clean: boolean; total: string }): 'auto' | 'human' {
  if (o.action && o.action !== 'create') return 'human';
  return policy.mode === 'auto' && o.clean && toSatang(o.total) <= toSatang(policy.cap) ? 'auto' : 'human';
}

function checksOf(st: MockState, d: Stored, trace: { role: string; r: Resolved }[], postingFailed: boolean): ReportCheck[] {
  const out: ReportCheck[] = [], date = d.header.documentDate, total = toSatang(d.totals.total);
  const add = (code: string, severity: ReportCheck['severity'], message: string) => out.push({ code, severity, message });
  const co = st.companies.find((c) => c.id === d.companyId);
  const policy = policyOf(st, d.companyId, d.type);
  // errors: block posting
  if (isClosed(st, d.companyId, date)) add('period_closed', 'error', `งวด ${date.slice(0, 7)} ปิดแล้ว ลงเอกสารวันที่ ${date} ไม่ได้`);
  if (T_BUYER.includes(d.type) && co?.vatRegistered && d.party?.vatRegistered && (!d.party.taxId || !d.party.branchCode)) add('buyer_tin_missing', 'error', 'ผู้ซื้อที่จดทะเบียน VAT ต้องมีเลขประจำตัวผู้เสียภาษีและสาขา');
  if (postingFailed) add('posting_failed', 'error', 'หาบัญชีที่จะลงรายการไม่ได้ ตรวจสอบกฎการลงบัญชี');
  if (policy.mode === 'off') add('policy_off', 'error', 'นโยบายของบริษัทปิดการใช้ agent สำหรับเอกสารประเภทนี้');
  // warnings: route to a human
  const peers = st.docs.filter((x) => x.companyId === d.companyId && x.id !== d.id && !!d.header.partyId && x.header.partyId === d.header.partyId && !x.header.obBatchId);
  const live = peers.filter((x) => LIVE.includes(x.status));
  const dup = peers.find((x) => x.type === d.type && !['cancelled', 'replaced'].includes(x.status) && toSatang(x.totals.total) === total && Math.abs(dayNo(x.header.documentDate) - dayNo(date)) <= 7);
  if (dup) add('duplicate', 'warning', `อาจซ้ำกับ ${dup.number ?? dup.id} (คู่ค้าและยอดเดียวกัน ห่างกันไม่เกิน 7 วัน)`);
  const recent = live.filter((x) => { const n = dayNo(date) - dayNo(x.header.documentDate); return n >= 0 && n <= 90; });
  const max = Math.max(0, ...recent.map((x) => toSatang(x.totals.total)));
  if (recent.length && total > 3 * max) add('over_3x', 'warning', `ยอดสูงกว่า 3 เท่าของยอดสูงสุดของคู่ค้าใน 90 วัน (${fromSatang(max)})`);
  if (d.header.partyId && !live.length) add('first_document', 'warning', 'เอกสารฉบับแรกของคู่ค้านี้');
  if (trace.some((t) => t.r.level === 'default' && (t.role === 'Revenue' || t.role === 'Expense'))) add('posting_default', 'warning', 'การลงบัญชีใช้กฎค่าเริ่มต้นของบริษัท ไม่มีกฎเฉพาะสินค้า หมวด คู่ค้า หรือประเภทเอกสาร');
  if (date.slice(0, 7) !== today().slice(0, 7)) add('date_not_current', 'warning', `วันที่เอกสาร ${date} ไม่ได้อยู่ในเดือนปัจจุบัน`);
  if (policy.mode === 'auto' && total > toSatang(policy.cap)) add('cap_exceeded', 'warning', `ยอด ${d.totals.total} เกินวงเงินอัตโนมัติ ${policy.cap}`);
  add('totals', 'info', `ยอดสุทธิ ${d.totals.net} ภาษี ${d.totals.vat} รวม ${d.totals.total}`);
  return out;
}

/** The agent's review of its own draft: stores a NEW report (a revise by the agent makes the next version) and points the document at it. Agents only. */
export function reviewDraft(st: MockState, actor: Actor, docId: string): StoredReport {
  if (actor.kind !== 'agent') throw new MockError(403, 'agent.review_agent_only', 'รายงานการตรวจสร้างโดย agent ที่ส่งร่างเท่านั้น');
  const d = st.docs.find((x) => x.id === docId);
  if (!d) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
  if (d.status !== 'draft' || d.createdBy.kind !== 'agent') throw new MockError(409, 'agent.review_not_draft', 'ตรวจได้เฉพาะร่างที่ agent สร้าง');
  const trace: { role: string; r: Resolved }[] = [];
  let journal: JournalPreview = { entries: [] }, failed = false;
  try { journal = traceResolutions(trace as never, () => ledgerFor(st, d)); } catch { failed = true; }
  const checks = checksOf(st, d, trace, failed);
  const policy = policyOf(st, d.companyId, d.type);
  const clean = !checks.some((c) => c.severity === 'error' || c.severity === 'warning');
  const reports = (st.agentReports ??= []);
  const at = stamp();
  const r: StoredReport = { id: `ar-${reports.length + 1}`, companyId: d.companyId, docId: d.id, docType: d.type, ...(d.number ? { docNumber: d.number } : {}), partyName: d.party?.name ?? '',
    version: reports.filter((x) => x.docId === d.id).length + 1, docVersion: d.version, createdAt: at, expiresAt: new Date(Date.parse(at) + TOKEN_MINUTES * 60_000).toISOString(),
    agentName: actor.name, ...(actor.ownerName ? { ownerName: actor.ownerName } : {}), totals: structuredClone(d.totals), journal, checks,
    route: routeOf(policy, { clean, total: d.totals.total }), policy: { mode: policy.mode, cap: policy.cap } };
  reports.push(r);
  d.agentReportId = r.id;
  logAudit(st, actor, d.companyId, 'agent.review', d.id, undefined, { reportId: r.id, route: r.route });
  return r;
}

/** The stored report, as it was made. Another company's report is a 404. */
export function getReport(st: MockState, companyId: string, id: string): AgentReport {
  const r = (st.agentReports ?? []).find((x) => x.id === id && x.companyId === companyId);
  if (!r) throw new MockError(404, 'record.not_found', 'ไม่พบรายงานการตรวจ');
  const { companyId: _c, ...wire } = structuredClone(r); void _c;
  return wire;
}

/** Seed (through the commands): the agent's own drafts ti-002 and ti-004, and one agent payment voucher, each reviewed the way the agent does. */
export function seedAgentReports(st: MockState): void {
  withFixedClock('2026-10-14T09:30:00+07:00', () => {
    createDraft(st, 'co-vat', 'PV', { header: { partyId: 'pv-09', documentDate: '2026-09-28', reference: 'ค่าถ่ายภาพ (agent ร่างให้)' },
      lines: [{ id: 'pv-ag1-l1', description: 'ค่าถ่ายภาพสินค้า', qty: '1', unit: 'งาน', unitPrice: '2500.00', taxCode: 'EX', expenseCategory: 'services', whtTypeCode: 'SVC' }] }, AGENT, 'seed-pv-ag1', { id: 'pv-ag1' });
    for (const id of ['ti-002', 'ti-004', 'pv-ag1']) reviewDraft(st, AGENT, id);
  });
}
