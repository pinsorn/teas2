import { describe, expect, it } from 'vitest';
import { qk } from './keys';

describe('query keys', () => {
  it('every company-scoped key starts with the company id (no cross-company cache hits)', () => {
    expect(qk.docs('co-vat', 'TI', { status: 'issued' })[0]).toBe('co-vat');
    expect(qk.doc('co-vat', 'TI', 'd1')[0]).toBe('co-vat');
    expect(qk.home('co-nonvat')[0]).toBe('co-nonvat');
    expect(qk.docs('a', 'TI', {})).not.toEqual(qk.docs('b', 'TI', {}));
  });
});
