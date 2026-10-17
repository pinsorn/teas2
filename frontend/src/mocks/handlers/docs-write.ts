import { DOC_TYPES, isTypeAvailable } from '@/domain/doc-types';
import { HttpResponse, http } from 'msw';
import type { Actor, AttachmentCategory, DocHeader, DocType, MarkKey, Qty } from '@/domain/types';
import { addAttachment, discardAttachment, listAttachments, markPrinted, removeAttachment } from '../engine/attachments';
import { PAPER_BUILDERS } from '../engine/paper';
import { buildChain } from '../engine/chain';
import { approve, sendBack } from '../engine/approval';
import { type Body, keepOmitted, unavailableTh, approveAndIssue, cancel, compute, convert, createDraft, deleteDraft, issue, publicDoc, submitForApproval, updateDraft } from '../engine/commands';
import { refuseJvRevise, reverseJv } from '../engine/journal';
import { payRun, refuseLaterRun, unpayRun } from '../engine/payroll';
import { employeeImpl } from '../records/employees';
import { controlExit } from '../engine/reconcile';
import { resolvedBankId } from '../engine/settlement';
import { buildPlan, correctionPlan, executePlan, planStale } from '../engine/corrections';
import { activateAsset, disposeAsset, planDepreciation, reverseDisposal, reviseAsset, reviseDp, runDepreciation, saleNeedsApproval, suggestMonth, unregisteredCapex } from '../engine/assets';
import { MockError } from '../engine/log';
import { closeRemainder, remainingOf, setMark } from '../engine/marks';
import { CLASS } from '../fixtures/documents';
import { refuseInactiveBank } from '../records/bank-accounts';
import { saveState } from '../store';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };

/** vatOverride (correction notes) and allocation targetNumber are engine-set only: never accepted from an API caller. */
const WHT_MODES = ['deduct', 'grossup_once', 'grossup_always'];
export const stripOverrides = <T extends Body>(b0: T): T => {
  let b = b0;
  // the shape of the request, refused where it enters (create, update, compute, correction plan): an unknown withholding mode would otherwise be read as "deduct" by some paths and as a gross-up by others
  if (b?.header?.whtMode != null && !WHT_MODES.includes(b.header.whtMode)) throw new MockError(422, 'wht.mode_invalid', `โหมดภาษีหัก ณ ที่จ่าย “${String(b.header.whtMode)}” ไม่ถูกต้อง ใช้ได้เฉพาะ: ${WHT_MODES.join(', ')}`);
  if (b?.header && ('reversalOf' in b.header || 'autoReversal' in b.header)) { const { reversalOf, autoReversal, ...h } = b.header; void reversalOf; void autoReversal; b = { ...b, header: h }; } // JV: a reversal's link is engine-set (reverse / auto-reverse), never accepted from a caller
  if (b?.header && ('obBatchId' in b.header || 'obSide' in b.header || 'obKind' in b.header)) { const { obBatchId, obSide, obKind, ...h } = b.header; void obBatchId; void obSide; void obKind; b = { ...b, header: h }; } // OB: the frozen items are engine-made, never accepted from a caller
  if (b?.opening) { const { codes, ...o } = b.opening; void codes; b = { ...b, opening: { ...o, openItems: Array.isArray(o.openItems) ? o.openItems.map((i) => { const { partyName, ...r } = i; void partyName; return r; }) : o.openItems } }; } // OB: the frozen account codes and party names are engine-set at issue / revise, never accepted (an item id is kept: the engine checks it against the stored batch)
  if (b && 'payroll' in b) { const { payroll, ...r } = b as T & { payroll?: unknown }; void payroll; b = r as T; } // PR: the frozen slips are engine-made at issue / revise, never accepted from a caller
  if (b?.header && 'disposal' in b.header) { const { disposal, ...h } = b.header; void disposal; b = { ...b, header: h }; } // AC5: a disposal invoice is made by the asset's dispose command only; its frozen figures are never accepted from a caller
  if (b?.header && 'bankSnapshot' in b.header) { const { bankSnapshot, ...h } = b.header; void bankSnapshot; b = { ...b, header: h }; } // engine-set at issue (I3): never accepted from a caller
  if (!Array.isArray(b?.lines)) return b;
  const lines = b.lines.map((l) => { if (!l || typeof l !== 'object') return l; const { vatOverride, ...r } = l; void vatOverride; return r; });
  // `targetNumber` is engine-set (the engine re-reads it from the target); only the user's own figures and the certificate number come from the caller
  const allocations = Array.isArray(b.allocations)
    ? b.allocations.map((a) => { if (!a || typeof a !== 'object') return a; const { targetNumber, partyId, ...r } = a; void targetNumber; void partyId; return r; }) : b.allocations;
  return { ...b, lines, ...(allocations ? { allocations } : {}) };
};

type Ctx = ReturnType<typeof ctx>;
type Out = Response | Promise<Response>;

/** Screen-state gate, type/company availability and one permission check; MockError becomes problem+json. */
async function guarded(type: string | undefined, perm: ((t: DocType) => string) | string | null, run: (c: Ctx, t: DocType) => Out): Promise<Response> {
  const gate = await screenGate('item');
  if (gate) return gate;
  try {
    const c = ctx();
    if (!type || !Object.hasOwn(CLASS, type)) return problem(404, 'doc.type_not_available', 'ไม่รู้จักประเภทเอกสารนี้');
    const t = type as DocType;
    if (!isTypeAvailable(t, c.company.vatRegistered)) return problem(404, 'doc.type_not_available', unavailableTh(t));
    const need = typeof perm === 'function' ? perm(t) : perm;
    if (need && !c.perms.includes(need)) return forbidden(need);
    return await run(c, t);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.title);
    throw e;
  }
}

/** AC5: an asset and a depreciation run are made by their own commands (register / run), never by the generic routes. Cancel is the generic route (the engine's rules decide). */
const generic: typeof guarded = (type, perm, run) => guarded(type, perm, (c, t) => (t === 'FA' || t === 'DP'
  ? problem(409, 'doc.use_asset_screen', t === 'FA' ? 'สินทรัพย์ลงทะเบียนจากหน้า “ลงทะเบียนสินทรัพย์” (จากรายการซื้อสินทรัพย์หรือยอดยกมา) แก้ไขเงื่อนไขและจำหน่ายได้จากหน้าสินทรัพย์' : 'ค่าเสื่อมราคาคิดจากหน้า “คิดค่าเสื่อมราคา” รายเดือน แก้ไขโดยคำนวณใหม่หรือยกเลิกจากงวดล่าสุด')
  : run(c, t)));

/** The document must exist in the active company with the URL's type. */
function own(c: Ctx, type: DocType, id: unknown) {
  const d = c.st.docs.find((x) => x.id === id && x.type === type && x.companyId === c.company.id);
  if (!d) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
  return d;
}
/** AC5: an optional `version` the caller holds; a stale one is refused (same as /recompute). */
const staleVersion = (d: { version: number }, v: number | undefined) => { if (v !== undefined && v !== d.version) throw new MockError(409, 'doc.version_conflict', 'เอกสารถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่'); };
const versionOf = (req: Request, body?: { version?: number }) => {
  const v = body?.version ?? Number(req.headers.get('If-Match')?.replace(/"/g, ''));
  if (!Number.isFinite(v)) throw new MockError(422, 'doc.version_required', 'ต้องระบุเวอร์ชันของเอกสาร');
  return v;
};
const done = (c: Ctx) => persist(c.st);

/** I1: the rule judges the RESOLVED account (a cash receipt uses the cash box, whatever bank id it carries); `kept` = the stored document's own header, whose account stays allowed. */
const refuseInactive = (c: Ctx, type: DocType, header: DocHeader | undefined, kept?: DocHeader) =>
  refuseInactiveBank(c.st, c.company.id, resolvedBankId(c.st, c.company.id, type, header), resolvedBankId(c.st, c.company.id, type, kept));

const P = (perm: string) => (t: DocType) => `doc.${t}.${perm}`;

export const docsWriteHandlers = [
  http.post('*/bff/v1/docs/:type/compute', ({ request, params }) => generic(String(params.type), P('read'), async (c, t) =>
    {
    const docId = new URL(request.url).searchParams.get('docId') ?? undefined; // revise mode: the issued document's own settlements are given back
    if (docId) own(c, t, docId);
    const { journal, ...r } = compute(c.st, c.company.id, t, stripOverrides((await request.json()) as Body), { docId });
    return HttpResponse.json(c.perms.includes('ledger.read') ? { ...r, journal } : r); // D-09: no journal without ledger.read
  })),

  http.post('*/bff/v1/docs/:type', ({ request, params }) => generic(String(params.type), P('create'), async (c, t) => {
    const key = request.headers.get('Idempotency-Key') ?? crypto.randomUUID();
    const body = stripOverrides((await request.json()) as Body);
    refuseInactive(c, t, body?.header); // the shape of the request, refused where it enters: a new document does not pick a closed account
    const doc = createDraft(c.st, c.company.id, t, body, ACTOR, key);
    done(c);
    return HttpResponse.json(doc, { status: 201 });
  })),

  http.put('*/bff/v1/docs/:type/:id', ({ request, params }) => generic(String(params.type), P('create'), async (c, t) => {
    const stored = own(c, t, params.id);
    const body = stripOverrides((await request.json()) as Body & { version?: number });
    refuseInactive(c, t, body?.header, stored.header); // keeping the account it already has is fine
    const doc = updateDraft(c.st, String(params.id), body, versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),

  http.delete('*/bff/v1/docs/:type/:id', ({ request, params }) => generic(String(params.type), P('create'), (c, t) => {
    own(c, t, params.id);
    const q = new URL(request.url).searchParams.get('version');
    deleteDraft(c.st, String(params.id), versionOf(request, q ? { version: Number(q) } : undefined), ACTOR);
    done(c);
    return new HttpResponse(null, { status: 204 });
  })),

  http.post('*/bff/v1/docs/:type/:id/issue', ({ request, params }) => generic(String(params.type), P('issue'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const doc = issue(c.st, String(params.id), versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),

  // §7.6 approval. The gate itself is in the engine (issue refuses an unapproved document); these are the ways through it, each with its own right.
  http.post('*/bff/v1/docs/:type/:id/submit', ({ request, params }) => generic(String(params.type), P('create'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const doc = submitForApproval(c.st, String(params.id), versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),
  http.post('*/bff/v1/docs/:type/:id/approve', ({ request, params }) => generic(String(params.type), P('approve'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const doc = approve(c.st, String(params.id), versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),
  http.post('*/bff/v1/docs/:type/:id/approve-and-issue', ({ request, params }) => generic(String(params.type), P('approve'), async (c, t) => {
    own(c, t, params.id);
    if (!c.perms.includes(`doc.${t}.issue`)) return forbidden(`doc.${t}.issue`); // one action only for a person who holds BOTH rights
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const doc = approveAndIssue(c.st, String(params.id), versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),
  http.post('*/bff/v1/docs/:type/:id/send-back', ({ request, params }) => generic(String(params.type), P('approve'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json().catch(() => ({}))) as { version?: number; reason?: string };
    const doc = sendBack(c.st, String(params.id), versionOf(request, body), typeof body.reason === 'string' ? body.reason : '', ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),

  http.post('*/bff/v1/docs/:type/:id/cancel', ({ request, params }) => guarded(String(params.type), P('cancel'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json()) as { version?: number; reasonCode: string; reasonText: string };
    const doc = cancel(c.st, String(params.id), versionOf(request, body), body.reasonCode, body.reasonText, ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),

  // AC1 "กลับรายการ": a JV's entry is reversed by a reversing JV; any other document is refused with the exit (its own cancel / correction)
  http.post('*/bff/v1/docs/:type/:id/reverse', ({ request, params }) => generic(String(params.type), P('issue'), async (c, t) => {
    own(c, t, params.id);
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { date?: string; reason?: string };
    if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw new MockError(422, 'ledger.reverse_date', 'วันที่กลับรายการไม่ถูกต้อง');
    const r = reverseJv(c.st, String(params.id), ACTOR, { ...(body.date ? { date: body.date } : {}), ...(typeof body.reason === 'string' && body.reason.trim() ? { reason: body.reason.trim() } : {}) });
    done(c);
    return HttpResponse.json(publicDoc(r), { status: 201 });
  })),
  // PY2: pay a payroll run (the whole run, from one own account) and the way out of it. Both are PR-only commands of their own right (`doc.PR.pay`); the engine judges everything before it writes.
  http.post('*/bff/v1/docs/PR/:id/pay', ({ request, params }) => guarded('PR', 'doc.PR.pay', async (c) => {
    own(c, 'PR', params.id);
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { accountId?: string; date?: string; version?: number };
    const doc = payRun(c.st, c.company.id, String(params.id), { ...(typeof b.accountId === 'string' && b.accountId ? { accountId: b.accountId } : {}), date: b.date as string, version: versionOf(request, b) }, ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),
  http.post('*/bff/v1/docs/PR/:id/unpay', ({ request, params }) => guarded('PR', 'doc.PR.pay', async (c) => {
    own(c, 'PR', params.id);
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { reason?: string; version?: number };
    const doc = unpayRun(c.st, c.company.id, String(params.id), { reason: typeof b.reason === 'string' ? b.reason : '', version: versionOf(request, b) }, ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),
  // the accounts a journal voucher may post to: postable, none a document owns (the server refuses the others at issue)
  // AC3 (?for=OB): the opening balance posts to controlled accounts too (it ties them to their steps); only 3900, the system's plug, is left out
  http.get('*/bff/v1/accounting/journal-accounts', ({ request }) => guarded(new URL(request.url).searchParams.get('for') === 'OB' ? 'OB' : 'JV', P('create'), (c) => HttpResponse.json(
    c.st.accounts.filter((a) => a.companyId === c.company.id && a.postable && a.active !== false && (new URL(request.url).searchParams.get('for') === 'OB' ? a.subClass !== 'opening' && a.subClass !== 'current-year' : !controlExit(c.st, c.company.id, a.code, 'jv'))).map((a) => ({ code: a.code, nameTh: a.nameTh, class: a.class }))))),

  // PY1: an employee on any payroll run is deactivated, never deleted (the exit says so); an unused one can go
  http.delete('*/bff/v1/records/employee/:id', async ({ request, params }) => {
    const gate = await screenGate('item');
    if (gate) return gate;
    try {
      const c = ctx();
      if (!c.perms.includes('employee.manage')) return forbidden('employee.manage');
      const p = c.st.parties.find((x) => x.id === params.id && x.companyId === c.company.id && x.kind === 'employee');
      if (!p) return problem(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
      const v = new URL(request.url).searchParams.get('version');
      if (v !== null && Number(v) !== (p.version ?? 1)) return problem(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
      employeeImpl.remove(c.st, c.company.id, p.id);
      persist(c.st);
      return new HttpResponse(null, { status: 204 });
    } catch (e) {
      if (e instanceof MockError) return problem(e.status, e.code, e.title);
      throw e;
    }
  }),

  http.post('*/bff/v1/docs/:type/:id/correction-plan', ({ request, params }) => generic(String(params.type), P('create'), async (c, t) => {
    const orig = own(c, t, params.id);
    const proposal = stripOverrides((await request.json()) as Body);
    if (t === 'JV') refuseJvRevise(c.st, orig, proposal); // a reversed JV and a reversal are final: refused before a plan is shown
    if (t === 'PR') refuseLaterRun(c.st, orig); // PY1: a run a later run builds on cannot be revised: refused before a plan is shown (exit: the next run's adjustment lines)
    refuseInactive(c, t, proposal?.header && keepOmitted(orig, proposal.header), orig.header); // I2: a correction cannot re-point the document to a closed account
    const plan = correctionPlan(c.st, String(params.id), proposal, c.s.role);
    done(c);
    return HttpResponse.json(plan);
  })),

  http.post('*/bff/v1/corrections', async ({ request }) => {
    const gate = await screenGate('item');
    if (gate) return gate;
    try {
      const c = ctx();
      const { planId, planHash } = (await request.json()) as { planId: string; planHash: string };
      const stored = c.st.plans?.[planId];
      const target = stored && c.st.docs.find((d) => d.id === stored.docId && d.companyId === c.company.id);
      if (!stored || !target) throw new MockError(404, 'correction.plan_not_found', 'ไม่พบแผนการแก้ไข');
      let current;
      refuseInactive(c, target.type, stored.proposed.header && keepOmitted(target, stored.proposed.header), target.header); // I2: the account may have been closed since the plan was made
      try { current = buildPlan(c.st, stored.docId, stored.proposed, c.s.role); } catch { throw planStale(); } // the world moved since the plan: stale, not a raw engine error
      for (const s of current.steps) if (!c.perms.includes(s.permission)) return forbidden(s.permission);
      const result = executePlan(c.st, planId, planHash, ACTOR, c.s.role);
      done(c);
      return HttpResponse.json(result);
    } catch (e) {
      if (e instanceof MockError) return problem(e.status, e.code, e.title);
      throw e;
    }
  }),

  http.post('*/bff/v1/docs/:type/:id/convert', ({ request, params }) => generic(String(params.type), P('read'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json()) as { targetType: DocType; lines: { sourceLineId: string; qty: Qty }[] };
    if (!Object.hasOwn(CLASS, body.targetType)) throw new MockError(422, 'doc.conversion_not_allowed', 'ประเภทเอกสารปลายทางไม่ถูกต้อง');
    const need = `doc.${body.targetType}.create`;
    if (!c.perms.includes(need)) return forbidden(need);
    const doc = convert(c.st, String(params.id), body.targetType, body.lines, ACTOR);
    done(c);
    return HttpResponse.json(doc, { status: 201 });
  })),

  http.post('*/bff/v1/docs/:type/:id/marks', ({ request, params }) => generic(String(params.type), P('issue'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json()) as { mark: MarkKey; version?: number; reason?: string };
    const doc = setMark(c.st, String(params.id), body.mark, versionOf(request, body), ACTOR, body.reason);
    done(c);
    return HttpResponse.json(doc);
  })),

  http.post('*/bff/v1/docs/:type/:id/close-remainder', ({ request, params }) => generic(String(params.type), P('issue'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json()) as { version?: number; reason?: string };
    const doc = closeRemainder(c.st, String(params.id), versionOf(request, body), body.reason ?? '', ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),

  http.get('*/bff/v1/docs/:type/:id/remaining', ({ params }) => guarded(String(params.type), P('read'), (c, t) => {
    own(c, t, params.id);
    return HttpResponse.json(remainingOf(c.st, String(params.id)));
  })),

  http.get('*/bff/v1/docs/:type/:id/chain', ({ params }) => guarded(String(params.type), P('read'), (c, t) => {
    own(c, t, params.id);
    return HttpResponse.json(buildChain(c.st, String(params.id)));
  })),
  http.get('*/bff/v1/docs/:type/:id/activity', ({ params }) => guarded(String(params.type), P('read'), (c, t) => {
    own(c, t, params.id);
    return HttpResponse.json(c.st.activity.filter((a) => a.docId === params.id).map(({ docId, ...a }) => (void docId, a)).sort((a, b) => b.at.localeCompare(a.at)));
  })),
  http.get('*/bff/v1/docs/:type/:id/revisions', ({ params }) => guarded(String(params.type), P('read'), (c, t) => {
    own(c, t, params.id);
    return HttpResponse.json(c.st.revisions.filter((r) => r.docId === params.id).map(({ docId, ...r }) => (void docId, r)).sort((a, b) => b.revision - a.revision));
  })),
  http.get('*/bff/v1/docs/:type/:id/ledger', ({ params }) => guarded(String(params.type), P('read'), (c, t) => {
    if (!c.perms.includes('ledger.read')) return forbidden('ledger.read'); // D-09: the document's read is checked first, then the ledger's
    own(c, t, params.id);
    return HttpResponse.json(c.st.journals.find((j) => j.docId === params.id)?.preview ?? { entries: [] });
  })),
  http.get('*/bff/v1/docs/:type/:id/attachments', ({ params }) => guarded(String(params.type), P('read'), (c, t) => {
    own(c, t, params.id);
    return HttpResponse.json(listAttachments(c.st, String(params.id)));
  })),
  http.post('*/bff/v1/docs/:type/:id/attachments', ({ request, params }) => guarded(String(params.type), P('create'), async (c, t) => {
    const d = own(c, t, params.id);
    const a = addAttachment(c.st, d, (await request.json()) as { category: AttachmentCategory; name: string; mime: string; dataUrl: string }, ACTOR);
    if (!saveState(c.st)) { // the bytes went in but the record of them did not: undo, never claim a file the next read would not find
      discardAttachment(c.st, a.id);
      return problem(507, 'attachment.storage_full', 'พื้นที่เก็บไฟล์ตัวอย่างเต็ม — ลบไฟล์แนบเก่าหรือรีเซ็ตข้อมูลตัวอย่าง');
    }
    return HttpResponse.json(a, { status: 201 });
  })),
  http.delete('*/bff/v1/docs/:type/:id/attachments/:attId', ({ params }) => guarded(String(params.type), P('create'), (c, t) => {
    const d = own(c, t, params.id);
    removeAttachment(c.st, d, String(params.attId), ACTOR);
    done(c);
    return new HttpResponse(null, { status: 204 });
  })),
  // the print action was used (the paper page's print button): what it counts as is the server's decision
  http.post('*/bff/v1/docs/:type/:id/printed', ({ request, params }) => guarded(String(params.type), P('read'), async (c0, t) => {
    own(c0, t, params.id);
    const body = (await request.json().catch(() => ({}))) as { copy?: boolean };
    const c = ctx(); // the body was awaited: read the state again so two quick prints (two tabs) see each other and only one is the original
    const doc = own(c, t, params.id);
    const r = markPrinted(c.st, doc, body.copy === true, ACTOR, t === 'WT' && PAPER_BUILDERS.WT && !['draft', 'pending', 'approved'].includes(doc.status) ? PAPER_BUILDERS.WT(c, publicDoc(doc), false) : undefined); // 50 tawi: frozen at the first print (I7)
    done(c);
    return HttpResponse.json(r);
  })),
  http.get('*/bff/v1/docs/:type/:id/paper', ({ request, params }) => guarded(String(params.type), P('read'), (c, t) => {
    const d = own(c, t, params.id);
    const builder = PAPER_BUILDERS[t];
    if (!DOC_TYPES[t].printable || !builder) return problem(404, 'doc.paper_not_available', 'ยังไม่มีแบบพิมพ์สำหรับเอกสารประเภทนี้');
    if (['draft', 'pending', 'approved'].includes(d.status)) return problem(409, 'doc.not_printable', 'เอกสารที่ยังไม่ได้ออกพิมพ์ไม่ได้ ต้องออกเอกสารก่อน');
    return HttpResponse.json(builder(c, publicDoc(d), new URL(request.url).searchParams.get('copy') === '1'));
  })),

  // ---- AC5 fixed assets and depreciation runs: their own commands (the generic routes refuse FA / DP, see `generic`)
  http.get('*/bff/v1/assets/unregistered', () => guarded('FA', 'doc.FA.read', (c) => HttpResponse.json({ items: unregisteredCapex(c.st, c.company.id) }))),
  http.post('*/bff/v1/assets', ({ request }) => guarded('FA', 'doc.FA.create', async (c) => {
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { source?: never; name?: string; salvage?: string; lifeMonths?: number; startDate?: string };
    const fa = activateAsset(c.st, c.company.id, { source: b.source as never, ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(typeof b.salvage === 'string' ? { salvage: b.salvage } : {}), ...(b.lifeMonths !== undefined ? { lifeMonths: b.lifeMonths } : {}), ...(typeof b.startDate === 'string' ? { startDate: b.startDate } : {}) }, ACTOR);
    done(c);
    return HttpResponse.json(publicDoc(fa), { status: 201 });
  })),
  http.post('*/bff/v1/docs/FA/:id/dispose', ({ request, params }) => guarded('FA', 'doc.FA.issue', async (c) => {
    const d = own(c, 'FA', params.id);
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { date?: string; kind?: 'sale' | 'write_off'; proceeds?: string; buyerId?: string; version?: number };
    staleVersion(d, b.version);
    const inv = c.company.vatRegistered ? 'TI' : 'IV';
    if (b.kind === 'sale') for (const v of ['create', 'issue']) if (!c.perms.includes(`doc.${inv}.${v}`)) return forbidden(`doc.${inv}.${v}`); // the sale issues the invoice: its rights too
    if (b.kind === 'sale' && saleNeedsApproval(c.st, c.company.id, b.proceeds) && !c.perms.includes(`doc.${inv}.approve`)) return forbidden(`doc.${inv}.approve`); // a policy-gated invoice is approved by whoever may, not by the dispose command
    const fa = disposeAsset(c.st, c.company.id, String(params.id), { date: String(b.date), kind: b.kind as 'sale', ...(b.proceeds !== undefined ? { proceeds: b.proceeds } : {}), ...(b.buyerId ? { buyerId: b.buyerId } : {}) }, ACTOR);
    done(c);
    return HttpResponse.json(publicDoc(fa));
  })),
  http.post('*/bff/v1/docs/FA/:id/undispose', ({ request, params }) => guarded('FA', 'doc.FA.cancel', async (c) => {
    const d = own(c, 'FA', params.id);
    staleVersion(d, (((await request.json().catch(() => ({}))) ?? {}) as { version?: number }).version);
    const fa = reverseDisposal(c.st, c.company.id, String(params.id), ACTOR);
    done(c);
    return HttpResponse.json(publicDoc(fa));
  })),
  http.post('*/bff/v1/docs/FA/:id/terms', ({ request, params }) => guarded('FA', 'doc.FA.correct', async (c) => {
    const d = own(c, 'FA', params.id);
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { name?: string; salvage?: string; lifeMonths?: number; startDate?: string; version?: number };
    staleVersion(d, b.version);
    const fa = reviseAsset(c.st, c.company.id, String(params.id), { ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(typeof b.salvage === 'string' ? { salvage: b.salvage } : {}), ...(b.lifeMonths !== undefined ? { lifeMonths: b.lifeMonths } : {}), ...(typeof b.startDate === 'string' ? { startDate: b.startDate } : {}) }, ACTOR);
    done(c);
    return HttpResponse.json(publicDoc(fa));
  })),
  http.get('*/bff/v1/depreciation/preview', ({ request }) => guarded('DP', 'doc.DP.read', (c) => {
    const month = new URL(request.url).searchParams.get('month') || suggestMonth(c.st, c.company.id);
    const { problem: pb, ...plan } = planDepreciation(c.st, c.company.id, month);
    return HttpResponse.json({ ...plan, suggested: suggestMonth(c.st, c.company.id), ...(pb ? { problem: { status: pb.status, code: pb.code, title: pb.title } } : {}) });
  })),
  http.post('*/bff/v1/depreciation/runs', ({ request }) => guarded('DP', 'doc.DP.issue', async (c) => {
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { month?: string };
    const dp = runDepreciation(c.st, c.company.id, String(b.month), ACTOR);
    done(c);
    return HttpResponse.json(publicDoc(dp), { status: 201 });
  })),
  http.post('*/bff/v1/docs/DP/:id/recompute', ({ request, params }) => guarded('DP', 'doc.DP.correct', async (c) => {
    const d = own(c, 'DP', params.id);
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { version?: number };
    staleVersion(d, b.version);
    const dp = reviseDp(c.st, d.id, ACTOR);
    done(c);
    return HttpResponse.json(publicDoc(dp));
  })),
];


