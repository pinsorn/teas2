import type {
  ActivityEntry, Allocation, ApprovalPolicy, Attachment, AuditEntry, BankImport, BankJournal, BankLine, ChainEdge, Company, CorrectionPlan, Doc, DocHeader, DocLine, ItemSummary, JournalPreview, Membership, Money, PaperModel, PartySummary, PayrollPayment, Revision, Role, ScheduleRecord, SettlementRecord,
} from '@/domain/types';
import { DOC_TYPES, LIVE } from '@/domain/doc-types';
import { recomputeSettlement } from './engine/commands';
import { ledgerFor } from './engine/ledger';
import { withBankSnapshot } from './engine/settlement';
import { adjustSnapshot, hasSnapshot } from './engine/notes';
import type { CitYearData } from '@/domain/filings';
import type { YearClose } from './engine/close';
import { type Filing, seedFilings } from './engine/filings';
import type { Period } from './engine/periods';
import type { PostingRule } from './engine/posting';
import type { BankAccount } from './fixtures/bank-accounts';
import type { CompanyAccount } from './fixtures/coa';
import type { CompanyWhtType } from './fixtures/wht-types';
import { SEED_SPECS, seedAudit } from './fixtures';
import { seedAssets } from './fixtures/specs/assets';
import { seedSchedules } from './fixtures/specs/schedules';
import { runSeed } from './fixtures/seed-runner';
import { buildSeed } from './fixtures';
import { clearAttachmentBlobs } from './engine/attachments';
import { getSettings } from './settings';
import { seedBankStatements } from './fixtures/statements';

export interface MockState {
  version: 55;
  companies: Company[];
  memberships: (Membership & { userId: string })[];
  /** `active` (default true) and `version` (default 1) are the master record's; documents keep their own party snapshot. */
  parties: (PartySummary & { companyId: string; active?: boolean; version?: number })[];
  /** `version` (default 1) is the master record's. */
  items: (ItemSummary & { companyId: string; version?: number })[];
  docs: (Doc & { companyId: string })[];
  links: (ChainEdge & { companyId: string })[];
  activity: (ActivityEntry & { docId: string })[];
  revisions: (Revision & { docId: string })[];
  journals: { docId: string; preview: JournalPreview }[];
  accounts: CompanyAccount[];
  postingRules: PostingRule[];
  periods: Period[];
  bankAccounts: BankAccount[];
  /** FN1: imported statements and their lines (the raw file is an attachment whose `docId` is the import id). Importing posts nothing. */
  bankImports: (BankImport & { companyId: string; /** content hash of the file bytes (M3: the same file is not imported twice) */ hash?: string })[];
  bankLines: (BankLine & { companyId: string })[];
  /** FN2: journals the reconciliation wrote (fee / rounding difference, inline journal, seeded opening balance); no document behind them. */
  bankJournals: BankJournal[];
  /** FN3: settlement records (deposits / prepayments applied, netting, write-offs; D-13). Each carries its own journal and its frozen legs; its links are `settles` links whose `from` is the record id. */
  settlements: SettlementRecord[];
  /** AC4: recurring templates and prepaid / deferred amortisation schedules (frozen at creation; a run posts a system JV or makes a draft). */
  schedules: ScheduleRecord[];
  /** AC6: the year-end closing entries (one live per company-year; a reopen keeps the record and reverses its entry). Each carries its own journal and its frozen lines. */
  yearCloses: YearClose[];
  /** TX1: finalized tax filings (ภ.พ.30): the boxes, tie-outs and the exact documents, frozen at finalize. A draft is never stored: it is computed from the documents. */
  filings: Filing[];
  /** PY2: payroll runs paid (and unpaid): the whole run's net, the date and the account as they were at pay, and the journal (a bank journal of kind 'payroll'). A reversed payment stays as history. */
  payrollPayments: PayrollPayment[];
  /** TX3a: the corporate income tax year data per company and fiscal year (paid-up capital, prior losses, user adjustments, the ภ.ง.ด.51 estimate). */
  citYears: (CitYearData & { companyId: string })[];
  /** FN3: per company, the largest difference a settlement may absorb: satang rounding, and a small write-off (also the bank fee) [SP-R]. */
  settlementTolerance: { companyId: string; rounding: Money; smallWriteOff: Money }[];
  /** [SP-R] mock WHT types per company (fixtures/wht-types.ts). */
  whtTypes: CompanyWhtType[];
  audit: AuditEntry[];
  /** Attachment METADATA only. The bytes live under their own localStorage key `teas2.mock.att.<id>` (engine/attachments.ts): they must never be part of this blob, whose save swallows quota errors. */
  attachments: (Omit<Attachment, 'dataUrl'> & { companyId: string })[];
  /** Print log of issued documents; `printCount` on a read is derived from it. `copy` = printed as สำเนา. */
  prints: { docId: string; at: string; by: string; copy: boolean; /** WT only: the paper as printed the first time (I7); every later print shows this. */ paper?: PaperModel }[];
  /** Approval rules per company and document type (§7.6, fixtures/approval-policy.ts; ST3 edits them). */
  approvalPolicies: ApprovalPolicy[];
  series: Record<string, number>;
  /** `companyId|type|Idempotency-Key` -> draft id. */
  idempotency?: Record<string, string>;
  /** Correction plans awaiting execution (single use). */
  plans?: Record<string, { docId: string; proposed: { header: DocHeader; lines: DocLine[]; allocations?: Allocation[] }; role: Role; plan: CorrectionPlan }>;
}

const KEY = 'teas2.mock.state.v26';

/** The seed for a given role (default accountant: the screen index resolves fixture ids on the server, where there is no toolbar). */
export function buildSeedState(role: Role = 'accountant'): MockState {
  const s = buildSeed(role);
  for (const d of s.docs) if (DOC_TYPES[d.type].outstanding) recomputeSettlement(s, d.id); // balances follow the links (§7.11)
  for (const d of s.docs) {
    if (d.status === 'draft') continue;
    const preview = ledgerFor(s, d);
    if (preview.entries.length) s.journals.push({ docId: d.id, preview });
  }
  for (const d of s.docs) { // seeded notes enter directly: give them the ม.86/10 snapshot an issued note has, so the paper never recomputes them
    const ti = hasSnapshot(d.type) && LIVE.includes(d.status) && d.header.refDocId ? s.docs.find((x) => x.id === d.header.refDocId) : undefined;
    if (ti && !d.adjustSnapshot) d.adjustSnapshot = adjustSnapshot(s, ti, d);
  }
  runSeed(s, SEED_SPECS); // later groups' documents, produced through the engine (D-23)
  seedSchedules(s); // AC4: recurring templates and the insurance amortisation (3 runs), after the bill they come from
  seedAssets(s); // AC5: fixed assets, depreciation runs and the sale of one asset, after every bill / opening balance they come from
  for (const d of s.docs) if (d.issuedAt && !d.header.bankSnapshot) d.header = withBankSnapshot(s, d.companyId, d.type, d.header); // seeded receipts / vouchers entered directly: freeze the account they print, like an issued one (I3)
  seedBankStatements(s); // FN1: the September statements, imported through the same engine the upload uses
  seedFilings(s); // TX1: the ภ.พ.30 of 2026-07 and 2026-08 are filed (last: they lock the documents they took)
  seedAudit(s); // RP3: the trail in time order, then logins, switches, a posting-rule and a tax-table change
  return s;
}

export const seed = (): MockState => buildSeedState(getSettings().role);

export function loadState(): MockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw) as MockState; if (s.version === 55) return s; }
  } catch { /* fall through to a fresh seed */ }
  return seed();
}

/** False when the browser refused the write (quota / private mode): the state then lives for this call only. Most callers ignore it; a command that must not lose data checks it. */
export function saveState(s: MockState): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(s)); return true; } catch { return false; }
}

export function resetState(): MockState {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  clearAttachmentBlobs();
  const s = seed();
  saveState(s);
  return s;
}
