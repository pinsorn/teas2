import { beforeEach, expect, it } from 'vitest';
import { applyUrlSettings, getSettings } from './settings';

beforeEach(() => localStorage.clear());
it('applies state, role and company from the query and ignores unknown values', () => {
  applyUrlSettings('?state=empty&role=admin&company=nonvat');
  expect(getSettings()).toMatchObject({ screenState: 'empty', role: 'admin', companyKey: 'nonvat' });
  applyUrlSettings('?state=bogus&role=root');
  expect(getSettings()).toMatchObject({ screenState: 'empty', role: 'admin' });
});
