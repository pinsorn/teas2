import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReportModel } from '@/domain/reports';
import { reportCsv } from '../engine/reports';
import { setSettings } from '../settings';
import { resetState } from '../store';
import { testServer } from '../test-server';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });
const get = (p: string) => fetch(`http://localhost/bff/v1${p}`);

describe('GET /reports/:kind', () => {
  it('returns the server-computed trial balance with a zero tie-out', async () => {
    const r = await get('/reports/trial-balance?asOf=2099-12-31');
    expect(r.status).toBe(200);
    const m = (await r.json()) as ReportModel;
    expect(m.kind).toBe('trial-balance');
    expect(m.rows.at(-1)!.kind).toBe('total');
    expect(m.tieOuts![0].diff).toBe('0.00');
  });
  it('403 naming report.read for an operator; 404 for a kind not built; 422 for a bad date', async () => {
    setSettings({ role: 'operator' });
    const f = await get('/reports/trial-balance?asOf=2099-12-31');
    expect(f.status).toBe(403);
    expect((await f.json()).detail).toContain('report.read');
    setSettings({ role: 'accountant' });
    expect((await get('/reports/profit-loss')).status).toBe(404);
    expect((await get('/reports/trial-balance?asOf=31-12-2099')).status).toBe(422);
  });
  it('the toolbar "empty" state is a successful report with no rows', async () => {
    setSettings({ screenState: 'empty' });
    const m = (await (await get('/reports/trial-balance?asOf=2099-12-31')).json()) as ReportModel;
    expect(m.rows).toEqual([]);
  });
});

describe('GET /reports/:kind/export', () => {
  it('is text/csv with a BOM, CRLF line ends, Thai intact and the total row named', async () => {
    const r = await get('/reports/trial-balance/export?asOf=2099-12-31');
    expect(r.headers.get('content-type')).toContain('text/csv');
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1);
    const lines = text.split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(lines[0]).toBe('รหัสบัญชี,ชื่อบัญชี,เดบิต,เครดิต');
    expect(text).toContain('ลูกหนี้การค้า');
    expect(lines.at(-2)).toMatch(/^รวม,,\d+\.\d{2},\d+\.\d{2}$/);
  });
  it('quotes a cell that holds a comma or a quote', async () => {
    const s = resetState();
    s.accounts.find((a) => a.companyId === 'co-vat' && a.code === '1130')!.nameTh = 'ลูกหนี้, "การค้า"';
    localStorage.setItem('teas2.mock.state.v9', JSON.stringify(s));
    expect(await (await get('/reports/trial-balance/export?asOf=2099-12-31')).text()).toContain('"ลูกหนี้, ""การค้า"""');
  });
});

describe('report parameters and CSV safety', () => {
  it('every date param is a real calendar date (2099-13-45 and a bad from/to are 422)', async () => {
    for (const q of ['asOf=2099-13-45', 'from=2026-02-30', 'to=x']) expect((await get(`/reports/trial-balance?${q}`)).status, q).toBe(422);
  });
  it('neutralises formula cells (= + - @ tab CR) in text columns but keeps a negative number in a money column; headers follow the locale', () => {
    const col = (key: string, kind: 'text' | 'money') => ({ key, labelKey: `reports.tb.${key}`, kind });
    const m = {
      kind: 'trial-balance', titleKey: 'reports.tb.title', params: {},
      columns: [col('code', 'text'), col('name', 'text'), col('debit', 'money'), col('credit', 'money')],
      rows: ['=1+1', '+1', '-1', '@x', '\tx', '\rx'].map((n) => ({ level: 0, kind: 'row', cells: { code: '1', name: n, debit: '-1234.00', credit: '0.00' } })),
    } as ReportModel;
    const csv = reportCsv(m, 'en');
    const lines = csv.split('\r\n');
    expect(lines[0].slice(1)).toBe('Account code,Account name,Debit,Credit');
    expect(lines.slice(1, 5).map((l) => l.split(',')[1])).toEqual(["'=1+1", "'+1", "'-1", "'@x"]);
    expect(lines[1]).toBe("1,'=1+1,-1234.00,0.00");
    expect(csv).toContain("1,'\tx,-1234.00,0.00");
    expect(csv).toContain('1,"\'\rx",-1234.00,0.00');
  });
});
