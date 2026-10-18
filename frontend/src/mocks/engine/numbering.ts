import { DOC_TYPES } from '@/domain/doc-types';
import type { Actor, DocType, IsoDate } from '@/domain/types';
import type { MockState } from '../store';
import { MockError, logAudit, today } from './log';

export const formatDocNumber = (prefix: DocType, date: IsoDate, seq: number) =>
  `${prefix}-${date.slice(0, 4)}${date.slice(5, 7)}-${String(seq).padStart(4, '0')}`;

/** The seed's own allocator (fixtures number their documents with the default format). The engine allocates with `allocateNumber`. */
export class SeriesAllocator {
  private counters: Map<string, number>;
  constructor(init: Record<string, number> = {}) { this.counters = new Map(Object.entries(init)); }
  next(companyId: string, type: DocType, date: IsoDate): string {
    const key = `${companyId}|${type}|${date.slice(0, 7)}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return formatDocNumber(type, date, n);
  }
  toJSON(): Record<string, number> { return Object.fromEntries(this.counters); }
}

// ---- ST3: numbering series. The FORMAT IS FROZEN PER SERIES KEY (company x type x period): the first number of a key stores the format in force on it (`st.seriesFormats`), every later number of that key uses it.
// A config change therefore applies from the first period that has no numbers yet. The gap audit, the numbering invariant and `allocateNumber` all read a key's format through `templateOfKey` / `parseNumber` (one reading).

export type NumberingScope = 'monthly' | 'yearly';
export interface NumberingConfig { companyId: string; docType: DocType; prefix: string; scope: NumberingScope; branch?: string; format: string; version?: number }
export interface NumberingRow { docType: DocType; prefix: string; scope: NumberingScope; branch?: string; format: string; version: number; next: string }
export const DEFAULT_FORMAT = '{PREFIX}-{YYYY}{MM}-{####}';
const NOT_SETTING = 'numbering.not_found';
// (company.ts is not imported here: documents.ts -> numbering.ts -> company.ts -> log.ts -> documents.ts is an import cycle that breaks `class FieldErrors extends MockError`.)
const refuseAgent = (actor: Actor): void => { if (actor.kind === 'agent') throw new MockError(403, 'agent.forbidden_setting', 'ตัวแทน (agent) เปลี่ยนการตั้งค่าไม่ได้ ต้องให้ผู้ใช้ทำเอง'); };

export const numberingOf = (st: MockState, companyId: string, type: DocType): NumberingConfig =>
  st.numbering?.find((c) => c.companyId === companyId && c.docType === type) ?? { companyId, docType: type, prefix: type, scope: 'monthly', format: DEFAULT_FORMAT };

/** The period of a series key: `yyyy-mm` (monthly) or `yyyy` (yearly). */
export const periodOfKey = (key: string): string => key.split('|')[2];
const typeOfKey = (key: string): DocType => key.split('|')[1] as DocType;
export const scopeOfKey = (key: string): NumberingScope => (periodOfKey(key).length === 4 ? 'yearly' : 'monthly');
export const seriesKeyOf = (companyId: string, type: DocType, date: IsoDate, scope: NumberingScope): string => `${companyId}|${type}|${scope === 'yearly' ? date.slice(0, 4) : date.slice(0, 7)}`;
/** What a key's numbers look like when nothing is stored on it: the original `TYPE-yyyymm-####` (every seeded number). */
const legacyTemplate = (type: DocType) => `${type}-{YYYY}{MM}-{####}`;
export const templateOfKey = (st: MockState, key: string): string => st.seriesFormats?.[key] ?? legacyTemplate(typeOfKey(key));
const resolve = (c: Pick<NumberingConfig, 'prefix' | 'branch' | 'format'>) => c.format.replaceAll('{PREFIX}', c.prefix).replaceAll('{BRANCH}', c.branch ?? '');

const TOKEN = /\{(YYYY|YY|MM|#{3,8})\}/g;
export const formatByTemplate = (tpl: string, period: string, seq: number): string =>
  tpl.replace(TOKEN, (_m, t: string) => (t === 'YYYY' ? period.slice(0, 4) : t === 'YY' ? period.slice(2, 4) : t === 'MM' ? period.slice(5, 7) : String(seq).padStart(t.length, '0')));

const compiled = new Map<string, RegExp>();
const regexOf = (tpl: string): RegExp => {
  let r = compiled.get(tpl);
  if (!r) {
    let src = '', at = 0;
    for (const m of tpl.matchAll(TOKEN)) { src += tpl.slice(at, m.index).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'); src += m[1] === 'YYYY' ? '(?<y>\\d{4})' : m[1] === 'YY' ? '(?<yy>\\d{2})' : m[1] === 'MM' ? '(?<m>\\d{2})' : `(?<n>\\d{${m[1].length},})`; at = m.index! + m[0].length; }
    r = new RegExp(`^${src}${tpl.slice(at).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}$`);
    compiled.set(tpl, r);
  }
  return r;
};

/** The one parser: which series key and sequence a number belongs to, under the formats stored on the company's keys of that type (and the original one). Undefined = it is the number of no series. */
export function parseNumber(st: MockState, companyId: string, type: DocType, number: string): { key: string; seq: number } | undefined {
  const tpls = new Set<string>([legacyTemplate(type)]);
  for (const [k, t] of Object.entries(st.seriesFormats ?? {})) if (k.startsWith(`${companyId}|${type}|`)) tpls.add(t);
  const hits = new Map<string, number>(); // ST3a M1: a number must belong to exactly one key; two keys that both store a matching format make it malformed (never a guess)
  for (const tpl of tpls) {
    const g = regexOf(tpl).exec(number)?.groups;
    if (!g) continue;
    const year = g.y ?? `20${g.yy}`, key = g.m ? `${companyId}|${type}|${year}-${g.m}` : `${companyId}|${type}|${year}`;
    if (templateOfKey(st, key) === tpl) hits.set(key, Number(g.n));
  }
  if (hits.size !== 1) return undefined;
  const [[key, seq]] = [...hits];
  return { key, seq };
}

/** ST3a M1: a period keeps one scope. If the date's year already has numbers in one scope (any monthly key of that year, or the yearly key) every date of that year keeps it; a scope switch applies from the first year with no numbers. */
export function scopeForDate(st: MockState, companyId: string, type: DocType, date: IsoDate, configured: NumberingScope): NumberingScope {
  const pre = `${companyId}|${type}|${date.slice(0, 4)}`;
  for (const [k, n] of Object.entries(st.series)) if (n > 0 && k.startsWith(pre) && (k.length === pre.length || k[pre.length] === '-')) return scopeOfKey(k);
  return configured;
}
/** The template a NEW key of this scope gets: the configured one, or - when the year keeps the other scope - the format of the year's latest key. */
function templateForNew(st: MockState, cfg: NumberingConfig, key: string, scope: NumberingScope): string {
  if (scope === cfg.scope) return resolve(cfg);
  const pre = `${cfg.companyId}|${cfg.docType}|${periodOfKey(key).slice(0, 4)}`;
  const latest = Object.keys(st.series).filter((k) => st.series[k] > 0 && k.startsWith(pre) && (k.length === pre.length || k[pre.length] === '-')).sort().at(-1);
  return latest ? templateOfKey(st, latest) : resolve(cfg);
}
/** Would the number `seq` of `key` under `tpl` parse back (one parser) to exactly its own key and sequence? */
function parsesToOwnKey(st: MockState, companyId: string, type: DocType, key: string, tpl: string, seq: number): boolean {
  const p = parseNumber({ ...st, seriesFormats: { ...(st.seriesFormats ?? {}), [key]: tpl } }, companyId, type, formatByTemplate(tpl, periodOfKey(key), seq));
  return p?.key === key && p.seq === seq;
}
const EXIT = 'ทางออก: แก้รูปแบบเลขที่ในหน้าตั้งค่าเลขที่เอกสาร (เช่น ใส่ตัวคั่นระหว่างปี เดือน และตัวนับ)';

/** The next number of a company's type for a document dated `date`; the first allocation of a key stores the format in force. A number another document already holds is a collision (never issued twice). */
export function allocateNumber(st: MockState, companyId: string, type: DocType, date: IsoDate): string {
  const cfg = numberingOf(st, companyId, type), scope = scopeForDate(st, companyId, type, date, cfg.scope), key = seriesKeyOf(companyId, type, date, scope), have = st.series[key] ?? 0;
  const stored = st.seriesFormats?.[key], tpl = stored ?? (have ? legacyTemplate(type) : templateForNew(st, cfg, key, scope));
  const number = formatByTemplate(tpl, periodOfKey(key), have + 1);
  if (!parsesToOwnKey(st, companyId, type, key, tpl, have + 1)) throw new MockError(409, 'numbering.ambiguous', `เลขที่ ${number} อ่านกลับเป็นชุดเลขอื่นได้ ออกเลขนี้ไม่ได้ ${EXIT}`);
  if (st.docs.some((d) => d.companyId === companyId && d.type === type && d.number === number)) throw new MockError(409, 'numbering.collision', `เลขที่ ${number} มีเอกสารใช้แล้ว ออกเลขซ้ำไม่ได้ ทางออก: แก้รูปแบบเลขที่ในหน้าตั้งค่าเลขที่เอกสาร`);
  if (!stored) (st.seriesFormats ??= {})[key] = tpl;
  st.series[key] = have + 1;
  return number;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const bad = (code: string, title: string) => new MockError(422, code, title);
/** Validates a config (§5.14) and returns its resolved template. */
function validate(c: Pick<NumberingConfig, 'prefix' | 'scope' | 'branch' | 'format'>): string {
  if (!/^[A-Za-z0-9-]{1,10}$/.test(c.prefix)) throw bad('numbering.bad_prefix', 'คำนำหน้าใช้ตัวอักษรอังกฤษ ตัวเลข และ - ไม่เกิน 10 ตัว');
  if (c.scope !== 'monthly' && c.scope !== 'yearly') throw bad('numbering.bad_scope', 'ต้องเลือกนับเลขรายเดือนหรือรายปี');
  if (c.branch !== undefined && !/^[A-Za-z0-9]{1,6}$/.test(c.branch)) throw bad('numbering.bad_branch', 'รหัสสาขาใช้ตัวอักษรอังกฤษหรือตัวเลขไม่เกิน 6 ตัว');
  const groups: string[] = c.format.match(/\{[^}]*\}/g) ?? [];
  const unknown = groups.find((g) => !/^\{(PREFIX|BRANCH|YYYY|YY|MM|#{3,8})\}$/.test(g));
  if (unknown) throw bad('numbering.bad_token', `ไม่รู้จักตัวแทน ${unknown} ใช้ได้เฉพาะ {PREFIX} {BRANCH} {YYYY} {YY} {MM} {####}`);
  if (groups.includes('{BRANCH}') && !c.branch) throw bad('numbering.bad_token', 'รูปแบบใช้ {BRANCH} ต้องระบุสาขา');
  if (!/^[A-Za-z0-9\-/_.]*$/.test(c.format.replace(/\{[^}]*\}/g, ''))) throw bad('numbering.bad_token', 'ข้อความคงที่ในรูปแบบใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข - / _ .');
  const has = (t: string) => groups.includes(t), counters = groups.filter((g) => g.startsWith('{#'));
  if (counters.length !== 1) throw bad(counters.length ? 'numbering.bad_token' : 'numbering.missing_token', counters.length ? 'ใช้ตัวนับ {####} ได้เพียงตัวเดียว' : 'รูปแบบต้องมีตัวนับ {####}');
  if (has('{YYYY}') && has('{YY}')) throw bad('numbering.bad_token', 'ใช้ปีได้เพียงแบบเดียว ({YYYY} หรือ {YY})');
  const year = has('{YYYY}') || has('{YY}');
  if (c.scope === 'monthly' && !(has('{MM}') && year)) throw bad('numbering.missing_token', 'เลขรายเดือนต้องมี {MM} และปี ({YYYY} หรือ {YY})');
  if (c.scope === 'yearly' && (!year || has('{MM}'))) throw bad('numbering.missing_token', 'เลขรายปีต้องมีปี ({YYYY} หรือ {YY}) และห้ามมี {MM}');
  return resolve(c);
}

const nextPeriod = (key: string): string => {
  const p = periodOfKey(key);
  if (p.length === 4) return String(Number(p) + 1);
  const [y, m] = p.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
/** The first number a config would give: today's period when it has no numbers, else the next period (the format of a key with numbers is frozen). */
function firstNumber(st: MockState, companyId: string, type: DocType, tpl: string, scope: NumberingScope): { number: string; period: string; inUse: boolean; switched: boolean } {
  const kept = scopeForDate(st, companyId, type, today(), scope), switched = kept !== scope;
  let key = seriesKeyOf(companyId, type, today(), scope), inUse = (st.series[key] ?? 0) > 0, period = inUse ? nextPeriod(key) : periodOfKey(key);
  if (switched) { const y = Number(today().slice(0, 4)) + 1; period = scope === 'yearly' ? String(y) : `${y}-01`; inUse = true; } // this year keeps its scope: the new one starts with the first year without numbers
  key = `${companyId}|${type}|${period}`;
  if (!parsesToOwnKey(st, companyId, type, key, tpl, 1)) throw new MockError(422, 'numbering.ambiguous', `เลขที่แรกตามรูปแบบนี้ (${formatByTemplate(tpl, period, 1)}) อ่านกลับเป็นชุดเลขอื่นได้ ${EXIT}`);
  return { number: formatByTemplate(tpl, period, 1), period, inUse, switched };
}
/** The number the next document dated today gets. */
function nextNumber(st: MockState, companyId: string, type: DocType): string {
  const cfg = numberingOf(st, companyId, type), scope = scopeForDate(st, companyId, type, today(), cfg.scope), key = seriesKeyOf(companyId, type, today(), scope), have = st.series[key] ?? 0;
  return formatByTemplate(st.seriesFormats?.[key] ?? (have ? legacyTemplate(type) : templateForNew(st, cfg, key, scope)), periodOfKey(key), have + 1);
}
const rowOf = (st: MockState, companyId: string, type: DocType): NumberingRow => {
  const c = numberingOf(st, companyId, type);
  return { docType: type, prefix: c.prefix, scope: c.scope, ...(c.branch ? { branch: c.branch } : {}), format: c.format, version: c.version ?? 1, next: nextNumber(st, companyId, type) };
};
const known = (st: MockState, companyId: string, type: string): DocType => {
  const vat = !!st.companies.find((c) => c.id === companyId)?.vatRegistered, i = DOC_TYPES[type as DocType];
  if (!i || type === 'OB' || (i.vat === 'vat-only' && !vat) || (i.vat === 'non-vat-only' && vat)) throw new MockError(404, NOT_SETTING, 'ไม่พบประเภทเอกสาร');
  return type as DocType;
};

/** Every numbered document type of the company (an opening-balance batch keeps the old document's numbers; a type the company cannot issue is not listed). */
export const listNumbering = (st: MockState, companyId: string): NumberingRow[] => {
  const vat = !!st.companies.find((c) => c.id === companyId)?.vatRegistered;
  return (Object.keys(DOC_TYPES) as DocType[]).filter((t) => { const v = DOC_TYPES[t].vat; return t !== 'OB' && !(v === 'vat-only' && !vat) && !(v === 'non-vat-only' && vat); }).map((t) => rowOf(st, companyId, t));
};

const configOf = (companyId: string, type: DocType, b: Record<string, unknown>): NumberingConfig =>
  ({ companyId, docType: type, prefix: text(b.prefix), scope: b.scope as NumberingScope, ...(text(b.branch) ? { branch: text(b.branch) } : {}), format: text(b.format) });

/** What a config would number first (read-only, nothing saved): the server's own formatting for the form's preview, with the same refusals as a save. */
export function previewNumbering(st: MockState, companyId: string, type: string, b: Record<string, unknown>): { next: string; period: string; inUse: boolean } {
  const t = known(st, companyId, type), cfg = configOf(companyId, t, b), f = firstNumber(st, companyId, t, validate(cfg), cfg.scope);
  return { next: f.number, period: f.period, inUse: f.inUse };
}

export function updateNumbering(st: MockState, actor: Actor, companyId: string, type: string, b: Record<string, unknown>): { row: NumberingRow; notice?: { code: string; title: string } } {
  refuseAgent(actor);
  const t = known(st, companyId, type), cur = numberingOf(st, companyId, t);
  if (b.version !== (cur.version ?? 1)) throw new MockError(409, 'record.version_conflict', 'รูปแบบเลขที่นี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
  const cfg = configOf(companyId, t, b), f = firstNumber(st, companyId, t, validate(cfg), cfg.scope);
  if (st.docs.some((d) => d.companyId === companyId && d.type === t && d.number === f.number)) {
    throw new MockError(422, 'numbering.collision', `เลขที่ถัดไปตามรูปแบบนี้ (${f.number}) มีเอกสารใช้แล้ว ทางออก: เปลี่ยนรูปแบบหรือคำนำหน้า`);
  }
  const next: NumberingConfig = { ...cfg, version: (cur.version ?? 1) + 1 };
  const list = (st.numbering ??= []), at = list.findIndex((c) => c.companyId === companyId && c.docType === t);
  if (at >= 0) list[at] = next; else list.push(next);
  logAudit(st, actor, companyId, 'numbering.update', t, { prefix: cur.prefix, scope: cur.scope, branch: cur.branch, format: cur.format }, { prefix: next.prefix, scope: next.scope, branch: next.branch, format: next.format });
  return { row: rowOf(st, companyId, t), ...(f.inUse ? { notice: { code: 'numbering.in_use', title: `${f.switched ? 'ปีนี้มีเลขที่ออกแล้วด้วยการนับเลขแบบเดิม จึงใช้แบบเดิมต่อจนสิ้นปี ' : 'มีเลขที่ออกแล้วในงวดปัจจุบัน '}รูปแบบใหม่มีผลตั้งแต่งวด ${f.period} (เลขที่ที่ออกแล้วไม่เปลี่ยน)` } } : {}) };
}
