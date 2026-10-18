import type { Actor } from '@/domain/types';
import type { AccountRuleRow, DimensionRule, DimensionsView, DimensionTypeRow, DimensionValueRow } from '@/records/dimensions';
import { FieldErrors, refuseAgent } from '../engine/company';
import { companyEntries } from '../engine/ledger';
import { MockError, logAudit } from '../engine/log';
import { MAX_DIMENSION_TYPES, dimTypesOf, dimValuesOf, ensureDimensions } from '../engine/posting';
import type { MockState } from '../store';

// ST2: dimension types (<= 4), their values, and the per-account rules (required / forbidden; absent = optional). The master is `st.dimensionTypes` / `st.dimensionValues` (absent in the state = the seed's;
// the first write copies it in). Documents and posted lines carry the tag as `{ typeKey: valueCode }`; nothing here rewrites them.

const KEY = /^[a-z][a-z0-9_]{0,19}$/, CODE = /^[A-Za-z0-9_-]{1,20}$/;
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const conflict = () => new MockError(409, 'record.version_conflict', 'ข้อมูลมิตินี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
const inUseError = (what: string) => new MockError(409, 'dimension.in_use', `ลบ${what}ไม่ได้ เพราะมีเอกสารหรือรายการลงบัญชีใช้อยู่ ทางออก: ปิดใช้งานแทนการลบ`);

/** Which (type, value) pairs any document (header or line) or posted line of the company carries. */
function tagsInUse(st: MockState, companyId: string): Set<string> {
  const used = new Set<string>();
  const add = (m?: Record<string, string>) => { for (const [k, v] of Object.entries(m ?? {})) { used.add(`${k}|${v}`); used.add(`${k}|`); } };
  for (const d of st.docs) if (d.companyId === companyId) { add(d.header.dimensions); for (const l of d.lines) add(l.dimensions); }
  for (const e of companyEntries(st, companyId)) for (const l of e.lines) add(l.dimensions);
  return used;
}

export function dimensionsView(st: MockState, companyId: string): DimensionsView {
  const used = tagsInUse(st, companyId), values = dimValuesOf(st, companyId);
  const types: DimensionTypeRow[] = dimTypesOf(st, companyId).map((t) => ({
    key: t.key, nameTh: t.nameTh, version: t.version ?? 1, inUse: used.has(`${t.key}|`),
    values: values.filter((v) => v.typeKey === t.key).map((v): DimensionValueRow => ({ code: v.code, nameTh: v.nameTh, active: v.active, version: v.version ?? 1, inUse: used.has(`${t.key}|${v.code}`) })),
  }));
  return { maxTypes: MAX_DIMENSION_TYPES, types };
}

const typeRow = (st: MockState, companyId: string, key: string) => {
  const t = dimTypesOf(st, companyId).find((x) => x.key === key);
  if (!t) throw new MockError(404, 'dimension.not_found', 'ไม่พบประเภทมิติ');
  return t;
};

export function createDimensionType(st: MockState, actor: Actor, companyId: string, v: Record<string, unknown>): DimensionTypeRow {
  refuseAgent(actor);
  const key = text(v.key), nameTh = text(v.nameTh), e: Record<string, string[]> = {};
  if (!KEY.test(key)) e.key = ['รหัสประเภทมิติใช้ตัวอักษรอังกฤษพิมพ์เล็ก ตัวเลข และ _ ไม่เกิน 20 ตัว ขึ้นต้นด้วยตัวอักษร'];
  if (!nameTh) e.nameTh = ['ต้องระบุชื่อมิติ'];
  else if (nameTh.length > 40) e.nameTh = ['ชื่อมิติยาวเกิน 40 ตัวอักษร'];
  if (Object.keys(e).length) throw new FieldErrors(e);
  const mine = dimTypesOf(st, companyId);
  if (mine.some((t) => t.key === key || t.nameTh === nameTh)) throw new MockError(422, 'dimension.duplicate', 'มีมิติรหัสหรือชื่อนี้อยู่แล้ว');
  if (mine.length >= MAX_DIMENSION_TYPES) throw new MockError(422, 'dimension.max_types', `มิติมีได้ไม่เกิน ${MAX_DIMENSION_TYPES} ประเภท ทางออก: ปิดใช้งานหรือลบประเภทที่ไม่ใช้ก่อน`);
  ensureDimensions(st);
  st.dimensionTypes!.push({ companyId, key, nameTh, version: 1 });
  logAudit(st, actor, companyId, 'dimension.type.create', key, undefined, { key, nameTh });
  return dimensionsView(st, companyId).types.find((t) => t.key === key)!;
}

export function updateDimensionType(st: MockState, actor: Actor, companyId: string, key: string, v: Record<string, unknown>): DimensionTypeRow {
  refuseAgent(actor);
  const t = typeRow(st, companyId, key), nameTh = text(v.nameTh);
  if (v.version !== (t.version ?? 1)) throw conflict();
  if (!nameTh || nameTh.length > 40) throw new FieldErrors({ nameTh: [nameTh ? 'ชื่อมิติยาวเกิน 40 ตัวอักษร' : 'ต้องระบุชื่อมิติ'] });
  if (dimTypesOf(st, companyId).some((x) => x.key !== key && x.nameTh === nameTh)) throw new MockError(422, 'dimension.duplicate', 'มีมิติชื่อนี้อยู่แล้ว');
  ensureDimensions(st);
  const live = st.dimensionTypes!.find((x) => x.companyId === companyId && x.key === key)!, before = { key, nameTh: live.nameTh };
  live.nameTh = nameTh; live.version = (live.version ?? 1) + 1;
  logAudit(st, actor, companyId, 'dimension.type.update', key, before, { key, nameTh });
  return dimensionsView(st, companyId).types.find((x) => x.key === key)!;
}

export function deleteDimensionType(st: MockState, actor: Actor, companyId: string, key: string, version: unknown): void {
  refuseAgent(actor);
  const t = typeRow(st, companyId, key);
  if (version !== (t.version ?? 1)) throw conflict();
  if (tagsInUse(st, companyId).has(`${key}|`)) throw inUseError('ประเภทมิตินี้');
  ensureDimensions(st);
  const rules: Record<string, DimensionRule> = {};
  for (const a of st.accounts) if (a.companyId === companyId && a.dimensionRules?.[key]) { rules[a.code] = a.dimensionRules[key]; delete a.dimensionRules[key]; if (!Object.keys(a.dimensionRules).length) delete a.dimensionRules; }
  st.dimensionTypes = st.dimensionTypes!.filter((x) => !(x.companyId === companyId && x.key === key));
  st.dimensionValues = st.dimensionValues!.filter((x) => !(x.companyId === companyId && x.typeKey === key));
  logAudit(st, actor, companyId, 'dimension.type.delete', key, { key, nameTh: t.nameTh, accountRules: rules }, undefined); // the rules that named it go with it, and the trail keeps them
}

const valueRow = (st: MockState, companyId: string, typeKey: string, code: string) => {
  typeRow(st, companyId, typeKey);
  const x = dimValuesOf(st, companyId).find((y) => y.typeKey === typeKey && y.code === code);
  if (!x) throw new MockError(404, 'dimension.not_found', 'ไม่พบค่ามิติ');
  return x;
};

export function createDimensionValue(st: MockState, actor: Actor, companyId: string, typeKey: string, v: Record<string, unknown>): DimensionValueRow {
  refuseAgent(actor);
  typeRow(st, companyId, typeKey);
  const code = text(v.code), nameTh = text(v.nameTh), e: Record<string, string[]> = {};
  if (!CODE.test(code)) e.code = ['รหัสค่ามิติใช้ตัวอักษรอังกฤษ ตัวเลข - และ _ ไม่เกิน 20 ตัว'];
  if (!nameTh) e.nameTh = ['ต้องระบุชื่อค่ามิติ'];
  else if (nameTh.length > 60) e.nameTh = ['ชื่อค่ามิติยาวเกิน 60 ตัวอักษร'];
  if (Object.keys(e).length) throw new FieldErrors(e);
  if (dimValuesOf(st, companyId).some((x) => x.typeKey === typeKey && x.code === code)) throw new FieldErrors({ code: ['รหัสนี้มีอยู่แล้วในมิตินี้'] });
  ensureDimensions(st);
  st.dimensionValues!.push({ companyId, typeKey, code, nameTh, active: true, version: 1 });
  logAudit(st, actor, companyId, 'dimension.value.create', `${typeKey}:${code}`, undefined, { typeKey, code, nameTh, active: true });
  return dimensionsView(st, companyId).types.find((t) => t.key === typeKey)!.values.find((x) => x.code === code)!;
}

export function updateDimensionValue(st: MockState, actor: Actor, companyId: string, typeKey: string, code: string, v: Record<string, unknown>): DimensionValueRow {
  refuseAgent(actor);
  const x = valueRow(st, companyId, typeKey, code);
  if (v.version !== (x.version ?? 1)) throw conflict();
  const nameTh = 'nameTh' in v ? text(v.nameTh) : x.nameTh, active = typeof v.active === 'boolean' ? v.active : x.active;
  if (!nameTh || nameTh.length > 60) throw new FieldErrors({ nameTh: [nameTh ? 'ชื่อค่ามิติยาวเกิน 60 ตัวอักษร' : 'ต้องระบุชื่อค่ามิติ'] });
  ensureDimensions(st);
  const live = st.dimensionValues!.find((y) => y.companyId === companyId && y.typeKey === typeKey && y.code === code)!, before = { code, nameTh: live.nameTh, active: live.active };
  live.nameTh = nameTh; live.active = active; live.version = (live.version ?? 1) + 1;
  logAudit(st, actor, companyId, 'dimension.value.update', `${typeKey}:${code}`, before, { code, nameTh, active });
  return dimensionsView(st, companyId).types.find((t) => t.key === typeKey)!.values.find((y) => y.code === code)!;
}

export function deleteDimensionValue(st: MockState, actor: Actor, companyId: string, typeKey: string, code: string, version: unknown): void {
  refuseAgent(actor);
  const x = valueRow(st, companyId, typeKey, code);
  if (version !== (x.version ?? 1)) throw conflict();
  if (tagsInUse(st, companyId).has(`${typeKey}|${code}`)) throw inUseError('ค่ามิตินี้');
  ensureDimensions(st);
  st.dimensionValues = st.dimensionValues!.filter((y) => !(y.companyId === companyId && y.typeKey === typeKey && y.code === code));
  logAudit(st, actor, companyId, 'dimension.value.delete', `${typeKey}:${code}`, { code, nameTh: x.nameTh, active: x.active }, undefined);
}

// ---------------------------------------------------------------- account rules

export const listAccountRules = (st: MockState, companyId: string): AccountRuleRow[] =>
  st.accounts.filter((a) => a.companyId === companyId && a.postable && a.active !== false).map((a) => ({ code: a.code, nameTh: a.nameTh, version: a.version ?? 1, rules: { ...(a.dimensionRules ?? {}) } }));

/** Replaces one account's rules. Only `required` / `forbidden` are stored (`optional` = no rule). The engine judges these at issue, revise and the plan - never retroactively. */
export function setAccountRules(st: MockState, actor: Actor, companyId: string, accountCode: string, v: { rules?: unknown; version?: unknown }): AccountRuleRow {
  refuseAgent(actor);
  const a = st.accounts.find((x) => x.companyId === companyId && x.code === accountCode);
  const bad = (m: string) => new MockError(422, 'dimension.rule_invalid', m);
  if (!a || !a.postable) throw bad(`บัญชี ${accountCode} ไม่มีในผังบัญชีหรือเป็นบัญชีหมวด กำหนดกฎมิติไม่ได้`);
  if (v.version !== (a.version ?? 1)) throw new MockError(409, 'record.version_conflict', 'บัญชีนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
  if (!v.rules || typeof v.rules !== 'object' || Array.isArray(v.rules)) throw bad('ข้อมูลกฎมิติไม่ถูกต้อง');
  const types = new Set(dimTypesOf(st, companyId).map((t) => t.key)), next: Record<string, DimensionRule> = {};
  for (const [k, r] of Object.entries(v.rules)) {
    if (!types.has(k)) throw bad(`ไม่พบประเภทมิติ ${k}`);
    if (r !== 'required' && r !== 'optional' && r !== 'forbidden') throw bad(`กฎมิติต้องเป็น ต้องระบุ / ไม่บังคับ / ห้ามระบุ (ได้ ${String(r)})`);
    if (r !== 'optional') next[k] = r;
  }
  const before = { ...(a.dimensionRules ?? {}) };
  if (Object.keys(next).length) a.dimensionRules = next; else delete a.dimensionRules;
  a.version = (a.version ?? 1) + 1;
  logAudit(st, actor, companyId, 'dimension.rules.update', accountCode, before, next);
  return listAccountRules(st, companyId).find((x) => x.code === accountCode)!;
}
