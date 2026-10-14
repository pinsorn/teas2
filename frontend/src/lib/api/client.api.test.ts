import { HttpResponse, http } from 'msw';
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

describe('2xx with a body that is not JSON', () => {
  it('is an ApiError, never returned as data (a proxy / login page behind the BFF)', async () => {
    testServer.use(http.get('*/bff/v1/me', () => new HttpResponse('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    const err = await endpoints.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('http.invalid_body');
  });
});
