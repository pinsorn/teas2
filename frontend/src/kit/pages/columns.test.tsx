import { describe, expect, it } from 'vitest';
import { taxInvoice } from '@/descriptors/tax-invoice';
import type { DocDescriptor } from '@/domain/descriptors';
import th from '@/messages/th.json';
import { columnsFor } from './columns';

const t = (k: string) => k.split('.').reduce((o: never, p) => (o as Record<string, never>)[p], th.docList as never) as string;
const common = (k: string) => (th.common as Record<string, string>)[k];

describe('columnsFor', () => {
  it('the party column is named by the counterparty: customer for sales, vendor for purchases', () => {
    const head = (d: DocDescriptor) => columnsFor(d, t, common).find((c) => c.key === 'party')!.header;
    expect(head(taxInvoice)).toBe('ลูกค้า');
    expect(head({ ...taxInvoice, partyKind: 'vendor' })).toBe('ผู้ขาย');
    expect(head({ ...taxInvoice, partyKind: 'employee' })).toBe('คู่ค้า');
  });
});
