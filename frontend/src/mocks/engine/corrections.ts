import type { Actor, CorrectionPlan, CorrectionResult, CorrectionStep, Role } from '@/domain/types';
import { PERMISSIONS_BY_ROLE } from '../permissions';
import type { MockState } from '../store';
import {
  type Body, LIVE, addSettlement, calc, cancel, createDraft, getDoc, isFiscalChange, issue, reissue, revise,
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
/** Net/VAT change a credit or debit note must carry. A change of party/date takes the whole TI out (full credit). */
function adjustment(d: Stored, p: Body) {
  const t = calc(p).totals;
  const sameKey = p.header.partyId === d.header.partyId && p.header.documentDate === d.header.documentDate
    && !!p.header.priceIncludesVat === !!d.header.priceIncludesVat;
  const dNet = sameKey ? toSatang(t.net) - toSatang(d.totals.net) : -toSatang(d.totals.net);
  const dVat = sameKey ? toSatang(t.vat) - toSatang(d.totals.vat) : -toSatang(d.totals.vat);
  return { sameKey, dNet, dVat, dTotal: dNet + dVat };
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
    const adj = d.type === 'TI' ? adjustment(d, proposed) : undefined;
    const creditNote = (full: boolean) => {
      const amount = fromSatang(Math.abs(adj!.dTotal));
      add(adj!.dTotal < 0 ? 'issue_cn' : 'issue_dn', d,
        `${adj!.dTotal < 0 ? 'ออกใบลดหนี้' : 'ออกใบเพิ่มหนี้'} ${amount} บาท ${full ? 'เต็มจำนวน ' : ''}อ้างอิง ${label}`,
        adj!.dTotal < 0 ? 'doc.CN.issue' : 'doc.DN.issue');
    };
    const deps = st.links.filter((l) => l.to === id && l.active);
    if (adj && adj.sameKey && adj.dTotal !== 0) {
      creditNote(false);
      explanation = 'ยอดรวมเปลี่ยน ออกใบลดหนี้/ใบเพิ่มหนี้เฉพาะส่วนต่าง เอกสารเดิมไม่ถูกยกเลิก';
    } else if (d.locks.length) {
      if (adj && !adj.sameKey) { creditNote(true); explanation = 'เอกสารถูกล็อก ออกใบลดหนี้เต็มจำนวน แล้วออกใบกำกับภาษีฉบับใหม่แยกต่างหาก'; }
      else explanation = 'เอกสารถูกล็อก และการแก้ไขนี้ไม่เปลี่ยนยอด จึงทำไม่ได้';
    } else if (deps.some((l) => l.kind !== 'settles')) {
      explanation = 'มีใบลดหนี้/ใบเพิ่มหนี้/ใบวางบิลอ้างอิงอยู่ ต้องจัดการเอกสารเหล่านั้นก่อน';
    } else {
      const receipts = deps.map((l) => getDoc(st, l.from));
      for (const rc of receipts) add('cancel', rc, `ยกเลิก ${rc.type} ${rc.number}`, `doc.${rc.type}.cancel`);
      add('reissue', d, `ยกเลิกและออก ${label} ใหม่ (วันที่และยอดเดิม)`, `doc.${d.type}.correct`);
      for (const rc of receipts) add('reissue', rc, `ออก ${rc.type} ใหม่ผูกกับเอกสารใหม่`, `doc.${rc.type}.correct`);
      explanation = 'การแก้ไขนี้กระทบภาษี ยกเลิกใบเสร็จที่เกี่ยวข้อง ออกเอกสารใหม่ แล้วออกใบเสร็จใหม่ตามลำดับ';
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

interface Ctx { planId: string; newTi?: string; touched: string[] }

function runStep(w: MockState, s: CorrectionStep, proposed: Body, actor: Actor, c: Ctx): void {
  const doc = getDoc(w, s.docId);
  const touch = (...ids: string[]) => { for (const x of ids) if (!c.touched.includes(x)) c.touched.push(x); };
  if (s.action === 'revise') {
    revise(w, doc.id, proposed, doc.version, 'แก้ไขตามแผนการแก้ไข', actor);
    touch(doc.id);
  } else if (s.action === 'cancel') {
    cancel(w, doc.id, doc.version, 'CORRECTION', 'ยกเลิกเพื่อแก้ไขเอกสารต้นทาง', actor);
    touch(doc.id);
  } else if (s.action === 'reissue' && doc.status === 'cancelled') {
    // a receipt cancelled earlier in this plan: re-create it against the re-issued TI, same amount
    const ti = c.newTi ? getDoc(w, c.newTi) : undefined;
    if (!ti) throw new MockError(409, 'correction.plan_invalid', 'แผนการแก้ไขไม่ถูกต้อง');
    const amount = [...w.links].reverse().find((l) => l.from === doc.id && l.kind === 'settles')?.amount;
    const draft = createDraft(w, doc.companyId, doc.type, {
      header: { ...doc.header, partyId: ti.header.partyId },
      lines: doc.lines.map((l, i) => (i === 0 ? { ...l, description: `รับชำระตามใบกำกับภาษี ${ti.number}` } : l)),
    }, actor, `${c.planId}-${s.order}`);
    const rc = issue(w, draft.id, draft.version, actor);
    addSettlement(w, rc.id, ti.id, amount ?? rc.totals.total);
    touch(doc.id, rc.id, ti.id);
  } else if (s.action === 'reissue') {
    const nd = reissue(w, doc.id, proposed, actor, 'ออกใหม่ตามแผนการแก้ไข');
    if (doc.type === 'TI') c.newTi = nd.id;
    touch(doc.id, nd.id);
  } else {
    const adj = adjustment(doc, proposed);
    if (adj.dNet === 0) throw new MockError(422, 'correction.nothing_to_adjust', 'ไม่มียอดที่ต้องปรับ');
    const type = s.action === 'issue_cn' ? 'CN' : 'DN';
    const draft = createDraft(w, doc.companyId, type, {
      header: { partyId: doc.header.partyId, documentDate: today(), reference: doc.number, priceIncludesVat: false },
      lines: [{ id: 'l1', description: `ปรับปรุงใบกำกับภาษี ${doc.number}`, qty: '1', unit: 'งาน', unitPrice: fromSatang(Math.abs(adj.dNet)), taxCode: adj.dVat !== 0 ? 'S7' : 'Z0' }],
    }, actor, `${c.planId}-${s.order}`);
    const note = issue(w, draft.id, draft.version, actor);
    w.links.push({ companyId: doc.companyId, from: note.id, to: doc.id, kind: 'adjusts', amount: note.totals.total, active: true });
    touch(note.id);
  }
}

/** All or nothing: every step runs on a clone; `st` is only touched when the whole plan succeeded. */
export function executePlan(st: MockState, planId: string, planHash: string, actor: Actor): CorrectionResult {
  const stored = st.plans?.[planId];
  if (!stored) throw new MockError(404, 'correction.plan_not_found', 'ไม่พบแผนการแก้ไข');
  const plan = buildPlan(st, stored.docId, stored.proposed, stored.role);
  if (plan.planHash !== planHash) throw new MockError(409, 'correction.plan_stale', 'ข้อมูลเปลี่ยนไปหลังจากสร้างแผน กรุณาสร้างแผนใหม่');
  if (plan.missingPermissions.length) throw new MockError(403, 'auth.forbidden', `ต้องมีสิทธิ์ ${plan.missingPermissions.join(', ')}`);
  if (!plan.steps.length) throw new MockError(422, 'correction.empty_plan', 'แผนนี้ไม่มีขั้นตอน');
  const work = structuredClone(st);
  const c: Ctx = { planId, touched: [] };
  for (const s of plan.steps) runStep(work, s, stored.proposed, actor, c);
  delete work.plans![planId];
  Object.assign(st, work);
  return { affected: c.touched.map((docId) => { const d = getDoc(st, docId); return { docId, type: d.type, number: d.number, status: d.status }; }) };
}
