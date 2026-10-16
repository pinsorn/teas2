import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
const claim = { header: { partyId: 'emp-02', documentDate: '2026-10-14' }, lines: [{ id: 'l1', description: 'ค่าแท็กซี่', qty: '1', unit: 'เที่ยว', unitPrice: '180.00', taxCode: 'EX', expenseCategory: 'transport' }] };
const make = async () => (await (await call('POST', '/docs/EX', claim)).json()) as { id: string; version: number };
const stored = (id: string) => loadState().docs.find((d) => d.id === id)!;

describe('approval over the wire (§7.6): each way through the gate needs its own right, the server decides', () => {
  it('issue is refused for everyone while the claim is unapproved (422 approval.required), whoever asks', async () => {
    const d = await make();
    for (const role of ['operator', 'accountant'] as const) {
      setSettings({ role });
      const r = await call('POST', `/docs/EX/${d.id}/issue`, { version: d.version });
      expect([r.status, (await r.json()).code]).toEqual([422, 'approval.required']);
    }
    expect(stored(d.id)).toMatchObject({ status: 'draft' });
  });
  it('the operator submits but cannot approve, approve-and-issue or send back (403); the accountant can', async () => {
    const d = await make();
    const sub = await call('POST', `/docs/EX/${d.id}/submit`, { version: d.version });
    expect(sub.status).toBe(200);
    const v = (await sub.json()).version as number;
    for (const p of ['approve', 'approve-and-issue']) expect((await call('POST', `/docs/EX/${d.id}/${p}`, { version: v })).status).toBe(403);
    expect((await call('POST', `/docs/EX/${d.id}/send-back`, { version: v, reason: 'x' })).status).toBe(403);
    setSettings({ role: 'accountant' });
    expect((await call('POST', `/docs/EX/${d.id}/send-back`, { version: v, reason: '  ' })).status).toBe(422); // a reason is required
    expect((await call('POST', `/docs/EX/${d.id}/approve`, { version: v })).status).toBe(200);
  });
  it('approve-and-issue needs BOTH rights: an approver without issue is refused (403) and nothing changes', async () => {
    const d = await make();
    setSettings({ role: 'accountant' });
    const saved = PERMISSIONS_BY_ROLE.accountant;
    PERMISSIONS_BY_ROLE.accountant = saved.filter((p) => p !== 'doc.EX.issue');
    try {
      const r = await call('POST', `/docs/EX/${d.id}/approve-and-issue`, { version: d.version });
      expect(r.status).toBe(403);
      expect((await r.json()).detail).toContain('doc.EX.issue');
    } finally { PERMISSIONS_BY_ROLE.accountant = saved; }
    expect(stored(d.id)).toMatchObject({ status: 'draft' });
    expect(stored(d.id).number).toBeUndefined();
    const ok = await call('POST', `/docs/EX/${d.id}/approve-and-issue`, { version: d.version });
    expect([ok.status, (await ok.json()).status]).toEqual([200, 'issued']);
  });
  it('a stale version is a 409 and a draft read says the policy wants approval', async () => {
    const d = await make();
    expect((await (await call('GET', `/docs/EX/${d.id}`)).json()).approvalRequired).toBe(true);
    const r = await call('POST', `/docs/EX/${d.id}/submit`, { version: d.version + 5 });
    expect([r.status, (await r.json()).code]).toEqual([409, 'doc.version_conflict']);
  });
  it('the non-VAT company has no policy: submit says so (422 approval.not_required) and issue goes straight through', async () => {
    setSettings({ companyKey: 'nonvat' });
    const d = await (await call('POST', '/docs/EX', { ...claim, header: { partyId: 'nemp-01', documentDate: '2026-10-14' } })).json() as { id: string; version: number };
    expect((await (await call('GET', `/docs/EX/${d.id}`)).json()).approvalRequired).toBeUndefined();
    const sub = await call('POST', `/docs/EX/${d.id}/submit`, { version: d.version });
    expect([sub.status, (await sub.json()).code]).toEqual([422, 'approval.not_required']);
    const ok = await call('POST', `/docs/EX/${d.id}/issue`, { version: d.version });
    expect([ok.status, (await ok.json()).status]).toEqual([200, 'issued']);
  });
});
