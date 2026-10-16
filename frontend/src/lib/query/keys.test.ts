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
    expect(qk.bankGlAccounts('co-vat')[0]).toBe('co-vat');
    expect(qk.bankLines('co-vat', 'ba-kbank', {})).toEqual(['co-vat', 'bank-lines', 'ba-kbank', {}]);
    expect(qk.bankLines('a', 'x', {})).not.toEqual(qk.bankLines('b', 'x', {}));
    expect(qk.whtTypes('co-vat')[0]).toBe('co-vat');
    expect(qk.records('co-vat', 'customer', { q: 'a' })).toEqual(['co-vat', 'records', 'customer', { q: 'a' }]);
    expect(qk.record('co-vat', 'customer', 'pc-01')[0]).toBe('co-vat');
    expect(qk.docsByParty('co-vat', 'pc-01')[0]).toBe('co-vat');
    expect(qk.records('a', 'customer', {})).not.toEqual(qk.records('b', 'customer', {}));
    for (const k of [qk.chain, qk.activity, qk.revisions, qk.ledger]) {
      expect(k('co-vat', 'TI', 'd1')).toEqual(['co-vat', expect.any(String), 'TI', 'd1']);
      expect(k('co-vat', 'TI', 'd1')).not.toEqual(k('co-vat', 'RC', 'd1'));
    }
  });
});
