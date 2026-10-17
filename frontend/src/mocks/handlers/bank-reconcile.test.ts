import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BankLine, Doc } from '@/domain/types';
import type { ReportModel } from '@/domain/reports';
import { setSettings } from '../settings';
import { loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { utf8Base64 } from '../engine/bank-import';
import { kbizCsv } from '../fixtures/statements/kbiz-2026-10.csv';
import { KBANK_ACCOUNT_NO, KBANK_SEP_CLOSING, withBalances } from '../fixtures/statements/kplus-2026-09';

beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
afterEach(() => testServer.resetHandlers());
afterAll(() => testServer.close());
beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });

const call = (method: string, p: string, body?: unknown) =>
  fetch(`http://localhost/bff/v1${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
const L = '/finance/bank-lines/bi-001-003';

describe('reconciliation over HTTP', () => {
  it('match -> the receipt reads with the reconciliation lock, its cancel is refused 409, unmatch frees it', async () => {
    const m = await call('POST', `${L}/match`, { docIds: ['rc-013'] });
    expect(m.status).toBe(200);
    expect(((await m.json()) as BankLine)).toMatchObject({ status: 'matched', matches: [{ docId: 'rc-013', amount: '6955.00' }] });
    const doc = (await (await call('GET', '/docs/RC/rc-013')).json()) as Doc;
    expect(doc.locks.find((l) => l.kind === 'reconciliation')).toMatchObject({ exits: ['ยกเลิกการจับคู่'], href: '/finance/bank-accounts/ba-kbank?line=bi-001-003' });
    const c = await call('POST', '/docs/RC/rc-013/cancel', { version: doc.version, reasonCode: 'X', reasonText: 'ทดสอบ' });
    expect(c.status).toBe(409);
    expect(((await c.json()) as { code: string }).code).toBe('doc.reconciled');
    expect((await call('POST', `${L}/unmatch`, {})).status).toBe(200);
    expect(((await (await call('GET', '/docs/RC/rc-013')).json()) as Doc).locks.some((l) => l.kind === 'reconciliation')).toBe(false);
  });

  it('a refused match is a problem+json with its code and writes nothing', async () => {
    const r = await call('POST', `${L}/match`, { docIds: ['rc-012'] }); // 64,200 against a 6,955 line
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe('bank.match_amount');
    expect(loadState().bankLines.find((l) => l.id === 'bi-001-003')!.status).toBe('unmatched');
    expect(loadState().bankJournals.filter((j) => j.kind !== 'opening')).toHaveLength(0);
  });

  it('every reconciliation command needs bank.reconcile: operator and admin are refused 403, and nothing is written', async () => {
    for (const role of ['operator', 'admin'] as const) {
      setSettings({ companyKey: 'vat', role, screenState: 'normal' });
      for (const [method, p, body] of [['POST', `${L}/match`, { docIds: ['rc-013'] }], ['POST', `${L}/ignore`, {}], ['POST', `${L}/post`, { accountCode: '5200' }], ['GET', `${L}/candidates`], ['POST', '/finance/bank-accounts/ba-kbank/reconciled-to', { date: '2026-09-01' }], ['GET', '/finance/postable-accounts']] as const) {
        expect((await call(method, p, body)).status, `${role} ${p}`).toBe(403);
      }
    }
    expect(loadState().bankLines.every((l) => l.status === 'unmatched')).toBe(true);
  });

  it('candidates: the suggestion for the line, a search for others; the lines list carries matches and locked', async () => {
    const s = (await (await call('GET', `${L}/candidates`)).json()) as { items: { docId: string; exact: boolean }[] };
    expect(s.items.map((c) => [c.docId, c.exact])).toEqual([['rc-013', true]]);
    const q = (await (await call('GET', `${L}/candidates?q=RC-2026`)).json()) as { items: { docId: string }[] };
    expect(q.items.length).toBeGreaterThan(5);
    expect((await call('GET', '/finance/bank-lines/nope/candidates')).status).toBe(404);
    await call('POST', `${L}/match`, { docIds: ['rc-013'] });
    const page = (await (await call('GET', '/finance/bank-accounts/ba-kbank/lines?line=bi-001-003')).json()) as { items: BankLine[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0].matches![0].number).toBe('RC-202609-0001');
  });

  it('postable accounts hide the VAT / WHT control accounts; a refused journal is a 422 with the rule', async () => {
    const accts = (await (await call('GET', '/finance/postable-accounts')).json()) as { code: string }[];
    const codes = accts.map((a) => a.code);
    for (const hidden of ['1170', '2151', '1180', '2131', '2133', '2152', '1130', '2110', '2180', '2140', '1122', '3900']) expect(codes).not.toContain(hidden);
    expect(codes).toContain('5200');
    expect(((await (await call('POST', '/finance/bank-lines/bi-001-017/post', { accountCode: '1130' })).json()) as { code: string }).code).toBe('ledger.control_account');
    const r = await call('POST', '/finance/bank-lines/bi-001-017/post', { accountCode: '2151' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe('ledger.control_account');
    const ok = await call('POST', '/finance/bank-lines/bi-001-017/post', { accountCode: '5200', description: 'ค่าธรรมเนียม' });
    expect(ok.status).toBe(200);
    expect(loadState().bankJournals.at(-1)).toMatchObject({ kind: 'inline', lineId: 'bi-001-017' });
  });

  it('lock to a date over HTTP, then the lines read locked and the account reports the date', async () => {
    const e = await call('POST', '/finance/bank-accounts/ba-kbank/reconciled-to', { date: '2026-09-05' });
    expect(e.status).toBe(422);
    expect(((await e.json()) as { code: string }).code).toBe('bank.lock_unmatched');
    for (const id of ['bi-001-001', 'bi-001-002']) await call('POST', `/finance/bank-lines/${id}/ignore`, {});
    await call('POST', `${L}/match`, { docIds: ['rc-013'] });
    expect((await call('POST', '/finance/bank-accounts/ba-kbank/reconciled-to', { date: '2026-09-05' })).status).toBe(200);
    const rec = (await (await call('GET', '/finance/bank-accounts/ba-kbank/reconciliation')).json()) as { reconciledTo: string; counts: Record<string, number> };
    expect(rec).toMatchObject({ reconciledTo: '2026-09-05', counts: { matched: 1, ignored: 2, unmatched: 15 } });
    const u = await call('POST', `${L}/unmatch`, {});
    expect(u.status).toBe(422);
    expect(((await u.json()) as { code: string }).code).toBe('bank.reason_required');
    expect((await call('POST', `${L}/unmatch`, { reason: 'ผิดใบ' })).status).toBe(200);
  });
});

describe('the bank-reconciliation report endpoint', () => {
  it('ties out on the seed, needs an account, answers 404 for another company\'s account, and exports CSV', async () => {
    const r = await call('GET', '/reports/bank-reconciliation?account=ba-kbank&to=2026-09-30');
    expect(r.status).toBe(200);
    const m = (await r.json()) as ReportModel;
    expect(m).toMatchObject({ kind: 'bank-reconciliation', tieOuts: [{ diff: '0.00' }] });
    expect(m.rows.some((x) => x.kind === 'group')).toBe(true);
    expect(((await (await call('GET', '/reports/bank-reconciliation?to=2026-09-30')).json()) as { code: string }).code).toBe('report.bad_param');
    expect((await call('GET', '/reports/bank-reconciliation?account=nba-kbank&to=2026-09-30')).status).toBe(404);
    const csv = await call('GET', '/reports/bank-reconciliation/export?account=ba-kbank&to=2026-09-30');
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain('ยอดคงเหลือตาม statement');
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    expect((await call('GET', '/reports/bank-reconciliation?account=ba-kbank&to=2026-09-30')).status).toBe(403);
  });
});

describe('transfer between own accounts over HTTP', () => {
  it('transfer -> the other side is suggested the journal and matches it; reverse needs both sides unmatched', async () => {
    const t = await call('POST', '/finance/bank-lines/bi-001-001/transfer', { toAccountId: 'ba-scb' });
    expect(t.status).toBe(200);
    expect(((await t.json()) as BankLine)).toMatchObject({ status: 'matched', transfer: { side: 'out' } });
    const j = loadState().bankJournals.find((x) => x.kind === 'transfer')!;
    const st = loadState();
    st.bankLines.push({ companyId: 'co-vat', id: 'scb-1', accountId: 'ba-scb', importId: 'bi-001', date: st.bankLines.find((l) => l.id === 'bi-001-001')!.date, description: 'รับโอน', amount: '35000.00', balance: '35000.00', status: 'unmatched' });
    localStorage.setItem(Object.keys(localStorage).find((k) => k.startsWith('teas2.mock.state.'))!, JSON.stringify(st));
    const c = (await (await call('GET', '/finance/bank-lines/scb-1/candidates')).json()) as { items: { docId: string; type: string }[] };
    expect(c.items).toEqual([expect.objectContaining({ docId: j.id, type: 'TR' })]);
    expect((await call('POST', '/finance/bank-lines/scb-1/match', { docIds: [j.id] })).status).toBe(200);
    expect(((await (await call('POST', `/finance/bank-journals/${j.id}/reverse`, { reason: 'x' })).json()) as { code: string }).code).toBe('bank.transfer_matched');
    expect((await call('POST', '/finance/bank-lines/scb-1/unmatch', {})).status).toBe(200);
    expect((await call('POST', '/finance/bank-lines/bi-001-001/unmatch', {})).status).toBe(200);
    expect(((await (await call('POST', `/finance/bank-journals/${j.id}/reverse`, {})).json()) as { code: string }).code).toBe('bank.reason_required');
    expect((await call('POST', `/finance/bank-journals/${j.id}/reverse`, { reason: 'ผิดบัญชี' })).status).toBe(200);
    const bad = await call('POST', '/finance/bank-lines/bi-001-002/transfer', { toAccountId: 'ba-kbank' });
    expect(((await bad.json()) as { code: string }).code).toBe('bank.transfer_same_account');
  });
});

describe('TX2c: paying a finalized return over HTTP', () => {
  const importLine = async () => {
    const lines = withBalances(KBANK_SEP_CLOSING, [['2026-10-13', 'ชำระภาษี กรมสรรพากร', '-7875.00']]);
    const content = utf8Base64(kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'บริษัท ตัวอย่าง จำกัด', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines }));
    const r = await call('POST', '/finance/bank-accounts/ba-kbank/imports', { fileName: 'tax.csv', format: 'kbiz-csv', content });
    expect(r.status).toBe(201);
    return loadState().bankLines.find((l) => l.amount === '-7875.00')!.id;
  };
  it('payment-lines lists the exact line first; pay-tax posts it; the reverse endpoint routes a tax journal to its own reversal', async () => {
    const id = await importLine();
    const list = (await (await call('GET', '/filings/PP30/2026-08/payment-lines')).json()) as { due: string; lines: { id: string }[] };
    expect(list.due).toBe('7875.00');
    expect(list.lines[0].id).toBe(id);
    const pay = await call('POST', `/finance/bank-lines/${id}/pay-tax`, { form: 'PP30', period: '2026-08' });
    expect(pay.status).toBe(200);
    const line = (await pay.json()) as BankLine;
    expect(line).toMatchObject({ status: 'posted', taxPayment: { form: 'PP30', period: '2026-08' } });
    expect(((await (await call('GET', '/filings/PP30/2026-08')).json()) as { payment: { status: string } }).payment.status).toBe('paid');
    const again = await call('POST', `/finance/bank-lines/${id}/pay-tax`, { form: 'PP30', period: '2026-08' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('bank.line_state');
    expect((await call('POST', `/finance/bank-journals/${line.journalId}/reverse`, { reason: '' })).status).toBe(422);
    const rev = await call('POST', `/finance/bank-journals/${line.journalId}/reverse`, { reason: 'ผิดแบบ' });
    expect(rev.status).toBe(200);
    expect(loadState().bankLines.find((l) => l.id === id)!.status).toBe('unmatched');
    expect(loadState().bankJournals.find((j) => j.id === line.journalId)!.entries.map((e) => e.kind)).toEqual(['original', 'reversal']);
  });
  it('needs bank.reconcile: an operator is refused 403 on both and nothing is written', async () => {
    const id = await importLine();
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    expect((await call('POST', `/finance/bank-lines/${id}/pay-tax`, { form: 'PP30', period: '2026-08' })).status).toBe(403);
    expect((await call('GET', '/filings/PP30/2026-08/payment-lines')).status).toBe(403);
    expect(loadState().bankJournals.some((j) => j.kind === 'tax')).toBe(false);
  });
});
