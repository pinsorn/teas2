import type { RecordDescriptor, RecordKind } from '@/domain/records';
import { customer } from './customers';
import { vendor } from './vendors';

export const RECORDS: Partial<Record<RecordKind, RecordDescriptor>> = { customer, vendor };
export function recordByPath(path: string): RecordDescriptor | undefined {
  return Object.values(RECORDS).find((r) => r.basePath === path);
}
