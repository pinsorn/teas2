import type { VatScope } from '@/domain/doc-types';
import type { RecordKind, RecordRow } from '@/domain/records';
import type { MockState } from '../store';
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
  /** The reason when a rule demands refusing the deactivation (e.g. an account mapped by a posting rule); "in use" alone is NOT a refusal. */
  canDeactivate?: (st: MockState, companyId: string, id: string) => string | undefined;
}

export const RECORD_IMPLS: Partial<Record<RecordKind, RecordKindImpl>> = { customer: partyImpl('customer'), vendor: partyImpl('vendor') };
