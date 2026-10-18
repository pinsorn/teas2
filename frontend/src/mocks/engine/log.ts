import type { Actor, Allocation, DocHeader, DocLine, FieldChange } from '@/domain/types';
import { ANCHOR } from '../fixtures/documents';
import type { MockState } from '../store';
import type { PostingRule } from './posting';

/** Thrown by every engine command; handlers map it to problem+json. The message carries the code so tests can match it. */
export class MockError extends Error {
  constructor(public status: number, public code: string, public title: string) { super(`${code}: ${title}`); }
}

/** The mock world's "today" (the seed never reads the clock either). */
export const today = () => ANCHOR;
let fixed: { base: number; n: number } | undefined;
/** Server clock: the real one, or inside `withFixedClock` the pinned instant plus one second per call (seed history, D-23). */
export const stamp = () => (fixed ? new Date(fixed.base + 1000 * fixed.n++).toISOString() : new Date().toISOString());
/** True while history is being replayed: documents are posted "as of" their own date, so period/future checks do not apply. */
export const isPinned = () => fixed !== undefined;
export function withFixedClock<T>(iso: string, fn: () => T): T {
  const prev = fixed;
  fixed = { base: Date.parse(iso), n: 0 };
  try { return fn(); } finally { fixed = prev; }
}

export function logActivity(st: MockState, docId: string, actor: Actor, action: string, detail?: string): void {
  const n = st.activity.filter((a) => a.docId === docId).length + 1;
  st.activity.push({ docId, id: `act-${docId}-${n}`, at: stamp(), actor, action, ...(detail ? { detail } : {}) });
}

/** The one place an audit entry is written. RP3: the mock has one caller address and a deterministic trace id (the entry count), so the seed is stable; an agent's calls arrive over MCP, everything else from the web app. The trail is append-only: ids are unique and count up (invariant). Time is a fact about the event and is never adjusted. */
export function logAudit(st: MockState, actor: Actor, companyId: string, command: string, target?: string, before?: unknown, after?: unknown): void {
  const n = st.audit.length + 1;
  st.audit.push({ id: `aud-${n}`, at: stamp(), // the event's own time, never adjusted
    actor, companyId, command, target, before, after, result: 'ok', ip: '127.0.0.1', traceId: `trc-${n}`, client: actor.kind === 'agent' ? 'mcp' : 'web' });
}

// RP3 ruling 4: the events the mock has no screen for yet, as minimal commands (the seed and, later, the real screens call them).
export const recordLogin = (st: MockState, actor: Actor, companyId: string): void => logAudit(st, actor, companyId, 'auth.login', actor.id);
export const recordCompanySwitch = (st: MockState, actor: Actor, from: string, to: string): void => logAudit(st, actor, to, 'company.switch', undefined, { activeCompanyId: from }, { activeCompanyId: to });
/** Re-point one posting rule at another account (the rule is found by company, role, level and key). */
export function changePostingRule(st: MockState, actor: Actor, companyId: string, find: Pick<PostingRule, 'role' | 'level' | 'key'>, accountCode: string): void {
  const r = st.postingRules.find((x) => x.companyId === companyId && x.role === find.role && x.level === find.level && x.key === find.key);
  if (!r) throw new MockError(404, 'posting.rule_not_found', 'ไม่พบกฎการลงบัญชี');
  const before = { role: r.role, level: r.level, key: r.key, accountCode: r.accountCode };
  r.accountCode = accountCode;
  logAudit(st, actor, companyId, 'posting.rule.update', `${r.role}:${r.level}:${r.key ?? ''}`, before, { ...before, accountCode });
}
/** Change the withholding rate (basis points) of one WHT type of the company from `effectiveFrom` (default today): a NEW dated rate row, like every rate table (`whtTypeOf` takes the latest row in force on the document's date),
 *  so a document dated before the change keeps the old rate; a change on a date that already has a row replaces that row's rate. */
export function changeTaxRate(st: MockState, actor: Actor, companyId: string, code: string, rateBp: number, effectiveFrom: string = today()): void {
  const inForce = st.whtTypes.filter((x) => x.companyId === companyId && x.code === code && x.effectiveFrom <= effectiveFrom).sort((x, y) => y.effectiveFrom.localeCompare(x.effectiveFrom))[0];
  if (!inForce) throw new MockError(404, 'tax.type_not_found', 'ไม่พบประเภทภาษีหัก ณ ที่จ่าย');
  const before = { code, rateBp: inForce.rateBp, effectiveFrom: inForce.effectiveFrom };
  if (inForce.effectiveFrom === effectiveFrom) inForce.rateBp = rateBp; // the date already has its row: a correction REPLACES it (a second row of one date would never apply)
  else st.whtTypes.push({ ...inForce, rateBp, effectiveFrom });
  logAudit(st, actor, companyId, 'tax.table.update', code, before, { code, rateBp, effectiveFrom });
}

/** Changed leaves of two JSON-ish values as dotted paths, text on both sides (null = absent); same `val` as the document diff. A value that is not an object compares as one path "". */
export function diffFlat(a: unknown, b: unknown): FieldChange[] {
  const flat = (v: unknown, p: string, out: Map<string, string | null>) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flat(x, p ? `${p}.${k}` : k, out);
    else out.set(p, val(v));
    return out;
  };
  const x = flat(a, '', new Map()), y = flat(b, '', new Map());
  return [...new Set([...x.keys(), ...y.keys()])].filter((k) => (x.get(k) ?? null) !== (y.get(k) ?? null)).map((path) => ({ path, before: x.get(path) ?? null, after: y.get(path) ?? null }));
}

type Body = { header: DocHeader; lines: DocLine[]; allocations?: Allocation[] };
const val = (v: unknown): string | null => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
const keys = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])];

export function diffBody(a: Body, b: Body): FieldChange[] {
  const out: FieldChange[] = [];
  const push = (path: string, x: unknown, y: unknown) => { const bx = val(x), by = val(y); if (bx !== by) out.push({ path, before: bx, after: by }); };
  const ah = a.header as unknown as Record<string, unknown>, bh = b.header as unknown as Record<string, unknown>;
  for (const k of keys(ah, bh)) push(`header.${k}`, ah[k], bh[k]);
  const ids = [...new Set([...a.lines.map((l) => l.id), ...b.lines.map((l) => l.id)])];
  for (const id of ids) {
    const la = a.lines.find((l) => l.id === id) as unknown as Record<string, unknown> | undefined;
    const lb = b.lines.find((l) => l.id === id) as unknown as Record<string, unknown> | undefined;
    if (!la || !lb) { push(`lines.${id}`, la?.description, lb?.description); continue; }
    for (const k of keys(la, lb)) if (k !== 'postedAccount') push(`lines.${id}.${k}`, la[k], lb[k]); // engine-set (ST2c): never a client change
  }
  // settlement allocations, one path per target (a certificate number edit shows as allocations.<target>.certNumber)
  const aa = new Map((a.allocations ?? []).map((x) => [x.targetId, x as unknown as Record<string, unknown>]));
  const ab = new Map((b.allocations ?? []).map((x) => [x.targetId, x as unknown as Record<string, unknown>]));
  for (const id of new Set([...aa.keys(), ...ab.keys()])) {
    const x = aa.get(id), y = ab.get(id);
    if (!x || !y) { push(`allocations.${id}`, x?.amount, y?.amount); continue; }
    for (const k of keys(x, y)) if (k !== 'targetNumber') push(`allocations.${id}.${k}`, x[k], y[k]);
  }
  return out;
}
