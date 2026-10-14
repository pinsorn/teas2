import type { DocType, IsoDate } from '@/domain/types';

export const formatDocNumber = (prefix: DocType, date: IsoDate, seq: number) =>
  `${prefix}-${date.slice(0, 4)}${date.slice(5, 7)}-${String(seq).padStart(4, '0')}`;

export class SeriesAllocator {
  private counters: Map<string, number>;
  constructor(init: Record<string, number> = {}) { this.counters = new Map(Object.entries(init)); }
  next(companyId: string, type: DocType, date: IsoDate): string {
    const key = `${companyId}|${type}|${date.slice(0, 7)}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return formatDocNumber(type, date, n);
  }
  toJSON(): Record<string, number> { return Object.fromEntries(this.counters); }
}
