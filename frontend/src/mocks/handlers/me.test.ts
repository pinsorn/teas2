import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setSettings } from '../settings';
import { resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const me = () => fetch('http://localhost/bff/v1/me');

describe('GET /me under the toolbar screen state', () => {
  it('"forbidden" is about the screen content, not the session: the shell still gets the user', async () => {
    setSettings({ screenState: 'forbidden' });
    expect((await me()).status).toBe(200);
  });
  it('"error" still fails /me (the shell error path stays reachable)', async () => {
    setSettings({ screenState: 'error' });
    expect((await me()).status).toBe(500);
  });
});
