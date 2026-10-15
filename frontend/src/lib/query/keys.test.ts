import { describe, expect, it } from 'vitest';
import { qk } from './keys';

describe('query keys', () => {
  it('every company-scoped key starts with the company id (no cross-company cache hits)', () => {
    expect(qk.docs('co-vat', 'TI', { status: 'issued' })[0]).toBe('co-vat');
    expect(qk.doc('co-vat', 'TI', 'd1')[0]).toBe('co-vat');
    expect(qk.home('co-nonvat')[0]).toBe('co-nonvat');
    expect(qk.docs('a', 'TI', {})).not.toEqual(qk.docs('b', 'TI', {}));
    expect(qk.openItems('co-vat', 'pc-01', 'TI,IV')).toEqual(['co-vat', 'open-items', 'pc-01', 'TI,IV']);
    expect(qk.openItems('a', 'p', 't')).not.toEqual(qk.openItems('b', 'p', 't'));
    expect(qk.bankAccounts('co-vat')[0]).toBe('co-vat');
    expect(qk.whtTypes('co-vat')[0]).toBe('co-vat');
    for (const k of [qk.chain, qk.activity, qk.revisions, qk.ledger]) {
      expect(k('co-vat', 'TI', 'd1')).toEqual(['co-vat', expect.any(String), 'TI', 'd1']);
      expect(k('co-vat', 'TI', 'd1')).not.toEqual(k('co-vat', 'RC', 'd1'));
    }
  });
});
