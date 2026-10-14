import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '@/mocks/settings';
import { resetState } from '@/mocks/store';
import { testServer } from '@/mocks/test-server';
import { ApiError } from './client';
import { endpoints } from './endpoints';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

describe('api + endpoints against the mock backend', () => {
  it('reads /me and lists docs', async () => {
    const me = await endpoints.getMe();
    expect(me.activeCompanyId).toBe('co-vat');
    expect((await endpoints.listDocs('TI', { limit: 2 })).items.length).toBeGreaterThan(0);
  });
  it('maps a problem+json failure to ApiError', async () => {
    const err = await endpoints.getDoc('TI', 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('doc.not_found');
  });
});
