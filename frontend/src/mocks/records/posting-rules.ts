import { DOC_TYPES } from '@/domain/doc-types';
import type { Actor, DocType } from '@/domain/types';
import { PARTY_GROUPS } from '@/records/customers';
import { POSTING_LEVELS, type PostingLevel, type PostingPreviewRequest, type PostingPreviewResult, type PostingRuleRow, type PostingRulesView } from '@/records/posting-rules';
import { compute } from '../engine/commands';
import { FieldErrors, refuseAgent } from '../engine/company';
import { companyEntries, traceResolutions } from '../engine/ledger';
import { MockError, logAudit, today } from '../engine/log';
import { type AccountingRole, type PostingRule, ROLES, ROLE_FIT, categoriesOf, ensureCategories, roleProblem } from '../engine/posting';
import { vatOf } from '../engine/vat';
import type { MockState } from '../store';

// ST2: posting rules (SP0 §5.5). The rows ARE `st.postingRules`; this module is the only writer besides the seed. Ruling 1: a change never moves a posted entry (journals are stored; a rule
// is read when the NEXT issue / revise / correction posts), so the only rules it cannot let through are the ones the books are keyed by.

/** ST2b ruling 1: roles some reader resolves from the rules in force NOW (the aging and statements, the returns, the payroll / bank / closing tie-outs). They are set at the company default only
 *  (`posting.control_level`), a keyed default is created / deleted only while its account holds no postings, and an update is refused while the old or new account holds postings (`posting.control_in_use`).
 *  The free roles (revenue, expense, fixed asset, bank fee, ...) move at any level and apply to the NEXT posting only: no reader re-derives a posted account from today's rules. */
export const CONTROL_ROLES: ReadonlySet<AccountingRole> = new Set<AccountingRole>(['AR', 'AP', 'CustomerDeposit', 'VendorPrepayment', 'EmployeePayable', 'OutputVat', 'InputVat', 'InputVatUnclaimed', 'WhtReceivable', 'WhtPayable',
  'Pnd36VatPayable', 'VatPayable', 'VatCarryForward', 'PitPayable', 'SsoPayable', 'SalaryPayable', 'PayrollDeductionPayable', 'Cash', 'OpeningBalanceEquity', 'RetainedEarnings']);
const inUse = (st: MockState, companyId: string, role: string, code: string) => new MockError(409, 'posting.control_in_use', `เปลี่ยนหรือลบกฎของบทบาท ${role} ไม่ได้ เพราะบัญชี ${code} มีรายการลงบัญชีแล้ว (ทะเบียนลูกหนี้ เจ้าหนี้ และแบบภาษีอ่านยอดจากบัญชีของบทบาทนี้) ทางออก: ย้ายยอดด้วยใบสำคัญทั่วไป แล้วใช้บัญชีใหม่กับรายการถัดไป`);

export const ruleId = (r: { level: string; key?: string; role: string }): string => `${r.level}|${r.key ?? ''}|${r.role}`;
const find = (st: MockState, companyId: string, id: string): PostingRule => {
  const [level, key, role] = id.split('|');
  const r = st.postingRules.find((x) => x.companyId === companyId && x.level === level && (x.key ?? '') === key && x.role === role);
  if (!r) throw new MockError(404, 'posting.rule_not_found', 'ไม่พบกฎการลงบัญชี');
  return r;
};
const row = (st: MockState, r: PostingRule): PostingRuleRow => ({
  id: ruleId(r), level: r.level, ...(r.key !== undefined ? { key: r.key } : {}), role: r.role, accountCode: r.accountCode, version: r.version ?? 1,
  accountName: st.accounts.find((a) => a.companyId === r.companyId && a.code === r.accountCode)?.nameTh ?? r.accountCode, required: r.level === 'default' && r.key === undefined,
});
const ORDER = Object.fromEntries(POSTING_LEVELS.map((l, i) => [l, i]));
export function listPostingRules(st: MockState, companyId: string): PostingRulesView {
  const postable = st.accounts.filter((a) => a.companyId === companyId && a.postable && a.active !== false);
  return {
    items: st.postingRules.filter((r) => r.companyId === companyId).map((r) => row(st, r)).sort((a, b) => ORDER[a.level] - ORDER[b.level] || (a.key ?? '').localeCompare(b.key ?? '') || a.role.localeCompare(b.role)),
    roles: ROLES.map((role) => ({ role, accepts: ROLE_FIT[role].th, accountCodes: postable.filter((a) => !roleProblem(st, companyId, role, a.code)).map((a) => a.code) })), // the very check a save runs
    accounts: postable.map((a) => ({ code: a.code, nameTh: a.nameTh })),
  };
}

const WHT_FORMS = ['PND1', 'PND2', 'PND3', 'PND53', 'PND54'];
/** The key a level takes (a default rule may be keyless; its keyed forms are the WHT form, a bank account or the loss side of a disposal). */
function keyProblem(st: MockState, companyId: string, level: PostingLevel, key: string | undefined): string | undefined {
  if (level === 'default') return key === undefined || WHT_FORMS.includes(key) || key === 'loss' || st.bankAccounts.some((b) => b.companyId === companyId && b.id === key) ? undefined : 'กุญแจของค่าเริ่มต้นต้องเป็นแบบ ภ.ง.ด. บัญชีธนาคาร หรือ loss';
  if (!key) return 'ต้องระบุกุญแจของกฎ';
  const ok = level === 'item' ? st.items.some((i) => i.companyId === companyId && i.id === key)
    : level === 'category' ? categoriesOf(st, companyId).some((c) => c.code === key) || st.postingRules.some((r) => r.companyId === companyId && r.level === 'category' && r.key === key) // an asset class is a category-level key
    : level === 'partyGroup' ? PARTY_GROUPS.includes(key) : Object.hasOwn(DOC_TYPES, key);
  return ok ? undefined : `ไม่พบ ${key} ในระดับนี้ของบริษัท`;
}

const shape = (r: PostingRule) => ({ role: r.role, level: r.level, key: r.key, accountCode: r.accountCode });
const target = (r: PostingRule) => `${r.role}:${r.level}:${r.key ?? ''}`;
const conflict = () => new MockError(409, 'record.version_conflict', 'กฎนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');

export function createPostingRule(st: MockState, actor: Actor, companyId: string, v: Record<string, unknown>): PostingRuleRow {
  refuseAgent(actor);
  const level = v.level as PostingLevel, role = v.role as AccountingRole, key = typeof v.key === 'string' && v.key.trim() ? v.key.trim() : undefined, accountCode = String(v.accountCode ?? '');
  const e: Record<string, string[]> = {};
  if (!POSTING_LEVELS.includes(level)) e.level = ['ระดับของกฎไม่ถูกต้อง'];
  if (!ROLES.includes(role)) e.role = ['บทบาทบัญชีไม่ถูกต้อง'];
  if (Object.keys(e).length) throw new FieldErrors(e);
  const kp = keyProblem(st, companyId, level, key);
  if (kp) throw new MockError(422, 'posting.key_invalid', kp);
  const bad = roleProblem(st, companyId, role, accountCode);
  if (bad) throw bad;
  if (CONTROL_ROLES.has(role) && level !== 'default') throw new MockError(422, 'posting.control_level', `บทบาท ${role} เป็นบัญชีคุม ตั้งได้เฉพาะค่าเริ่มต้นของบริษัท`);
  if (CONTROL_ROLES.has(role)) { // a new keyed default re-routes its key: refused while the account it takes over (the keyless one) or the new one holds postings
    const keyless = st.postingRules.find((x) => x.companyId === companyId && x.level === 'default' && x.key === undefined && x.role === role)?.accountCode;
    for (const c of [keyless, accountCode]) if (c && posted(st, companyId, c)) throw inUse(st, companyId, role, c);
  }
  if (st.postingRules.some((r) => r.companyId === companyId && r.level === level && r.key === key && r.role === role)) throw new MockError(422, 'posting.duplicate', 'มีกฎของระดับ กุญแจ และบทบาทนี้อยู่แล้ว แก้บัญชีของกฎเดิมแทน');
  const r: PostingRule = { companyId, level, ...(key !== undefined ? { key } : {}), role, accountCode, version: 1 };
  st.postingRules.push(r);
  syncCategory(st, r);
  logAudit(st, actor, companyId, 'posting.rule.create', target(r), undefined, shape(r));
  return row(st, r);
}

/** The account of a category and its category-level Expense rule are one fact (SP0 §5.5): a rule edit shows on the category tab. */
function syncCategory(st: MockState, r: PostingRule): void {
  if (r.level !== 'category' || r.role !== 'Expense' || !r.key) return;
  const c = ensureCategories(st).find((x) => x.companyId === r.companyId && x.code === r.key);
  if (c && !c.capex) c.accountCode = r.accountCode;
}

/** True when any posted line of the company stands on the account. */
const posted = (st: MockState, companyId: string, code: string): boolean => { for (const e of companyEntries(st, companyId)) if (e.lines.some((l) => l.accountCode === code)) return true; return false; };

export function updatePostingRule(st: MockState, actor: Actor, companyId: string, id: string, v: { accountCode?: unknown; version?: unknown }): PostingRuleRow {
  refuseAgent(actor);
  const r = find(st, companyId, id);
  if (v.version !== (r.version ?? 1)) throw conflict();
  const accountCode = String(v.accountCode ?? '');
  const bad = roleProblem(st, companyId, r.role, accountCode);
  if (bad) throw bad;
  if (accountCode === r.accountCode) return row(st, r);
  if (CONTROL_ROLES.has(r.role) && (posted(st, companyId, r.accountCode) || posted(st, companyId, accountCode))) { // the old account holds this role's postings, the new one would take in other roles'
    throw inUse(st, companyId, r.role, posted(st, companyId, r.accountCode) ? r.accountCode : accountCode);
  }
  const before = shape(r);
  r.accountCode = accountCode; r.version = (r.version ?? 1) + 1;
  syncCategory(st, r);
  logAudit(st, actor, companyId, 'posting.rule.update', target(r), before, shape(r));
  return row(st, r);
}

export function deletePostingRule(st: MockState, actor: Actor, companyId: string, id: string, version: unknown): void {
  refuseAgent(actor);
  const r = find(st, companyId, id);
  if (version !== (r.version ?? 1)) throw conflict();
  if (r.level === 'default' && r.key === undefined) throw new MockError(409, 'posting.default_required', `ลบกฎค่าเริ่มต้นของบทบาท ${r.role} ไม่ได้ ทุกบทบาทต้องมีบัญชีค่าเริ่มต้นของบริษัท ทางออก: แก้บัญชีแทนการลบ`);
  if (CONTROL_ROLES.has(r.role) && posted(st, companyId, r.accountCode)) throw inUse(st, companyId, r.role, r.accountCode); // a keyed default: its postings would fall through to the keyless account
  if (r.level === 'category' && r.role === 'Expense' && categoriesOf(st, companyId).some((c) => c.code === r.key)) throw new MockError(409, 'posting.category_rule', `ลบกฎบัญชีของหมวด ${r.key} ไม่ได้ ทางออก: แก้บัญชีของหมวดแทนการลบ`);
  const before = shape(r);
  st.postingRules = st.postingRules.filter((x) => x !== r);
  logAudit(st, actor, companyId, 'posting.rule.delete', target(r), before, undefined);
}

const PREVIEW_TYPES: DocType[] = ['TI', 'IV', 'DN', 'CN', 'PB', 'PDN', 'PCN', 'EX', 'RC', 'PV'];
/** The resolution order made visible (SP0 §5.5): one sample line through the SAME `compute` -> `ledgerFor` -> `resolveRole` the editor and the issue use. Writes nothing. */
export function previewPosting(st: MockState, companyId: string, v: PostingPreviewRequest): PostingPreviewResult {
  if (!PREVIEW_TYPES.includes(v.docType)) throw new MockError(422, 'posting.preview_type', 'เลือกประเภทเอกสารที่ลงบัญชี');
  const sales = ['TI', 'IV', 'DN', 'CN', 'RC'].includes(v.docType);
  const lines = [{ id: 'preview-1', description: 'ตัวอย่างรายการ', qty: '1', unit: 'หน่วย', unitPrice: '1000.00', taxCode: (vatOf(st, companyId) ? 'S7' : 'EX') as 'S7' | 'EX',
    ...(v.itemId ? { itemId: v.itemId } : {}), ...(v.expenseCategory && !sales ? { expenseCategory: v.expenseCategory } : {}) }];
  const header = { documentDate: today(), ...(v.partyId ? { partyId: v.partyId } : {}) };
  const seen: Parameters<typeof traceResolutions>[0] = [];
  const out = traceResolutions(seen, () => compute(st, companyId, v.docType, { header, lines }));
  const entry = out.journal?.entries[0];
  const winners: PostingPreviewResult['winners'] = [];
  for (const l of entry?.lines ?? []) {
    const hit = seen.find((x) => x.r.rule === l.rule && x.r.code === l.accountCode); // the resolution that produced this very line
    if (hit && !winners.some((w) => w.role === hit.role)) winners.push({ role: hit.role, accountCode: l.accountCode, accountName: l.accountName, rule: l.rule, level: hit.r.level, ...(hit.r.key !== undefined ? { key: hit.r.key } : {}) });
  }
  return { winners, journal: out.journal ?? { entries: [] }, missing: out.missing.map((x) => x.message) };
}
