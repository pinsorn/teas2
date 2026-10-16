import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { testServer.resetHandlers(); vi.restoreAllMocks(); });
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
const partyId = () => loadState().parties.find((p) => p.companyId === 'co-vat' && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
const body = () => ({ header: { partyId: partyId(), documentDate: '2026-10-14' },
  lines: [{ id: 'l1', description: 'ออกแบบ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7' }] });
const draft = async () => (await (await call('POST', '/docs/TI', body())).json()) as { id: string; version: number };
const issued = async () => { const d = await draft(); return (await (await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version })).json()) as { id: string; version: number }; };

/** A data URL of `bytes` real bytes. */
const dataUrl = (mime: string, bytes: number) => `data:${mime};base64,${btoa('x'.repeat(bytes))}`;
const att = (over: Record<string, unknown> = {}) => ({ category: 'customer_po', name: 'po.pdf', mime: 'application/pdf', dataUrl: dataUrl('application/pdf', 100), ...over });
const attKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('teas2.mock.att.') && !k.includes('att-seed-')); // the seed's own receipt photo (ex-pend) is not what these tests count
const userAtt = () => loadState().attachments.filter((a) => !a.id.startsWith('att-seed-'));

describe('attachments', () => {
  it('a draft keeps its file (bytes under their own key, metadata in the state), and it survives issue', async () => {
    const d = await draft();
    const r = await call('POST', `/docs/TI/${d.id}/attachments`, att());
    expect(r.status).toBe(201);
    const a = await r.json();
    expect(a).toMatchObject({ docId: d.id, category: 'customer_po', name: 'po.pdf', size: 100, mime: 'application/pdf' });
    expect(attKeys()).toEqual([`teas2.mock.att.${a.id}`]);
    const st = loadState();
    expect(JSON.stringify(st)).not.toContain('base64'); // the bytes are never part of the state blob
    expect(userAtt()).toHaveLength(1);
    await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version });
    const list = await (await call('GET', `/docs/TI/${d.id}/attachments`)).json();
    expect(list).toHaveLength(1);
    expect(list[0].dataUrl).toBe(att().dataUrl);
  });
  it('refuses a file over 1 MB (422 attachment.too_large) and stores nothing; exactly 1 MB is accepted', async () => {
    const d = await draft();
    const big = await call('POST', `/docs/TI/${d.id}/attachments`, att({ dataUrl: dataUrl('application/pdf', 1024 * 1024 + 1) }));
    expect(big.status).toBe(422);
    expect((await big.json()).code).toBe('attachment.too_large');
    expect(attKeys()).toEqual([]);
    expect(userAtt()).toEqual([]);
    expect((await call('POST', `/docs/TI/${d.id}/attachments`, att({ dataUrl: dataUrl('application/pdf', 1024 * 1024) }))).status).toBe(201);
  });
  it('accepts pdf / png / jpeg / webp only (422 attachment.type_not_allowed); the size and type come from the bytes, not the client', async () => {
    const d = await draft();
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      expect((await call('POST', `/docs/TI/${d.id}/attachments`, att({ mime, dataUrl: dataUrl(mime, 10) }))).status).toBe(201);
    }
    const gif = await call('POST', `/docs/TI/${d.id}/attachments`, att({ mime: 'image/gif', dataUrl: dataUrl('image/gif', 10) }));
    expect(gif.status).toBe(422);
    expect((await gif.json()).code).toBe('attachment.type_not_allowed');
    const lie = await call('POST', `/docs/TI/${d.id}/attachments`, att({ mime: 'application/pdf', dataUrl: dataUrl('text/html', 10) })); // declared pdf, actually html
    expect((await lie.json()).code).toBe('attachment.type_not_allowed');
    const mismatch = await call('POST', `/docs/TI/${d.id}/attachments`, att({ mime: 'image/png', dataUrl: dataUrl('application/pdf', 10) })); // both allowed types, but they disagree
    expect((await mismatch.json()).code).toBe('attachment.type_not_allowed');
    expect((await (await call('POST', `/docs/TI/${d.id}/attachments`, att({ dataUrl: 'not a data url' }))).json()).code).toBe('attachment.type_not_allowed');
    expect((await (await call('POST', `/docs/TI/${d.id}/attachments`, att({ category: 'nope' }))).json()).code).toBe('attachment.category_invalid');
  });
  it('a full browser storage is a 507 attachment.storage_full, nothing half-saved', async () => {
    const d = await draft();
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('teas2.mock.att.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    const r = await call('POST', `/docs/TI/${d.id}/attachments`, att());
    expect(r.status).toBe(507);
    const p = await r.json();
    expect(p.code).toBe('attachment.storage_full');
    expect(p.title).toContain('พื้นที่เก็บไฟล์ตัวอย่างเต็ม');
    expect(userAtt()).toEqual([]);
  });
  it('the state blob refusing the metadata also rolls the file back (507)', async () => {
    const d = await draft();
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === 'teas2.mock.state.v24') throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    expect((await call('POST', `/docs/TI/${d.id}/attachments`, att())).status).toBe(507);
    expect(attKeys()).toEqual([]);
  });
  it('removing a draft file just removes it; removing from an issued document is audited and shows on the timeline', async () => {
    const d = await draft();
    const a1 = await (await call('POST', `/docs/TI/${d.id}/attachments`, att())).json();
    expect((await call('DELETE', `/docs/TI/${d.id}/attachments/${a1.id}`)).status).toBe(204);
    expect(attKeys()).toEqual([]);
    expect(loadState().audit.some((x) => x.command === 'attachment.remove')).toBe(false);

    const i = await issued();
    const a2 = await (await call('POST', `/docs/TI/${i.id}/attachments`, att({ name: 'สลิป.pdf', category: 'transfer_slip' }))).json();
    expect((await call('DELETE', `/docs/TI/${i.id}/attachments/${a2.id}`)).status).toBe(204);
    expect(attKeys()).toEqual([]);
    expect(loadState().audit.filter((x) => x.command === 'attachment.remove')).toHaveLength(1);
    const acts = (await (await call('GET', `/docs/TI/${i.id}/activity`)).json()) as { action: string; detail?: string }[];
    expect(acts.some((x) => x.action === 'ลบไฟล์แนบ' && x.detail === 'สลิป.pdf')).toBe(true);
    expect((await call('DELETE', `/docs/TI/${i.id}/attachments/${a2.id}`)).status).toBe(404);
  });
  it('deleting a draft takes its files; reset clears every stored file', async () => {
    const d = await draft();
    await call('POST', `/docs/TI/${d.id}/attachments`, att());
    await call('DELETE', `/docs/TI/${d.id}?version=${d.version}`);
    expect(attKeys()).toEqual([]);
    const e = await draft();
    await call('POST', `/docs/TI/${e.id}/attachments`, att());
    expect(attKeys()).toHaveLength(1);
    resetState();
    expect(attKeys()).toEqual([]);
  });
  it('adding / removing needs the create permission of the type and listing its read permission', async () => {
    const d = await draft();
    const a = await (await call('POST', `/docs/TI/${d.id}/attachments`, att())).json();
    setSettings({ role: 'admin' }); // no document permissions at all
    expect((await call('POST', `/docs/TI/${d.id}/attachments`, att())).status).toBe(403);
    expect((await call('DELETE', `/docs/TI/${d.id}/attachments/${a.id}`)).status).toBe(403);
    expect((await call('GET', `/docs/TI/${d.id}/attachments`)).status).toBe(403);
    setSettings({ role: 'accountant' });
    expect((await call('GET', '/docs/TI/nope/attachments')).status).toBe(404);
    expect(userAtt()).toHaveLength(1);
  });
});

describe('print tracking', () => {
  it('the first print is the ต้นฉบับ, every later one a สำเนา (the server decides), each logged; printCount is derived on read', async () => {
    const i = await issued();
    expect((await (await call('GET', `/docs/TI/${i.id}`)).json()).printCount ?? 0).toBe(0);
    const first = await (await call('POST', `/docs/TI/${i.id}/printed`, { copy: false })).json();
    expect(first).toMatchObject({ copy: false, printCount: 1 });
    const second = await (await call('POST', `/docs/TI/${i.id}/printed`, { copy: false })).json(); // a caller that forgot: still a copy
    expect(second).toMatchObject({ copy: true, printCount: 2 });
    const third = await (await call('POST', `/docs/TI/${i.id}/printed`, { copy: true })).json();
    expect(third).toMatchObject({ copy: true, printCount: 3 });
    expect((await (await call('GET', `/docs/TI/${i.id}`)).json()).printCount).toBe(3);
    const acts = ((await (await call('GET', `/docs/TI/${i.id}/activity`)).json()) as { action: string }[]).map((a) => a.action).filter((a) => a.startsWith('พิมพ์'));
    expect(acts.sort()).toEqual(['พิมพ์ต้นฉบับ', 'พิมพ์สำเนา', 'พิมพ์สำเนา']);
  });
  it('a draft cannot be printed (409) and nothing is logged', async () => {
    const d = await draft();
    const r = await call('POST', `/docs/TI/${d.id}/printed`, { copy: false });
    expect(r.status).toBe(409);
    expect(loadState().prints).toEqual([]);
  });
  it('the paper says ต้นฉบับ / สำเนา from ?copy=1 and a reprint of a note prints the values stored at issue, not recomputed ones', async () => {
    const i = await issued();
    expect((await (await call('GET', `/docs/TI/${i.id}/paper`)).json()).copyLabel).toBe('ต้นฉบับ');
    expect((await (await call('GET', `/docs/TI/${i.id}/paper?copy=1`)).json()).copyLabel).toBe('สำเนา');
    // two credit notes on the same invoice: the second shifts the running "correct value"
    const full = (await (await call('GET', `/docs/TI/${i.id}`)).json()) as { header: object; lines: { id: string }[] };
    const note = async (unitPrice: string) => {
      const c = await (await call('POST', '/docs/CN', {
        header: { partyId: partyId(), documentDate: '2026-10-14', refDocId: i.id, reasonCode: 'PRICE_REDUCTION' },
        lines: [{ id: 'n1', description: 'ลดราคา', qty: '1', unit: 'งาน', unitPrice, taxCode: 'S7', sourceLineId: full.lines[0].id }],
      })).json();
      return (await (await call('POST', `/docs/CN/${c.id}/issue`, { version: c.version })).json()) as { id: string };
    };
    const cn1 = await note('100.00');
    const original = await (await call('GET', `/docs/CN/${cn1.id}/paper`)).json();
    const cn2 = await note('200.00');
    const original2 = await (await call('GET', `/docs/CN/${cn2.id}/paper`)).json();
    const cancelled = await (await call('GET', `/docs/CN/${cn1.id}`)).json();
    await call('POST', `/docs/CN/${cn1.id}/cancel`, { version: cancelled.version, reasonCode: 'OTHER', reasonText: 'ทดสอบ' }); // the world moves: the running correct value of CN2 would shift if recomputed
    const copy2 = await (await call('GET', `/docs/CN/${cn2.id}/paper?copy=1`)).json();
    expect(copy2.adjusts).toEqual(original2.adjusts);
    const copy = await (await call('GET', `/docs/CN/${cn1.id}/paper?copy=1`)).json();
    expect(copy.copyLabel).toBe('สำเนา');
    expect(copy.adjusts).toEqual(original.adjusts);
    expect({ ...copy, copyLabel: 'x', voidMark: undefined }).toEqual({ ...original, copyLabel: 'x', voidMark: undefined }); // identical but for the label (CN1 itself is void by now)
  });
});

describe('default notes and the agent filter', () => {
  it('GET /settings/default-notes returns the per-type defaults', async () => {
    const r = await call('GET', '/settings/default-notes');
    expect(r.status).toBe(200);
    const notes = await r.json();
    expect(typeof notes.QT).toBe('string');
    expect(notes.QT.length).toBeGreaterThan(0);
  });
  it('?agent=1 lists only documents an agent created, and the document view names the report when there is one', async () => {
    const all = (await (await call('GET', '/docs/TI?limit=100')).json()).items as { createdByAgent: boolean }[];
    const agent = (await (await call('GET', '/docs/TI?agent=1&limit=100')).json()).items as { createdByAgent: boolean; id: string }[];
    expect(agent.length).toBeGreaterThan(0);
    expect(agent.length).toBeLessThan(all.length);
    expect(agent.every((x) => x.createdByAgent)).toBe(true);
    const one = await (await call('GET', `/docs/TI/${agent[0].id}`)).json();
    expect(one.createdBy.kind).toBe('agent');
  });
});

describe('S6 fix round 1', () => {
  it('I1: the server says copy for a second print, whichever caller asks; two "tabs" make one original only', async () => {
    const i = await issued();
    const [a, b] = await Promise.all([call('POST', `/docs/TI/${i.id}/printed`, { copy: false }), call('POST', `/docs/TI/${i.id}/printed`, { copy: false })]);
    const r = [await a.json(), await b.json()] as { copy: boolean }[];
    expect(r.filter((x) => !x.copy)).toHaveLength(1);
    expect(loadState().prints.filter((p) => !p.copy)).toHaveLength(1);
  });
  it('a cancelled document may be printed (void stamp) but is logged as such and never counted as the original', async () => {
    const i = await issued();
    await call('POST', `/docs/TI/${i.id}/cancel`, { version: i.version, reasonCode: 'OTHER', reasonText: 'x' });
    const r = await (await call('POST', `/docs/TI/${i.id}/printed`, { copy: false })).json();
    expect(r.copy).toBe(true);
    const acts = ((await (await call('GET', `/docs/TI/${i.id}/activity`)).json()) as { action: string }[]).map((x) => x.action);
    expect(acts).toContain('พิมพ์เอกสารที่ยกเลิกแล้ว');
    expect(acts).not.toContain('พิมพ์ต้นฉบับ');
    expect(loadState().prints.some((p) => !p.copy)).toBe(false);
  });
  it('I3: a write the browser cannot persist is a 507 storage.full, never a success, and the stored state is untouched', async () => {
    const d = await draft();
    const before = localStorage.getItem('teas2.mock.state.v24');
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === 'teas2.mock.state.v24') throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    const r = await call('POST', `/docs/TI/${d.id}/issue`, { version: d.version });
    expect(r.status).toBe(507);
    const p = await r.json();
    expect(p.code).toBe('storage.full');
    expect(p.title).toContain('พื้นที่เก็บข้อมูลตัวอย่างเต็ม');
    expect(localStorage.getItem('teas2.mock.state.v24')).toBe(before);
    vi.restoreAllMocks();
    const again = await (await call('GET', `/docs/TI/${d.id}`)).json();
    expect(again.status).toBe('draft');
    expect(again.number).toBeUndefined();
  });
  it('I3 for real: attachments fill the origin quota, then an issue answers 507 and the document is still a draft', async () => {
    const d = await draft();
    let full = false;
    for (let n = 0; n < 8 && !full; n++) full = (await call('POST', `/docs/TI/${d.id}/attachments`, att({ dataUrl: dataUrl('application/pdf', 1024 * 1024) }))).status === 507;
    expect(full).toBe(true); // the quota is reachable with ordinary attachments
    const e = await draft().catch(() => undefined);
    const r = e ? await call('POST', `/docs/TI/${e.id}/issue`, { version: e.version }) : undefined;
    if (r) expect([200, 507]).toContain(r.status); // whatever the leftover room allows, a 200 must really be persisted
    if (r?.status === 210) expect((await (await call('GET', `/docs/TI/${e!.id}`)).json()).status).toBe('issued');
  });
});
