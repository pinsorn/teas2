import type { DocType } from '@/domain/types';
import type { MockState } from '../store';
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
export interface Resolved { code: string; name: string; rule: string } // rule e.g. "ประเภทเอกสาร TI: Revenue → 4100"
export interface PostingRule {
  companyId: string; level: 'item' | 'category' | 'partyGroup' | 'docType' | 'default'; key?: string; role: AccountingRole; accountCode: string;
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
      return { code: acc.code, name: acc.nameTh, rule: `${label}: ${role} → ${acc.code}` };
    }
  }
  throw new MockError(422, 'posting.unresolved', `ไม่พบบัญชีสำหรับบทบาท ${role} (บริษัท ${ctx.companyId}, เอกสาร ${ctx.docType})`);
}
