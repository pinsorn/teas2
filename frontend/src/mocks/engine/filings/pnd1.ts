import { LIVE } from '@/domain/doc-types';
import type { FilingBlocker, FilingBox, FilingModel } from '@/domain/filings';
import type { PayrollSlip } from '@/domain/types';
import { isValidTin } from '@/domain/tin';
import type { MockState } from '../../store';
import { companyEntries } from '../ledger';
import { MockError } from '../log';
import { fromSatang, toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { resolveRole } from '../posting';
import { type Filing, PERIOD, type PayrollRow, boxOf, chainBlockers, fnv, tie } from './pp30';
import { formName as baseName, pndDue } from './pnd-wht';

/** PY3: the payroll returns. Ruling 1 [SP-R]: a run belongs to the month of its PAY DATE (header.documentDate, I11), paid or not - not the month it was paid out (PY2) and not the work period (Ham decides at GPY).
 *  Ruling 2 (CLAUDE.md freeze rule): a finalized return stores the runs it took (id, number, revision) and one row per employee COPIED from the stored slips of those runs; nothing is re-derived afterwards.
 *  `deriveRows` is the one function that makes rows from stored slips: finalize uses it and so does the invariant, so "re-derive from the stored slips of the stored runs" is literal. */
type Stored = MockState['docs'][number];
const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const DRAFTISH = ['draft', 'pending', 'approved'];
export type PayrollKind = 'pnd1' | 'sso';
/** The name of a form as the pages and messages write it (the payroll returns added to the withholding / VAT names of `pnd-wht`). */
export const formName = (f: string): string => (f === 'PND1' ? 'ภ.ง.ด.1' : f === 'PND1A' ? 'ภ.ง.ด.1ก' : f === 'SSO1-10' ? 'สปส.1-10' : baseName(f));

/** The issued runs paid ON a date in `period` (live: issued or settled), in chain order. */
export const runsOf = (st: MockState, companyId: string, period: string): Stored[] =>
  st.docs.filter((d) => d.companyId === companyId && d.type === 'PR' && LIVE.includes(d.status) && !!d.payroll && d.header.documentDate.startsWith(period))
    .sort((a, b) => a.header.documentDate.localeCompare(b.header.documentDate) || (a.number ?? a.id).localeCompare(b.number ?? b.id));
export const runRefs = (runs: Stored[]) => runs.map((d) => ({ id: d.id, number: d.number ?? d.id, revision: d.revision }));

/** One row per employee from the stored slips of `runs` (an employee with a slip in two runs of the month is one row: the figures add up). ภ.ง.ด.1: every employee paid, with income, PIT and the SSO paid (for the ภ.ง.ด.1ก and the 50 ทวิ).
 *  สปส.1-10: the employees under SSO; the wage base is the salary paid in the month clamped to the floor .. ceiling the SLIP stored (its own tables, never today's), and no base when no contribution was taken. */
export function deriveRows(runs: Stored[], kind: PayrollKind): PayrollRow[] {
  const by = new Map<string, PayrollSlip[]>();
  for (const d of runs) for (const s of d.payroll!.slips) by.set(s.employeeId, [...(by.get(s.employeeId) ?? []), s]);
  const rows: PayrollRow[] = [];
  for (const [employeeId, slips] of by) {
    const last = slips[slips.length - 1], total = (k: 'gross' | 'pit' | 'sso' | 'ssoEmployer' | 'salaryPaid') => slips.reduce((n, s) => n + sat(s[k]), 0);
    if (kind === 'sso' && !last.employee.ssoRegistered) continue;
    const base = { employeeId, name: last.name, nationalId: last.employee.nationalId ?? '', income: fromSatang(total('gross')), sso: fromSatang(total('sso')), ssoEmployer: fromSatang(total('ssoEmployer')) };
    if (kind === 'pnd1') rows.push({ ...base, pit: fromSatang(total('pit')) });
    else rows.push({ ...base, wageBase: fromSatang(total('sso') > 0 ? Math.min(Math.max(total('salaryPaid'), sat(last.tables.ssoFloor)), sat(last.tables.ssoCeiling)) : 0) });
  }
  return rows;
}

/** The credit movement (credit - debit) of a payroll payable (PitPayable 2153 / SsoPayable 2160) in the month: `runs` = the entries of the month's PAYROLL RUNS (by the run's own month, a later cancel's reversal included, like TX2's tie-out);
 *  `other` = every other entry of the month on that account except the payments of returns (a payment is the way the payable clears, not a movement to explain) - an opening balance, say. A non-zero `other` is its own amber tie-out line, never folded into the first. */
export function payrollMovement(st: MockState, companyId: string, role: 'PitPayable' | 'SsoPayable', period: string): { runs: number; other: number } {
  const code = resolveRole(st, role, { companyId, docType: 'PR' }).code;
  const net = (es: Iterable<{ date: string; lines: { accountCode: string; debit: string; credit: string }[] }>, inMonth: (e: { date: string }) => boolean) => {
    let n = 0;
    for (const e of es) if (inMonth(e)) for (const l of e.lines) if (l.accountCode === code) n += sat(l.credit) - sat(l.debit);
    return n;
  };
  const prDocs = new Set(st.docs.filter((d) => d.companyId === companyId && d.type === 'PR').map((d) => d.id)), prEntries = new Set<object>();
  let runs = 0;
  for (const j of st.journals) if (prDocs.has(j.docId)) {
    const d = st.docs.find((x) => x.id === j.docId)!;
    for (const e of j.preview.entries) { prEntries.add(e); if (d.header.documentDate.startsWith(period)) runs += net([e], () => true); }
  }
  const paid = new Set<object>(st.bankJournals.filter((j) => j.companyId === companyId && j.kind === 'tax').flatMap((j) => j.entries));
  const other = net([...companyEntries(st, companyId, false)].filter((e) => !prEntries.has(e) && !paid.has(e)), (e) => e.date.startsWith(period));
  return { runs, other };
}

export const ssoOpen = (co: { ssoEmployerAccountNo?: string } | undefined) => !/^\d{10}$/.test(co?.ssoEmployerAccountNo ?? '');
/** An employee a return cannot name: the national id is the payee's id on the return (ภ.ง.ด.1) and on the SSO file. */
export const nidBlockers = (rows: PayrollRow[]): FilingBlocker[] =>
  rows.filter((r) => !isValidTin(r.nationalId)).map((r) => ({ code: 'employee_nid', labelTh: `พนักงาน ${r.name} ไม่มีเลขประจำตัวประชาชนที่ถูกต้อง (ใช้ระบุผู้มีเงินได้ในแบบ)`, href: `/payroll/employees/${r.employeeId}` }));
/** Ruling 4: a run of the month that is still a draft is NOT in the return and could not be issued into this month once it is filed: a warning, like the withholding returns (they never block on a draft certificate). */
export const draftWarnings = (st: MockState, companyId: string, period: string): string[] =>
  st.docs.filter((d) => d.companyId === companyId && d.type === 'PR' && DRAFTISH.includes(d.status) && d.header.documentDate.startsWith(period))
    .map((d) => `รอบเงินเดือนฉบับร่าง ${d.header.reference ?? d.number ?? d.id} ลงวันที่ในเดือน ${monthLabelTh(period)} ยังไม่ได้ออก จึงไม่อยู่ในแบบนี้ (ออกรอบก่อนยืนยันแบบ ไม่เช่นนั้นออกเข้าเดือนที่ยื่นแล้วไม่ได้)`);
export const payrollHref = (tab: 'pnd1' | 'pnd1a' | 'sso', period: string) => `/payroll/filings?tab=${tab}&period=${period}`;
export const baseBlockers = (st: MockState, companyId: string): FilingBlocker[] => {
  const co = st.companies.find((c) => c.id === companyId);
  return !co || !isValidTin(co.taxId) ? [{ code: 'company_tin', labelTh: 'เลขประจำตัวผู้เสียภาษีของบริษัทไม่ถูกต้องหรือเป็นเลขสมมติ แก้ที่ตั้งค่าบริษัทก่อนยื่น', href: '/settings/company' }] : [];
};

const COLUMNS = [['no', 'ลำดับ'], ['nationalId', 'เลขประจำตัวประชาชน'], ['name', 'ชื่อผู้มีเงินได้'], ['income', 'เงินได้ที่จ่าย'], ['tax', 'ภาษีที่หัก']] as const;
export const pnd1Attachment = (rows: PayrollRow[]): NonNullable<FilingModel['attachment']> => ({ columns: COLUMNS.map(([key, labelTh]) => ({ key, labelTh })),
  rows: rows.map((r, i) => ({ no: String(i + 1), nationalId: r.nationalId, name: r.name, income: r.income, tax: r.pit ?? '0.00' })) });
const sum = (rows: PayrollRow[], f: (r: PayrollRow) => string | undefined) => rows.reduce((n, r) => n + sat(f(r)), 0);
export const pnd1Boxes = (rows: PayrollRow[]): FilingBox[] => [{ code: 'payees', labelTh: 'จำนวนผู้มีเงินได้ (ราย)', amount: String(rows.length), kind: 'count' },
  { code: 'income', labelTh: 'เงินได้ที่จ่ายทั้งสิ้น', amount: fromSatang(sum(rows, (r) => r.income)) }, { code: 'tax', labelTh: 'ภาษีที่หักและนำส่งทั้งสิ้น', amount: fromSatang(sum(rows, (r) => r.pit)) }];

/** Ruling 4: Σ PIT = the month's 2153 credit movement from the payroll runs; any other 2153 movement is a separate line. */
export function pnd1Ties(st: MockState, companyId: string, period: string, boxes: FilingBox[]) {
  const m = payrollMovement(st, companyId, 'PitPayable', period);
  return [tie('filing.tie.pnd1Gl', boxOf(boxes, 'tax'), m.runs), tie('filing.tie.pnd1Other', m.other, 0)];
}

/** The return of a month as it would be filed NOW; `version` fingerprints the runs and rows so finalize refuses a preview that went stale. */
export function pnd1Model(st: MockState, companyId: string, period: string): FilingModel {
  if (!PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const runs = runsOf(st, companyId, period), rows = deriveRows(runs, 'pnd1'), boxes = pnd1Boxes(rows);
  const blockers: FilingBlocker[] = [...baseBlockers(st, companyId)];
  if (!runs.length) blockers.push({ code: 'no_documents', labelTh: `เดือน ${monthLabelTh(period)} ไม่มีรอบเงินเดือนที่ออกแล้ว จึงไม่มีรายการยื่น ภ.ง.ด.1` });
  blockers.push(...nidBlockers(rows), ...chainBlockers(st, companyId, 'PND1', period, 'ภ.ง.ด.1', (p) => payrollHref('pnd1', p), (p) => runsOf(st, companyId, p).length > 0));
  return { form: 'PND1', period, status: 'draft', boxes, tieOuts: pnd1Ties(st, companyId, period, boxes), blockers, warnings: draftWarnings(st, companyId, period), attachment: pnd1Attachment(rows),
    version: fnv(JSON.stringify([runRefs(runs), rows])), dueDate: pndDue(period), exports: ['rdprep-txt', 'pdf'] };
}
export const pnd1Snapshot = (st: MockState, companyId: string, period: string): Pick<Filing, 'payroll' | 'docs' | 'carryIn' | 'pp36'> => {
  const runs = runsOf(st, companyId, period);
  return { payroll: { runs: runRefs(runs), rows: deriveRows(runs, 'pnd1') }, docs: [], carryIn: '0.00', pp36: '0.00' };
};

/** What every finalized monthly payroll return must still be (ruling 2): the runs it took exist, are live and unrevised, and are all the month's runs; its rows are exactly what the stored slips give; its boxes are its rows; its tie-outs start from the boxes. */
export function payrollSnapInvariants(st: MockState, f: Filing, w: string, out: string[], kind: PayrollKind): void {
  const snap = f.payroll!, found: Stored[] = [];
  for (const ref of snap.runs) {
    const d = st.docs.find((x) => x.id === ref.id && x.companyId === f.companyId && x.type === 'PR');
    if (!d) { out.push(`${w}: run ${ref.id} is gone`); continue; }
    found.push(d);
    if (!LIVE.includes(d.status) || !d.payroll) out.push(`${w}: run ${ref.id} is listed but is ${d.status}`);
    else if ((d.number ?? d.id) !== ref.number || d.revision !== ref.revision) out.push(`${w}: run ${ref.id} is ${d.number} revision ${d.revision} but the return took ${ref.number} revision ${ref.revision}`);
    if (!d.header.documentDate.startsWith(f.period)) out.push(`${w}: run ${ref.id} is dated ${d.header.documentDate}, not in ${f.period}`);
  }
  const listed = new Set(snap.runs.map((r) => r.id));
  for (const d of runsOf(st, f.companyId, f.period)) if (!listed.has(d.id)) out.push(`${w}: run ${d.id} is missing from the snapshot`);
  const live = found.filter((d) => LIVE.includes(d.status) && !!d.payroll), want = deriveRows(live, kind), have = snap.rows;
  if (want.length !== have.length) out.push(`${w}: the stored rows are ${have.length} but the stored slips of the stored runs give ${want.length}`);
  for (const [i, r] of have.entries()) {
    const x = want[i] as PayrollRow | undefined;
    if (!x) continue;
    for (const k of new Set([...Object.keys(r), ...Object.keys(x)]) as Set<keyof PayrollRow>) if (JSON.stringify(r[k]) !== JSON.stringify(x[k])) out.push(`${w}: row ${r.employeeId} ${k} "${r[k] ?? ''}" but the stored slips give "${x[k] ?? ''}"`);
  }
  const co = f.company;
  if (!isValidTin(co.taxId)) out.push(`${w}: the company tax id as filed is not valid`);
}

export function pnd1Invariants(st: MockState, f: Filing, w: string, out: string[]): void {
  const rows = f.payroll!.rows;
  payrollSnapInvariants(st, f, w, out, 'pnd1');
  if (JSON.stringify(pnd1Boxes(rows)) !== JSON.stringify(f.boxes)) out.push(`${w}: the stored boxes are not Σ its stored rows`);
  const t = f.tieOuts[0];
  if (f.tieOuts.length !== 2 || t.labelKey !== 'filing.tie.pnd1Gl' || f.tieOuts[1].labelKey !== 'filing.tie.pnd1Other') out.push(`${w}: tie-outs filing.tie.pnd1Gl / pnd1Other are missing`);
  else if (sat(t.left) !== boxOf(f.boxes, 'tax')) out.push(`${w}: tie-out filing.tie.pnd1Gl left ${t.left} is not the stored box`);
}
