import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_PREDICATES } from '../fixtures/ids';
import { setSettings } from '../settings';
import { resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

describe('GET /bff/v1/mock/fixtures', () => {
  it('returns every named key, even while the toolbar screen state is "error" (no screenGate)', async () => {
    setSettings({ screenState: 'error' });
    const r = await fetch('http://localhost/bff/v1/mock/fixtures');
    expect(r.status).toBe(200);
    const ids = await r.json() as Record<string, string>;
    expect(Object.keys(ids).sort()).toEqual(Object.keys(FIXTURE_PREDICATES).sort());
    expect(ids.tiLong).toBe('spike-60');
  });
});
