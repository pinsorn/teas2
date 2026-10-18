import type {
  ActivityEntry, Allocation, Attachment, AttachmentCategory, BankImport, BankLine, ChainGraph, ComputeResult, CorrectionPlan, CorrectionResult, Doc, DocHeader, DocLine, DocSummary,
  DocType, HomeInbox, MarkKey, Money, OpenItem, ItemSummary, JournalPreview, Me, Page, PaperModel, PartySummary, Qty, RemainingLine, Revision, SearchHit,
  DepositRow, DocOpening, SettlementDifferenceRole, SettlementKind, SettlementRecord, DpRow, FaSource, IsoDate, ChecklistItem, PeriodsView,
} from '@/domain/types';
import type { CitYearPatch, CitYearView, FilingForm, FilingHistoryItem, FilingModel, TaxPaymentLines } from '@/domain/filings';
import type { RecordKind, RecordRow } from '@/domain/records';
import type { FormCatalogue, ReportKind, ReportModel, VatThresholdWatch } from '@/domain/reports';
import { api, ApiError, normalizeProblem } from './client';

export type DocInput = { header: DocHeader; lines: DocLine[]; allocations?: Allocation[]; /** OB (AC3): the steps behind the trial balance */ opening?: DocOpening };
/** A postable current-asset account a bank / cash account can be bound to; `taken` = another bank account of the company already owns it. */
export interface BankGlAccount { code: string; nameTh: string; subClass: 'cash' | 'bank'; taken: boolean }
/** FN2: a receipt / voucher the line could match (`exact` = the suggestion: same cash, within 7 days). */
export interface BankCandidate { docId: string; type: 'RC' | 'PV' | 'TR'; number: string; documentDate: string; partyName: string; cash: Money; remaining: Money; exact: boolean }
/** AC5: a capex line (or opening-balance asset row) no live asset has been registered from; `accumulated` / `lifeMonths` only for an opening row. */
export interface UnregisteredAsset { source: FaSource; docNumber: string; docType: 'PB' | 'PV' | 'OB'; description: string; assetClass: string; cost: Money; date: IsoDate; partyName?: string; accumulated?: Money; lifeMonths?: number }
/** AC5: a depreciation run as it would be written now; `problem` = the first reason it would be refused. */
export interface DpPreview { month: string; date: IsoDate; rows: DpRow[]; total: Money; suggested: string; problem?: { status: number; code: string; title: string } }
export interface PostableAccount { code: string; nameTh: string; class: string }
export interface Reconciliation { reconciledTo: string | null; counts: Record<BankLine['status'], number> }
/** FN3: what `/finance/deposits` returns: the unapplied customer deposits / vendor prepayments, the company's tolerance for a difference and the customer / vendor pairs that can be netted. */
export interface DepositsView { items: DepositRow[]; tolerance?: { rounding: Money; smallWriteOff: Money }; pairs?: { customerId: string; customerName: string; vendorId: string; vendorName: string }[] }
export interface SettleInput { kind: SettlementKind; date: string; partyId: string; sources?: { docId: string; amount: Money }[]; targets: { docId: string; amount: Money }[]; difference?: { role: SettlementDifferenceRole; amount: Money }; reason?: string }
export interface WhtTypeRef { code: string; nameTh: string; rate: string; incomeType: string }
export interface ListDocsParams { status?: string; from?: string; to?: string; q?: string; outstanding?: 'positive'; overdue?: '1'; agent?: '1'; /** WT: the return (`PND3` ...) */ form?: string; limit?: number; cursor?: string }

/** Query string without undefined / empty values. */
const qs = (p: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};
const d = (type: DocType, id: string) => `/docs/${type}/${id}`;

export const endpoints = {
  getMe: () => api<Me>('GET', '/me'),
  setActiveCompany: (companyId: string) => api<Me>('POST', '/me/active-company', { companyId }),
  getHome: () => api<HomeInbox>('GET', '/home'),
  searchParties: (p: { kind?: 'customer' | 'vendor' | 'employee'; q?: string; limit?: number } = {}) =>
    api<Page<PartySummary>>('GET', `/parties${qs(p)}`),
  searchItems: (p: { q?: string; limit?: number; usage?: 'sales' | 'purchase' } = {}) => api<Page<ItemSummary>>('GET', `/items${qs(p)}`),
  search: (q: string) => api<{ items: SearchHit[] }>('GET', `/search${qs({ q })}`),

  listDocs: (type: DocType, params: ListDocsParams = {}) => api<Page<DocSummary>>('GET', `/docs/${type}${qs({ ...params })}`),
  getDoc: (type: DocType, id: string) => api<Doc>('GET', d(type, id)),
  computeDocument: (type: DocType, body: DocInput, docId?: string) => api<ComputeResult>('POST', `/docs/${type}/compute${qs({ docId })}`, body),
  createDoc: (type: DocType, body: DocInput, idempotencyKey: string) =>
    api<Doc>('POST', `/docs/${type}`, body, { idempotencyKey }),
  updateDoc: (type: DocType, id: string, body: DocInput, version: number) =>
    api<Doc>('PUT', d(type, id), { ...body, version }),
  deleteDoc: (type: DocType, id: string, version: number) => api<void>('DELETE', `${d(type, id)}?version=${version}`),
  issueDoc: (type: DocType, id: string, version: number) => api<Doc>('POST', `${d(type, id)}/issue`, { version }),
  /** PY2 / PY3 m6: pay a payroll run (the whole net, from an account on a date) and unpay it with a reason. */
  payRun: (id: string, body: { accountId: string; date: string; version: number }) => api<Doc>('POST', `${d('PR', id)}/pay`, body),
  unpayRun: (id: string, body: { reason: string; version: number }) => api<Doc>('POST', `${d('PR', id)}/unpay`, body),
  /** §7.6 approval: submit (draft -> pending), approve (pending -> approved), approve-and-issue (both rights, one command), send back (reason required). */
  submitDoc: (type: DocType, id: string, version: number) => api<Doc>('POST', `${d(type, id)}/submit`, { version }),
  approveDoc: (type: DocType, id: string, version: number) => api<Doc>('POST', `${d(type, id)}/approve`, { version }),
  approveAndIssueDoc: (type: DocType, id: string, version: number) => api<Doc>('POST', `${d(type, id)}/approve-and-issue`, { version }),
  sendBackDoc: (type: DocType, id: string, version: number, reason: string) => api<Doc>('POST', `${d(type, id)}/send-back`, { version, reason }),
  cancelDoc: (type: DocType, id: string, version: number, reasonCode: string, reasonText: string) =>
    api<Doc>('POST', `${d(type, id)}/cancel`, { version, reasonCode, reasonText }),
  getCorrectionPlan: (type: DocType, id: string, proposed: DocInput) =>
    api<CorrectionPlan>('POST', `${d(type, id)}/correction-plan`, proposed),
  executeCorrection: (planId: string, planHash: string) =>
    api<CorrectionResult>('POST', '/corrections', { planId, planHash }),
  convertDoc: (type: DocType, id: string, targetType: DocType, lines: { sourceLineId: string; qty: Qty }[]) =>
    api<Doc>('POST', `${d(type, id)}/convert`, { targetType, lines }),
  setMark: (type: DocType, id: string, mark: MarkKey, version: number, reason?: string) => api<Doc>('POST', `${d(type, id)}/marks`, { mark, version, reason }),
  closeRemainder: (type: DocType, id: string, version: number, reason: string) => api<Doc>('POST', `${d(type, id)}/close-remainder`, { version, reason }),
  getRemaining: (type: DocType, id: string) => api<RemainingLine[]>('GET', `${d(type, id)}/remaining`),
  getChain: (type: DocType, id: string) => api<ChainGraph>('GET', `${d(type, id)}/chain`),
  getActivity: (type: DocType, id: string) => api<ActivityEntry[]>('GET', `${d(type, id)}/activity`),
  getRevisions: (type: DocType, id: string) => api<Revision[]>('GET', `${d(type, id)}/revisions`),
  getLedger: (type: DocType, id: string) => api<JournalPreview>('GET', `${d(type, id)}/ledger`),
  openItems: (p: { partyId: string; types: DocType[] }) => api<{ items: OpenItem[]; total: Money }>('GET', `/docs/open-items${qs({ partyId: p.partyId, types: p.types.join(',') })}`),
  bankGlAccounts: () => api<BankGlAccount[]>('GET', '/finance/bank-gl-accounts'),
  /** FN1: `content` is the CSV text, or the PDF as base64. The password (K PLUS) is sent once and never kept. */
  importStatement: (accountId: string, body: { fileName: string; format: BankImport['format']; content: string; password?: string }) =>
    api<BankImport>('POST', `/finance/bank-accounts/${encodeURIComponent(accountId)}/imports`, body),
  listBankLines: (accountId: string, p: { status?: BankLine['status']; from?: string; to?: string; line?: string; limit?: number; cursor?: string } = {}) =>
    api<Page<BankLine>>('GET', `/finance/bank-accounts/${encodeURIComponent(accountId)}/lines${qs(p)}`),
  /** FN2 reconciliation (bank.reconcile): suggestions / search, match (batch, split share, fee / rounding difference), unmatch, ignore, inline journal, lock to a date. */
  bankCandidates: (lineId: string, q?: string) => api<{ items: BankCandidate[] }>('GET', `/finance/bank-lines/${encodeURIComponent(lineId)}/candidates${qs({ q })}`),
  matchBankLine: (lineId: string, body: { docIds: string[]; amounts?: Record<string, Money>; diff?: { role: 'BankFee' | 'RoundingDifference'; amount: Money } }) =>
    api<BankLine>('POST', `/finance/bank-lines/${encodeURIComponent(lineId)}/match`, body),
  bankLineCommand: (lineId: string, command: 'unmatch' | 'ignore' | 'unignore', reason?: string) =>
    api<BankLine>('POST', `/finance/bank-lines/${encodeURIComponent(lineId)}/${command}`, { reason }),
  /** I2: a line that is money moving to / from another own account. */
  transferBankLine: (lineId: string, toAccountId: string) => api<BankLine>('POST', `/finance/bank-lines/${encodeURIComponent(lineId)}/transfer`, { toAccountId }),
  /** R1-1: reverse a transfer journal (both lines unmatched, a reason). */
  reverseBankTransfer: (journalId: string, reason: string) => api<{ id: string; reversed: boolean }>('POST', `/finance/bank-journals/${encodeURIComponent(journalId)}/reverse`, { reason }),
  postBankLine: (lineId: string, body: { accountCode: string; description?: string }) =>
    api<BankLine>('POST', `/finance/bank-lines/${encodeURIComponent(lineId)}/post`, body),
  postableAccounts: () => api<PostableAccount[]>('GET', '/finance/postable-accounts'),
  /** JV: the accounts a journal voucher may post to. */
  journalAccounts: () => api<PostableAccount[]>('GET', '/accounting/journal-accounts'),
  /** AC3: the accounts an opening balance may post to (controlled ones included; the 3900 plug is the system's). */
  openingAccounts: () => api<PostableAccount[]>('GET', '/accounting/journal-accounts?for=OB'),
  /** JV "กลับรายการ": a reversing JV of this one (dated the first open date or later, never in the future); any other document type is refused. */
  reverseDoc: (type: DocType, id: string, body: { date?: string; reason?: string } = {}) => api<Doc>('POST', `${d(type, id)}/reverse`, body),
  getReconciliation: (accountId: string) => api<Reconciliation>('GET', `/finance/bank-accounts/${encodeURIComponent(accountId)}/reconciliation`),
  lockReconciliation: (accountId: string, date: string) => api<{ reconciledTo: string }>('POST', `/finance/bank-accounts/${encodeURIComponent(accountId)}/reconciled-to`, { date }),
  /** FN3 settlements (D-13): read with bank.read, post / reverse with bank.manage. */
  getDeposits: () => api<DepositsView>('GET', '/finance/deposits'),
  listSettlements: (p: { q?: string; status?: SettlementRecord['status']; limit?: number; cursor?: string } = {}) => api<Page<SettlementRecord>>('GET', `/finance/settlements${qs(p)}`),
  getSettlement: (id: string) => api<SettlementRecord>('GET', `/finance/settlements/${encodeURIComponent(id)}`),
  postSettlement: (body: SettleInput, idempotencyKey: string) => api<SettlementRecord>('POST', '/finance/settlements', body, { idempotencyKey }),
  reverseSettlement: (id: string, reason: string) => api<SettlementRecord>('POST', `/finance/settlements/${encodeURIComponent(id)}/reverse`, { reason }),
  whtTypes: () => api<WhtTypeRef[]>('GET', '/wht-types'),
  /** Every document of one party, across the types the role can read. */
  docsByParty: (partyId: string) => api<Page<DocSummary>>('GET', `/docs/by-party/${encodeURIComponent(partyId)}`),
  listRecords: (kind: RecordKind, p: { q?: string; active?: 'true' | 'false' | 'all'; limit?: number; cursor?: string; [k: string]: string | number | undefined }) =>
    api<Page<RecordRow>>('GET', `/records/${kind}${qs(p)}`),
  getRecord: (kind: RecordKind, id: string) => api<RecordRow>('GET', `/records/${kind}/${encodeURIComponent(id)}`),
  createRecord: (kind: RecordKind, values: Record<string, unknown>, idempotencyKey: string) =>
    api<RecordRow>('POST', `/records/${kind}`, values, { idempotencyKey }),
  updateRecord: (kind: RecordKind, id: string, values: Record<string, unknown>, version: number) =>
    api<RecordRow>('PUT', `/records/${kind}/${encodeURIComponent(id)}`, { ...values, version }),
  setRecordActive: (kind: RecordKind, id: string, active: boolean, version: number) =>
    api<RecordRow>('POST', `/records/${kind}/${encodeURIComponent(id)}/active`, { active, version }),
  /** AC4 schedules: "รันตอนนี้" (a plan month for an amortisation, a draft for a recurring one) and "หยุด"; both need ledger.schedule.manage, `version` is the record kit's concurrency check. */
  runSchedule: (id: string, version: number, month?: string) => api<RecordRow>('POST', `/schedules/${encodeURIComponent(id)}/run`, { version, ...(month ? { month } : {}) }),
  stopSchedule: (id: string, version: number, reason?: string) => api<RecordRow>('POST', `/schedules/${encodeURIComponent(id)}/stop`, { version, ...(reason ? { reason } : {}) }),
  /** AC5 fixed assets and depreciation runs (their own commands; the generic document routes refuse FA / DP). */
  unregisteredAssets: () => api<{ items: UnregisteredAsset[] }>('GET', '/assets/unregistered'),
  registerAsset: (body: { source: FaSource; name?: string; salvage?: Money; lifeMonths?: number; startDate?: IsoDate }) => api<Doc>('POST', '/assets', body),
  disposeAsset: (id: string, body: { version: number; date: IsoDate; kind: 'sale' | 'write_off'; proceeds?: Money; buyerId?: string }) => api<Doc>('POST', `/docs/FA/${id}/dispose`, body),
  undisposeAsset: (id: string, version: number) => api<Doc>('POST', `/docs/FA/${id}/undispose`, { version }),
  reviseAssetTerms: (id: string, body: { version: number; name?: string; salvage?: Money; lifeMonths?: number; startDate?: IsoDate }) => api<Doc>('POST', `/docs/FA/${id}/terms`, body),
  previewDepreciation: (month?: string) => api<DpPreview>('GET', `/depreciation/preview${qs({ month })}`),
  runDepreciation: (month: string) => api<Doc>('POST', '/depreciation/runs', { month }),
  recomputeDepreciation: (id: string, version: number) => api<Doc>('POST', `/docs/DP/${id}/recompute`, { version }),
  /** AC6 period close: the year's months, a month's checklist (ledger.read), close (ledger.period.close; `acknowledge` accepts the warnings) and reopen (ledger.period.reopen, with a reason) of a month and of a year. */
  getPeriods: (year?: number) => api<PeriodsView>('GET', `/periods${qs({ year })}`),
  getChecklist: (month: string) => api<{ items: ChecklistItem[] }>('GET', `/periods/checklist${qs({ month })}`),
  closePeriod: (month: string, acknowledge: { code: string; count: number }[]) => api<PeriodsView>('POST', `/periods/${encodeURIComponent(month)}/close`, { acknowledge }),
  reopenPeriod: (month: string, reason: string) => api<PeriodsView>('POST', `/periods/${encodeURIComponent(month)}/reopen`, { reason }),
  closeYear: (year: number) => api<PeriodsView>('POST', `/periods/year/${year}/close`, {}),
  reopenYear: (year: number, reason: string) => api<PeriodsView>('POST', `/periods/year/${year}/reopen`, { reason }),
  /** The claim period the server will store for a bill with these dates (the first unfiled month of its window). */
  claimPeriodDefault: (documentDate: string, vendorDocDate?: string) => api<{ claimPeriod: string }>('GET', `/claim-period${qs({ documentDate, vendorDocDate })}`),
  /** TX1 tax filings: the finalized ones with the month to look at next (tax.read), one period (draft: tax.filing.preview too), finalize (tax.filing.finalize; `version` is the preview's), and the RD Prep text of a finalized one. */
  listFilings: (form: FilingForm) => api<{ items: FilingHistoryItem[]; next: string }>('GET', `/filings/${form}`),
  getFiling: (form: FilingForm, period: string) => api<FilingModel>('GET', `/filings/${form}/${encodeURIComponent(period)}`),
  /** PY3 ruling 8: the annual 50 ทวิ of every employee, built from the FINALIZED ภ.ง.ด.1ก of the year (409 until it is finalized). */
  employeeCertificates: (year: string) => api<PaperModel[]>('GET', `/filings/PND1A/${encodeURIComponent(year)}/certificates`),
  getFormCatalogue: () => api<FormCatalogue>('GET', '/form-catalogue'),
  getVatThreshold: () => api<VatThresholdWatch | null>('GET', '/vat-threshold'),
  finalizeFiling: (form: FilingForm, period: string, version: number, ack?: boolean) => api<FilingModel>('POST', `/filings/${form}/${encodeURIComponent(period)}/finalize`, { version, ...(ack ? { ack } : {}) }),
  /** TX2c: the statement lines a finalized return can be paid from (bank.reconcile), pay it from one, and undo a payment (same URL as reverseBankTransfer). */
  /** TX3a: the CIT year data (capital, prior losses, the ภ.ง.ด.51 estimate) and the user adjustments of a fiscal year (period = YYYY). */
  getCitYear: (year: string) => api<CitYearView>('GET', `/cit-years/${encodeURIComponent(year)}`),
  putCitYear: (year: string, patch: CitYearPatch) => api<CitYearView>('PUT', `/cit-years/${encodeURIComponent(year)}`, patch),
  addCitAdjustment: (year: string, b: { line: number; amount: string; reason: string }) => api<CitYearView>('POST', `/cit-years/${encodeURIComponent(year)}/adjustments`, b),
  updateCitAdjustment: (year: string, id: string, b: { line: number; amount: string; reason: string }) => api<CitYearView>('PUT', `/cit-years/${encodeURIComponent(year)}/adjustments/${encodeURIComponent(id)}`, b),
  deleteCitAdjustment: (year: string, id: string) => api<CitYearView>('DELETE', `/cit-years/${encodeURIComponent(year)}/adjustments/${encodeURIComponent(id)}`),
  taxPaymentLines: (form: FilingForm, period: string) => api<TaxPaymentLines>('GET', `/filings/${form}/${encodeURIComponent(period)}/payment-lines`),
  payTax: (lineId: string, req: { form: FilingForm; period: string; extras?: { accountCode: string; amount: string; description?: string }[] }) => api<BankLine>('POST', `/finance/bank-lines/${encodeURIComponent(lineId)}/pay-tax`, req),
  reverseTaxPayment: (journalId: string, reason: string) => api<{ id: string; reversed: boolean }>('POST', `/finance/bank-journals/${encodeURIComponent(journalId)}/reverse`, { reason }),
  exportFiling: async (form: FilingForm, period: string, kind: 'rdprep-txt'): Promise<string> => {
    const res = await fetch(new URL(`/bff/v1/filings/${form}/${encodeURIComponent(period)}/export${qs({ kind })}`, window.location.origin));
    if (!res.ok) throw new ApiError(normalizeProblem(res.status, await res.json().catch(() => undefined)));
    return res.text();
  },
  getReport: (kind: ReportKind, params: Record<string, string>) => api<ReportModel>('GET', `/reports/${kind}${qs(params)}`),
  /** The CSV the server builds for the same parameters (text/csv, BOM, CRLF). */
  exportReport: async (kind: ReportKind, params: Record<string, string>): Promise<Blob> => {
    const res = await fetch(new URL(`/bff/v1/reports/${kind}/export${qs(params)}`, window.location.origin));
    if (!res.ok) throw new ApiError(normalizeProblem(res.status, await res.json().catch(() => undefined)));
    return res.blob();
  },
  listAttachments: (type: DocType, id: string) => api<Attachment[]>('GET', `${d(type, id)}/attachments`),
  addAttachment: (type: DocType, id: string, a: { category: AttachmentCategory; name: string; mime: string; dataUrl: string }) => api<Attachment>('POST', `${d(type, id)}/attachments`, a),
  removeAttachment: (type: DocType, id: string, attId: string) => api<void>('DELETE', `${d(type, id)}/attachments/${attId}`),
  /** The print action was used. The server decides ต้นฉบับ / สำเนา; the answer says which it recorded. */
  markPrinted: (type: DocType, id: string, copy: boolean, employee?: string) => api<{ copy: boolean; printCount: number }>('POST', `${d(type, id)}/printed`, { copy, ...(employee ? { employee } : {}) }),
  getDefaultNotes: () => api<Partial<Record<DocType, string>>>('GET', '/settings/default-notes'),
  getPaper: (type: DocType, id: string, copy = false) => api<PaperModel>('GET', `${d(type, id)}/paper${qs({ copy: copy ? 1 : undefined })}`),
};
