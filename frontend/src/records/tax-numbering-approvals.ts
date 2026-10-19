import { api } from '@/lib/api/client';

// SP1c ST3: the wire of /settings/tax, /settings/numbering and /settings/approvals (custom pages; the mock engine is mocks/engine/{wht,numbering,approval}.ts).

export interface WhtRateRow { effectiveFrom: string; rateBp: number; rate: string }
export interface WhtTypeSetting { code: string; nameTh: string; incomeType: string; active: boolean; version: number; /** the rate in force today */ rate: string; /** a document carries it */ inUse: boolean; rows: WhtRateRow[] }
export interface VatRequestRow { id: string; register: boolean; effectiveFrom: string; status: 'pending'; requestedBy: string; requestedAt: string }
export interface TaxSettings {
  vat: { registered: boolean; rate: string; source: string; requests: VatRequestRow[] };
  taxCodes: { code: string; nameTh: string; rate: string }[];
  whtTypes: WhtTypeSetting[];
}
const T = '/settings/tax';
export const taxApi = {
  get: () => api<TaxSettings>('GET', T),
  changeRate: (code: string, body: { rateBp: number; effectiveFrom?: string; version: number }) => api<WhtTypeSetting>('POST', `${T}/wht-types/${encodeURIComponent(code)}/rate`, body),
  setActive: (code: string, body: { active: boolean; version: number }) => api<WhtTypeSetting>('POST', `${T}/wht-types/${encodeURIComponent(code)}/active`, body),
  requestVat: (body: { register: boolean; effectiveFrom: string }) => api<VatRequestRow>('POST', `${T}/vat-request`, body),
};

export type NumberingScope = 'monthly' | 'yearly';
export interface NumberingRow { docType: string; prefix: string; scope: NumberingScope; branch?: string; format: string; version: number; /** the number the next document dated today gets, formatted by the server */ next: string; /** set on a save: the config applies from a later period */ notice?: { code: string; title: string } }
export interface NumberingBody { prefix: string; scope: NumberingScope; branch?: string; format: string }
export interface NumberingPreview { next: string; period: string; inUse: boolean }
const N = '/settings/numbering';
export const numberingApi = {
  list: () => api<{ items: NumberingRow[] }>('GET', N),
  preview: (docType: string, body: NumberingBody) => api<NumberingPreview>('POST', `${N}/preview`, { docType, ...body }),
  save: (docType: string, body: NumberingBody & { version: number }) => api<NumberingRow>('PUT', `${N}/${docType}`, body),
};

export interface ApprovalRuleRow { docType: string; enabled: boolean; minAmount?: string; version: number }
export interface ApprovalsView { items: ApprovalRuleRow[]; selfApproval: boolean; selfApprovalVersion: number; tolerance: { rounding: string; smallWriteOff: string; version: number } }
const A = '/settings/approvals';
export const approvalApi = {
  get: () => api<ApprovalsView>('GET', A),
  saveRule: (docType: string, body: { enabled: boolean; minAmount?: string; version: number }) => api<ApprovalRuleRow>('PUT', `${A}/${docType}`, body),
  saveSelf: (body: { selfApproval: boolean; version: number }) => api<ApprovalsView>('PUT', `${A}/self-approval`, body),
  saveTolerance: (body: { rounding: string; smallWriteOff: string; version: number }) => api<ApprovalsView['tolerance']>('PUT', `${A}/tolerance`, body),
};
