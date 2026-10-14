import { beforeEach, describe, expect, it } from 'vitest';
import { applyUrlSettings, getSettings } from './settings';

beforeEach(() => localStorage.clear());
it('applies state, role and company from the query and ignores unknown values', () => {
  applyUrlSettings('?state=empty&role=admin&company=nonvat');
  expect(getSettings()).toMatchObject({ screenState: 'empty', role: 'admin', companyKey: 'nonvat' });
  applyUrlSettings('?state=bogus&role=root');
  expect(getSettings()).toMatchObject({ screenState: 'empty', role: 'admin' });
});

describe('stored mock settings are validated on read', () => {
  it('a stale / hand-edited value falls back to its default, valid fields survive', () => {
    localStorage.setItem('teas2.mock.settings.v1', JSON.stringify({ role: 'superuser', companyKey: 'zzz', screenState: 'bogus' }));
    expect(getSettings()).toEqual({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
    localStorage.setItem('teas2.mock.settings.v1', JSON.stringify({ role: 'admin', companyKey: 'nonvat', screenState: 'bogus' }));
    expect(getSettings()).toEqual({ companyKey: 'nonvat', role: 'admin', screenState: 'normal' });
  });
});
