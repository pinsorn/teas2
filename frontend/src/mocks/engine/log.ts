import type { Actor, DocHeader, DocLine, FieldChange } from '@/domain/types';
import { ANCHOR } from '../fixtures/documents';
import type { MockState } from '../store';

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

export function logAudit(st: MockState, actor: Actor, companyId: string, command: string, target?: string, before?: unknown, after?: unknown): void {
  st.audit.push({ id: `aud-${st.audit.length + 1}`, at: stamp(), actor, companyId, command, target, before, after, result: 'ok' });
}

type Body = { header: DocHeader; lines: DocLine[] };
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
    for (const k of keys(la, lb)) push(`lines.${id}.${k}`, la[k], lb[k]);
  }
  return out;
}
