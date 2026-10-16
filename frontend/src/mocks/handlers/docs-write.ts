import { DOC_TYPES, isTypeAvailable } from '@/domain/doc-types';
import { HttpResponse, http } from 'msw';
import type { Actor, AttachmentCategory, DocType, MarkKey, Qty } from '@/domain/types';
import { addAttachment, discardAttachment, listAttachments, markPrinted, removeAttachment } from '../engine/attachments';
import { PAPER_BUILDERS } from '../engine/paper';
import { buildChain } from '../engine/chain';
import { approve, sendBack } from '../engine/approval';
import { type Body, unavailableTh, approveAndIssue, cancel, compute, convert, createDraft, deleteDraft, issue, publicDoc, submitForApproval, updateDraft } from '../engine/commands';
import { buildPlan, correctionPlan, executePlan, planStale } from '../engine/corrections';
import { MockError } from '../engine/log';
import { closeRemainder, remainingOf, setMark } from '../engine/marks';
import { CLASS } from '../fixtures/documents';
import { saveState } from '../store';
import { ctx, forbidden, persist, problem, screenGate } from './common';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };

/** vatOverride (correction notes) and allocation targetNumber are engine-set only: never accepted from an API caller. */
export const stripOverrides = <T extends Body>(b: T): T => {
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

/** The document must exist in the active company with the URL's type. */
function own(c: Ctx, type: DocType, id: unknown) {
  const d = c.st.docs.find((x) => x.id === id && x.type === type && x.companyId === c.company.id);
  if (!d) throw new MockError(404, 'doc.not_found', 'ไม่พบเอกสาร');
  return d;
}
const versionOf = (req: Request, body?: { version?: number }) => {
  const v = body?.version ?? Number(req.headers.get('If-Match')?.replace(/"/g, ''));
  if (!Number.isFinite(v)) throw new MockError(422, 'doc.version_required', 'ต้องระบุเวอร์ชันของเอกสาร');
  return v;
};
const done = (c: Ctx) => persist(c.st);

const P = (perm: string) => (t: DocType) => `doc.${t}.${perm}`;

export const docsWriteHandlers = [
  http.post('*/bff/v1/docs/:type/compute', ({ request, params }) => guarded(String(params.type), P('read'), async (c, t) =>
    {
    const docId = new URL(request.url).searchParams.get('docId') ?? undefined; // revise mode: the issued document's own settlements are given back
    if (docId) own(c, t, docId);
    const { journal, ...r } = compute(c.st, c.company.id, t, stripOverrides((await request.json()) as Body), { docId });
    return HttpResponse.json(c.perms.includes('ledger.read') ? { ...r, journal } : r); // D-09: no journal without ledger.read
  })),

  http.post('*/bff/v1/docs/:type', ({ request, params }) => guarded(String(params.type), P('create'), async (c, t) => {
    const key = request.headers.get('Idempotency-Key') ?? crypto.randomUUID();
    const doc = createDraft(c.st, c.company.id, t, stripOverrides((await request.json()) as Body), ACTOR, key);
    done(c);
    return HttpResponse.json(doc, { status: 201 });
  })),

  http.put('*/bff/v1/docs/:type/:id', ({ request, params }) => guarded(String(params.type), P('create'), async (c, t) => {
    own(c, t, params.id);
    const body = stripOverrides((await request.json()) as Body & { version?: number });
    const doc = updateDraft(c.st, String(params.id), body, versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),

  http.delete('*/bff/v1/docs/:type/:id', ({ request, params }) => guarded(String(params.type), P('create'), (c, t) => {
    own(c, t, params.id);
    const q = new URL(request.url).searchParams.get('version');
    deleteDraft(c.st, String(params.id), versionOf(request, q ? { version: Number(q) } : undefined), ACTOR);
    done(c);
    return new HttpResponse(null, { status: 204 });
  })),

  http.post('*/bff/v1/docs/:type/:id/issue', ({ request, params }) => guarded(String(params.type), P('issue'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const doc = issue(c.st, String(params.id), versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),

  // §7.6 approval. The gate itself is in the engine (issue refuses an unapproved document); these are the ways through it, each with its own right.
  http.post('*/bff/v1/docs/:type/:id/submit', ({ request, params }) => guarded(String(params.type), P('create'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const doc = submitForApproval(c.st, String(params.id), versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),
  http.post('*/bff/v1/docs/:type/:id/approve', ({ request, params }) => guarded(String(params.type), P('approve'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const doc = approve(c.st, String(params.id), versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),
  http.post('*/bff/v1/docs/:type/:id/approve-and-issue', ({ request, params }) => guarded(String(params.type), P('approve'), async (c, t) => {
    own(c, t, params.id);
    if (!c.perms.includes(`doc.${t}.issue`)) return forbidden(`doc.${t}.issue`); // one action only for a person who holds BOTH rights
    const body = (await request.json().catch(() => ({}))) as { version?: number };
    const doc = approveAndIssue(c.st, String(params.id), versionOf(request, body), ACTOR);
    done(c);
    return HttpResponse.json(doc);
  })),
  http.post('*/bff/v1/docs/:type/:id/send-back', ({ request, params }) => guarded(String(params.type), P('approve'), async (c, t) => {
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

  http.post('*/bff/v1/docs/:type/:id/correction-plan', ({ request, params }) => guarded(String(params.type), P('create'), async (c, t) => {
    own(c, t, params.id);
    const plan = correctionPlan(c.st, String(params.id), stripOverrides((await request.json()) as Body), c.s.role);
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

  http.post('*/bff/v1/docs/:type/:id/convert', ({ request, params }) => guarded(String(params.type), P('read'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json()) as { targetType: DocType; lines: { sourceLineId: string; qty: Qty }[] };
    if (!Object.hasOwn(CLASS, body.targetType)) throw new MockError(422, 'doc.conversion_not_allowed', 'ประเภทเอกสารปลายทางไม่ถูกต้อง');
    const need = `doc.${body.targetType}.create`;
    if (!c.perms.includes(need)) return forbidden(need);
    const doc = convert(c.st, String(params.id), body.targetType, body.lines, ACTOR);
    done(c);
    return HttpResponse.json(doc, { status: 201 });
  })),

  http.post('*/bff/v1/docs/:type/:id/marks', ({ request, params }) => guarded(String(params.type), P('issue'), async (c, t) => {
    own(c, t, params.id);
    const body = (await request.json()) as { mark: MarkKey; version?: number; reason?: string };
    const doc = setMark(c.st, String(params.id), body.mark, versionOf(request, body), ACTOR, body.reason);
    done(c);
    return HttpResponse.json(doc);
  })),

  http.post('*/bff/v1/docs/:type/:id/close-remainder', ({ request, params }) => guarded(String(params.type), P('issue'), async (c, t) => {
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
];

