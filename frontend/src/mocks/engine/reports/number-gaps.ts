import { docViewHref } from '@/descriptors';
import type { ReportModel, ReportRow } from '@/domain/reports';
import type { DocType } from '@/domain/types';
import type { MockState } from '../../store';
import { numbersBySeries, seriesKeys } from '../invariants';
import { formatByTemplate, periodOfKey, templateOfKey } from '../numbering';

export interface GapParams { year?: string; month?: string; type?: string; onlyProblems?: string }

/** The number audit (RP3, SP0 §7.12 rule 5): EVERY legal series of the company - company x type x month, from the counters AND from the numbers found on documents - is checked and listed, "ครบ" or "มีปัญหา".
 *  Per series, against the counter: a GAP is a number in 1..max(counter, highest used) that sits on no document; a DUPLICATE is one number on two or more documents (all named); a counter BEHIND is lower than the highest number used.
 *  A cancelled or replaced document keeps its number: it is listed with its reason / the document that replaced it and is never a gap. The parsing is the numbering invariant's own (`numbersBySeries`). */
export function numberGaps(st: MockState, companyId: string, p: GapParams = {}): ReportModel {
  const { groups, malformed } = numbersBySeries(st, st.docs.filter((d) => d.companyId === companyId));
  const type = p.type?.trim().toUpperCase(), month = p.month?.trim() ? String(Number(p.month)).padStart(2, '0') : '', year = p.year?.trim();
  const keys = seriesKeys(st, groups, companyId)
    .map((k) => ({ k, type: k.split('|')[1] as DocType, month: periodOfKey(k) })) // the period is a month (yyyy-mm) or, for a yearly series, a year (yyyy)
    .filter((s) => (!type || s.type === type) && (!year || s.month.startsWith(year)) && (!month || (s.month.length === 7 && s.month.endsWith(`-${month}`))))
    .sort((a, b) => a.month.localeCompare(b.month) || a.type.localeCompare(b.type));
  const rows: ReportRow[] = [];
  let bad = 0;
  for (const s of keys) {
    const found = groups.get(s.k) ?? [], counter = st.series[s.k] ?? 0, max = Math.max(0, ...found.map((f) => f.seq));
    const at = (n: number) => found.filter((f) => f.seq === n).map((f) => f.doc);
    const name = (n: number) => formatByTemplate(templateOfKey(st, s.k), s.month, n); // the key's own stored format
    const kids: ReportRow[] = [];
    let gaps = 0, dups = 0;
    for (let n = 1; n <= Math.max(counter, max); n++) {
      const docs = at(n);
      if (!docs.length) { gaps++; kids.push({ level: 1, kind: 'row', cells: { series: name(n), state: 'เลขขาด', detail: 'ออกเลขนี้แล้วแต่ไม่มีเอกสารถือเลขนี้' } }); }
      else if (docs.length > 1) { dups++; kids.push({ level: 1, kind: 'row', href: docViewHref(docs[0].type, docs[0].id), cells: { series: docs[0].number!, state: 'เลขซ้ำ', detail: docs.map((d) => d.id).join(', ') } }); }
    }
    const behind = max > counter;
    if (behind) kids.push({ level: 1, kind: 'row', cells: { series: name(max), state: 'ตัวนับไม่ตรง', detail: `ตัวนับ ${counter} ต่ำกว่าเลขสูงสุดที่ใช้ ${max}` } });
    for (const f of [...found].sort((a, b) => a.seq - b.seq)) { // not problems: the number is still on the document
      const d = f.doc, by = d.replacedById ? st.docs.find((x) => x.id === d.replacedById) : undefined, why = d.cancel?.reasonText || d.cancel?.reasonCode;
      if (d.status === 'cancelled') kids.push({ level: 1, kind: 'row', href: docViewHref(d.type, d.id), cells: { series: d.number!, state: 'ยกเลิก', detail: why ?? '' } });
      else if (d.status === 'replaced') kids.push({ level: 1, kind: 'row', href: docViewHref(d.type, d.id), cells: { series: d.number!, state: 'ถูกแทนที่', detail: `แทนที่ด้วย ${by?.number ?? by?.id ?? '-'}${why ? ` (${why})` : ''}` } });
    }
    const problems = gaps + dups + (behind ? 1 : 0);
    if (problems) bad++;
    else if (p.onlyProblems === 'true') continue;
    rows.push({ level: 0, kind: 'group', cells: { series: `${s.type} ${s.month}`, counter: String(counter), used: String(found.length), state: problems ? 'มีปัญหา' : 'ครบ',
      detail: problems ? [gaps && `เลขขาด ${gaps}`, dups && `เลขซ้ำ ${dups}`, behind && 'ตัวนับต่ำกว่าเลขที่ใช้'].filter(Boolean).join(', ') : '' } }, ...kids);
  }
  // a number that does not parse, or parses into another type's or month's series, is on no series: each such document is its own named problem (never silently dropped)
  const stray = malformed.filter((d) => (!type || d.type === type) && (!year || d.header.documentDate.startsWith(`${year}-`)) && (!month || d.header.documentDate.slice(5, 7) === month));
  if (stray.length) {
    bad++;
    rows.push({ level: 0, kind: 'group', cells: { series: 'ไม่เข้าชุดเลขที่', counter: '', used: String(stray.length), state: 'มีปัญหา', detail: `เลขผิดรูปแบบ ${stray.length}` } },
      ...stray.map((d): ReportRow => ({ level: 1, kind: 'row', href: docViewHref(d.type, d.id), cells: { series: d.number!, state: 'เลขผิดรูปแบบ', detail: `${d.id} (${d.type}) ถือเลขที่ ${d.number} ซึ่งไม่ใช่เลขที่ของชนิดเอกสารและเดือนที่ออกเอกสารนี้` } })));
  }
  return {
    kind: 'number-gaps', titleKey: 'reports.audit.gaps.title', params: { ...p },
    columns: [
      { key: 'series', labelKey: 'reports.audit.gaps.series' }, { key: 'counter', labelKey: 'reports.audit.gaps.counter', align: 'end', kind: 'qty' },
      { key: 'used', labelKey: 'reports.audit.gaps.used', align: 'end', kind: 'qty' }, { key: 'state', labelKey: 'reports.audit.gaps.state' }, { key: 'detail', labelKey: 'reports.audit.gaps.detail' },
    ],
    rows, notes: [`ตรวจแล้ว ${keys.length} ชุดเลขที่ มีปัญหา ${bad} ชุด`],
  };
}
