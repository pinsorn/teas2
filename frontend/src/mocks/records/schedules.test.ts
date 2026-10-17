import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RecordRow } from '@/domain/records';
import { checkInvariants } from '../engine/invariants';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

type Json = Record<string, unknown> & Partial<RecordRow> & { code?: string; title?: string; fieldErrors?: Record<string, string[]>; items?: RecordRow[]; runs?: { month?: string; resultDocId?: string }[] };
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Json };
};
const get = async (id: string) => (await call('GET', `/records/schedule/${id}`)).json;
const AMORT = { kind: 'amortisation', docId: 'pb-ins', lineId: 'pb-ins-l1', name: 'ประกันภัยทดสอบ', total: '6000.00', months: 6, startMonth: '2026-10', expenseAccount: '5120' };

describe('the schedule record kit (AC4)', () => {
  it('lists the company\'s schedules with the figures the screens read; the other company\'s are separate', async () => {
    const { json } = await call('GET', '/records/schedule?active=all');
    expect(json.items!.map((r) => r.id).sort()).toEqual(['sch-amort', 'sch-rec-jv', 'sch-rec-ti']);
    const a = json.items!.find((r) => r.id === 'sch-amort')!;
    expect(a).toMatchObject({ name: 'เบี้ยประกันอัคคีภัยอาคาร', kind: 'amortisation', total: '12000.00', runsDone: 3, remaining: '9000.00', nextRun: '2026-10-31', active: true, version: 4, sourceNumber: expect.stringMatching(/^PB-/) });
    setSettings({ companyKey: 'nonvat', role: 'accountant', screenState: 'normal' });
    expect((await call('GET', '/records/schedule?active=all')).json.items!.map((r) => r.id)).toEqual(['nsch-rec-iv']);
    expect((await call('GET', '/records/schedule/sch-amort')).json.code).toBe('record.not_found');
  });

  it('permissions: read needs ledger.read, create / edit / stop / run need ledger.schedule.manage (the operator is forbidden)', async () => {
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    expect((await call('GET', '/records/schedule')).status).toBe(403);
    expect((await call('POST', '/schedules/sch-amort/run', {})).status).toBe(403);
    setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' });
    expect((await call('GET', '/records/schedule')).status).toBe(403); // ledger.read is the accountant's
  });

  it('create validates the shape (field errors) and the engine refuses the rules with their own codes; nothing is written by a refusal', async () => {
    const bad = await call('POST', '/records/schedule', { kind: 'amortisation', docId: 'pb-ins', name: ' ', total: 'abc', months: 0, startMonth: 'x' });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.json.fieldErrors!).sort()).toEqual(['expenseAccount', 'lineId', 'months', 'name', 'startMonth', 'total']);
    expect((await call('POST', '/records/schedule', AMORT)).json.code).toBe('schedule.source_taken'); // pb-ins-l1 already has sch-amort
    expect((await call('POST', '/records/schedule', { ...AMORT, lineId: 'nope' })).json.code).toBe('schedule.source_invalid');
    expect((await call('POST', '/records/schedule', { kind: 'recurring', docId: 'pb-ins', name: 'x', frequency: 'weekly', nextRun: '2026-13-01' })).json.fieldErrors).toMatchObject({ frequency: expect.any(Array), nextRun: expect.any(Array) });
    expect(loadState().schedules.map((s) => s.id).sort()).toEqual(['nsch-rec-iv', 'sch-amort', 'sch-rec-jv', 'sch-rec-ti']);
  });

  it('create from a document is idempotent on its key; the new schedule is audited and the invariants hold', async () => {
    const hdr = { 'content-type': 'application/json', 'Idempotency-Key': 'k-1' };
    const send = () => fetch('http://localhost/bff/v1/records/schedule', { method: 'POST', headers: hdr, body: JSON.stringify({ kind: 'recurring', docId: 'pb-1', name: 'ค่าเช่า', frequency: 'monthly', nextRun: '2026-11-06' }) }).then((r) => r.json() as Promise<Json>);
    const a = await send(), b = await send();
    expect(a.id).toBe(b.id);
    expect(loadState().schedules.filter((s) => s.name === 'ค่าเช่า')).toHaveLength(1);
    expect(loadState().audit.some((x) => x.command === 'record.schedule.create' && x.target === a.id)).toBe(true);
    expect(a.template).toMatchObject({ type: 'PB' });
    expect(checkInvariants(loadState())).toEqual([]);
  });

  it('edit: the name for everyone, recurring also frequency / next run / end; an amortisation stays frozen; a stale version conflicts', async () => {
    const a = await get('sch-amort');
    const renamed = await call('PUT', '/records/schedule/sch-amort', { name: 'ประกันภัย ใหม่', total: '1.00', months: 1, version: a.version });
    expect(renamed.json).toMatchObject({ name: 'ประกันภัย ใหม่', total: '12000.00', months: 12 }); // the figures did not move
    expect((await call('PUT', '/records/schedule/sch-amort', { name: 'x', version: a.version })).json.code).toBe('record.version_conflict');
    const r = await get('sch-rec-ti');
    const upd = await call('PUT', '/records/schedule/sch-rec-ti', { name: r.name, frequency: 'quarterly', nextRun: '2026-12-15', endAfter: 3, version: r.version });
    expect(upd.json).toMatchObject({ frequency: 'quarterly', nextRun: '2026-12-15', endAfter: 3, version: r.version! + 1 });
    const cleared = await call('PUT', '/records/schedule/sch-rec-ti', { name: r.name, endAfter: null, version: upd.json.version });
    expect(cleared.json.endAfter).toBeUndefined();
    expect((await call('PUT', '/records/schedule/sch-rec-ti', { name: r.name, nextRun: '2026-02-30', version: cleared.json.version })).status).toBe(422);
  });

  it('"รันตอนนี้": the run endpoint checks the version and refuses in order and says why - October is not over (today is mid October), so nothing is posted ahead', async () => {
    const a = await get('sch-amort');
    expect((await call('POST', '/schedules/sch-amort/run', { version: a.version! + 1 })).json.code).toBe('record.version_conflict');
    expect((await call('POST', '/schedules/sch-amort/run', { month: '2026-09' })).json.code).toBe('schedule.already_run');
    expect((await call('POST', '/schedules/sch-amort/run', { month: '2026-11' })).json.code).toBe('schedule.out_of_order');
    const early = await call('POST', '/schedules/sch-amort/run', { version: a.version });
    expect(early.json.code).toBe('schedule.not_due');
    expect((await get('sch-amort')).version).toBe(a.version); // refused: nothing written
    expect(checkInvariants(loadState())).toEqual([]);
  });

  it('"หยุด": audited, keeps the balance, the runs and the lock stand; run is refused afterwards; the generic deactivate does the same; a stopped amortisation cannot be switched on', async () => {
    const a = await get('sch-amort');
    const stopped = await call('POST', '/schedules/sch-amort/stop', { version: a.version, reason: 'เลิกกรมธรรม์' });
    expect(stopped.json).toMatchObject({ active: false, remaining: '9000.00', stopped: { reason: 'เลิกกรมธรรม์' } });
    expect(loadState().audit.some((x) => x.command === 'schedule.stop' && x.target === 'sch-amort')).toBe(true);
    expect((await call('POST', '/schedules/sch-amort/run', {})).json.code).toBe('schedule.stopped');
    expect((await call('POST', '/records/schedule/sch-amort/active', { active: true, version: stopped.json.version })).json.code).toBe('schedule.stopped_final');
    const r = await get('sch-rec-ti');
    const off = await call('POST', '/records/schedule/sch-rec-ti/active', { active: false, version: r.version });
    expect(off.json).toMatchObject({ active: false });
    expect(loadState().audit.some((x) => x.command === 'record.schedule.deactivate' && x.target === 'sch-rec-ti')).toBe(true);
    expect((await call('POST', '/records/schedule/sch-rec-ti/active', { active: true, version: off.json.version })).json.active).toBe(true); // a recurring one may be resumed
    expect(checkInvariants(loadState())).toEqual([]);
  });

  it('recurring run now: a draft dated nextRun lands in the document list, owned by the person who ran it', async () => {
    const r = await get('sch-rec-ti');
    const ran = await call('POST', '/schedules/sch-rec-ti/run', { version: r.version });
    expect(ran.json).toMatchObject({ nextRun: '2026-12-01', runsDone: 1 });
    const d = (await call('GET', `/docs/TI/${ran.json.runs![0].resultDocId}`)).json as { status?: string; header?: { documentDate: string }; createdBy?: { id: string } };
    expect(d).toMatchObject({ status: 'draft', header: { documentDate: '2026-11-01' }, createdBy: { id: 'u-1' } });
  });

  it('AC7b: PUT with a template body refuses an incomplete template with field errors the editor shows, saves a good one frozen, and hands the editor its party', async () => {
    const r = await get('sch-rec-ti');
    const line = { id: 'tl-new', description: 'ดูแลเว็บไซต์ + โฆษณา', qty: '1', unit: 'เดือน', unitPrice: '9000.00', taxCode: 'S7' };
    const bad = await call('PUT', '/records/schedule/sch-rec-ti', { name: r.name, template: { header: {}, lines: [] }, version: r.version });
    expect(bad.status).toBe(422);
    expect(bad.json.fieldErrors).toMatchObject({ 'header.partyId': [expect.any(String)], lines: [expect.any(String)] });
    expect((await get('sch-rec-ti')).version).toBe(r.version);
    const ok = await call('PUT', '/records/schedule/sch-rec-ti', { name: r.name, template: { header: { partyId: 'pc-04', reference: 'PO-1', documentDate: '1999-01-01' }, lines: [line] }, version: r.version });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ template: { header: { partyId: 'pc-04', reference: 'PO-1' }, lines: [{ id: 'tl-new', unitPrice: '9000.00' }] }, templateHistory: [{ by: { id: 'u-1' } }], templatePartyRef: { id: 'pc-04' } });
    expect((ok.json.template as { header: object }).header).not.toHaveProperty('documentDate');
    expect(checkInvariants(loadState())).toEqual([]);
  });
});
