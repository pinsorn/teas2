import type { ActivityEntry, Actor, ChainEdge, Doc, DocLine, DocStatus, DocType, Lock, PartySummary, Revision } from '@/domain/types';
import { CLASS } from '@/domain/doc-types';
import { fromSatang, toSatang } from '../engine/money';
import { SeriesAllocator } from '../engine/numbering';
import { computeDoc } from '../engine/vat';
import type { SeedItem } from './items';
import type { SeedParty } from './parties';

/** Fixed "today" of the mock world. Seed never reads the clock. */
export const ANCHOR = '2026-10-14';
export const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

export const USER: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
export const AGENT: Actor = { kind: 'agent', id: 'ag-1', name: 'ผู้ช่วยบัญชี (AI)', ownerName: USER.name };
/** SP0-charter §7.3 */
export { CLASS } from '@/domain/doc-types';
const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const strip = (p: SeedParty): PartySummary => { const r: Partial<SeedParty> = { ...p }; delete r.companyId; return r as PartySummary; };
const FILING_LOCK: Lock = { kind: 'filing', reason: 'ภ.พ.30 เดือน ก.ย. 2569 ยื่นแล้ว', exits: ['ออกใบลดหนี้ / ใบเพิ่มหนี้ในงวดถัดไป'] };

interface Spec {
  key: string; type: DocType; party: SeedParty; date: string; lines: DocLine[]; status: DocStatus; by: Actor; order: number;
  term?: boolean; notes?: string; prevNotes?: string; revision?: number; locks?: Lock[]; paid?: number;
  settles?: string; replaces?: string; replacedBy?: string; adjusts?: string; convertedFrom?: string;
}
export type SeedDoc = Doc & { companyId: string };

export function buildDocs(parties: SeedParty[], items: SeedItem[]) {
  const companyId = 'co-vat';
  const customers = parties.filter((p) => p.companyId === companyId && p.kind === 'customer');
  const item = (id: string) => items.find((i) => i.id === id)!;
  const specs: Spec[] = [];
  const add = (s: Omit<Spec, 'order'>) => { const full = { ...s, order: specs.length }; specs.push(full); return full; };
  const totalOf = (lines: DocLine[]) => toSatang(computeDoc(lines, false).totals.total);
  const copyLines = (key: string, lines: DocLine[]) => lines.map((l, n) => ({ ...l, id: `${key}-l${n + 1}` }));

  const linesFor = (key: string, p: SeedParty, k: number): DocLine[] =>
    (p.usualItemIds ?? ['SV-01']).slice(0, 1 + (k % 2)).map((id, n) => {
      const it = item(id);
      return { id: `${key}-l${n + 1}`, itemId: id, description: it.name, unit: it.unit, unitPrice: it.unitPrice,
        qty: it.kind === 'good' ? String(10 + (k % 5) * 5) : k % 4 === 2 ? '2' : '1',
        ...(k % 7 === 3 ? { discountPct: '10' } : {}), taxCode: p.id === 'pc-11' ? ('Z0' as const) : it.taxCode };
    });

  // ---- tax invoices: 6 drafts, then 48 dated slots in a fixed permutation, then 3 replacements ----
  let k = 0;
  const tiKey = () => `ti-${pad(k + 1)}`;
  // issued documents only use buyers that pass `issue` validation; the TIN-less VAT party stays available for drafts
  const issuable = customers.filter((p) => !p.vatRegistered || (p.taxId && p.branchCode));
  const party = (draft = false) => { const pool = draft ? customers : issuable; return pool[(k * 5) % pool.length]; };
  for (let i = 0; i < 6; i++, k++) {
    const key = tiKey(); const p = i === 2 ? customers.find((c) => c.vatRegistered && !c.taxId) ?? party(true) : party(true); // one draft keeps the TIN-less VAT buyer (validation fixture)
    add({ key, type: 'TI', party: p, date: addDays(ANCHOR, -(1 + i * 2)), lines: linesFor(key, p, k), status: 'draft',
      by: i === 1 || i === 3 ? AGENT : USER, term: true });
  }
  const KINDS: ('issued' | 'partly' | 'settled' | 'replaced')[] = [
    ...Array<'issued'>(9).fill('issued'), ...Array<'partly'>(6).fill('partly'), ...Array<'settled'>(30).fill('settled'), ...Array<'replaced'>(3).fill('replaced')];
  const STATUS = { issued: 'issued', partly: 'partly_settled', settled: 'settled', replaced: 'replaced' } as const;
  for (let j = 0; j < 48; j++, k++) {
    const kind = KINDS[(j * 5) % 48];
    const key = tiKey(); const p = party();
    const lines = linesFor(key, p, k);
    const total = totalOf(lines);
    const ti = add({ key, type: 'TI', party: p, date: addDays(ANCHOR, -(8 + j * 7)), lines, status: STATUS[kind], by: USER, term: true,
      ...(kind === 'settled' ? { paid: total } : kind === 'partly' ? { paid: Math.floor((total * 4) / 10) } : {}) });
    if (ti.paid) {
      add({ key: `rc-${pad(k + 1)}`, type: 'RC', party: p, date: ANCHOR < addDays(ti.date, 8 + (k % 9)) ? ANCHOR : addDays(ti.date, 8 + (k % 9)),
        lines: [], status: 'issued', by: USER, settles: key, paid: ti.paid });
    }
  }
  const tis = () => specs.filter((s) => s.type === 'TI');
  for (const old of tis().filter((s) => s.status === 'replaced')) {
    const key = tiKey(); k++;
    add({ key, type: 'TI', party: old.party, date: old.date, lines: copyLines(key, old.lines), status: 'issued', by: USER,
      term: true, replaces: old.key });
    old.replacedBy = key;
  }
  const filing = tis().find((s) => s.status === 'settled' && s.date.startsWith('2026-09'));
  if (!filing) throw new Error('seed: no settled TI in September 2026 for the filing lock');
  filing.locks = [FILING_LOCK];

  // ---- 4 QT -> SO -> DO -> TI chains on the first four settled TIs ----
  tis().filter((s) => s.status === 'settled').slice(0, 4).forEach((ti, n) => {
    let prev: string | undefined;
    ([['QT', 'qt', -21], ['SO', 'so', -14], ['DO', 'do', -7]] as const).forEach(([type, pre, off]) => {
      const key = `${pre}-c${n + 1}`;
      add({ key, type, party: ti.party, date: addDays(ti.date, off), lines: copyLines(key, ti.lines), status: 'issued', by: USER, convertedFrom: prev });
      prev = key;
    });
    ti.convertedFrom = prev;
  });
  // ---- 2 issued SOs with nothing delivered, 1 QT revised once ----
  [[3, 15], [4, 40]].forEach(([c, back], n) => {
    const key = `so-u${n + 1}`;
    add({ key, type: 'SO', party: customers[c], date: addDays(ANCHOR, -back), lines: linesFor(key, customers[c], 10 + n), status: 'issued', by: USER });
  });
  add({ key: 'qt-r1', type: 'QT', party: customers[5], date: addDays(ANCHOR, -12), lines: linesFor('qt-r1', customers[5], 12), status: 'issued',
    by: USER, revision: 1, prevNotes: 'ราคายังไม่รวมค่าจัดส่ง', notes: 'ราคารวมค่าจัดส่ง ชำระภายใน 30 วัน' });
  // ---- 2 credit notes adjusting issued TIs ----
  tis().filter((s) => s.status === 'issued' && !s.replaces).slice(0, 2).forEach((ti, n) => {
    const key = `cn-${n + 1}`; const d = addDays(ti.date, 5);
    add({ key, type: 'CN', party: ti.party, date: ANCHOR < d ? ANCHOR : d, status: 'issued', by: USER, adjusts: ti.key,
      lines: [{ id: `${key}-l1`, description: 'ลดหนี้ส่วนลดการค้า', qty: '1', unit: 'งาน', unitPrice: n ? '2500.00' : '1000.00', taxCode: 'S7' }] });
  });

  // ---- 3 rendering-spike TIs (ADR-0001): 1 / 25 / 60 lines, dated in a month with no other document so numbering and lists stay unchanged ----
  const PHR = ['ค่าบริการออกแบบและพัฒนาระบบบริหารจัดการข้อมูลลูกค้าสัมพันธ์', 'ค่าที่ปรึกษาด้านการวางแผนภาษีมูลค่าเพิ่มและภาษีเงินได้นิติบุคคล',
    'ค่าติดตั้งอุปกรณ์เครือข่ายคอมพิวเตอร์พร้อมค่าบำรุงรักษาประจำปี', 'ค่าจัดอบรมพนักงานเกี่ยวกับการใช้งานโปรแกรมบัญชีสำหรับผู้ประกอบการ',
    'ค่าขนส่งสินค้าระหว่างประเทศ รวมค่าธรรมเนียมพิธีการศุลกากรและค่าประกันภัย', 'ค่าเช่าพื้นที่จัดเก็บเอกสารและบริการสำรองข้อมูลอิเล็กทรอนิกส์',
    'ค่าตรวจสอบความถูกต้องของรายงานภาษีซื้อ-ภาษีขาย ประจำเดือน', 'น้ำยาทำความสะอาดพื้นผิวอเนกประสงค์ ชนิดเข้มข้น ขนาดบรรจุ 5 ลิตร'];
  const spikeLines = (key: string, n: number, long: number): DocLine[] => Array.from({ length: n }, (_, i) => {
    let d = PHR[i % PHR.length];
    if (i < long) while (d.length < 270 - (i % 3) * 10) d += ` และ${PHR[(i + d.length) % PHR.length]}`;
    return { id: `${key}-l${i + 1}`, description: `${i + 1}. ${d}`.slice(0, 300), unit: 'งาน', qty: String(1 + (i % 4)), unitPrice: String(1000 + i * 125) + '.00', taxCode: 'S7' as const };
  });
  [['spike-1', 1, 1], ['spike-25', 25, 6], ['spike-60', 60, 20]].forEach(([key, n, long]) => {
    add({ key: key as string, type: 'TI', party: issuable[0], date: '2025-03-14', lines: spikeLines(key as string, n as number, long as number), status: 'issued', by: USER, term: true });
  });

  // ---- numbering in document-date order, then materialise ----
  const alloc = new SeriesAllocator();
  const number: Record<string, string> = {};
  [...specs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order))
    .forEach((s) => { if (s.status !== 'draft') number[s.key] = alloc.next(companyId, s.type, s.date); });

  const at = (d: string, t: string) => `${d}T${t}+07:00`;
  const docs: SeedDoc[] = [], links: (ChainEdge & { companyId: string })[] = [];
  const activity: (ActivityEntry & { docId: string })[] = [], revisions: (Revision & { docId: string })[] = [];

  for (const s of specs) {
    const lines = s.type === 'RC'
      ? [{ id: `${s.key}-l1`, description: `รับชำระตามใบกำกับภาษี ${number[s.settles!]}`, qty: '1', unit: 'ครั้ง', unitPrice: fromSatang(s.paid!), taxCode: 'EX' as const }]
      : s.lines;
    const totals = computeDoc(lines, false).totals;
    const outstanding = s.type !== 'TI' ? undefined : s.status === 'settled' ? '0.00' : s.status === 'partly_settled' ? fromSatang(toSatang(totals.total) - s.paid!)
      : s.status === 'issued' ? totals.total : undefined;
    const issuedAt = s.status === 'draft' ? undefined : at(s.date, '10:00:00');
    const doc: SeedDoc = {
      companyId, id: s.key, type: s.type, number: number[s.key], status: s.status, correctionClass: CLASS[s.type],
      revision: s.revision ?? 0, version: 1,
      header: { partyId: s.party.id, documentDate: s.date, ...(s.term ? { dueDate: addDays(s.date, s.party.paymentTermDays) } : {}),
        ...(s.notes ? { notes: s.notes } : {}), priceIncludesVat: false },
      party: strip(s.party), lines, totals, ...(outstanding ? { outstanding } : {}), locks: s.locks ?? [], createdBy: s.by,
      ...(issuedAt ? { issuedAt } : {}),
      ...(s.status === 'replaced' ? { cancel: { reasonCode: 'WRONG_DETAIL', reasonText: 'ข้อมูลผู้ซื้อไม่ถูกต้อง ยกเลิกและออกใหม่', at: at(addDays(s.date, 2), '11:00:00') } } : {}),
      ...(s.replacedBy ? { replacedById: s.replacedBy } : {}), ...(s.replaces ? { replacesId: s.replaces } : {}),
    };
    docs.push(doc);

    let n = 0;
    const act = (when: string, actor: Actor, action: string, detail?: string) =>
      activity.push({ docId: s.key, id: `act-${s.key}-${++n}`, at: when, actor, action, ...(detail ? { detail } : {}) });
    act(at(s.date, '09:00:00'), s.by, 'create');
    if (issuedAt) act(issuedAt, USER, 'issue', number[s.key]);
    if (s.type === 'TI' && s.paid) {
      const rc = specs.find((r) => r.settles === s.key)!;
      act(at(rc.date, '14:00:00'), USER, 'settle', `${number[rc.key]} · ${fromSatang(s.paid)}`);
    }
    if (s.status === 'replaced') act(at(addDays(s.date, 2), '11:00:00'), USER, 'cancel', `แทนที่ด้วย ${number[s.replacedBy!]}`);
    if (s.revision) act(at(addDays(s.date, 3), '15:00:00'), USER, 'revise', s.notes);

    if (issuedAt) {
      const { companyId: _c, ...rest } = doc; void _c;
      const snap: Doc = { ...rest, status: 'issued', revision: 0, cancel: undefined, replacedById: undefined,
        outstanding: s.type === 'TI' ? totals.total : undefined, ...(s.prevNotes ? { header: { ...rest.header, notes: s.prevNotes } } : {}) };
      revisions.push({ docId: s.key, revision: 0, at: issuedAt, actor: USER, snapshot: snap, diff: [] });
      if (s.revision) {
        revisions.push({ docId: s.key, revision: 1, at: at(addDays(s.date, 3), '15:00:00'), actor: USER, reason: 'แก้ไขเงื่อนไขการจัดส่ง', snapshot: rest,
          diff: [{ path: 'header.notes', before: s.prevNotes ?? null, after: s.notes ?? null }] });
      }
    }

    if (s.settles) links.push({ companyId, from: s.key, to: s.settles, kind: 'settles', amount: fromSatang(s.paid!), active: true });
    if (s.convertedFrom) links.push({ companyId, from: s.key, to: s.convertedFrom, kind: 'converted_from', active: true });
    if (s.replaces) links.push({ companyId, from: s.key, to: s.replaces, kind: 'replaces', active: true });
    if (s.adjusts) links.push({ companyId, from: s.key, to: s.adjusts, kind: 'adjusts', amount: totals.total, active: true });
  }
  return { docs, links, activity, revisions, series: alloc.toJSON() };
}
