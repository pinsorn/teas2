import { describe, expect, it } from 'vitest';
import { LIVE } from '@/domain/doc-types';
import { today } from '../log';
import { buildSeedState } from '@/mocks/store';
import { fixtureIds } from '@/mocks/fixtures/ids';
import { toSatang } from '../money';
import { trialBalance } from './trial-balance';

describe('trial balance', () => {
  it.each(['co-vat', 'co-nonvat'])('debits equal credits and account balances equal the GL for %s', (company) => {
    const s = buildSeedState();
    for (const asOf of [today(), '2026-06-30']) {
      const report = trialBalance(s, company, { asOf });
      expect(report.tieOuts![0].diff).toBe('0.00');
      expect(report.tieOuts![0].left).toBe(report.tieOuts![0].right);
      const lines = s.journals.filter((j) => s.docs.some((d) => d.id === j.docId && d.companyId === company))
        .flatMap((j) => j.preview.entries).filter((e) => e.date <= asOf).flatMap((e) => e.lines);
      const expectedCodes = [...new Set(lines.map((l) => l.accountCode))].sort();
      expect(report.rows.filter((r) => r.kind === 'row').map((r) => r.cells.code).sort()).toEqual(expectedCodes);
      for (const row of report.rows.filter((r) => r.kind === 'row')) {
        const gl = lines.filter((l) => l.accountCode === row.cells.code).reduce((n, l) => n + toSatang(l.debit) - toSatang(l.credit), 0);
        expect(toSatang(row.cells.debit) - toSatang(row.cells.credit)).toBe(gl);
      }
    }
  });
  it('1130 equals outstanding of live TI and IV', () => {
    const s = buildSeedState();
    for (const company of s.companies) {
      const report = trialBalance(s, company.id, { asOf: '2099-12-31', includeZero: 'true' });
      const ar = report.rows.find((r) => r.cells.code === '1130')!;
      const outstanding = s.docs.filter((d) => d.companyId === company.id && ['TI', 'IV'].includes(d.type) && LIVE.includes(d.status)
        ).reduce((n, d) => n + toSatang(d.outstanding ?? '0.00'), 0);
      expect(toSatang(ar.cells.debit) - toSatang(ar.cells.credit)).toBe(outstanding);
    }
  });
  it('before every entry returns no rows and zero totals', () => {
    const r = trialBalance(buildSeedState(), 'co-vat', { asOf: '1900-01-01' });
    expect(r.rows).toEqual([]);
    expect(r.tieOuts![0]).toMatchObject({ left: '0.00', right: '0.00', diff: '0.00' });
  });
  it('filters dimension lines and includes zero accounts only on request', () => {
    const s = buildSeedState();
    const id = fixtureIds(s).tiIssuedUnpaid;
    const j = s.journals.find((j) => j.docId === id)!;
    for (const e of j.preview.entries) for (const l of e.lines) l.dimensions = { project: 'test' };
    const r = trialBalance(s, 'co-vat', { asOf: '2099-12-31', dimension: 'project:test' });
    expect(r.rows.filter((r) => r.kind === 'row').length).toBeGreaterThan(0);
    expect(r.tieOuts![0].diff).toBe('0.00');
    expect(trialBalance(s, 'co-vat', { asOf: '2099-12-31', dimension: 'project:missing' }).rows).toEqual([]);
    expect(trialBalance(s, 'co-vat', { asOf: '1900-01-01', includeZero: 'true' }).rows.filter((r) => r.kind === 'row')).toHaveLength(s.accounts.filter((a) => a.companyId === 'co-vat' && a.postable).length);
  });
  it('a corrupted journal produces a non-zero tie-out', () => {
    const s = buildSeedState();
    const j = s.journals.find((j) => j.docId === fixtureIds(s).tiIssuedUnpaid)!;
    const line = j.preview.entries.flatMap((e) => e.lines).find((l) => l.accountCode === '1130')!;
    line.debit = '0.00';
    expect(trialBalance(s, 'co-vat', { asOf: '2099-12-31' }).tieOuts![0].diff).not.toBe('0.00');
  });
});
