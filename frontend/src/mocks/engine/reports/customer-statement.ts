import type { ReportModel, TieOut } from '@/domain/reports';
import type { MockState } from '../../store';
import { MockError, today } from '../log';
import { fromSatang, toSatang } from '../money';
import { resolveRole } from '../posting';
import { balancesByParty } from './ar-aging';
import { generalLedger } from './general-ledger';
import { badParam, needDate } from './statement-lines';

export type StatementSide = 'AR' | 'AP';
const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** ReportModel `customer-statement` / `vendor-ledger`: one party's lines on 1130 / 2110 (the general ledger of that party id: the documents, receipts, notes, write-offs and opening items posted under it) with the opening before `from`, a running balance
 *  computed here and the closing. The party is its id, named as the master is now (each line keeps the name the document was issued with). Tied to the ledger twice, with a separate sum: the opening to the party's balance the day before
 *  `from`, the closing to its balance at `to`. A live view of the books. */
export function partyStatement(side: StatementSide, st: MockState, companyId: string, p: Record<string, string>): ReportModel {
  const id = p.party?.trim();
  if (!id) throw badParam('ต้องระบุคู่ค้า');
  const party = st.parties.find((x) => x.companyId === companyId && x.id === id);
  if (!party) throw new MockError(404, 'party.not_found', 'ไม่พบคู่ค้านี้ในบริษัท');
  const kind = side === 'AR' ? 'customer' : 'vendor';
  if (party.kind !== kind) throw badParam(side === 'AR' ? 'ต้องเลือกลูกค้า' : 'ต้องเลือกผู้ขาย');
  const to = p.to ? needDate('to', p.to) : today(), from = p.from ? needDate('from', p.from) : `${to.slice(0, 4)}-01-01`;
  if (from > to) throw badParam('วันที่เริ่มต้นต้องไม่หลังวันที่สิ้นสุด');
  const code = resolveRole(st, side, { companyId, docType: 'JV' }).code;
  const gl = generalLedger(st, companyId, { account: code, party: id, from, to });
  const s = side === 'AR' ? 1 : -1; // the ledger's debit - credit in the statement's own sign (a payable reads credit-positive)
  const books = (d: string) => s * (balancesByParty(st, companyId, code, d).get(id) ?? 0);
  const rows = gl.rows;
  const open = rows.length ? toSatang(rows[0].cells.balance) : 0, close = rows.length ? toSatang(rows.at(-1)!.cells.balance) : 0;
  const tie = (labelKey: string, left: number, right: number): TieOut => ({ labelKey, left: fromSatang(left), right: fromSatang(right), diff: fromSatang(left - right) });
  return {
    kind: side === 'AR' ? 'customer-statement' : 'vendor-ledger', titleKey: side === 'AR' ? 'reports.stmt.customerTitle' : 'reports.stmt.vendorTitle', params: { party: id, from, to }, columns: gl.columns, rows,
    tieOuts: [tie('reports.stmt.tieOpen', open, books(prevDay(from))), tie('reports.stmt.tieClose', close, books(to))],
    notes: [`${side === 'AR' ? 'ลูกค้า' : 'ผู้ขาย'}: ${party.code} ${party.name}${party.taxId ? ` · เลขประจำตัวผู้เสียภาษี ${party.taxId}` : ''}`, `ช่วงวันที่ ${from} ถึง ${to}`],
  };
}

export const customerStatement = (st: MockState, companyId: string, p: Record<string, string>): ReportModel => partyStatement('AR', st, companyId, p);
