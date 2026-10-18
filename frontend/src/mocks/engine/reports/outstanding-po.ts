import { docViewHref } from '@/descriptors';
import { LIVE } from '@/domain/doc-types';
import type { ReportModel, ReportRow } from '@/domain/reports';
import type { Doc } from '@/domain/types';
import type { MockState } from '../../store';
import { consumed, fmtQ, q4 } from '../chain';
import { today } from '../log';
import { revisionInForce } from './as-of';
import { badParam, needDate } from './statement-lines';

/** ReportModel `outstanding-po`: the issued purchase orders (not cancelled, not closed) dated by the date, line by line: ordered, billed and what is left. Billed is the PO progress function (`consumed`, chain.ts) over the issued PBs dated by the date;
 *  a draft bill only reserves quantity. Overdue = the expected date (กำหนดรับของ) is before the date. A live view: the closed mark and the status are as they are now. */
export function outstandingPo(st: MockState, companyId: string, p: Record<string, string>): ReportModel {
  const asOf = p.asOf ? needDate('asOf', p.asOf) : today();
  if (p.overdueOnly && !['true', 'false'].includes(p.overdueOnly)) throw badParam('overdueOnly ต้องเป็น true หรือ false');
  const only = p.overdueOnly === 'true';
  const rows: ReportRow[] = [];
  for (const po of st.docs.filter((d) => d.companyId === companyId && d.type === 'PO' && LIVE.includes(d.status) && !d.marks?.closed && d.header.documentDate <= asOf)
    .sort((a, b) => (a.header.dueDate ?? '9999').localeCompare(b.header.dueDate ?? '9999') || (a.number ?? a.id).localeCompare(b.number ?? b.id))) {
    const billedBy = (t: Doc) => t.type === 'PB' && !!revisionInForce(st, t.id, asOf); // the bill's posting in force on the date: a bill cancelled after it still counts until its reversal
    const left = po.lines.flatMap((l) => { const ordered = q4(l.qty), billed = consumed(st, po, l, billedBy, { inactive: true }); return ordered - billed > 0 ? [{ l, ordered, billed }] : []; });
    const late = !!po.header.dueDate && po.header.dueDate < asOf;
    if (!left.length || (only && !late)) continue;
    const vendor = st.parties.find((x) => x.companyId === companyId && x.id === po.header.partyId);
    const blank = { vendor: '', expected: '', item: '', ordered: '', billed: '', remaining: '', status: '' };
    rows.push({ level: 0, kind: 'group', href: docViewHref('PO', po.id), cells: { ...blank, po: po.number ?? po.id, vendor: vendor ? `${vendor.code} ${vendor.name}` : po.party?.name ?? '', expected: po.header.dueDate ?? '', status: late ? 'เลยกำหนด' : '' } });
    for (const x of left) rows.push({ level: 1, kind: 'row', cells: { ...blank, po: '', item: `${x.l.description}${x.l.unit ? ` (${x.l.unit})` : ''}`, ordered: fmtQ(x.ordered), billed: fmtQ(x.billed), remaining: fmtQ(x.ordered - x.billed) } });
  }
  return {
    kind: 'outstanding-po', titleKey: 'reports.po.title', asOf, params: { asOf, ...(only ? { overdueOnly: 'true' } : {}) },
    columns: [{ key: 'po', labelKey: 'reports.po.po', kind: 'text' }, { key: 'vendor', labelKey: 'reports.po.vendor', kind: 'text' }, { key: 'expected', labelKey: 'reports.po.expected', kind: 'date' }, { key: 'item', labelKey: 'reports.po.item', kind: 'text' },
      { key: 'ordered', labelKey: 'reports.po.ordered', kind: 'qty', align: 'end' }, { key: 'billed', labelKey: 'reports.po.billed', kind: 'qty', align: 'end' }, { key: 'remaining', labelKey: 'reports.po.remaining', kind: 'qty', align: 'end' }, { key: 'status', labelKey: 'reports.po.status', kind: 'text' }],
    rows,
    notes: ['จำนวนที่เรียกเก็บนับตามใบรับวางบิลที่บันทึกบัญชีแล้ว ณ วันที่เลือก แต่ใช้จำนวนในใบรับวางบิลฉบับปัจจุบัน (การแก้จำนวนหลังวันที่เลือกไม่ย้อนกลับ) และสถานะปิดยอด/ยกเลิกของใบสั่งซื้อเป็นสถานะปัจจุบัน'],
  };
}
