import { describe, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { createDraft, issue } from '../engine/commands';
import { checkInvariants } from '../engine/invariants';
import { resolveRole } from '../engine/posting';
import { AGENT, USER } from '../fixtures/documents';
import { buildSeedState } from '../store';
import { createCategory, deleteCategory, listCategories, updateCategory } from './expense-categories';

// ST2 ruling 6: expense categories are editable; the account is checked as an Expense account; a category in use keeps working, and a change applies to the next postings only (ruling 1).
const V = 'co-vat';
const seed = () => buildSeedState('accountant');
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };
const line = (p: Partial<DocLine> = {}): DocLine => ({ id: 'a', description: 'x', qty: '1', unit: 'u', unitPrice: '1000.00', taxCode: 'S7', ...p });
let n = 0;
const bill = (st: ReturnType<typeof seed>, cat: string) => {
  const d = createDraft(st, V, 'PB', { header: { partyId: 'pv-03', documentDate: '2026-10-01' }, lines: [line({ expenseCategory: cat })] }, USER, `ec-${n++}`);
  return issue(st, d.id, d.version, USER);
};
const postedTo = (st: ReturnType<typeof seed>, id: string) => st.journals.find((j) => j.docId === id)!.preview.entries[0].lines.map((l) => l.accountCode);

describe('ruling 6: expense categories', () => {
  it('lists the seed with its account, recoverable VAT, capex and asset class; a category is used when a line or an item names it', () => {
    const st = seed(), rows = listCategories(st, V);
    expect(rows.map((r) => r.code)).toContain('supplies');
    expect(rows.find((r) => r.code === 'entertainment')).toMatchObject({ accountCode: '5150', recoverableVat: false, capex: false, active: true });
    expect(rows.find((r) => r.code === 'capex-equipment')).toMatchObject({ capex: true, assetClass: 'equipment' });
  });
  it('the account must be an Expense account (class check, the same table as the posting rules); the category-level Expense rule follows the account; audited', () => {
    const st = seed();
    expect(code(() => createCategory(st, USER, V, { code: 'misc', nameTh: 'เบ็ดเตล็ด', accountCode: '4100', recoverableVat: true }))).toBe('posting.class_mismatch');
    expect(code(() => createCategory(st, USER, V, { code: 'misc', nameTh: 'เบ็ดเตล็ด', accountCode: '5000', recoverableVat: true }))).toBe('posting.account_invalid');
    const r = createCategory(st, USER, V, { code: 'misc', nameTh: 'เบ็ดเตล็ด', accountCode: '5140', recoverableVat: true });
    expect(r).toMatchObject({ code: 'misc', accountCode: '5140', version: 1, inUse: false });
    expect(resolveRole(st, 'Expense', { companyId: V, docType: 'PB', expenseCategory: 'misc' }).code).toBe('5140');
    expect(st.audit.at(-1)).toMatchObject({ command: 'category.create', target: 'misc', after: { accountCode: '5140' } });
    const up = updateCategory(st, USER, V, 'misc', { nameTh: 'เบ็ดเตล็ด 2', accountCode: '5130', recoverableVat: false, version: 1 });
    expect(up).toMatchObject({ accountCode: '5130', recoverableVat: false, version: 2 });
    expect(resolveRole(st, 'Expense', { companyId: V, docType: 'PB', expenseCategory: 'misc' }).code).toBe('5130');
    expect(st.audit.at(-1)).toMatchObject({ command: 'category.update', before: { accountCode: '5140', recoverableVat: true }, after: { accountCode: '5130', recoverableVat: false } });
  });
  it('capex needs a known asset class and takes no expense account; a default WHT type must exist; a parent must exist and not make a cycle', () => {
    const st = seed();
    expect(code(() => createCategory(st, USER, V, { code: 'cx', nameTh: 'ซื้อรถ', capex: true, recoverableVat: true }))).toBe('record.invalid'); // no asset class
    expect(code(() => createCategory(st, USER, V, { code: 'cx', nameTh: 'ซื้อรถ', capex: true, assetClass: 'spaceship', recoverableVat: true }))).toBe('record.invalid');
    expect(createCategory(st, USER, V, { code: 'cx', nameTh: 'ซื้อรถ', capex: true, assetClass: 'vehicle', recoverableVat: true })).toMatchObject({ capex: true, assetClass: 'vehicle' });
    expect(listCategories(st, V).find((c) => c.code === 'cx')).not.toHaveProperty('accountCode');
    expect(code(() => createCategory(st, USER, V, { code: 'w', nameTh: 'x', accountCode: '5140', defaultWhtType: 'NOPE', recoverableVat: true }))).toBe('record.invalid');
    expect(code(() => createCategory(st, USER, V, { code: 'w', nameTh: 'x', accountCode: '5140', parent: 'ghost', recoverableVat: true }))).toBe('record.invalid');
    createCategory(st, USER, V, { code: 'p1', nameTh: 'แม่', accountCode: '5140', recoverableVat: true });
    createCategory(st, USER, V, { code: 'p2', nameTh: 'ลูก', accountCode: '5140', parent: 'p1', recoverableVat: true });
    expect(code(() => updateCategory(st, USER, V, 'p1', { nameTh: 'แม่', accountCode: '5140', parent: 'p2', recoverableVat: true, version: 1 }))).toBe('category.cycle');
    expect(code(() => updateCategory(st, USER, V, 'p1', { nameTh: 'แม่', accountCode: '5140', parent: 'p1', recoverableVat: true, version: 1 }))).toBe('category.cycle');
  });
  it('IN USE keeps working: an edit of the account moves the NEXT bill only; the posted entry and invariants stay; a delete is refused (deactivate), deactivated still posts', () => {
    const st = seed();
    const first = bill(st, 'supplies');
    const before = JSON.stringify(st.journals.find((j) => j.docId === first.id));
    const cur = listCategories(st, V).find((c) => c.code === 'supplies')!;
    expect(cur.inUse).toBe(true);
    expect(code(() => deleteCategory(st, USER, V, 'supplies', cur.version))).toBe('category.in_use');
    updateCategory(st, USER, V, 'supplies', { nameTh: cur.nameTh, accountCode: '5130', recoverableVat: true, version: cur.version });
    expect(JSON.stringify(st.journals.find((j) => j.docId === first.id))).toBe(before);
    expect(checkInvariants(st)).toEqual([]);
    expect(postedTo(st, bill(st, 'supplies').id)).toContain('5130');
    const v2 = listCategories(st, V).find((c) => c.code === 'supplies')!;
    updateCategory(st, USER, V, 'supplies', { nameTh: v2.nameTh, accountCode: '5130', recoverableVat: true, active: false, version: v2.version });
    expect(listCategories(st, V).find((c) => c.code === 'supplies')!.active).toBe(false);
    expect(postedTo(st, bill(st, 'supplies').id)).toContain('5130'); // an old document revised later, or a draft already on it, still posts
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an unused category can be deleted (with its rule); agent refused; stale version 409; another company has its own list', () => {
    const st = seed();
    createCategory(st, USER, V, { code: 'tmp', nameTh: 'ชั่วคราว', accountCode: '5140', recoverableVat: true });
    expect(code(() => deleteCategory(st, USER, V, 'tmp', 9))).toBe('record.version_conflict');
    deleteCategory(st, USER, V, 'tmp', 1);
    expect(listCategories(st, V).some((c) => c.code === 'tmp')).toBe(false);
    expect(st.postingRules.some((r) => r.companyId === V && r.level === 'category' && r.key === 'tmp')).toBe(false);
    expect(st.audit.at(-1)).toMatchObject({ command: 'category.delete', before: { code: 'tmp' } });
    const audit = st.audit.length;
    expect(code(() => createCategory(st, AGENT, V, { code: 'tmp', nameTh: 'x', accountCode: '5140', recoverableVat: true }))).toBe('agent.forbidden_setting');
    expect(code(() => deleteCategory(st, AGENT, V, 'rent', 1))).toBe('agent.forbidden_setting');
    expect(st.audit.length).toBe(audit);
    createCategory(st, USER, 'co-nonvat', { code: 'only-nv', nameTh: 'เฉพาะ NV', accountCode: '5140', recoverableVat: true });
    expect(listCategories(st, V).some((c) => c.code === 'only-nv')).toBe(false);
  });
});
