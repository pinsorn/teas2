import type { RecordKind } from '@/domain/records';
import type { ReportKind } from '@/domain/reports';
import type { DocType } from '@/domain/types';

/** Every key starts with the active companyId (except `me`) so a company switch can never hit another company's cache. */
export const qk = {
  me: () => ['me'] as const,
  home: (c: string) => [c, 'home'] as const,
  docs: (c: string, type: DocType, params: object) => [c, 'docs', type, params] as const,
  doc: (c: string, type: DocType, id: string) => [c, 'doc', type, id] as const,
  chain: (c: string, type: DocType, id: string) => [c, 'chain', type, id] as const,
  remaining: (c: string, type: DocType, id: string) => [c, 'remaining', type, id] as const,
  activity: (c: string, type: DocType, id: string) => [c, 'activity', type, id] as const,
  attachments: (c: string, type: DocType, id: string) => [c, 'attachments', type, id] as const,
  defaultNotes: (c: string) => [c, 'default-notes'] as const,
  revisions: (c: string, type: DocType, id: string) => [c, 'revisions', type, id] as const,
  paper: (c: string, type: DocType, id: string, copy: boolean) => [c, 'paper', type, id, copy] as const,
  ledger: (c: string, type: DocType, id: string) => [c, 'ledger', type, id] as const,
  openItems: (c: string, partyId: string, types: string) => [c, 'open-items', partyId, types] as const,
  bankGlAccounts: (c: string) => [c, 'bank-gl-accounts'] as const,
  bankLines: (c: string, accountId: string, params: object) => [c, 'bank-lines', accountId, params] as const,
  bankReconciliation: (c: string, accountId: string) => [c, 'bank-reconciliation', accountId] as const,
  bankCandidates: (c: string, lineId: string, q: string) => [c, 'bank-candidates', lineId, q] as const,
  postableAccounts: (c: string) => [c, 'postable-accounts'] as const,
  deposits: (c: string) => [c, 'deposits'] as const,
  settlements: (c: string, params: object) => [c, 'settlements', params] as const,
  settlement: (c: string, id: string) => [c, 'settlement', id] as const,
  citYear: (c: string, year: string) => [c, 'filings', 'cit-year', year] as const,
  filings: (c: string, form: string) => [c, 'filings', form] as const,
  filing: (c: string, form: string, period: string) => [c, 'filings', form, period] as const,
  report: (c: string, kind: ReportKind, params: Record<string, string>) => [c, 'report', kind, params] as const,
  records: (c: string, kind: RecordKind, params: object) => [c, 'records', kind, params] as const,
  record: (c: string, kind: RecordKind, id: string) => [c, 'record', kind, id] as const,
  docsByParty: (c: string, partyId: string) => [c, 'docs-by-party', partyId] as const,
  itemOptions: (c: string) => [c, 'item-options'] as const,
  whtTypes: (c: string) => [c, 'wht-types'] as const,
};
