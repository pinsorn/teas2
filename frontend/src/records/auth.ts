import type { DocType, IsoDate, PaperModel } from '@/domain/types';
import { api } from '@/lib/api/client';

// SP1c HC3: the wire of the platform screens (D-32: auth is mock-only; the mock engine is mocks/engine/auth.ts).
// A password, a TOTP code, a recovery code or a public token never goes into a URL: they travel in a POST body (the token of a public link is the path of ITS OWN page, by design).

export type SessionState = 'active' | 'expiring' | 'expired' | 'out';
export type LoginResult = { status: 'ok' } | { status: 'totp_required'; challenge: string };
export interface ProfileView { userId: string; email: string; displayName: string; totpEnabled: boolean; recoveryRemaining: number }
export interface SessionRow { id: string; device: string; ip: string; createdAt: string; lastSeenAt: string; current: boolean }
export interface OnboardBody { legalNameTh: string; taxId: string; branchCode: string; address: string; vatRegistered: boolean; fiscalYearStartMonth: number; template: string;
  bank: { kind: 'bank' | 'cash'; accountName: string; bankName?: string; accountNo?: string }; cutoff: IsoDate }
export interface Demo { email: string; password: string; totpEmail: string; totpPassword: string; totpCode: string; recoveryCode?: string }

/** HC3a M4: the documents that go to a counterparty - only these get a public link (never a payroll run, a journal, an expense claim, a payment voucher or a vendor bill). WT: for the payee. */
export const PUBLIC_LINK_TYPES: DocType[] = ['QT', 'SO', 'DO', 'IV', 'TI', 'BL', 'RC', 'CN', 'DN', 'PO', 'WT'];

export const authApi = {
  login: (email: string, password: string) => api<LoginResult>('POST', '/auth/login', { email, password }),
  totp: (challenge: string, v: { code: string } | { recoveryCode?: string }) => api<LoginResult>('POST', '/auth/totp', { challenge, ...v }),
  session: () => api<{ state: SessionState; email: string; expiresInSec?: number }>('GET', '/auth/session'),
  extend: () => api<{ state: SessionState }>('POST', '/auth/session/extend'),
  logout: () => api<{ state: SessionState }>('POST', '/auth/logout'),
  /** an expired session only; a user with two-step on gets `totp_required` first and sends the password again with the code */
  relogin: (password: string, v: { code?: string; recoveryCode?: string } = {}) => api<{ status: 'ok' | 'totp_required' }>('POST', '/auth/relogin', { password, ...v }),
  /** mock only: what to type. A real backend has no such route (404) and the hint stays hidden. */
  demo: () => api<Demo>('GET', '/auth/demo'),
  profile: () => api<ProfileView>('GET', '/auth/profile'),
  changePassword: (current: string, next: string, confirm: string) => api<{ status: 'ok' }>('POST', '/auth/password', { current, next, confirm }),
  startEnrol: () => api<{ secret: string; uri: string }>('POST', '/auth/totp/enrol'),
  /** the recovery codes are in THIS response and nowhere else */
  verifyEnrol: (code: string) => api<{ recoveryCodes: string[] }>('POST', '/auth/totp/enrol/verify', { code }),
  sessions: () => api<{ items: SessionRow[] }>('GET', '/auth/sessions'),
  revokeSession: (id: string) => api<{ signedOut: boolean }>('POST', `/auth/sessions/${encodeURIComponent(id)}/revoke`),
  onboard: (body: OnboardBody) => api<{ companyId: string; cutoff: IsoDate }>('POST', '/onboarding', body),
  /** a new public link for an issued document; the token is returned once */
  createLink: (type: DocType, id: string) => api<{ token: string }>('POST', `/docs/${type}/${encodeURIComponent(id)}/public-links`, {}),
  revokeLinks: (type: DocType, id: string) => api<{ revoked: number }>('DELETE', `/docs/${type}/${encodeURIComponent(id)}/public-links`),
  publicPaper: (token: string) => api<{ type: DocType; paper: PaperModel }>('GET', `/public/p/${encodeURIComponent(token)}`),
};

/** The language preference lives in the `locale` cookie the server reads (i18n/request.ts). */
export const setLocale = (locale: 'th' | 'en') => { document.cookie = `locale=${locale}; path=/; max-age=31536000; SameSite=Lax`; };
export const currentLocale = (): 'th' | 'en' => (typeof document !== 'undefined' && /(?:^|;\s*)locale=en/.test(document.cookie) ? 'en' : 'th');
