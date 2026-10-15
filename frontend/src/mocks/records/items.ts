import type { RecordRow } from '@/domain/records';
import type { ItemSummary } from '@/domain/types';
import { MockError } from '../engine/log';
import { EXPENSE_CATEGORIES } from '../fixtures/expense-categories';
import type { MockState } from '../store';
import type { RecordKindImpl } from './registry';

type Item = MockState['items'][number];
type Values = Record<string, unknown>;

const KINDS = ['good', 'service'];
const TAX_CODES = ['S7', 'Z0', 'EX'];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const mine = (st: MockState, companyId: string) => st.items.filter((i) => i.companyId === companyId);
const used = (st: MockState, i: Item) => st.docs.some((d) => d.companyId === i.companyId && d.lines.some((l) => l.itemId === i.id));
const vatOf = (st: MockState, companyId: string) => st.companies.find((c) => c.id === companyId)!.vatRegistered;
/** Blank = 0.00; otherwise a non-negative number with at most two decimals. */
const price = (v: unknown): string | undefined => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!s) return '0.00';
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s).toFixed(2) : undefined;
};

/** The flat record a form edits; `usage` is the derived key the list column labels. */
function toRow(st: MockState, i: Item): RecordRow {
  const { sales, purchase } = i.usage;
  return {
    id: i.id, version: i.version ?? 1, active: i.active !== false, inUse: used(st, i),
    kind: i.kind, code: i.code, name: i.name, unit: i.unit, unitPrice: i.unitPrice, taxCode: i.taxCode, whtTypeCode: i.whtTypeCode,
    usage: sales && purchase ? 'both' : purchase ? 'purchase' : 'sales', usageSales: sales, usagePurchase: purchase, expenseCategory: i.expenseCategory,
  };
}

export const itemImpl: RecordKindImpl = {
  perms: { read: 'item.read', manage: 'item.manage' },
  rows: (st, companyId) => mine(st, companyId).map((i) => toRow(st, i)),

  validate(v, st, companyId, id) {
    const e: Record<string, string[]> = {};
    const add = (k: string, m: string) => { (e[k] ??= []).push(m); };
    const kind = String(v.kind ?? '');
    if (!KINDS.includes(kind)) add('kind', 'ต้องเลือกประเภท');
    const code = str(v.code);
    const prev = id ? mine(st, companyId).find((i) => i.id === id) : undefined;
    if (!code) add('code', 'ต้องระบุรหัส');
    else if (mine(st, companyId).some((i) => i.code === code && i.id !== id)) add('code', 'รหัสนี้ใช้แล้ว');
    else if (prev && code !== prev.code && used(st, prev)) add('code', 'รหัสแก้ไม่ได้หลังจากใช้ในเอกสารแล้ว');
    if (!str(v.name)) add('name', 'ต้องระบุชื่อ');
    if (!str(v.unit)) add('unit', 'ต้องระบุหน่วย');
    if (price(v.unitPrice) === undefined) add('unitPrice', 'ราคาต่อหน่วยต้องเป็นตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง');
    // a non-VAT company has no VAT code to choose: whatever arrives is ignored (stored EX)
    if (vatOf(st, companyId) && str(v.taxCode) && !TAX_CODES.includes(String(v.taxCode))) add('taxCode', 'รหัสภาษีไม่ถูกต้อง');
    const wht = str(v.whtTypeCode);
    if (kind !== 'good' && wht && !st.whtTypes.some((t) => t.companyId === companyId && t.code === wht)) add('whtTypeCode', 'ไม่พบประเภทภาษีหัก ณ ที่จ่ายนี้');
    if (v.usageSales !== true && v.usagePurchase !== true) add('usageSales', 'ต้องเลือกอย่างน้อยหนึ่งการใช้งาน');
    const cat = str(v.expenseCategory);
    if (v.usagePurchase === true && cat && !EXPENSE_CATEGORIES.some((c) => c.code === cat)) add('expenseCategory', 'ไม่พบหมวดค่าใช้จ่ายนี้');
    return e;
  },

  create(st, companyId, v) {
    const code = str(v.code)!;
    const stem = vatOf(st, companyId) ? code : `nv-${code}`;
    let id = stem;
    for (let n = 2; st.items.some((i) => i.id === id); n++) id = `${stem}-${n}`; // a renamed code can leave its old id behind
    const item = build(st, undefined, { id, companyId }, v);
    st.items.push(item);
    return toRow(st, item);
  },

  update(st, companyId, id, v) {
    const prev = mine(st, companyId).find((i) => i.id === id);
    if (!prev) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    const next = build(st, prev, { id, companyId }, v);
    Object.assign(prev, next);
    for (const k of Object.keys(prev) as (keyof Item)[]) if (!(k in next)) delete prev[k]; // a cleared field is gone, not stale
    return toRow(st, prev);
  },

  setActive(st, companyId, id, active) {
    const i = mine(st, companyId).find((x) => x.id === id);
    if (!i) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    i.active = active;
    i.version = (i.version ?? 1) + 1;
    return toRow(st, i);
  },
};

/** Values -> the stored item. Only the keys the form edits are read, so a body can never set `id`, `companyId`, `version` or `active`. */
function build(st: MockState, prev: Item | undefined, base: Pick<Item, 'id' | 'companyId'>, v: Values): Item {
  const kind = v.kind as ItemSummary['kind'];
  const purchase = v.usagePurchase === true;
  const wht = kind === 'service' ? str(v.whtTypeCode) : undefined;
  const cat = purchase ? str(v.expenseCategory) : undefined;
  const next: Item = {
    ...(prev ? { active: prev.active } : {}), ...base, kind, code: str(v.code)!, name: str(v.name)!, unit: str(v.unit)!, unitPrice: price(v.unitPrice)!,
    taxCode: vatOf(st, base.companyId) ? ((str(v.taxCode) ?? 'S7') as Item['taxCode']) : 'EX',
    usage: { sales: v.usageSales === true, purchase },
    ...(wht ? { whtTypeCode: wht } : {}), ...(cat ? { expenseCategory: cat } : {}),
    version: prev ? (prev.version ?? 1) + 1 : 1,
  };
  return JSON.parse(JSON.stringify(next)) as Item; // drop the undefined keys, like the stored JSON would
}
