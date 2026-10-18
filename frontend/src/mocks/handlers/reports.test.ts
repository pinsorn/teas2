import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReportModel } from '@/domain/reports';
import { reportCsv } from '../engine/reports';
import { PERMISSIONS_BY_ROLE } from '../permissions';
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
    expect((await get('/reports/no-such-report')).status).toBe(404);
    expect((await get('/reports/trial-balance?asOf=31-12-2099')).status).toBe(422);
  });
  it('RP1: the statements need report.read (operator 403), the GL needs its account (422), an account or party of another company is 404, CSV carries the dimension headers', async () => {
    for (const p of ['/reports/profit-loss?from=2026-01-01&to=2026-12-31', '/reports/balance-sheet?asOf=2026-06-30', '/reports/general-ledger?account=1130']) {
      expect((await get(p)).status, p).toBe(200);
      setSettings({ role: 'operator' });
      expect((await get(p)).status, p).toBe(403);
      setSettings({ role: 'accountant' });
    }
    expect((await get('/reports/general-ledger')).status).toBe(422);
    expect((await get('/reports/general-ledger?account=9999')).status).toBe(404);
    expect((await get('/reports/general-ledger?account=1130&party=nc-01')).status).toBe(404); // the other company's customer
    expect((await get('/reports/profit-loss?from=2026-01-01&to=2026-12-31&compare=none&format=class')).status).toBe(200); // the screen's words for "none" / "by class"
    expect((await get('/reports/profit-loss?from=2026-12-31&to=2026-01-01')).status).toBe(422);
    setSettings({ companyKey: 'nonvat' });
    const csv = await (await get('/reports/profit-loss/export?from=2026-01-01&to=2026-12-31&groupBy=project')).text();
    expect(csv.split(String.fromCharCode(13, 10))[0]).toBe('รหัสบัญชี,ชื่อบัญชี,P-A,P-B,ไม่ระบุ,รวม');
  });
  it('RP2: receivables, payables and the summaries need report.arap.read (accountant and admin; operator 403 naming it); a statement needs its party, the party of another company is 404', async () => {
    const paths = ['/reports/ar-aging', '/reports/ap-aging', '/reports/sales-summary', '/reports/purchase-summary', '/reports/outstanding-po', '/reports/customer-statement?party=pc-04', '/reports/vendor-ledger?party=pv-01'];
    for (const role of ['accountant', 'admin'] as const) { setSettings({ role }); for (const p of paths) expect((await get(p)).status, `${role} ${p}`).toBe(200); }
    setSettings({ role: 'operator' });
    for (const p of paths) { const r = await get(p); expect(r.status, p).toBe(403); expect((await r.json()).detail, p).toContain('report.arap.read'); }
    setSettings({ role: 'accountant' });
    expect((await get('/reports/customer-statement')).status).toBe(422);
    expect((await get('/reports/customer-statement?party=nc-01')).status).toBe(404); // the other company's customer
    expect((await get('/reports/vendor-ledger?party=pc-04')).status).toBe(422); // a customer is not a vendor
    expect((await get('/reports/ar-aging?asOf=2026-02-30')).status).toBe(422);
    expect((await get('/reports/asset-register')).status).toBe(200);
    expect((await get('/reports/ar-aging/export?asOf=2026-09-30')).headers.get('content-type')).toContain('text/csv');
    const m = (await (await get('/reports/ar-aging')).json()) as ReportModel;
    expect(m.tieOuts!.every((t) => t.diff === '0.00')).toBe(true);
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
    localStorage.setItem('teas2.mock.state.v26', JSON.stringify(s));
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

describe('TX1 M8: the VAT registers of a month not yet filed need the filing preview right', () => {
  it('tax.read alone reads a finalized month (2026-08) but is refused an unfiled one (2026-09) naming tax.filing.preview', async () => {
    const perms = PERMISSIONS_BY_ROLE.accountant, kept = [...perms];
    perms.splice(0, perms.length, ...kept.filter((p) => p !== 'tax.filing.preview'));
    try {
      expect((await get('/reports/vat-output-register?period=2026-08')).status).toBe(200);
      const r = await get('/reports/vat-input-register?period=2026-09');
      expect(r.status).toBe(403);
      expect((await r.json()).detail).toContain('tax.filing.preview');
    } finally { perms.splice(0, perms.length, ...kept); }
    expect((await get('/reports/vat-output-register?period=2026-09')).status).toBe(200);
  });
});
