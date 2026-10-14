import { describe, expect, it } from 'vitest';
import { buildSeedState, type MockState } from '../store';
import { checkInvariants } from './invariants';

const msgs = (st: MockState) => checkInvariants(st).join('\n');
const jOf = (st: MockState, docId: string) => st.journals.find((j) => j.docId === docId)!;
const issuedTi = (st: MockState) => st.docs.find((x) => x.type === 'TI' && x.status === 'issued')!;

describe('ledger invariants over the whole seed (S7)', () => {
  it('hold for the seed', () => { expect(checkInvariants(buildSeedState())).toEqual([]); });
  it('hold for every role seed', () => {
    for (const role of ['operator', 'accountant', 'admin'] as const) expect(checkInvariants(buildSeedState(role))).toEqual([]);
  });
  it('report an unbalanced entry (can fail)', () => {
    const st = buildSeedState(); const j = st.journals[0].preview.entries[0];
    j.lines[0] = { ...j.lines[0], debit: (Number(j.lines[0].debit) + 1).toFixed(2) };
    expect(msgs(st)).toMatch(/unbalanced/);
  });
  it('report a negative posted amount (can fail)', () => {
    const st = buildSeedState(); const l = st.journals[0].preview.entries[0].lines[0];
    l.debit = '-1.00'; l.credit = '-1.00';
    expect(msgs(st)).toMatch(/negative/);
  });
  it('report an account missing from the chart, and one that is not postable (can fail)', () => {
    const a = buildSeedState();
    a.accounts = a.accounts.filter((x) => !(x.companyId === 'co-vat' && x.code === '1130'));
    expect(msgs(a)).toMatch(/unknown account 1130/);
    const b = buildSeedState(); b.journals[0].preview.entries[0].lines[0].accountCode = '1000';
    expect(msgs(b)).toMatch(/not postable/);
  });
  it('report an outstanding that disagrees with the links (can fail)', () => {
    const st = buildSeedState(); const l = st.links.find((x) => x.kind === 'settles' && x.active)!;
    l.amount = '1.00';
    expect(msgs(st)).toMatch(/outstanding/);
  });
  it('report AR subledger drift (can fail)', () => {
    const st = buildSeedState(); issuedTi(st).outstanding = '0.00';
    expect(msgs(st)).toMatch(/outstanding|1130/);
  });
  it('report GL 1130 drifting from the subledger even when each document is self-consistent (can fail)', () => {
    const st = buildSeedState(); const d = issuedTi(st);
    const e = jOf(st, d.id).preview.entries[0];
    const ar = e.lines.find((l) => l.accountCode === '1130')!, rev = e.lines.find((l) => l.accountCode === '4100')!;
    ar.debit = (Number(ar.debit) + 1).toFixed(2); rev.credit = (Number(rev.credit) + 1).toFixed(2); // still balanced
    expect(msgs(st)).toMatch(/GL 1130/);
  });
  it('report GL 2110 / 2180 drift once purchase documents exist (can fail)', () => {
    const st = buildSeedState(); const base = issuedTi(st);
    st.docs.push({ ...structuredClone(base), id: 'pb-x', type: 'PB', outstanding: '100.00' }, { ...structuredClone(base), id: 'ex-x', type: 'EX', outstanding: '50.00' });
    const out = msgs(st);
    expect(out).toMatch(/GL 2110/);
    expect(out).toMatch(/GL 2180/);
  });
  it('report a status that disagrees with the settlements (can fail)', () => {
    const st = buildSeedState(); st.docs.find((d) => d.status === 'settled')!.status = 'partly_settled';
    expect(msgs(st)).toMatch(/status/);
    const b = buildSeedState(); issuedTi(b).status = 'settled'; // settled with no settlement
    expect(msgs(b)).toMatch(/status/);
  });
  it('report a converted quantity above the source quantity (can fail)', () => {
    const st = buildSeedState(); const e = st.links.find((l) => l.kind === 'converted_from' && l.active)!;
    st.docs.find((d) => d.id === e.to)!.lines[0].qty = '0.0001';
    expect(msgs(st)).toMatch(/conversion/);
  });
  it('report a link across companies, a missing journal and a cancelled document without its reversal (can fail)', () => {
    const a = buildSeedState(); const l = a.links.find((x) => x.kind === 'settles')!;
    a.docs.find((d) => d.id === l.to)!.companyId = 'co-nonvat';
    expect(msgs(a)).toMatch(/link .* different companies/);
    const b = buildSeedState(); const d = issuedTi(b);
    b.journals = b.journals.filter((j) => j.docId !== d.id);
    expect(msgs(b)).toMatch(/no journal/);
    const c = buildSeedState(); const r = c.docs.find((x) => x.status === 'replaced')!;
    jOf(c, r.id).preview.entries.pop();
    expect(msgs(c)).toMatch(/reversal/);
  });
  it('report a late entry before the first open date and a plain reversal in a closed period (can fail)', () => {
    const a = buildSeedState(); const d = issuedTi(a);
    jOf(a, d.id).preview.entries.push({ ...structuredClone(jOf(a, d.id).preview.entries[0]), kind: 'correction', date: '2026-03-05', late: true });
    expect(msgs(a)).toMatch(/closed period/);
    const b = buildSeedState(); const d2 = issuedTi(b);
    jOf(b, d2.id).preview.entries.push({ ...structuredClone(jOf(b, d2.id).preview.entries[0]), kind: 'reversal', date: '2026-03-05' });
    expect(msgs(b)).toMatch(/closed period/);
  });
  it('report a numbering gap and a stored period lock (can fail)', () => {
    const a = buildSeedState(); const d = a.docs.find((x) => x.type === 'TI' && x.number)!;
    d.number = 'TI-202610-0099';
    expect(msgs(a)).toMatch(/numbering/);
    const b = buildSeedState(); b.docs[0].locks.push({ kind: 'period', reason: 'x', exits: [] });
    expect(msgs(b)).toMatch(/stored period lock/);
  });
});
