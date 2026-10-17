import type { RecordDescriptor, RecordKind } from '@/domain/records';
import { account } from './accounts';
import { bankAccount } from './bank-accounts';
import { customer } from './customers';
import { employee } from './employees';
import { item } from './items';
import { schedule } from './schedules';
import { vendor } from './vendors';

export const RECORDS: Partial<Record<RecordKind, RecordDescriptor>> = { customer, vendor, item, 'bank-account': bankAccount, account, schedule, employee };
export function recordByPath(path: string): RecordDescriptor | undefined {
  return Object.values(RECORDS).find((r) => r.basePath === path);
}
