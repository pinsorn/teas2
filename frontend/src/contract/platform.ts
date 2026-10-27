// SP3 platform contract, CONTRACT_VERSION 1.0 (docs/specs/SP3-platform.md section 5; master plan docs/plans/2026-10-27-sp2-contract-freeze.md section 2).
// FROZEN once Ham approves the spec: a change is an ADR + Ham's approval + a version bump (plan section 2.4). Hash-checked via FROZEN.json.
// A LEAF: type-only imports, no runtime import. The old paths (domain/types, records/auth, records/connect) re-export from here.
import type { DocType, IsoDate, Money } from '@/domain/types';
import type { RouteSpec } from './route-spec';

export const CONTRACT_VERSION = '1.0';

// ---- 5.1 types moved verbatim from the mock ----
export interface Page<T> { items: T[]; nextCursor?: string; total?: number }
export interface Company { id: string; legalNameTh: string; legalNameEn?: string; taxId: string; branchCode: string;
  vatRegistered: boolean; address: string; phone?: string; /** ST1 (company settings): the SSO employer account, 10 digits; the สปส.1-10 cannot be filed without it (PY3) */ ssoEmployerAccountNo?: string;
  /** ST1: the rest of the company profile. `fiscalYearStartMonth` is stored but the engine only supports 1 (calendar year) [SP-R]: any other value is refused (company.fiscal_year_unsupported). */
  fiscalYearStartMonth: number; registrationNo?: string; tradeName?: string; email?: string; website?: string; paidUpCapital?: Money;
  /** Images as data URLs (png / jpeg / webp <= 1 MB; the logo may also be svg). Papers do not print them yet (the snapshot at issue is ST3). */ logoDataUrl?: string; stampDataUrl?: string;
  /** The note a blank new document of the type starts with. */ defaultNotes?: Partial<Record<DocType, string>>;
  /** ST1b m3: bumped by every saved settings section; a save carrying an older one is a 409 (absent = 1). */ version?: number }
/** ST1: a person's membership of one company (the mock's users list). `roleId` is a system role (operator / accountant / admin) or a custom role's id. Only a hash of a one-time link is kept. */
export interface StaffMember { id: string; companyId: string; userId?: string; name: string; email: string; roleId: string; position?: string; signatureDataUrl?: string; active: boolean; version: number;
  lastLoginAt?: string; invitePending: boolean; linkHash?: string }
export type CompanySettings = Company & { fiscalYearLocked: boolean };
export type UserRow = Omit<StaffMember, 'linkHash' | 'userId'> & { roleName: string };
export interface RoleRow { id: string; version: number; active: true; system: boolean; name: string; description?: string; permissions: string[]; inUse: boolean;
  /** Document types whose approval is on in this company (the matrix is judged against them). */ approvalTypes: DocType[];
  /** Separation of duties: types with approval on that this role can both create and approve. A warning only: self-approval is a company setting (D-36). */ sodTypes: DocType[] }
export interface Actor { kind: 'user' | 'agent'; id: string; name: string; ownerName?: string }
export interface ApiProblem { type?: string; title: string; status: number; code: string; detail?: string;
  traceId?: string; fieldErrors?: Record<string, string[]> }
export interface AuditEntry { id: string; at: string; actor: Actor; companyId: string; command: string; target?: string;
  before?: unknown; after?: unknown; result: 'ok' | 'rejected'; /** SP3 D10: the Idempotency-Key of the command (absent = none sent). */ idempotencyKey?: string;
  /** RP3: where the call came from; optional because an entry written before they existed has none. */ ip?: string; traceId?: string; client?: 'web' | 'mcp' | 'api' }
export type SessionState = 'active' | 'expiring' | 'expired' | 'out';
export type LoginResult = { status: 'ok' } | { status: 'totp_required'; challenge: string };
export interface ProfileView { userId: string; email: string; displayName: string; totpEnabled: boolean; recoveryRemaining: number }
export interface SessionRow { id: string; device: string; ip: string; createdAt: string; lastSeenAt: string; current: boolean }
export type KeyKind = 'rest' | 'mcp';
export type KeyStatus = 'active' | 'revoked' | 'expired';
export interface ApiKeyRow { id: string; version: number; name: string; kind: KeyKind; /** display prefix of the secret */ prefix: string; ownerName: string; scopes: string[]; scopeCount: number;
  createdAt: string; lastUsedAt?: string; expiresAt?: IsoDate; revokedAt?: string; status: KeyStatus }
export interface ApiKeysView { items: ApiKeyRow[]; /** what the signed-in owner may grant a key on this company */ scopeChoices?: string[] }
export interface ApiKeyCreated { key: ApiKeyRow; /** shown once */ secret: string }
export interface ApiKeyBody { name: string; kind: KeyKind; scopes: string[]; expiresAt?: IsoDate }

// ---- 5.1 deltas from the mock (P0 makes the mock conform) ----
export interface Membership { companyId: string; companyName: string; roleId: string; roleName: string } // was role: Role
export interface Me { userId: string; displayName: string; memberships: Membership[];
  activeCompanyId: string | null;            // null = no membership yet (bootstrap admin) -> /onboarding
  vatRegistered: boolean; permissions: string[]; businessDate: IsoDate }
export interface LinkInfo { kind: 'invite' | 'reset'; email: string; companyName?: string; expiresAt: string }
export interface SetPasswordBody { password: string; confirm: string }
export interface WhoAmI { actor: Actor; companyId: string; companyName: string; rights: string[] }
export type CompanySection = 'identity' | 'contact' | 'payroll' | 'fiscal' | 'images' | 'notes';
export interface CompanyIdentityBody { version: number; confirm: true; legalNameTh: string; legalNameEn?: string; taxId: string;
  branchCode: string; registrationNo?: string; address: string; paidUpCapital?: Money }
export interface CompanyContactBody { version: number; tradeName?: string; phone?: string; email?: string; website?: string }
export interface CompanyPayrollBody { version: number; ssoEmployerAccountNo?: string }
export interface CompanyFiscalBody { version: number; fiscalYearStartMonth: number }
export interface CompanyImagesBody { version: number; logoDataUrl?: string | null; stampDataUrl?: string | null } // absent = keep, '' / null = remove
export interface CompanyNotesBody { version: number; defaultNotes: Partial<Record<DocType, string>> }
export interface InviteBody { name: string; email: string; roleId: string; position?: string }
export interface UpdateMemberBody { version: number; name?: string; roleId?: string; position?: string; signatureDataUrl?: string | null }
export interface RoleBody { name: string; description?: string; permissions: string[] }
export interface UpdateRoleBody extends Partial<RoleBody> { version: number }

// ---- permission catalog and system role templates (SP3 4.5): the code is authoritative; labels stay in messages/th.json + en.json ----
export const PERMISSION_CODES: readonly string[] = [
  'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.QT.cancel', 'doc.QT.correct', 'doc.QT.approve', 'doc.SO.read',
  'doc.SO.create', 'doc.SO.issue', 'doc.SO.cancel', 'doc.SO.correct', 'doc.SO.approve', 'doc.DO.read',
  'doc.DO.create', 'doc.DO.issue', 'doc.DO.cancel', 'doc.DO.correct', 'doc.DO.approve', 'doc.BL.read',
  'doc.BL.create', 'doc.BL.issue', 'doc.BL.cancel', 'doc.BL.correct', 'doc.BL.approve', 'doc.IV.read',
  'doc.IV.create', 'doc.IV.issue', 'doc.IV.cancel', 'doc.IV.correct', 'doc.IV.approve', 'doc.TI.read',
  'doc.TI.create', 'doc.TI.issue', 'doc.TI.cancel', 'doc.TI.correct', 'doc.TI.approve', 'doc.RC.read',
  'doc.RC.create', 'doc.RC.issue', 'doc.RC.cancel', 'doc.RC.correct', 'doc.RC.approve', 'doc.CN.read',
  'doc.CN.create', 'doc.CN.issue', 'doc.CN.cancel', 'doc.CN.correct', 'doc.CN.approve', 'doc.DN.read',
  'doc.DN.create', 'doc.DN.issue', 'doc.DN.cancel', 'doc.DN.correct', 'doc.DN.approve', 'doc.PO.read',
  'doc.PO.create', 'doc.PO.issue', 'doc.PO.cancel', 'doc.PO.correct', 'doc.PO.approve', 'doc.PB.read',
  'doc.PB.create', 'doc.PB.issue', 'doc.PB.cancel', 'doc.PB.correct', 'doc.PB.approve', 'doc.PCN.read',
  'doc.PCN.create', 'doc.PCN.issue', 'doc.PCN.cancel', 'doc.PCN.correct', 'doc.PCN.approve', 'doc.PDN.read',
  'doc.PDN.create', 'doc.PDN.issue', 'doc.PDN.cancel', 'doc.PDN.correct', 'doc.PDN.approve', 'doc.PV.read',
  'doc.PV.create', 'doc.PV.issue', 'doc.PV.cancel', 'doc.PV.correct', 'doc.PV.approve', 'doc.WT.read', 'doc.EX.read',
  'doc.EX.create', 'doc.EX.issue', 'doc.EX.cancel', 'doc.EX.correct', 'doc.EX.approve', 'doc.JV.read',
  'doc.JV.create', 'doc.JV.issue', 'doc.JV.cancel', 'doc.JV.correct', 'doc.JV.approve', 'doc.FA.read',
  'doc.FA.create', 'doc.FA.issue', 'doc.FA.cancel', 'doc.FA.correct', 'doc.DP.read', 'doc.DP.create', 'doc.DP.issue',
  'doc.DP.cancel', 'doc.DP.correct', 'doc.PR.read', 'doc.PR.create', 'doc.PR.issue', 'doc.PR.cancel',
  'doc.PR.correct', 'doc.PR.pay', 'doc.OB.read', 'doc.OB.create', 'doc.OB.issue', 'doc.OB.cancel', 'doc.OB.correct',
  'party.read', 'party.manage', 'item.read', 'item.manage', 'bank.read', 'bank.manage', 'bank.reconcile',
  'ledger.read', 'ledger.coa.manage', 'ledger.posting.manage', 'ledger.schedule.manage', 'ledger.period.close',
  'ledger.period.reopen', 'payroll.read', 'employee.read', 'employee.manage', 'audit.read', 'settings.manage',
  'users.manage', 'report.read', 'report.arap.read', 'tax.read', 'tax.filing.preview', 'tax.filing.finalize',
  'tax.settings.manage', 'connect.manage',
];
export const SYSTEM_ROLES: Record<'operator' | 'accountant' | 'admin', readonly string[]> = {
  operator: [
    'doc.TI.read', 'doc.TI.create', 'doc.TI.issue', 'doc.IV.read', 'doc.IV.create', 'doc.IV.issue', 'doc.BL.read',
    'doc.BL.create', 'doc.BL.issue', 'doc.PO.read', 'doc.PO.create', 'doc.PO.issue', 'doc.PB.read', 'doc.PB.create',
    'doc.PB.issue', 'doc.PV.read', 'doc.PV.create', 'doc.PV.issue', 'doc.WT.read', 'doc.EX.read', 'doc.EX.create',
    'doc.EX.issue', 'doc.PCN.read', 'doc.PDN.read', 'doc.SO.read', 'doc.DO.read', 'doc.CN.read', 'doc.DN.read',
    'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.SO.create',
    'doc.SO.issue', 'doc.DO.create', 'doc.DO.issue', 'party.read', 'party.manage', 'item.read', 'bank.read',
  ],
  accountant: [
    'doc.TI.read', 'doc.TI.create', 'doc.TI.issue', 'doc.IV.read', 'doc.IV.create', 'doc.IV.issue', 'doc.BL.read',
    'doc.BL.create', 'doc.BL.issue', 'doc.PO.read', 'doc.PO.create', 'doc.PO.issue', 'doc.PB.read', 'doc.PB.create',
    'doc.PB.issue', 'doc.PB.cancel', 'doc.PB.correct', 'doc.PCN.read', 'doc.PCN.create', 'doc.PCN.issue',
    'doc.PCN.cancel', 'doc.PCN.correct', 'doc.PDN.read', 'doc.PDN.create', 'doc.PDN.issue', 'doc.PDN.cancel',
    'doc.PDN.correct', 'doc.PV.read', 'doc.PV.create', 'doc.PV.issue', 'doc.WT.read', 'doc.PV.cancel',
    'doc.PV.correct', 'doc.PV.approve', 'doc.EX.read', 'doc.EX.create', 'doc.EX.issue', 'doc.EX.cancel',
    'doc.EX.correct', 'doc.EX.approve', 'doc.JV.read', 'doc.JV.create', 'doc.JV.issue', 'doc.JV.cancel',
    'doc.JV.correct', 'doc.JV.approve', 'doc.OB.read', 'doc.OB.create', 'doc.OB.issue', 'doc.OB.cancel',
    'doc.OB.correct', 'doc.FA.read', 'doc.FA.create', 'doc.FA.issue', 'doc.FA.cancel', 'doc.FA.correct',
    'doc.DP.read', 'doc.DP.create', 'doc.DP.issue', 'doc.DP.cancel', 'doc.DP.correct', 'doc.PR.read',
    'doc.PR.create', 'doc.PR.issue', 'doc.PR.cancel', 'doc.PR.correct', 'doc.PR.pay', 'employee.read',
    'employee.manage', 'payroll.read', 'doc.PO.cancel', 'doc.PO.correct', 'doc.IV.cancel', 'doc.IV.correct',
    'doc.BL.cancel', 'doc.BL.correct', 'doc.SO.read', 'doc.DO.read', 'doc.CN.read', 'doc.DN.read', 'doc.TI.cancel',
    'doc.TI.correct', 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.RC.cancel', 'doc.RC.correct',
    'doc.CN.create', 'doc.CN.issue', 'doc.CN.cancel', 'doc.CN.correct', 'doc.DN.create', 'doc.DN.issue',
    'doc.DN.cancel', 'doc.DN.correct', 'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.QT.cancel',
    'doc.QT.correct', 'doc.SO.create', 'doc.SO.issue', 'doc.SO.cancel', 'doc.SO.correct', 'doc.DO.create',
    'doc.DO.issue', 'doc.DO.cancel', 'doc.DO.correct', 'party.read', 'party.manage', 'item.read', 'item.manage',
    'ledger.read', 'ledger.coa.manage', 'ledger.posting.manage', 'ledger.schedule.manage', 'ledger.period.close',
    'ledger.period.reopen', 'audit.read', 'report.read', 'report.arap.read', 'bank.read', 'bank.manage',
    'bank.reconcile', 'tax.read', 'tax.filing.preview', 'tax.filing.finalize', 'tax.settings.manage',
  ],
  admin: [
    'settings.manage', 'connect.manage', 'tax.settings.manage', 'users.manage', 'employee.read', 'party.read',
    'item.read', 'item.manage', 'audit.read', 'report.read', 'report.arap.read', 'bank.read', 'bank.manage',
  ],
};
/** SP0 8.5 widened (ADR-0005, Q9): no key, app or agent ever holds these, whatever its owner holds. */
const NEVER_FOR_AGENT: readonly string[] = ['settings.manage', 'users.manage', 'connect.manage', 'ledger.period.close', 'ledger.period.reopen', 'tax.filing.finalize', 'tax.settings.manage', 'ledger.posting.manage', 'ledger.coa.manage', 'ledger.schedule.manage'];
export const agentForbidden = (code: string): boolean => NEVER_FOR_AGENT.includes(code) || /^doc\.[A-Z]+\.(approve|cancel|correct)$/.test(code);

// ---- 5.2 error codes: code -> HTTP status (a pair = the status differs by route: 401 on use, 409 on rotate) ----
export const ERROR_CODES = {
  'auth.invalid_credentials': 401, 'auth.locked': 429, 'auth.challenge_invalid': 401, 'auth.totp_invalid': 401, 'auth.session_expired': 401, 'auth.unauthenticated': 401,
  'auth.not_expired': 409, 'auth.current_password_invalid': 422, 'auth.password_mismatch': 422, 'auth.password_weak': 422, 'auth.password_reuse': 422, 'auth.enrol_not_started': 409,
  'auth.session_not_found': 404, 'auth.link_invalid': 404, 'auth.forbidden': 403, 'company.not_found': 404, 'company.section_unknown': 404, 'company.confirm_required': 422,
  'company.vat_readonly': 422, 'company.fiscal_year_unsupported': 422, 'company.fiscal_year_locked': 409, 'record.invalid': 422, 'record.not_found': 404, 'record.version_conflict': 409,
  'user.last_admin': 409, 'user.inactive': 409, 'role.system_readonly': 409, 'role.in_use': 409, 'connect.not_member': 403, 'connect.scope_forbidden': 422, 'connect.scope_exceeds': 422,
  'connect.key_revoked': [401, 409], 'connect.key_expired': [401, 409], 'connect.key_invalid': 401, 'connect.owner_inactive': 409, 'connect.key_kind_mismatch': 403,
  'agent.forbidden_action': 403, 'agent.forbidden_setting': 403, 'idempotency.key_required': 400, 'idempotency.key_reused': 422, 'http.rate_limited': 429, 'storage.full': 507, 'http.500': 500,
} as const satisfies Record<string, number | readonly number[]>;
export type ErrorCode = keyof typeof ERROR_CODES;

// ---- 5.3 routes: rows 1-34 of the spec table, in order (row 35, /health and /version, is not under /bff and is not a contract row) ----
const none = { idempotency: 'none', concurrency: 'none' } as const;
const body = { idempotency: 'none', concurrency: 'version-body' } as const;
export const ROUTES: RouteSpec[] = [
  { method: 'POST', path: '/auth/login', auth: 'public', agent: false, ...none, request: '{email,password}', response: 'LoginResult', errors: ['auth.invalid_credentials', 'auth.locked'], audit: 'auth.login' },
  { method: 'POST', path: '/auth/totp', auth: 'public', agent: false, ...none, request: '{challenge, code | recoveryCode}', response: "{status:'ok'}", errors: ['auth.challenge_invalid', 'auth.totp_invalid', 'auth.locked'], audit: 'auth.login' },
  { method: 'GET', path: '/auth/session', auth: 'public', agent: false, ...none, response: '{state, email?, expiresInSec?}', errors: [] },
  { method: 'POST', path: '/auth/session/extend', auth: 'session', agent: false, ...none, response: "{state:'active'}", errors: ['auth.session_expired', 'auth.unauthenticated'] },
  { method: 'POST', path: '/auth/logout', auth: 'public', agent: false, ...none, response: "{state:'out'}", errors: [], audit: 'auth.logout' },
  { method: 'POST', path: '/auth/relogin', auth: 'session-or-expired', rule: 'expired only', agent: false, ...none, request: '{password, code?, recoveryCode?}', response: "{status:'ok'|'totp_required'}", errors: ['auth.unauthenticated', 'auth.not_expired', 'auth.invalid_credentials', 'auth.totp_invalid', 'auth.locked'], audit: 'auth.login' },
  { method: 'GET', path: '/auth/profile', auth: 'session', agent: false, ...none, response: 'ProfileView', errors: [] },
  { method: 'POST', path: '/auth/password', auth: 'session', agent: false, ...none, request: '{current,next,confirm}', response: "{status:'ok'}", errors: ['auth.current_password_invalid', 'auth.password_mismatch', 'auth.password_weak', 'auth.password_reuse', 'auth.locked'], audit: 'auth.password.change' },
  { method: 'POST', path: '/auth/totp/enrol', auth: 'session', agent: false, ...none, response: '{secret, uri}', errors: [], audit: 'auth.totp.enrol_start' },
  { method: 'POST', path: '/auth/totp/enrol/verify', auth: 'session', agent: false, ...none, request: '{code}', response: '{recoveryCodes}', errors: ['auth.enrol_not_started', 'auth.totp_invalid'], audit: 'auth.totp.enable' },
  { method: 'GET', path: '/auth/sessions', auth: 'session', agent: false, ...none, response: '{items: SessionRow[]}', errors: [] },
  { method: 'POST', path: '/auth/sessions/{id}/revoke', auth: 'session', rule: 'own sessions', agent: false, ...none, response: '{signedOut}', errors: ['auth.session_not_found'], audit: 'auth.session.revoke' },
  { method: 'GET', path: '/auth/links/{token}', auth: 'public', agent: false, ...none, response: 'LinkInfo', errors: ['auth.link_invalid'] },
  { method: 'POST', path: '/auth/links/{token}', auth: 'public', agent: false, ...none, request: 'SetPasswordBody', response: "{status:'ok'}", errors: ['auth.link_invalid', 'auth.password_mismatch', 'auth.password_weak'], audit: 'user.accept_invite | auth.password.reset' },
  { method: 'GET', path: '/me', auth: 'session', agent: false, ...none, response: 'Me', errors: [] },
  { method: 'POST', path: '/me/active-company', auth: 'session', rule: 'member of target', agent: false, ...none, request: '{companyId}', response: 'Me', errors: ['company.not_found'], audit: 'company.switch' },
  { method: 'GET', path: '/settings/companies/{id}', auth: 'session', permission: 'settings.manage', agent: false, ...none, response: 'CompanySettings', errors: ['company.not_found'] },
  { method: 'PUT', path: '/settings/companies/{id}/{section}', auth: 'session', permission: 'settings.manage', agent: false, ...body, request: 'Company<Section>Body', response: 'CompanySettings',
    errors: ['company.not_found', 'company.section_unknown', 'company.confirm_required', 'company.vat_readonly', 'company.fiscal_year_unsupported', 'company.fiscal_year_locked', 'record.invalid', 'record.version_conflict'], audit: 'company.update.<section>' },
  { method: 'GET', path: '/settings/default-notes', auth: 'session', rule: 'any member', agent: true, ...none, response: 'Partial<Record<DocType,string>>', errors: [] },
  { method: 'GET', path: '/settings/users', auth: 'session', permission: 'users.manage', agent: false, ...none, response: '{items: UserRow[]}', errors: [] },
  { method: 'POST', path: '/settings/users', auth: 'session', permission: 'users.manage', agent: false, ...none, request: 'InviteBody', response: 'UserRow & {link} (201; the only response with the link)', errors: ['record.invalid'], audit: 'user.invite' },
  { method: 'PUT', path: '/settings/users/{id}', auth: 'session', permission: 'users.manage', agent: false, ...body, request: 'UpdateMemberBody', response: 'UserRow', errors: ['record.not_found', 'user.last_admin', 'record.invalid', 'record.version_conflict'], audit: 'user.update' },
  { method: 'POST', path: '/settings/users/{id}/active', auth: 'session', permission: 'users.manage', agent: false, ...body, request: '{active, version}', response: 'UserRow', errors: ['record.not_found', 'user.last_admin', 'record.version_conflict'], audit: 'user.activate | user.deactivate' },
  { method: 'POST', path: '/settings/users/{id}/reset-link', auth: 'session', permission: 'users.manage', agent: false, ...none, response: '{link}', errors: ['record.not_found', 'user.inactive'], audit: 'user.reset_link' },
  { method: 'POST', path: '/settings/users/{id}/totp-reset', auth: 'session', permission: 'users.manage', rule: 'not self', agent: false, ...body, request: '{version}', response: 'UserRow', errors: ['record.not_found', 'record.version_conflict'], audit: 'user.totp_reset' },
  { method: 'GET', path: '/settings/roles', auth: 'session', permission: 'users.manage', agent: false, ...none, response: '{items: RoleRow[]}', errors: [] },
  { method: 'POST', path: '/settings/roles', auth: 'session', permission: 'users.manage', agent: false, ...none, request: 'RoleBody', response: 'RoleRow (201)', errors: ['record.invalid'], audit: 'role.create' },
  { method: 'PUT', path: '/settings/roles/{id}', auth: 'session', permission: 'users.manage', agent: false, ...body, request: 'UpdateRoleBody', response: 'RoleRow', errors: ['role.system_readonly', 'record.not_found', 'user.last_admin', 'record.invalid', 'record.version_conflict'], audit: 'role.update' },
  { method: 'DELETE', path: '/settings/roles/{id}', auth: 'session', permission: 'users.manage', agent: false, idempotency: 'none', concurrency: 'version-query', response: '{ok:true}', errors: ['role.system_readonly', 'role.in_use', 'record.not_found', 'record.version_conflict'], audit: 'role.delete' },
  { method: 'GET', path: '/connect/keys', auth: 'session', rule: 'member (own); connect.manage (all)', agent: false, ...none, response: 'ApiKeysView', errors: [] },
  { method: 'POST', path: '/connect/keys', auth: 'session', rule: 'active member', agent: false, ...none, request: 'ApiKeyBody', response: 'ApiKeyCreated (201)', errors: ['connect.not_member', 'record.invalid', 'connect.scope_forbidden', 'connect.scope_exceeds'], audit: 'connect.key.create' },
  { method: 'POST', path: '/connect/keys/{id}/rotate', auth: 'session', rule: "the key's owner only", agent: false, ...body, request: '{version}', response: 'ApiKeyCreated (201)', errors: ['record.not_found', 'record.version_conflict', 'connect.key_revoked', 'connect.key_expired', 'connect.owner_inactive'], audit: 'connect.key.rotate + connect.key.revoke' },
  { method: 'POST', path: '/connect/keys/{id}/revoke', auth: 'session', rule: 'owner, or connect.manage', agent: false, ...body, request: '{version}', response: 'ApiKeyRow (already revoked: no write, no audit)', errors: ['record.not_found', 'record.version_conflict'], audit: 'connect.key.revoke' },
  { method: 'GET', path: '/api/v1/whoami', auth: 'key', agent: true, ...none, response: 'WhoAmI', errors: ['connect.key_invalid', 'connect.key_revoked', 'connect.key_expired', 'connect.key_kind_mismatch'] }, // machine route (MCP tool `whoami`): not under /bff, no mock handler
];
