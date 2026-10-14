import type { Actor, CorrectionPlan, CorrectionResult, CorrectionStep, DocLine, Role, TaxCode } from '@/domain/types';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import type { MockState } from '../store';
import {
  type Body, LIVE, addAdjustment, blockingLocks, addSettlement, calc, cancel, createDraft, getDoc, isFiscalChange, issue, markReplaced, reissue, revise,
} from './commands';
import { MockError, today } from './log';
import { fromSatang, toSatang } from './money';

/** Small sync FNV-1a (crypto.subtle is async). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

type Stored = MockState['docs'][number];
/** The CN / DN a correction would issue, built by the engine: ONE line per tax code carrying that code's net difference
 *  between the original and the proposed lines (VAT is the engine's per line). `full` = credit the whole document instead.
 *  A pure shift between codes yields a signed (negative) line. Null = nothing to adjust. */
function noteFor(d: Stored, p: Body, full: boolean): { type: 'CN' | 'DN'; lines: DocLine[]; total: number; incl: boolean } | null {
  const orig: Body = { header: d.header, lines: d.lines };
  let lines: DocLine[];
  let type: 'CN' | 'DN';
  if (full) { // mirror the original lines so the credit clears the balance to the satang
    type = 'CN';
    lines = d.lines.map((l, i) => ({ ...l, id: `l${i + 1}`, itemId: undefined, sourceLineId: undefined }));
  } else {
    const byCode = (b: Body) => { const m = new Map<TaxCode, number>(); calc(b).lines.forEach((r, i) => m.set(b.lines[i].taxCode, (m.get(b.lines[i].taxCode) ?? 0) + toSatang(r.net))); return m; };
    const o = byCode(orig), n = byCode(p);
    const diff = [...new Set([...o.keys(), ...n.keys()])].map((c) => [c, (n.get(c) ?? 0) - (o.get(c) ?? 0)] as const).filter(([, v]) => v !== 0);
    type = toSatang(calc(p).totals.total) < toSatang(d.totals.total) ? 'CN' : 'DN';
    lines = diff.map(([taxCode, v], i) => ({ id: `l${i + 1}`, description: `ปรับปรุงใบกำกับภาษี ${d.number} (${taxCode})`, qty: '1', unit: 'งาน', unitPrice: fromSatang(type === 'CN' ? -v : v), taxCode }));
  }
  if (!lines.length) return null;
  const incl = full && !!d.header.priceIncludesVat;
  const total = Math.abs(toSatang(calc({ header: { ...d.header, priceIncludesVat: incl }, lines }).totals.total));
  return total === 0 ? null : { type, lines, total, incl };
}

/** Pure: what a correction would do, from the current state. */
export function buildPlan(st: MockState, id: string, proposed: Body, role: Role): CorrectionPlan {
  const d = getDoc(st, id);
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_correctable', 'แก้ไขได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  const label = `${d.type} ${d.number ?? ''}`.trim();
  const steps: Omit<CorrectionStep, 'order'>[] = [];
  const add = (action: CorrectionStep['action'], doc: Stored, summary: string, permission: string) =>
    steps.push({ action, docId: doc.id, docType: action === 'issue_cn' ? 'CN' : action === 'issue_dn' ? 'DN' : doc.type, number: doc.number, summary, permission });
  let explanation: string;

  if (JSON.stringify({ header: d.header, lines: d.lines }) === JSON.stringify(proposed)) {
    explanation = 'ไม่มีการเปลี่ยนแปลง';
  } else if (d.correctionClass !== 'T' || !isFiscalChange(d, proposed)) {
    add('revise', d, `แก้ไข ${label} (เลขที่เดิม เพิ่มรุ่นแก้ไข)`, `doc.${d.type}.correct`);
    explanation = 'การแก้ไขนี้ไม่กระทบภาษี แก้ไขในเอกสารเดิมและเก็บประวัติการแก้ไข';
  } else {
    const newTotal = toSatang(calc(proposed).totals.total);
    const delta = newTotal - toSatang(d.totals.total);
    const partyChanged = proposed.header.partyId !== d.header.partyId;
    const contentChanged = JSON.stringify(proposed.lines) !== JSON.stringify(d.lines) || !!proposed.header.priceIncludesVat !== !!d.header.priceIncludesVat;
    /** Adds the CN / DN step with the amount the engine will post; false = nothing to adjust (no step shown). */
    const note = (full: boolean) => {
      const n = noteFor(d, proposed, full);
      if (!n) return false;
      add(n.type === 'CN' ? 'issue_cn' : 'issue_dn', d,
        `${n.type === 'CN' ? 'ออกใบลดหนี้' : 'ออกใบเพิ่มหนี้'} ${fromSatang(n.total)} บาท ${full ? 'เต็มจำนวน ' : ''}อ้างอิง ${label}`, n.type === 'CN' ? 'doc.CN.issue' : 'doc.DN.issue');
      return true;
    };
    const deps = st.links.filter((l) => l.to === id && l.active);
    // I9: a reissue keeps the original date and total; a different total is always a CN / DN (TI) or a new receipt (RC)
    const needsReissue = d.type === 'TI' ? partyChanged || (delta === 0 && contentChanged) : true;
    if (d.type === 'TI' && !needsReissue && delta !== 0 && note(false)) {
      explanation = 'ยอดรวมเปลี่ยน ออกใบลดหนี้/ใบเพิ่มหนี้เฉพาะส่วนต่าง เอกสารเดิมไม่ถูกยกเลิก';
    } else if (d.type === 'TI' && !needsReissue) {
      explanation = 'วันที่ของเอกสารแก้ไขไม่ได้ (ออกใหม่ต้องใช้วันที่เดิม) จึงไม่มีขั้นตอนที่ต้องทำ';
    } else if (blockingLocks(d).length) {
      if (d.type === 'TI') { note(true); explanation = 'เอกสารถูกล็อก ออกใบลดหนี้เต็มจำนวน แล้วออกใบกำกับภาษีฉบับใหม่แยกต่างหาก'; }
      else explanation = 'เอกสารถูกล็อก ทำไม่ได้';
    } else if (d.type === 'TI' && deps.some((l) => l.kind !== 'settles')) {
      explanation = 'มีใบลดหนี้/ใบเพิ่มหนี้/ใบวางบิลอ้างอิงอยู่ ต้องจัดการเอกสารเหล่านั้นก่อน';
    } else if (d.type === 'RC') {
      add('cancel', d, `ยกเลิก ${label}`, 'doc.RC.cancel');
      add('reissue', d, `ออก ${d.type} ใหม่ (วันที่เดิม${delta === 0 ? ' ยอดเดิม' : ' ยอดใหม่'})`, 'doc.RC.correct');
      explanation = 'ใบเสร็จแก้ยอดไม่ได้ ยกเลิกแล้วออกใบเสร็จใหม่ผูกกับเอกสารเดิม';
    } else if (d.type !== 'TI') {
      add('reissue', d, `ออก ${label} ใหม่`, `doc.${d.type}.correct`);
      explanation = 'การแก้ไขนี้กระทบภาษี ยกเลิกและออกเอกสารใหม่';
    } else {
      const receipts = deps.map((l) => getDoc(st, l.from));
      for (const rc of receipts) add('cancel', rc, `ยกเลิก ${rc.type} ${rc.number}`, `doc.${rc.type}.cancel`);
      add('reissue', d, `ยกเลิกและออก ${label} ใหม่ (วันที่และยอดเดิม)`, `doc.${d.type}.correct`);
      for (const rc of receipts) add('reissue', rc, `ออก ${rc.type} ใหม่ผูกกับเอกสารใหม่`, `doc.${rc.type}.correct`);
      if (delta !== 0) note(false);
      explanation = 'การแก้ไขนี้กระทบภาษี ยกเลิกใบเสร็จที่เกี่ยวข้อง ออกเอกสารใหม่ด้วยยอดเดิม แล้วออกใบเพิ่ม/ลดหนี้สำหรับส่วนต่าง';
    }
  }
  const ordered = steps.map((s, i) => ({ ...s, order: i + 1 }));
  const granted = PERMISSIONS_BY_ROLE[role];
  return {
    planId: `plan-${fnv(JSON.stringify([id, proposed, role]))}`,
    planHash: fnv(JSON.stringify({ steps: ordered, version: d.version })),
    steps: ordered,
    missingPermissions: [...new Set(ordered.map((s) => s.permission))].filter((p) => !granted.includes(p)),
    explanation,
  };
}

/** Builds the plan and remembers it (single use) so `executePlan` can recompute it. */
export function correctionPlan(st: MockState, id: string, proposed: Body, role: Role): CorrectionPlan {
  const plan = buildPlan(st, id, proposed, role);
  (st.plans ??= {})[plan.planId] = { docId: id, proposed: structuredClone(proposed), role };
  return plan;
}

interface Ctx { planId: string; planDocId: string; newTi?: string; touched: string[] }

function runStep(w: MockState, s: CorrectionStep, proposed: Body, actor: Actor, c: Ctx): void {
  const doc = getDoc(w, s.docId);
  const touch = (...ids: string[]) => { for (const x of ids) if (!c.touched.includes(x)) c.touched.push(x); };
  if (s.action === 'revise') {
    revise(w, doc.id, proposed, doc.version, 'แก้ไขตามแผนการแก้ไข', actor);
    touch(doc.id);
  } else if (s.action === 'cancel') {
    cancel(w, doc.id, doc.version, 'CORRECTION', 'ยกเลิกเพื่อแก้ไขเอกสารต้นทาง', actor);
    touch(doc.id);
  } else if (s.action === 'reissue' && doc.type === 'RC') {
    // the receipt was cancelled by the previous step: issue its replacement (original date) and mark the old one replaced
    const ti = c.newTi ? getDoc(w, c.newTi) : undefined;
    const old = [...w.links].reverse().find((l) => l.from === doc.id && l.kind === 'settles');
    const target = ti ?? (old ? getDoc(w, old.to) : undefined);
    if (!target) throw new MockError(409, 'correction.plan_invalid', 'แผนการแก้ไขไม่ถูกต้อง');
    const own = doc.id === c.planDocId; // correcting the receipt itself: the proposed content, else a copy re-aimed at the new TI
    const body: Body = own
      ? { header: { ...proposed.header, documentDate: doc.header.documentDate }, lines: proposed.lines }
      : { header: { ...doc.header, partyId: target.header.partyId },
        lines: doc.lines.map((l, i) => (i === 0 ? { ...l, description: `รับชำระตามใบกำกับภาษี ${target.number}` } : l)) };
    const draft = createDraft(w, doc.companyId, 'RC', body, actor, `${c.planId}-${s.order}`);
    const rc = issue(w, draft.id, draft.version, actor);
    markReplaced(w, doc.id, rc.id, actor);
    addSettlement(w, rc.id, target.id, own ? rc.totals.total : old?.amount ?? rc.totals.total);
    touch(doc.id, rc.id, target.id);
  } else if (s.action === 'reissue') {
    // a TI keeps its original date and total: when the proposal changes the total, the delta goes through a CN / DN afterwards
    const same = calc(proposed).totals.total === doc.totals.total;
    const body: Body = same ? proposed : { header: { ...proposed.header, priceIncludesVat: doc.header.priceIncludesVat }, lines: doc.lines };
    const nd = reissue(w, doc.id, body, actor, 'ออกใหม่ตามแผนการแก้ไข');
    if (doc.type === 'TI') c.newTi = nd.id;
    touch(doc.id, nd.id);
  } else {
    const target = c.newTi && doc.status === 'replaced' ? getDoc(w, c.newTi) : doc; // after a reissue the note adjusts the new TI
    const full = blockingLocks(target).length > 0 && proposed.header.partyId !== target.header.partyId;
    const n = noteFor(target, proposed, full);
    if (!n) throw new MockError(422, 'correction.nothing_to_adjust', 'ไม่มียอดที่ต้องปรับ');
    const draft = createDraft(w, target.companyId, n.type, {
      header: { partyId: target.header.partyId, documentDate: today(), reference: target.number, priceIncludesVat: n.incl },
      lines: n.lines,
    }, actor, `${c.planId}-${s.order}`);
    const noteDoc = issue(w, draft.id, draft.version, actor);
    addAdjustment(w, noteDoc.id, target.id, noteDoc.totals.total);
    touch(noteDoc.id);
  }
}

/** All or nothing: every step runs on a clone; `st` is only touched when the whole plan succeeded. */
export function executePlan(st: MockState, planId: string, planHash: string, actor: Actor, role?: Role): CorrectionResult {
  const stored = st.plans?.[planId];
  if (!stored) throw new MockError(404, 'correction.plan_not_found', 'ไม่พบแผนการแก้ไข');
  const plan = buildPlan(st, stored.docId, stored.proposed, role ?? stored.role);
  if (plan.planHash !== planHash) throw new MockError(409, 'correction.plan_stale', 'ข้อมูลเปลี่ยนไปหลังจากสร้างแผน กรุณาสร้างแผนใหม่');
  if (plan.missingPermissions.length) throw new MockError(403, 'auth.forbidden', `ต้องมีสิทธิ์ ${plan.missingPermissions.join(', ')}`);
  if (!plan.steps.length) throw new MockError(422, 'correction.empty_plan', 'แผนนี้ไม่มีขั้นตอน');
  const work = structuredClone(st);
  const c: Ctx = { planId, planDocId: stored.docId, touched: [] };
  for (const s of plan.steps) runStep(work, s, stored.proposed, actor, c);
  delete work.plans![planId];
  Object.assign(st, work);
  return { affected: c.touched.map((docId) => { const d = getDoc(st, docId); return { docId, type: d.type, number: d.number, status: d.status }; }) };
}
