import type { ApprovalPolicy } from '@/domain/types';

/** Approval rules (§7.6; ST3 edits them). VAT company: expense claims always, payment vouchers above 50,000.00 (strictly above), the creator may approve their own document.
 *  The non-VAT company has none: every rule is off. */
export const approvalPolicies = (): ApprovalPolicy[] => [
  { companyId: 'co-vat', docType: 'EX', enabled: true, selfApproval: true },
  { companyId: 'co-vat', docType: 'PV', enabled: true, minAmount: '50000.00', selfApproval: true },
  { companyId: 'co-nonvat', docType: 'EX', enabled: false, selfApproval: true },
  { companyId: 'co-nonvat', docType: 'PV', enabled: false, selfApproval: true },
];
