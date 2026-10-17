import type { PostingRule } from '../engine/posting';
import { EXPENSE_CATEGORIES } from './expense-categories';

/** Company-default posting rules (SP0 §5.5, D-26). Keyed defaults: WHT form accounts, bank accounts, the loss side of a disposal. */
const DEFAULTS: [AccountingRoleKey, string][] = [
  ['AR', '1130'], ['AP', '2110'], ['Revenue', '4100'], ['SalesReturn', '4110'], ['SalesDiscount', '4120'], ['OutputVat', '2151'], ['InputVat', '1170'],
  ['InputVatUnclaimed', '5170'], ['WhtReceivable', '1180'], ['WhtPayable', '2131'], ['WhtExpense', '5180'], ['Pnd36VatPayable', '2152'], ['Cash', '1120'],
  ['CustomerDeposit', '2140'], ['VendorPrepayment', '1140'], ['Expense', '5100'], ['BankFee', '5200'], ['RoundingDifference', '5210'],
  ['SmallWriteOff', '5220'], ['DepreciationExpense', '5300'], ['SalaryExpense', '5400'], ['SsoExpense', '5410'], ['PitPayable', '2153'],
  ['SsoPayable', '2160'], ['SalaryPayable', '2170'], ['EmployeePayable', '2180'], ['RetainedEarnings', '3200'], ['OpeningBalanceEquity', '3900'],
  ['DisposalGainLoss', '4210'], ['VatPayable', '2154'], ['VatCarryForward', '1172'],
];
type AccountingRoleKey = PostingRule['role'];

const KEYED: [AccountingRoleKey, string, string][] = [
  ['WhtPayable', 'PND53', '2132'], ['WhtPayable', 'PND1', '2133'], ['WhtPayable', 'PND54', '2134'], ['WhtPayable', 'PND2', '2135'],
  ['DisposalGainLoss', 'loss', '5500'],
];
const CATEGORY: [AccountingRoleKey, string, string][] = [
  ['FixedAsset', 'equipment', '1210'], ['AccumulatedDepreciation', 'equipment', '1211'],
  ['FixedAsset', 'vehicle', '1220'], ['AccumulatedDepreciation', 'vehicle', '1221'],
  // SP0 5.5: a purchase line's expense category picks its expense account (a capex category has none: it capitalises to its asset class above)
  ...EXPENSE_CATEGORIES.flatMap((c): [AccountingRoleKey, string, string][] => (c.accountCode ? [['Expense', c.code, c.accountCode]] : [])),
];

export function postingRulesFor(companyId: string, bankAccounts: Record<string, string>): PostingRule[] {
  return [
    ...DEFAULTS.map(([role, accountCode]) => ({ companyId, level: 'default' as const, role, accountCode })),
    ...KEYED.map(([role, key, accountCode]) => ({ companyId, level: 'default' as const, key, role, accountCode })),
    ...Object.entries(bankAccounts).map(([key, accountCode]) => ({ companyId, level: 'default' as const, key, role: 'Cash' as const, accountCode })),
    ...CATEGORY.map(([role, key, accountCode]) => ({ companyId, level: 'category' as const, key, role, accountCode })),
  ];
}
