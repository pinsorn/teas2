import type {
  ActivityEntry, Allocation, ChainGraph, ComputeResult, CorrectionPlan, CorrectionResult, Doc, DocHeader, DocLine, DocSummary,
  DocType, HomeInbox, MarkKey, Money, OpenItem, ItemSummary, JournalPreview, Me, Page, PaperModel, PartySummary, Qty, RemainingLine, Revision, SearchHit,
} from '@/domain/types';
import type { RecordKind, RecordRow } from '@/domain/records';
import type { ReportKind, ReportModel } from '@/domain/reports';
import { api, ApiError, normalizeProblem } from './client';

export type DocInput = { header: DocHeader; lines: DocLine[]; allocations?: Allocation[] };
export interface BankAccountRef { id: string; nameTh: string; accountNo?: string; default?: boolean }
export interface WhtTypeRef { code: string; nameTh: string; rate: string; incomeType: string }
export interface ListDocsParams { status?: string; from?: string; to?: string; q?: string; outstanding?: 'positive'; overdue?: '1'; agent?: '1'; limit?: number; cursor?: string }

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
  searchParties: (p: { kind?: 'customer' | 'vendor'; q?: string; limit?: number } = {}) =>
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
  bankAccounts: () => api<BankAccountRef[]>('GET', '/bank-accounts'),
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
  getReport: (kind: ReportKind, params: Record<string, string>) => api<ReportModel>('GET', `/reports/${kind}${qs(params)}`),
  /** The CSV the server builds for the same parameters (text/csv, BOM, CRLF). */
  exportReport: async (kind: ReportKind, params: Record<string, string>): Promise<Blob> => {
    const res = await fetch(new URL(`/bff/v1/reports/${kind}/export${qs(params)}`, window.location.origin));
    if (!res.ok) throw new ApiError(normalizeProblem(res.status, await res.json().catch(() => undefined)));
    return res.blob();
  },
  getPaper: (type: DocType, id: string, copy = false) => api<PaperModel>('GET', `${d(type, id)}/paper${qs({ copy: copy ? 1 : undefined })}`),
};
