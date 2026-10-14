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
