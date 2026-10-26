import type { Role } from '@/domain/types';

export type ScreenState = 'normal' | 'empty' | 'loading' | 'error' | 'forbidden' | 'locked';
/** HC3: the browser's session as the toolbar simulates it: signed in, about to expire (2 minutes), expired (re-login dialog) or signed out. `companyKey` 'new' = the company the onboarding wizard made (co-new). */
export type SessionState = 'active' | 'expiring' | 'expired' | 'out';
export interface MockSettings { companyKey: 'vat' | 'nonvat' | 'new'; role: Role; screenState: ScreenState }
const KEY = 'teas2.mock.settings.v1';
const DEFAULTS: MockSettings = { companyKey: 'vat', role: 'accountant', screenState: 'normal' };

export function setSettings(p: Partial<MockSettings>): MockSettings {
  const next = { ...getSettings(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: settings stay default */ }
  return next;
}

const STATES: ScreenState[] = ['normal', 'empty', 'loading', 'error', 'forbidden', 'locked'];
const ROLES: Role[] = ['operator', 'accountant', 'admin'];
const SESSIONS: SessionState[] = ['active', 'expiring', 'expired', 'out'];
const SESSION_KEY = 'teas2.mock.session.v1';
/** HC3: the simulated session lives under its own key (it is not a screen setting: a reset of the sample data leaves it alone). */
export function getSession(): SessionState {
  try { const v = localStorage.getItem(SESSION_KEY); return SESSIONS.includes(v as SessionState) ? (v as SessionState) : 'active'; } catch { return 'active'; }
}
export function setSession(s: SessionState): void {
  try { localStorage.setItem(SESSION_KEY, s); } catch { /* private mode: stays signed in */ }
}
/** Stored values are untrusted (stale / hand-edited localStorage): anything unknown falls back to its default. */
export function getSettings(): MockSettings {
  let raw: Partial<Record<keyof MockSettings, unknown>> = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* defaults */ }
  const pick = <T extends string>(v: unknown, ok: readonly T[], dflt: T): T => (ok.includes(v as T) ? (v as T) : dflt);
  return {
    companyKey: pick(raw.companyKey, ['vat', 'nonvat', 'new'], DEFAULTS.companyKey),
    role: pick(raw.role, ROLES, DEFAULTS.role),
    screenState: pick(raw.screenState, STATES, DEFAULTS.screenState),
  };
}

/** The screen index links set the toolbar through `?state=&role=&company=`; unknown values are ignored. */
export function applyUrlSettings(search: string) {
  const q = new URLSearchParams(search);
  const state = q.get('state') as ScreenState, role = q.get('role') as Role, company = q.get('company') as MockSettings['companyKey'], session = q.get('session') as SessionState;
  const p: Partial<MockSettings> = {};
  if (STATES.includes(state)) p.screenState = state;
  if (ROLES.includes(role)) p.role = role;
  if (company === 'vat' || company === 'nonvat') p.companyKey = company;
  if (SESSIONS.includes(session)) setSession(session);
  if (Object.keys(p).length) setSettings(p);
}
