import type { VatScope } from '@/domain/doc-types';
import type { RecordKind, RecordRow } from '@/domain/records';
import type { MockState } from '../store';
import { accountImpl } from './accounts';
import { bankAccountImpl } from './bank-accounts';
import { itemImpl } from './items';
import { partyImpl } from './parties';

/** One implementation per record kind: the handlers in `handlers/records.ts` are generic over this. */
export interface RecordKindImpl {
  perms: { read: string; manage: string };
  vat?: VatScope;
  rows: (st: MockState, companyId: string) => RecordRow[];
  /** Field errors keyed by field, Thai; empty = valid. `id` = the record being updated. */
  validate: (values: Record<string, unknown>, st: MockState, companyId: string, id?: string) => Record<string, string[]>;
  create: (st: MockState, companyId: string, values: Record<string, unknown>) => RecordRow;
  update: (st: MockState, companyId: string, id: string, values: Record<string, unknown>) => RecordRow;
  /** Flips `active` and bumps the version (the handler has already checked the version and any refusal). */
  setActive: (st: MockState, companyId: string, id: string, active: boolean) => RecordRow;
  /** The reason when a rule demands refusing the deactivation (e.g. a bank account that is the company default); "in use" alone is NOT a refusal. An impl whose refusals carry their own problem code (the chart of accounts: `account.mapped` ...) throws a `MockError` instead. */
  canDeactivate?: (st: MockState, companyId: string, id: string) => string | undefined;
}

export const RECORD_IMPLS: Partial<Record<RecordKind, RecordKindImpl>> = { customer: partyImpl('customer'), vendor: partyImpl('vendor'), item: itemImpl, 'bank-account': bankAccountImpl, account: accountImpl };
