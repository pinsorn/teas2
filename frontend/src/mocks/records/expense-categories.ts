import type { Actor } from '@/domain/types';
import type { ExpenseCategoryItem } from '@/records/expense-categories';
import { FieldErrors, refuseAgent } from '../engine/company';
import { MockError, logAudit } from '../engine/log';
import { type ExpenseCategoryRow, categoriesOf, ensureCategories, roleProblem } from '../engine/posting';
import type { MockState } from '../store';

// ST2 ruling 6: expense categories (SP0 §5.5), editable. A category is keyed by its code, which documents store on their lines (C1), so the code never changes; everything else may. The category's account IS its
// category-level Expense posting rule (this module writes the rule; a rule edit writes the account back), and - ruling 1 - an edit applies to the NEXT posting only.

const CODE = /^[a-z][a-z0-9-]{0,29}$/;
const conflict = () => new MockError(409, 'record.version_conflict', 'หมวดค่าใช้จ่ายนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The asset classes the company can capitalise to: the ones with a FixedAsset rule. */
export const assetClassesOf = (st: MockState, companyId: string): string[] => st.postingRules.filter((r) => r.companyId === companyId && r.role === 'FixedAsset' && r.level === 'category' && r.key).map((r) => r.key!);

function inUse(st: MockState, companyId: string, code: string): boolean {
  return st.docs.some((d) => d.companyId === companyId && d.lines.some((l) => l.expenseCategory === code))
    || st.items.some((i) => i.companyId === companyId && i.expenseCategory === code) || categoriesOf(st, companyId).some((c) => c.parent === code);
}
const item = (st: MockState, c: ExpenseCategoryRow): ExpenseCategoryItem => ({
  code: c.code, nameTh: c.nameTh, ...(c.accountCode ? { accountCode: c.accountCode } : {}), recoverableVat: c.recoverableVat, capex: !!c.capex, ...(c.assetClass ? { assetClass: c.assetClass } : {}),
  ...(c.defaultWhtType ? { defaultWhtType: c.defaultWhtType } : {}), ...(c.parent ? { parent: c.parent } : {}), active: c.active !== false, version: c.version ?? 1, inUse: inUse(st, c.companyId, c.code),
});
export const listCategories = (st: MockState, companyId: string): ExpenseCategoryItem[] => categoriesOf(st, companyId).map((c) => item(st, c));

interface Clean { nameTh: string; accountCode?: string; recoverableVat: boolean; capex: boolean; assetClass?: string; defaultWhtType?: string; parent?: string; active?: boolean }
function validate(st: MockState, companyId: string, v: Record<string, unknown>, selfCode: string): Clean {
  const e: Record<string, string[]> = {}, add = (k: string, m: string) => { (e[k] ??= []).push(m); };
  const nameTh = text(v.nameTh), capex = v.capex === true, accountCode = text(v.accountCode) || undefined, assetClass = text(v.assetClass) || undefined, wht = text(v.defaultWhtType) || undefined, parent = text(v.parent) || undefined;
  if (!nameTh) add('nameTh', 'ต้องระบุชื่อหมวด'); else if (nameTh.length > 60) add('nameTh', 'ชื่อหมวดยาวเกิน 60 ตัวอักษร');
  if (typeof v.recoverableVat !== 'boolean') add('recoverableVat', 'ต้องระบุว่าภาษีซื้อขอคืนได้หรือไม่');
  if (capex) {
    if (!assetClass || !assetClassesOf(st, companyId).includes(assetClass)) add('assetClass', 'ต้องเลือกประเภทสินทรัพย์ที่มีอยู่ในระบบ');
  } else if (!accountCode) add('accountCode', 'ต้องระบุบัญชีค่าใช้จ่าย');
  if (wht && !st.whtTypes.some((t) => t.companyId === companyId && t.code === wht)) add('defaultWhtType', 'ไม่พบประเภทภาษีหัก ณ ที่จ่ายนี้');
  if (parent && !categoriesOf(st, companyId).some((c) => c.code === parent)) add('parent', 'ไม่พบหมวดแม่');
  if (Object.keys(e).length) throw new FieldErrors(e);
  if (!capex) { const bad = roleProblem(st, companyId, 'Expense', accountCode!); if (bad) throw bad; }
  for (let p = parent, hops = 0; p; p = categoriesOf(st, companyId).find((c) => c.code === p)?.parent, hops++) { // walking up from the parent must never meet this category
    if (p === selfCode || hops > 50) throw new MockError(422, 'category.cycle', 'ตั้งหมวดแม่เป็นตัวเองหรือหมวดลูกของตัวเองไม่ได้ (เป็นวงกลม)');
  }
  return { nameTh, ...(capex ? {} : { accountCode }), recoverableVat: v.recoverableVat as boolean, capex, ...(capex ? { assetClass } : {}), ...(wht ? { defaultWhtType: wht } : {}), ...(parent ? { parent } : {}),
    ...(typeof v.active === 'boolean' ? { active: v.active } : {}) };
}
const shape = (c: ExpenseCategoryRow) => ({ code: c.code, nameTh: c.nameTh, accountCode: c.accountCode, recoverableVat: c.recoverableVat, capex: !!c.capex, assetClass: c.assetClass, defaultWhtType: c.defaultWhtType, parent: c.parent, active: c.active !== false });

/** The category's account and its category-level Expense rule are one fact: write the rule (or drop it for a capex category, which capitalises to its asset class). */
function syncRule(st: MockState, c: ExpenseCategoryRow): void {
  const at = st.postingRules.findIndex((r) => r.companyId === c.companyId && r.level === 'category' && r.key === c.code && r.role === 'Expense');
  if (c.capex || !c.accountCode) { if (at >= 0) st.postingRules.splice(at, 1); return; }
  if (at >= 0) { st.postingRules[at].accountCode = c.accountCode; st.postingRules[at].version = (st.postingRules[at].version ?? 1) + 1; }
  else st.postingRules.push({ companyId: c.companyId, level: 'category', key: c.code, role: 'Expense', accountCode: c.accountCode, version: 1 });
}

export function createCategory(st: MockState, actor: Actor, companyId: string, v: Record<string, unknown>): ExpenseCategoryItem {
  refuseAgent(actor);
  const code = text(v.code);
  if (!CODE.test(code)) throw new FieldErrors({ code: ['รหัสหมวดใช้ตัวอักษรอังกฤษพิมพ์เล็ก ตัวเลข และ - ไม่เกิน 30 ตัว ขึ้นต้นด้วยตัวอักษร'] });
  if (categoriesOf(st, companyId).some((c) => c.code === code)) throw new FieldErrors({ code: ['รหัสหมวดนี้มีอยู่แล้ว'] });
  const clean = validate(st, companyId, v, code);
  const c: ExpenseCategoryRow = { companyId, code, ...clean, active: clean.active ?? true, version: 1 };
  ensureCategories(st).push(c);
  syncRule(st, c);
  logAudit(st, actor, companyId, 'category.create', code, undefined, shape(c));
  return item(st, c);
}

const find = (st: MockState, companyId: string, code: string): ExpenseCategoryRow => {
  const c = categoriesOf(st, companyId).find((x) => x.code === code);
  if (!c) throw new MockError(404, 'category.not_found', 'ไม่พบหมวดค่าใช้จ่าย');
  return c;
};

export function updateCategory(st: MockState, actor: Actor, companyId: string, code: string, v: Record<string, unknown>): ExpenseCategoryItem {
  refuseAgent(actor);
  const cur = find(st, companyId, code);
  if (v.version !== (cur.version ?? 1)) throw conflict();
  const clean = validate(st, companyId, v, code);
  ensureCategories(st);
  const c = find(st, companyId, code), before = shape(c);
  for (const k of ['accountCode', 'assetClass', 'defaultWhtType', 'parent'] as const) delete c[k];
  Object.assign(c, clean, { active: clean.active ?? c.active, version: (c.version ?? 1) + 1 });
  syncRule(st, c);
  logAudit(st, actor, companyId, 'category.update', code, before, shape(c));
  return item(st, c);
}

export function deleteCategory(st: MockState, actor: Actor, companyId: string, code: string, version: unknown): void {
  refuseAgent(actor);
  const cur = find(st, companyId, code);
  if (version !== (cur.version ?? 1)) throw conflict();
  if (inUse(st, companyId, code)) throw new MockError(409, 'category.in_use', `ลบหมวด ${cur.nameTh} ไม่ได้ เพราะมีเอกสาร สินค้า/บริการ หรือหมวดลูกใช้อยู่ ทางออก: ปิดใช้งานแทนการลบ`);
  ensureCategories(st);
  const before = shape(cur);
  st.expenseCategories = st.expenseCategories!.filter((x) => !(x.companyId === companyId && x.code === code));
  st.postingRules = st.postingRules.filter((r) => !(r.companyId === companyId && r.level === 'category' && r.key === code && r.role === 'Expense'));
  logAudit(st, actor, companyId, 'category.delete', code, before, undefined);
}
