import type { Actor, Allocation, ChainEdge, CorrectionNote, CorrectionPlan, CorrectionResult, CorrectionStep, DocLine, Role, TaxCode } from '@/domain/types';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import type { MockState } from '../store';
import {
  type Body, LIVE, addAdjustment, blockingLocks, calc, cancel, createDraft, getDoc, isFiscalChange, issue, markReplaced, refuseBelowSettled, refuseNonPositive, refusePartyChange, reissue, revise, totalsOf,
} from './commands';
import { MockError, today } from './log';
import { fromSatang, toSatang } from './money';
import { vatOf } from './vat';

/** Small sync FNV-1a (crypto.subtle is async). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

type Stored = MockState['docs'][number];
/** The CN / DN a correction would issue, built by the engine: ONE line per tax code carrying that code's net AND VAT change
 *  between the original and the proposed document (rule B: VAT is fixed per line via `vatOverride`, not recomputed on the difference). `full` = credit the whole document instead.
 *  A pure shift between codes yields a signed (negative) line. Null = nothing to adjust. */
function noteFor(d: Stored, p: Body, full: boolean, vat: boolean): CorrectionNote | null {
  const orig: Body = { header: d.header, lines: d.lines };
  let lines: DocLine[];
  let type: 'CN' | 'DN';
  if (full) { // mirror the original lines so the credit clears the balance to the satang
    type = 'CN';
    lines = d.lines.map((l, i) => ({ ...l, id: `l${i + 1}`, itemId: undefined, sourceLineId: undefined }));
  } else {
    // rule B: per tax code the note carries the ACTUAL change of the engine's own net and VAT (both with per-line rounding)
    const byCode = (b: Body) => {
      const m = new Map<TaxCode, { net: number; vat: number }>();
      calc(b, vat).lines.forEach((r, i) => { const c = b.lines[i].taxCode, x = m.get(c) ?? { net: 0, vat: 0 }; m.set(c, { net: x.net + toSatang(r.net), vat: x.vat + toSatang(r.vat) }); });
      return m;
    };
    const o = byCode(orig), n = byCode(p);
    type = toSatang(calc(p, vat).totals.total) < toSatang(d.totals.total) ? 'CN' : 'DN';
    const sign = type === 'CN' ? -1 : 1;
    const zero = { net: 0, vat: 0 };
    lines = [...new Set([...o.keys(), ...n.keys()])]
      .map((c) => ({ c, net: sign * ((n.get(c) ?? zero).net - (o.get(c) ?? zero).net), vat: sign * ((n.get(c) ?? zero).vat - (o.get(c) ?? zero).vat) }))
      .filter((x) => x.net !== 0 || x.vat !== 0)
      .map((x, i) => ({ id: `l${i + 1}`, description: `ปรับปรุงใบกำกับภาษี ${d.number} (${x.c})`, qty: '1', unit: 'งาน', unitPrice: fromSatang(x.net), taxCode: x.c, vatOverride: fromSatang(x.vat) }));
  }
  if (!lines.length && calc(p, vat).totals.total === d.totals.total && !full) return null;
  const incl = full && !!d.header.priceIncludesVat;
  const computed = calc({ header: { ...d.header, priceIncludesVat: incl }, lines }, vat);
  const total = toSatang(computed.totals.total);
  // a difference note's total is |proposed - original| by construction (rule B); only a note that adjusts nothing is refused
  if (!full && total > 0 && total !== Math.abs(toSatang(calc(p, vat).totals.total) - toSatang(d.totals.total))) {
    throw new MockError(500, 'engine.invariant', 'note total differs from |original - proposed| (rule B violated)'); // defence in depth, never expected
  }
  if (total <= 0 || (full && total !== toSatang(d.totals.total))) {
    throw new MockError(422, 'correction.unrepresentable', 'ไม่สามารถออกใบลดหนี้/ใบเพิ่มหนี้ที่ยอดไม่เป็นบวกได้');
  }
  const codes = [...new Set(lines.map((l) => l.taxCode))];
  const taxLines = codes.map((taxCode) => {
    const rows = computed.lines.filter((_, i) => lines[i].taxCode === taxCode);
    const sum = (key: 'net' | 'vat' | 'total') => fromSatang(rows.reduce((n, r) => n + toSatang(r[key]), 0));
    return { taxCode, net: sum('net'), vat: sum('vat'), total: sum('total') };
  });
  return { type, lines, total: computed.totals.total, priceIncludesVat: incl, fullCredit: full, taxLines };
}

/** Pure: what a correction would do, from the current state. */
export function buildPlan(st: MockState, id: string, proposed: Body, role: Role): CorrectionPlan {
  const d = getDoc(st, id);
  if (!LIVE.includes(d.status)) throw new MockError(409, 'doc.not_correctable', 'แก้ไขได้เฉพาะเอกสารที่ออกแล้วและยังไม่ถูกยกเลิก');
  const label = `${d.type} ${d.number ?? ''}`.trim();
  const steps: Omit<CorrectionStep, 'order'>[] = [];
  const add = (action: CorrectionStep['action'], doc: Stored, summary: string, permission: string, note?: CorrectionNote) =>
    steps.push({ action, docId: doc.id, docType: action === 'issue_cn' ? 'CN' : action === 'issue_dn' ? 'DN' : doc.type, number: doc.number, summary, permission, ...(note ? { note } : {}) });
  let explanation: string;

  const sameBody = JSON.stringify({ header: d.header, lines: d.lines }) === JSON.stringify({ header: proposed.header, lines: proposed.lines })
    && (proposed.allocations === undefined || JSON.stringify(d.allocations ?? []) === JSON.stringify(proposed.allocations));
  if (sameBody) {
    explanation = 'ไม่มีการเปลี่ยนแปลง';
  } else if (d.correctionClass !== 'T' || !isFiscalChange(d, proposed)) {
    refusePartyChange(st, d, proposed);
    refuseNonPositive(st, d.companyId, d.type, proposed);
    refuseBelowSettled(st, d, proposed); // an IV cannot be revised below what is already received: say so before the plan is shown
    add('revise', d, `แก้ไข ${label} (เลขที่เดิม เพิ่มรุ่นแก้ไข)`, `doc.${d.type}.correct`);
    explanation = 'การแก้ไขนี้ไม่กระทบภาษี แก้ไขในเอกสารเดิมและเก็บประวัติการแก้ไข';
  } else {
    const newTotal = toSatang(totalsOf(st, d.companyId, d.type, proposed).total);
    const delta = newTotal - toSatang(d.totals.total);
    const partyChanged = proposed.header.partyId !== d.header.partyId;
    const contentChanged = JSON.stringify(proposed.lines) !== JSON.stringify(d.lines) || !!proposed.header.priceIncludesVat !== !!d.header.priceIncludesVat;
    /** Adds the CN / DN step with the amount the engine will post; false = nothing to adjust (no step shown). */
    const note = (full: boolean) => {
      const n = noteFor(d, proposed, full, vatOf(st, d.companyId));
      if (!n) return false;
      add(n.type === 'CN' ? 'issue_cn' : 'issue_dn', d,
        `${n.type === 'CN' ? 'ออกใบลดหนี้' : 'ออกใบเพิ่มหนี้'} ${n.total} บาท ${full ? 'เต็มจำนวน ' : ''}อ้างอิง ${label}`, n.type === 'CN' ? 'doc.CN.issue' : 'doc.DN.issue', n);
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
  (st.plans ??= {})[plan.planId] = { docId: id, proposed: structuredClone(proposed), role, plan: structuredClone(plan) };
  return plan;
}

/** `rcLinks`: what each receipt of the plan had active BEFORE the plan's cancel step (amount + WHT per target), captured when the plan starts to run.
 *  `moved`: invoices reissued by the plan (old id -> new id), so a receipt's link follows its invoice. */
interface Ctx { planId: string; planDocId: string; newTi?: string; touched: string[]; rcLinks: Map<string, (ChainEdge & { companyId: string })[]>; moved: Map<string, string> }

function runStep(w: MockState, s: CorrectionStep, proposed: Body, actor: Actor, c: Ctx): void {
  const doc = getDoc(w, s.docId);
  const touch = (...ids: string[]) => { for (const x of ids) if (!c.touched.includes(x)) c.touched.push(x); };
  if (s.action === 'revise') {
    revise(w, doc.id, proposed, doc.version, 'แก้ไขตามแผนการแก้ไข', actor);
    touch(doc.id);
  } else if (s.action === 'cancel') {
    cancel(w, doc.id, doc.version, 'CORRECTION', 'ยกเลิกเพื่อแก้ไขเอกสารต้นทาง', actor, { correction: true });
    touch(doc.id);
  } else if (s.action === 'reissue' && doc.type === 'RC') {
    // the receipt was cancelled by the previous step: issue its replacement (original date) with ONE settlement per link it had, then mark the old one replaced
    const links = c.rcLinks.get(doc.id) ?? [];
    if (!links.length && !doc.lines.length && !doc.header.depositAmount) throw new MockError(409, 'correction.plan_invalid', 'แผนการแก้ไขไม่ถูกต้อง');
    const own = doc.id === c.planDocId; // correcting the receipt itself: the proposed content, else a copy re-aimed at the reissued invoice(s)
    const carried: Allocation[] = links.map((l) => {
      const was = doc.allocations?.find((a) => a.targetId === l.to);
      const to = c.moved.get(l.to) ?? l.to;
      return { targetId: to, targetType: getDoc(w, to).type, amount: l.amount!, ...(l.wht ? { wht: l.wht } : {}),
        ...(was?.whtTypeCode ? { whtTypeCode: was.whtTypeCode } : {}), ...(was?.certNumber ? { certNumber: was.certNumber } : {}) };
    });
    const movedIds = [...c.moved.values()]; // invoices this plan reissued: only their targets may belong to another customer than the receipt
    const allMoved = links.length > 0 && links.every((l) => c.moved.has(l.to)); // then the receipt follows the invoice's new customer
    const body: Body = own
      ? { header: { ...proposed.header, documentDate: doc.header.documentDate }, lines: proposed.lines, allocations: proposed.allocations ?? carried }
      : { header: { ...doc.header, ...(allMoved ? { partyId: getDoc(w, c.moved.get(links[0].to)!).header.partyId } : {}) }, lines: doc.lines, allocations: carried };
    const draft = createDraft(w, doc.companyId, 'RC', body, actor, `${c.planId}-${s.order}`);
    const rc = issue(w, draft.id, draft.version, actor, { keepDate: true, partyExempt: own ? [] : carried.filter((a) => movedIds.includes(a.targetId)).map((a) => a.targetId), prior: doc.allocations }); // original date (I9); issue re-creates every settlement and checks each target's outstanding
    markReplaced(w, doc.id, rc.id, actor);
    touch(doc.id, rc.id, ...(rc.allocations ?? []).map((x) => x.targetId));
  } else if (s.action === 'reissue') {
    // a TI keeps its original date and total: when the proposal changes the total, the delta goes through a CN / DN afterwards
    const same = calc(proposed, vatOf(w, doc.companyId)).totals.total === doc.totals.total;
    const body: Body = same ? proposed : { header: { ...proposed.header, priceIncludesVat: doc.header.priceIncludesVat }, lines: doc.lines };
    const nd = reissue(w, doc.id, body, actor, 'ออกใหม่ตามแผนการแก้ไข');
    if (doc.type === 'TI') { c.newTi = nd.id; c.moved.set(doc.id, nd.id); }
    touch(doc.id, nd.id);
  } else {
    const target = c.newTi && doc.status === 'replaced' ? getDoc(w, c.newTi) : doc; // after a reissue the note adjusts the new TI
    const n = s.note!; // verified before any writes; execute the confirmed contract
    const draft = createDraft(w, target.companyId, n.type, {
      header: { partyId: target.header.partyId, documentDate: today(), reference: target.number, priceIncludesVat: n.priceIncludesVat },
      lines: n.lines,
    }, actor, `${c.planId}-${s.order}`);
    const noteDoc = issue(w, draft.id, draft.version, actor);
    addAdjustment(w, noteDoc.id, target.id, noteDoc.totals.total);
    touch(noteDoc.id);
  }
}

export const planStale = () => new MockError(409, 'correction.plan_stale', 'ข้อมูลเปลี่ยนไปหลังจากสร้างแผน กรุณาสร้างแผนใหม่');

/** All or nothing: every step runs on a clone; `st` is only touched when the whole plan succeeded. */
export function executePlan(st: MockState, planId: string, planHash: string, actor: Actor, role?: Role): CorrectionResult {
  const stored = st.plans?.[planId];
  if (!stored) throw new MockError(404, 'correction.plan_not_found', 'ไม่พบแผนการแก้ไข');
  const stale = planStale;
  const plan = stored.plan;
  if (!plan || plan.planHash !== planHash) throw stale();
  let current: CorrectionPlan;
  try { current = buildPlan(st, stored.docId, stored.proposed, role ?? stored.role); }
  catch { throw stale(); }
  if (current.planHash !== planHash || JSON.stringify(current.steps) !== JSON.stringify(plan.steps)) throw stale();
  const granted = PERMISSIONS_BY_ROLE[role ?? stored.role];
  const missing = plan.steps.map((s) => s.note ? `doc.${s.note.type}.issue` : s.permission).filter((p) => !granted.includes(p));
  if (missing.length) throw new MockError(403, 'auth.forbidden', `ต้องมีสิทธิ์ ${missing.join(', ')}`);
  if (!plan.steps.length) throw new MockError(422, 'correction.empty_plan', 'แผนนี้ไม่มีขั้นตอน');
  const work = structuredClone(st);
  const c: Ctx = { planId, planDocId: stored.docId, touched: [], rcLinks: new Map(), moved: new Map() };
  for (const s of plan.steps) {
    if (s.action === 'reissue' && s.docType === 'RC') c.rcLinks.set(s.docId, work.links.filter((l) => l.from === s.docId && l.kind === 'settles' && l.active).map((l) => structuredClone(l)));
  }
  for (const s of plan.steps) runStep(work, s, stored.proposed, actor, c);
  delete work.plans![planId];
  Object.assign(st, work);
  return { affected: c.touched.map((docId) => { const d = getDoc(st, docId); return { docId, type: d.type, number: d.number, status: d.status }; }) };
}
