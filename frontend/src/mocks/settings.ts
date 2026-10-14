import type { Role } from '@/domain/types';

export type ScreenState = 'normal' | 'empty' | 'loading' | 'error' | 'forbidden' | 'locked';
export interface MockSettings { companyKey: 'vat' | 'nonvat'; role: Role; screenState: ScreenState }
const KEY = 'teas2.mock.settings.v1';
const DEFAULTS: MockSettings = { companyKey: 'vat', role: 'accountant', screenState: 'normal' };

export function getSettings(): MockSettings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; }
}
export function setSettings(p: Partial<MockSettings>): MockSettings {
  const next = { ...getSettings(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: settings stay default */ }
  return next;
}

const STATES: ScreenState[] = ['normal', 'empty', 'loading', 'error', 'forbidden', 'locked'];
const ROLES: Role[] = ['operator', 'accountant', 'admin'];
/** The screen index links set the toolbar through `?state=&role=&company=`; unknown values are ignored. */
export function applyUrlSettings(search: string) {
  const q = new URLSearchParams(search);
  const state = q.get('state') as ScreenState, role = q.get('role') as Role, company = q.get('company') as MockSettings['companyKey'];
  const p: Partial<MockSettings> = {};
  if (STATES.includes(state)) p.screenState = state;
  if (ROLES.includes(role)) p.role = role;
  if (company === 'vat' || company === 'nonvat') p.companyKey = company;
  if (Object.keys(p).length) setSettings(p);
}
