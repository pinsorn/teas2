import type { Company, Doc, DocLine, PartySummary } from '@/domain/types';
import { computeDoc } from '@/mocks/engine/vat';
import { addDays, ANCHOR } from '@/mocks/fixtures/documents';
import { vatItems } from '@/mocks/fixtures/items';
import { formatDocNumber } from '@/mocks/engine/numbering';
import { seed } from '@/mocks/store';

/** Display status: the stored status, plus "overdue" derived from the due date (a chip, not a state). */
export type ChipStatus = 'draft' | 'issued' | 'partly' | 'settled' | 'overdue' | 'cancelled';
export const CHIP_LABEL: Record<ChipStatus, string> = {
  draft: 'ร่าง', issued: 'ออกแล้ว', partly: 'ชำระบางส่วน', settled: 'ชำระแล้ว', overdue: 'เกินกำหนด', cancelled: 'ถูกแทนที่',
};

export interface ListRow { id: string; number: string; party: string; date: string; due?: string; status: ChipStatus; total: string; outstanding: string }

export interface Sample {
  company: Company;
  rows: ListRow[];
  party: PartySummary;
  lines: DocLine[];
  calc: ReturnType<typeof computeDoc>;
  date: string;
  due: string;
  number: string;
}

const chipOf = (d: Doc): ChipStatus => {
  const open = d.status === 'issued' || d.status === 'partly_settled';
  if (open && d.header.dueDate && d.header.dueDate < ANCHOR) return 'overdue';
  return ({ draft: 'draft', issued: 'issued', partly_settled: 'partly', settled: 'settled' } as Record<string, ChipStatus>)[d.status] ?? 'cancelled';
};

/** All figures come from the mock engine and seed: nothing on the tiles is typed in by hand. */
export function buildSample(): Sample {
  const s = seed();
  const company = s.companies.find((c) => c.id === 'co-vat')!;
  const tis = s.docs.filter((d) => d.companyId === 'co-vat' && d.type === 'TI').sort((a, b) => b.header.documentDate.localeCompare(a.header.documentDate));
  // 10 rows with a spread of statuses: newest first, at most 3 of any one chip
  const seen: Record<string, number> = {};
  const picked: Doc[] = [];
  for (const d of tis) {
    const c = chipOf(d);
    if ((seen[c] ?? 0) >= 3 || picked.length === 10) continue;
    seen[c] = (seen[c] ?? 0) + 1;
    picked.push(d);
  }
  const rows: ListRow[] = picked.map((d) => ({
    id: d.id, number: d.number ?? 'ร่าง', party: d.party?.name ?? '-', date: d.header.documentDate, due: d.header.dueDate,
    status: chipOf(d), total: d.totals.total, outstanding: d.outstanding ?? (d.status === 'draft' ? '0.00' : d.totals.total),
  }));

  const party = s.parties.find((p) => p.companyId === 'co-vat' && p.kind === 'customer' && p.vatRegistered && p.taxId)!;
  const items = vatItems();
  const pick = (id: string) => items.find((i) => i.id === id)!;
  const mk = (n: number, id: string, qty: string, discountPct?: string): DocLine => {
    const it = pick(id);
    return { id: `sample-l${n}`, itemId: id, description: it.name, unit: it.unit, unitPrice: it.unitPrice, qty, taxCode: it.taxCode, ...(discountPct ? { discountPct } : {}) };
  };
  const lines = [mk(1, 'SV-01', '1'), mk(2, 'SV-06', '2', '10'), mk(3, 'GD-01', '20')];
  const calc = computeDoc(lines, false);
  const month = formatDocNumber('TI', ANCHOR, 0).slice(0, -4);
  const seqs = tis.map((d) => d.number).filter((n): n is string => !!n && n.startsWith(month)).map((n) => Number(n.slice(-4)));
  return { company, rows, party, lines, calc, date: ANCHOR, due: addDays(ANCHOR, party.paymentTermDays),
    number: formatDocNumber('TI', ANCHOR, Math.max(0, ...seqs) + 1) };
}
