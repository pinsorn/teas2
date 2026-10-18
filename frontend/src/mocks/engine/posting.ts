import type { DocType } from '@/domain/types';
import { GROUP_OF, type AccountClass, type AccountGroup } from '@/records/accounts';
import type { MockState } from '../store';
import { EXPENSE_CATEGORIES, type ExpenseCategory } from '../fixtures/expense-categories';
import { MockError } from './log';

export type AccountingRole = 'AR' | 'AP' | 'Revenue' | 'SalesDiscount' | 'SalesReturn' | 'OutputVat' | 'InputVat'
  | 'InputVatUnclaimed' | 'WhtReceivable' | 'WhtPayable' | 'WhtExpense' | 'Pnd36VatPayable' | 'Cash' | 'CustomerDeposit'
  | 'VendorPrepayment' | 'Expense' | 'FixedAsset' | 'AccumulatedDepreciation' | 'DepreciationExpense' | 'DisposalGainLoss'
  | 'SalaryExpense' | 'PitPayable' | 'SsoPayable' | 'SsoExpense' | 'SalaryPayable' | 'EmployeePayable' | 'PayrollDeductionPayable' | 'BankFee'
  | 'RoundingDifference' | 'SmallWriteOff' | 'RetainedEarnings' | 'OpeningBalanceEquity' | 'VatPayable' | 'VatCarryForward';

export interface PostingContext {
  companyId: string; docType: DocType; itemId?: string; expenseCategory?: string; assetClass?: string; partyGroup?: string;
  bankAccountId?: string; whtForm?: 'PND1' | 'PND2' | 'PND3' | 'PND53' | 'PND54'; /** DisposalGainLoss: the loss side posts to its own account. */ outcome?: 'gain' | 'loss';
  /** Carried onto the journal line; never used to resolve an account. */ dimensions?: Record<string, string>;
}
export interface Resolved { code: string; name: string; rule: string; level: PostingRule['level']; key?: string } // rule e.g. "ประเภทเอกสาร TI: Revenue → 4100"
export interface PostingRule {
  companyId: string; level: 'item' | 'category' | 'partyGroup' | 'docType' | 'default'; key?: string; role: AccountingRole; accountCode: string;
  /** ST2 (optional: absent = 1, like the other masters, so the seed is unchanged). */ version?: number;
}

const LEVEL_TH: Record<PostingRule['level'], string> = {
  item: 'สินค้า/บริการ', category: 'หมวด', partyGroup: 'กลุ่มคู่ค้า', docType: 'ประเภทเอกสาร', default: 'ค่าเริ่มต้นบริษัท',
};

/** SP0 §5.5: product/service → expense category or asset class → party group → document type → company default; first match wins.
 *  Within the default level a rule keyed by the context (WHT form, bank account, disposal outcome) beats the keyless one. */
export function resolveRole(st: MockState, role: AccountingRole, ctx: PostingContext): Resolved {
  const mine = st.postingRules.filter((r) => r.companyId === ctx.companyId && r.role === role);
  const tiers: [PostingRule['level'], (string | undefined)[]][] = [
    ['item', [ctx.itemId]], ['category', [ctx.expenseCategory, ctx.assetClass]], ['partyGroup', [ctx.partyGroup]],
    ['docType', [ctx.docType]], ['default', [ctx.whtForm, ctx.bankAccountId, ctx.outcome, undefined].filter((k, i, a) => k !== undefined || i === a.length - 1)],
  ];
  for (const [level, keys] of tiers) {
    for (const key of keys) {
      if (key === undefined && level !== 'default') continue;
      const hit = mine.find((r) => r.level === level && r.key === key);
      if (!hit) continue;
      const acc = st.accounts.find((a) => a.companyId === ctx.companyId && a.code === hit.accountCode);
      if (!acc?.postable) throw new MockError(422, 'posting.invalid_rule', `กฎบัญชี ${LEVEL_TH[level]}${hit.key ? ` ${hit.key}` : ''}: ${role} → ${hit.accountCode} ชี้ไปยังบัญชีที่ไม่มีหรือลงบัญชีไม่ได้`);
      const label = hit.key === undefined ? LEVEL_TH[level] : `${LEVEL_TH[level]} ${hit.key}`;
      return { code: acc.code, name: acc.nameTh, rule: `${label}: ${role} → ${acc.code}`, level, ...(hit.key !== undefined ? { key: hit.key } : {}) };
    }
  }
  throw new MockError(422, 'posting.unresolved', `ไม่พบบัญชีสำหรับบทบาท ${role} (บริษัท ${ctx.companyId}, เอกสาร ${ctx.docType})`);
}

// ---------------------------------------------------------------- ST2: which account may stand behind a role (ONE table: the rule save and the preview both read it)

type Fit = { th: string; ok: (a: { class: AccountClass; subClass: string }) => boolean };
const cls = (th: string, ...c: AccountClass[]): Fit => ({ th, ok: (a) => c.includes(a.class) });
const grp = (th: string, ...g: AccountGroup[]): Fit => ({ th, ok: (a) => g.includes(GROUP_OF[a.class]) });
const CA = cls('สินทรัพย์หมุนเวียน', 'current-asset'), CL = cls('หนี้สินหมุนเวียน', 'current-liability'), EXP = grp('ค่าใช้จ่าย', 'expense'), LIAB = grp('หนี้สิน', 'liability'), REV = cls('รายได้', 'sales-revenue', 'other-income');
export const ROLE_FIT: Record<AccountingRole, Fit> = {
  AR: CA, AP: CL, Revenue: REV, SalesDiscount: REV, SalesReturn: REV, OutputVat: CL, InputVat: CA, InputVatUnclaimed: EXP, WhtReceivable: CA, WhtPayable: CL, WhtExpense: EXP,
  Pnd36VatPayable: CL, Cash: CA, CustomerDeposit: LIAB, VendorPrepayment: CA,
  Expense: { th: 'ค่าใช้จ่าย (หรือค่าใช้จ่ายจ่ายล่วงหน้า)', ok: (a) => GROUP_OF[a.class] === 'expense' || a.subClass === 'prepayment' }, // a category may land on the prepaid account (AC4)
  FixedAsset: cls('สินทรัพย์ไม่หมุนเวียน', 'non-current-asset'), AccumulatedDepreciation: cls('สินทรัพย์ไม่หมุนเวียน', 'non-current-asset'), DepreciationExpense: EXP,
  DisposalGainLoss: grp('รายได้หรือค่าใช้จ่าย', 'revenue', 'expense'), SalaryExpense: EXP, SsoExpense: EXP, PitPayable: LIAB, SsoPayable: LIAB, SalaryPayable: LIAB, EmployeePayable: LIAB, PayrollDeductionPayable: LIAB,
  BankFee: EXP, RoundingDifference: EXP, SmallWriteOff: EXP, RetainedEarnings: grp('ส่วนของผู้ถือหุ้น', 'equity'), OpeningBalanceEquity: grp('ส่วนของผู้ถือหุ้น', 'equity'), VatPayable: LIAB, VatCarryForward: CA,
};
export const ROLES = Object.keys(ROLE_FIT) as AccountingRole[];

/** Why `accountCode` cannot stand behind `role` of this company (undefined = it can): it exists, is postable and active, and its class fits the role. */
export function roleProblem(st: MockState, companyId: string, role: AccountingRole, accountCode: string): MockError | undefined {
  const a = st.accounts.find((x) => x.companyId === companyId && x.code === accountCode);
  if (!a || !a.postable || a.active === false) return new MockError(422, 'posting.account_invalid', `บัญชี ${accountCode} ${!a ? 'ไม่มีในผังบัญชี' : !a.postable ? 'เป็นบัญชีหมวด ลงรายการไม่ได้' : 'ปิดใช้งานแล้ว'}`);
  if (!ROLE_FIT[role].ok(a)) return new MockError(422, 'posting.class_mismatch', `บทบาท ${role} ต้องใช้บัญชีหมวด${ROLE_FIT[role].th} แต่ ${accountCode} ${a.nameTh} เป็นบัญชีหมวดอื่น`);
  return undefined;
}

// ---------------------------------------------------------------- ST2: masters that are editable but start from the seed
// Absent in the state = the seed's; the first write copies them in (so the seed, and the state version, do not change).

export type ExpenseCategoryRow = ExpenseCategory & { companyId: string; active?: boolean; version?: number; defaultWhtType?: string; parent?: string };
export const categoriesOf = (st: MockState, companyId: string): ExpenseCategoryRow[] =>
  st.expenseCategories ? st.expenseCategories.filter((c) => c.companyId === companyId) : EXPENSE_CATEGORIES.map((c) => ({ ...c, companyId }));
export const ensureCategories = (st: MockState): ExpenseCategoryRow[] => (st.expenseCategories ??= st.companies.flatMap((co) => EXPENSE_CATEGORIES.map((c) => ({ ...c, companyId: co.id }))));

export type DimensionRule = 'required' | 'optional' | 'forbidden';
export interface DimTypeRow { companyId: string; key: string; nameTh: string; version?: number }
export interface DimValueRow { companyId: string; typeKey: string; code: string; nameTh: string; active: boolean; version?: number }
export const MAX_DIMENSION_TYPES = 4;
const SEED_TYPES: [string, string][] = [['department', 'แผนก'], ['project', 'โปรเจกต์']];
const SEED_VALUES: [string, string, string][] = [['department', 'D-01', 'ออกแบบ'], ['department', 'D-02', 'การตลาด'], ['department', 'D-03', 'บริหาร'],
  ['project', 'P-A', 'เว็บไซต์ลูกค้า A'], ['project', 'P-B', 'งานบรรจุภัณฑ์ B']]; // RP1's seeded tags (project: P-A / P-B) stay valid
export const dimTypesOf = (st: MockState, companyId: string): DimTypeRow[] =>
  st.dimensionTypes ? st.dimensionTypes.filter((t) => t.companyId === companyId) : SEED_TYPES.map(([key, nameTh]) => ({ companyId, key, nameTh }));
export const dimValuesOf = (st: MockState, companyId: string): DimValueRow[] =>
  st.dimensionValues ? st.dimensionValues.filter((v) => v.companyId === companyId) : SEED_VALUES.map(([typeKey, code, nameTh]) => ({ companyId, typeKey, code, nameTh, active: true }));
export function ensureDimensions(st: MockState): void {
  st.dimensionTypes ??= st.companies.flatMap((co) => SEED_TYPES.map(([key, nameTh]) => ({ companyId: co.id, key, nameTh })));
  st.dimensionValues ??= st.companies.flatMap((co) => SEED_VALUES.map(([typeKey, code, nameTh]) => ({ companyId: co.id, typeKey, code, nameTh, active: true })));
}
