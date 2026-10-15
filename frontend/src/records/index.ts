import type { RecordDescriptor, RecordKind } from '@/domain/records';
import { customer } from './customers';
import { item } from './items';
import { vendor } from './vendors';

export const RECORDS: Partial<Record<RecordKind, RecordDescriptor>> = { customer, vendor, item };
export function recordByPath(path: string): RecordDescriptor | undefined {
  return Object.values(RECORDS).find((r) => r.basePath === path);
}
