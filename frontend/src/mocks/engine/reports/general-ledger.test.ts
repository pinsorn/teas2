import { beforeEach, describe, expect, it } from 'vitest';
import type { ReportModel } from '@/domain/reports';
import { buildSeedState, type MockState } from '../../store';
import { today } from '../log';
import { toSatang } from '../money';
import { generalLedger } from './general-ledger';
import { trialBalance } from './trial-balance';

const VAT = 'co-vat', NV = 'co-nonvat';
let st: MockState;
beforeEach(() => { st = buildSeedState(); });

/** The test's own oracle: raw journal lines (closing included) of one account, with their entry date, straight from the stores. */
const raw = (s: MockState, co: string, code: string) => [
  ...s.journals.filter((j) => s.docs.some((d) => d.id === j.docId && d.companyId === co)).flatMap((j) => j.preview.entries),
  ...s.bankJournals.filter((j) => j.companyId === co).flatMap((j) => j.entries),
  ...s.settlements.filter((x) => x.companyId === co).flatMap((x) => x.journal),
  ...s.filings.filter((f) => f.companyId === co).flatMap((f) => f.journal ?? []),
  ...s.yearCloses.filter((y) => y.companyId === co).flatMap((y) => y.journal),
].flatMap((e) => e.lines.filter((l) => l.accountCode === code).map((l) => ({ date: e.date, l })));
const net = (xs: ReturnType<typeof raw>) => xs.reduce((a, { l }) => a + toSatang(l.debit) - toSatang(l.credit), 0);
const CREDIT_NORMAL = new Set(['2110', '4100']);
const sign = (code: string) => (CREDIT_NORMAL.has(code) ? -1 : 1);
const nat = (code: string, sat: number) => sign(code) * sat || 0; // never -0
const body = (m: ReportModel) => m.rows.filter((r) => r.kind === 'row');
const opening = (m: ReportModel) => (m.rows.length ? toSatang(m.rows[0].cells.balance) : 0);
const closing = (m: ReportModel) => (m.rows.length ? toSatang(m.rows.at(-1)!.cells.balance) : 0);

describe('ruling 4: general ledger', () => {
  it.each([['1130', VAT], ['2110', VAT], ['4100', VAT], ['4100', NV], ['1121', NV]])('%s (%s): opening + Σdr - Σcr = closing, in the natural side; each running balance follows', (code, co) => {
    for (const [from, to] of [['', ''], ['2026-03-01', '2026-08-31'], ['2026-09-01', today()]] as const) {
      const m = generalLedger(st, co, { account: code, from, to });
      const all = raw(st, co, code);
      const before = all.filter((x) => from && x.date < from), inside = all.filter((x) => (!from || x.date >= from) && (!to || x.date <= to));
      expect(opening(m)).toBe(nat(code, net(before)));
      expect(closing(m)).toBe(nat(code, net(before.concat(inside))));
      let run = opening(m), dsum = 0, csum = 0;
      for (const r of body(m)) {
        const d = toSatang(r.cells.debit || '0.00'), c = toSatang(r.cells.credit || '0.00');
        run += sign(code) * (d - c); dsum += d; csum += c;
        expect(toSatang(r.cells.balance)).toBe(run);
      }
      expect(body(m)).toHaveLength(inside.length);
      expect(dsum - csum).toBe(net(inside));
      expect(opening(m) + sign(code) * (dsum - csum)).toBe(closing(m));
      expect(m.rows.map((r) => r.cells.date).filter(Boolean)).toEqual([...m.rows.map((r) => r.cells.date).filter(Boolean)].sort());
    }
  });
  it('with no filter the closing is the trial balance of that account at `to`', () => {
    for (const co of [VAT, NV]) for (const code of ['1130', '2110', '4100', '1121']) for (const to of ['2026-06-30', today()]) {
      const m = generalLedger(st, co, { account: code, to });
      const tb = trialBalance(st, co, { asOf: to }).rows.find((r) => r.cells.code === code)?.cells;
      const tbNet = tb ? toSatang(tb.debit) - toSatang(tb.credit) : 0;
      expect(closing(m), `${co} ${code} ${to}`).toBe(nat(code, tbNet));
      if (m.rows.length) expect(m.tieOuts![0].diff).toBe('0.00');
    }
  });
  it('each line has a document link, the description, the party; the opening and closing rows frame them', () => {
    const m = generalLedger(st, VAT, { account: '1130', from: '2026-08-01', to: '2026-10-31' });
    expect(m.columns.map((c) => c.key)).toEqual(['date', 'doc', 'desc', 'party', 'debit', 'credit', 'balance']);
    const first = body(m)[0];
    expect(first.links?.doc).toMatch(/^\//);
    expect(first.cells.doc).toBeTruthy();
    expect(first.cells.desc).toBeTruthy();
    expect(body(m).some((r) => r.cells.party)).toBe(true);
    expect(m.rows[0]).toMatchObject({ kind: 'group', cells: { desc: 'ยอดยกมา' } });
    expect(m.rows.at(-1)).toMatchObject({ kind: 'total', cells: { desc: 'ยอดยกไป' } });
  });
  it('a party filter filters the opening the same way; the parties (and none) add back to the whole', () => {
    const from = '2026-09-01', to = today();
    const whole = generalLedger(st, VAT, { account: '1130', from, to });
    const names = [...new Set(raw(st, VAT, '1130').flatMap(({ l }) => (l.partyName ? [l.partyName] : [])))];
    expect(names.length).toBeGreaterThan(1);
    let sumOpen = 0, sumClose = 0;
    for (const name of names) {
      const id = st.parties.find((p) => p.companyId === VAT && p.name === name)!.id;
      const m = generalLedger(st, VAT, { account: '1130', from, to, party: id });
      const mine = raw(st, VAT, '1130').filter(({ l }) => l.partyName === name);
      expect(opening(m)).toBe(net(mine.filter((x) => x.date < from)));
      expect(closing(m)).toBe(net(mine.filter((x) => x.date <= to)));
      expect(body(m).every((r) => r.cells.party === name)).toBe(true);
      expect(m.notes?.some((x) => x.includes('กรอง'))).toBe(true);
      sumOpen += opening(m); sumClose += closing(m);
    }
    const noParty = raw(st, VAT, '1130').filter(({ l }) => !l.partyName);
    expect(sumOpen + net(noParty.filter((x) => x.date < from))).toBe(opening(whole));
    expect(sumClose + net(noParty.filter((x) => x.date <= to))).toBe(closing(whole));
  });
  it('a dimension filter (type:value) filters lines and opening alike', () => {
    const m = generalLedger(st, NV, { account: '1130', from: '2026-09-21', to: today(), dimension: 'project:P-A' });
    const mine = raw(st, NV, '1130').filter(({ l }) => l.dimensions?.project === 'P-A');
    expect(mine.length).toBeGreaterThan(0);
    expect(opening(m)).toBe(net(mine.filter((x) => x.date < '2026-09-21')));
    expect(closing(m)).toBe(net(mine.filter((x) => x.date <= today())));
    expect(generalLedger(st, NV, { account: '1130', dimension: 'project=P-A' }).rows).toEqual(generalLedger(st, NV, { account: '1130', dimension: 'project:P-A' }).rows);
  });
  it('the account is required; an unknown account or another company\'s party is 404 (company isolation)', () => {
    expect(() => generalLedger(st, VAT, { account: '' })).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => generalLedger(st, VAT, { account: '9999' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => generalLedger(st, NV, { account: '1130', party: 'pc-01' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => generalLedger(st, VAT, { account: '1130', from: '2026-05-01', to: '2026-01-01' })).toThrow(expect.objectContaining({ status: 422 }));
  });
});
