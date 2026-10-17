import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, DocLine } from '@/domain/types';
import { USER as me } from '../../fixtures/documents';
import { seed, type MockState } from '../../store';
import { cancel, createDraft, issue, revise } from '../commands';
import { finalizeFiling } from '../filings';
import { pp36Model } from '../filings/pp36';
import { checkInvariants } from '../invariants';
import { generalJournal } from '../journal';
import { buildReport } from './index';

// TX2b: the WHT receivable (RC allocations that withheld tax, aged, tied to GL 1180), the missing-50-tawi chase list, and the general journal carrying the ภ.พ.36 entry.
const CO = 'co-vat';
let st: MockState;
beforeEach(() => { st = seed(); });
const rc = (id: string) => st.docs.find((d) => d.id === id)!;
const recv = (asOf = '2026-10-31') => buildReport(st, CO, 'wht-receivable', { asOf });
const missing = () => buildReport(st, CO, 'missing-wht-cert', {});
const detail = (m: { rows: { level: number; cells: Record<string, string>; href?: string }[] }) => m.rows.filter((r) => r.level === 1);
const enter = (number: string) => { const d = rc('rc-nocert'); return revise(st, d.id, { header: d.header, lines: d.lines, allocations: d.allocations!.map((a) => (a.wht && !a.certNumber ? { ...a, certNumber: number } : a)) }, d.version, 'x', me); };

describe('wht-receivable', () => {
  it('lists the withheld allocations by month with customer and certificate number; total = GL 1180', () => {
    const m = recv();
    expect(m.kind).toBe('wht-receivable');
    expect(detail(m).map((r) => [r.cells.receipt, r.cells.customer, r.cells.cert, r.cells.wht])).toEqual([
      [rc('rc-multi').number, 'บริษัท นาวาพาณิชย์ จำกัด', 'ท.2569/0451', '30.00'],
      [rc('rc-nocert').number, 'บริษัท กรีนลีฟ เทรดดิ้ง จำกัด', '', '300.00'],
    ]);
    expect(m.rows.filter((r) => r.kind === 'group').map((r) => r.cells.receipt)).toEqual(['ต.ค. 2569']);
    expect(m.rows.at(-1)).toMatchObject({ kind: 'total', cells: { wht: '330.00' } });
    expect(m.tieOuts).toMatchObject([{ left: '330.00', right: '330.00', diff: '0.00' }]);
    expect(detail(m)[0].href).toBe(`/sales/receipts/rc-multi`);
  });
  it('ages the amount by days since the receipt, as of the date asked', () => {
    expect(detail(recv('2026-10-31')).map((r) => [r.cells.d0, r.cells.d31, r.cells.d61, r.cells.d90])).toEqual([['30.00', '', '', ''], ['300.00', '', '', '']]);
    expect(detail(recv('2026-12-31')).map((r) => [r.cells.d0, r.cells.d31, r.cells.d61, r.cells.d90])).toEqual([['', '', '30.00', ''], ['', '', '300.00', '']]); // 80 and 79 days
    expect(detail(recv('2027-02-28')).map((r) => r.cells.d90)).toEqual(['30.00', '300.00']);
  });
  it('a cancelled receipt leaves the list and the tie-out still holds', () => {
    cancel(st, 'rc-nocert', rc('rc-nocert').version, 'OTHER', 'x', me);
    const m = recv();
    expect(detail(m)).toHaveLength(1);
    expect(m.tieOuts![0]).toMatchObject({ left: '30.00', right: '30.00', diff: '0.00' });
  });
});

describe('missing-wht-cert', () => {
  it('lists the allocations that withheld tax without a certificate number, each linking to its receipt', () => {
    const m = missing();
    expect(m.rows.map((r) => [r.cells.receipt, r.cells.customer, r.cells.wht, r.href])).toEqual([[rc('rc-nocert').number, 'บริษัท กรีนลีฟ เทรดดิ้ง จำกัด', '300.00', '/sales/receipts/rc-nocert']]);
  });
  it('shrinks after the number is entered on the receipt', () => {
    enter('ท.2569/0999');
    expect(missing().rows).toHaveLength(0);
    expect(detail(recv()).map((r) => r.cells.cert)).toEqual(['ท.2569/0451', 'ท.2569/0999']);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('the general journal carries the ภ.พ.36 entry', () => {
  const L = (id: string, price: string): DocLine => ({ id, description: id, qty: '1', unit: 'งาน', unitPrice: price, taxCode: 'EX', expenseCategory: 'services', whtTypeCode: 'FOR-SVC', pnd36: true });
  it('after the filing is finalized, with its date and its two lines', () => {
    const d = createDraft(st, CO, 'PV', { header: { partyId: 'pv-12', documentDate: '2026-09-12' } as Doc['header'], lines: [L('a', '10000.05')] }, me, 'tx2b-1');
    issue(st, d.id, d.version, me);
    expect(generalJournal(st, CO, { account: '2152' }).rows.filter((r) => r.kind === 'group').length).toBe(0);
    finalizeFiling(st, CO, 'PP36', '2026-09', pp36Model(st, CO, '2026-09').version, me, true);
    const rows = generalJournal(st, CO, { account: '2152', from: '2026-09-30', to: '2026-09-30' }).rows;
    expect(rows.find((r) => r.kind === 'group')).toMatchObject({ cells: { date: '2026-09-30' } });
    expect(rows.filter((r) => r.level === 1 && r.cells.credit === '700.00')).toHaveLength(1);
  });
});
