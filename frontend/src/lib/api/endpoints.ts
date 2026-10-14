import type {
  ActivityEntry, ChainGraph, ComputeResult, CorrectionPlan, CorrectionResult, Doc, DocHeader, DocLine, DocSummary,
  DocType, HomeInbox, ItemSummary, JournalPreview, Me, Page, PaperModel, PartySummary, Qty, Revision, SearchHit,
} from '@/domain/types';
import { api } from './client';

export type DocInput = { header: DocHeader; lines: DocLine[] };
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
  searchItems: (p: { q?: string; limit?: number } = {}) => api<Page<ItemSummary>>('GET', `/items${qs(p)}`),
  search: (q: string) => api<{ items: SearchHit[] }>('GET', `/search${qs({ q })}`),

  listDocs: (type: DocType, params: ListDocsParams = {}) => api<Page<DocSummary>>('GET', `/docs/${type}${qs({ ...params })}`),
  getDoc: (type: DocType, id: string) => api<Doc>('GET', d(type, id)),
  computeDocument: (type: DocType, body: DocInput) => api<ComputeResult>('POST', `/docs/${type}/compute`, body),
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
  getChain: (type: DocType, id: string) => api<ChainGraph>('GET', `${d(type, id)}/chain`),
  getActivity: (type: DocType, id: string) => api<ActivityEntry[]>('GET', `${d(type, id)}/activity`),
  getRevisions: (type: DocType, id: string) => api<Revision[]>('GET', `${d(type, id)}/revisions`),
  getLedger: (type: DocType, id: string) => api<JournalPreview>('GET', `${d(type, id)}/ledger`),
  getPaper: (type: DocType, id: string, copy = false) => api<PaperModel>('GET', `${d(type, id)}/paper${qs({ copy: copy ? 1 : undefined })}`),
};
