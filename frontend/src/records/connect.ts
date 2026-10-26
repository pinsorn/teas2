import type { DocTotals, DocType, IsoDate, JournalPreview, Money } from '@/domain/types';
import { api } from '@/lib/api/client';

// SP1c HC2: the wire of TEAS Connect (API keys, connected apps, the agent policy, the agent review report). The mock engines are mocks/records/connect.ts and mocks/engine/agent-review.ts.
// A secret is on the wire exactly once: in the response of create / rotate. No other response carries it.

export type KeyKind = 'rest' | 'mcp';
export type KeyStatus = 'active' | 'revoked' | 'expired';
export interface ApiKeyRow { id: string; version: number; name: string; kind: KeyKind; /** display prefix of the secret */ prefix: string; ownerName: string; scopes: string[]; scopeCount: number;
  createdAt: string; lastUsedAt?: string; expiresAt?: IsoDate; revokedAt?: string; status: KeyStatus }
export interface ApiKeysView { items: ApiKeyRow[]; /** what the signed-in owner may grant a key on this company */ scopeChoices?: string[] }
export interface ApiKeyCreated { key: ApiKeyRow; /** shown once */ secret: string }
export interface ApiKeyBody { name: string; kind: KeyKind; scopes: string[]; expiresAt?: IsoDate }

export interface OAuthAppRow { id: string; version: number; name: string; ownerName: string; scopes: string[]; connectedAt: string; revokedAt?: string }
export interface ConsentInfo { client: { id: string; name: string }; company: { id: string; name: string }; owner: { name: string }; requested: string[]; granted: string[]; notGranted: string[] }
export type ConsentResult = { status: 'approved' | 'denied'; appId?: string };

export type PolicyMode = 'off' | 'human' | 'auto';
export interface PolicyRow { docType: DocType; mode: PolicyMode; cap: Money; version: number; tClass: boolean }
export interface PolicyView { items: PolicyRow[]; /** §8.5: what an agent never does (read-only) */ hardLimits: string[] }

export type Severity = 'error' | 'warning' | 'info';
export interface ReportCheck { code: string; severity: Severity; message: string }
/** §8.2: computed ONCE when the agent submits the draft and stored; never recomputed on read. */
export interface AgentReport { id: string; docId: string; docType: DocType; docNumber?: string; partyName: string; /** report number of this document (a revise by the agent makes the next) */ version: number; docVersion: number;
  createdAt: string; expiresAt: string; /** where the document stands now (read live, never part of the stored report) */ docNowVersion?: number; agentName: string; ownerName?: string; totals: DocTotals; journal: JournalPreview; checks: ReportCheck[]; route: 'auto' | 'human';
  policy: { mode: PolicyMode; cap: Money } }

const shown = new Map<string, string>(); // client -> the company its consent page showed
export const connectApi = {
  keys: () => api<ApiKeysView>('GET', '/connect/keys'),
  createKey: (body: ApiKeyBody) => api<ApiKeyCreated>('POST', '/connect/keys', body),
  rotateKey: (id: string, version: number) => api<ApiKeyCreated>('POST', `/connect/keys/${id}/rotate`, { version }),
  revokeKey: (id: string, version: number) => api<ApiKeyRow>('POST', `/connect/keys/${id}/revoke`, { version }),
  apps: () => api<{ items: OAuthAppRow[] }>('GET', '/connect/apps'),
  revokeApp: (id: string, version: number) => api<OAuthAppRow>('POST', `/connect/apps/${id}/revoke`, { version }),
  policy: () => api<PolicyView>('GET', '/connect/policy'),
  savePolicy: (docType: string, body: { mode: PolicyMode; cap: Money; version: number }) => api<PolicyRow>('PUT', `/connect/policy/${docType}`, body),
  consentInfo: async (client: string) => { const i = await api<ConsentInfo>('GET', `/oauth/consent-info?client=${encodeURIComponent(client)}`); shown.set(client, i.company.id); return i; },
  /** the decision carries the company the page showed: the server refuses it if the active company has moved */
  consent: (client: string, decision: 'approve' | 'deny') => api<ConsentResult>('POST', '/oauth/consent', { client, decision, companyId: shown.get(client) }),
  report: (id: string) => api<AgentReport>('GET', `/agent-reports/${encodeURIComponent(id)}`),
};
