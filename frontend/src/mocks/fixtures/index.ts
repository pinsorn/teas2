import type { Company, Role } from '@/domain/types';
import type { MockState } from '../store';
import companiesJson from './companies.json';
import type { Period } from '../engine/periods';
import { postingRulesFor } from './posting-profiles';
import { bankAccounts } from './bank-accounts';
import { chartOfAccounts } from './coa';
import { AGENT, USER, buildDocs } from './documents';
import { changePostingRule, changeTaxRate, recordCompanySwitch, recordLogin, withFixedClock } from '../engine/log';
import type { SeedSpec } from './seed-runner';
import { ACCOUNTING_SPECS } from './specs/accounting';
import { ASSET_SPECS } from './specs/assets';
import { PAYROLL_SPECS } from './specs/payroll';
import { FINANCE_SPECS } from './specs/finance';
import { PURCHASE_SPECS } from './specs/purchases';
import { SALES_SPECS } from './specs/sales';
import { citYearsSeed } from './cit-year';
import { nonVatItems, vatItems } from './items';
import { whtTypesFor } from './wht-types';
import { approvalPolicies } from './approval-policy';
import { nonVatEmployees, vatEmployees } from './employees';
import { nonVatParties, vatParties } from './parties';
import { DEFAULT_NOTES } from './default-notes';
import { staffSeed } from './staff';

/** Documents later groups seed THROUGH the engine (`fixtures/specs/<group>.ts`, appended here in group order). */
export const SEED_SPECS: SeedSpec[] = [...SALES_SPECS, ...PURCHASE_SPECS, ...FINANCE_SPECS, ...ACCOUNTING_SPECS, ...ASSET_SPECS, ...PAYROLL_SPECS];

/** Months 2025-01 .. 2026-12; everything up to 2026-06 is closed (D-10), closed at the 10th of the following month. */
const periodsFor = (companyId: string): Period[] => Array.from({ length: 24 }, (_, i) => {
  const month = `${2025 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  if (month > '2026-06') return { companyId, month, status: 'open' as const };
  const next = i % 12 === 11 ? `${2026 + Math.floor(i / 12)}-01` : `${2025 + Math.floor(i / 12)}-${String((i % 12) + 2).padStart(2, '0')}`;
  return { companyId, month, status: 'closed' as const, closedAt: `${next}-10T09:00:00+07:00` };
});

/** Deterministic seed: no Math.random, no clock. */
export function buildSeed(role: Role): MockState {
  const companies: Company[] = companiesJson.companies.map(({ key, ...c }) => ({ id: `co-${key}`, ...c, defaultNotes: { ...DEFAULT_NOTES } })); // ST1: the fiscal year start is kept (D-33); the default notes are the company's own, seeded from the fixture
  const parties = [...vatParties(), ...nonVatParties(), ...vatEmployees(), ...nonVatEmployees()];
  const items = [...vatItems(), ...nonVatItems()];
  const { docs, links, activity, revisions, series } = buildDocs(parties, items);
  return {
    version: 58,
    companies, staff: staffSeed(role), roles: [],
    memberships: companies.map((c) => ({ userId: 'u-1', companyId: c.id, companyName: c.legalNameTh, role: c.vatRegistered ? role : 'operator' })),
    parties, items, docs, links, activity, revisions, journals: [], bankImports: [], bankLines: [], bankJournals: [], settlements: [], schedules: [], yearCloses: [], filings: [], payrollPayments: [], citYears: citYearsSeed(), settlementTolerance: companies.map((c) => ({ companyId: c.id, rounding: '1.00', smallWriteOff: '100.00' })), audit: [], series, attachments: [], prints: [],
    accounts: companies.flatMap((c) => chartOfAccounts().map((a) => ({ ...a, companyId: c.id }))),
    bankAccounts: bankAccounts(), whtTypes: companies.flatMap((c) => whtTypesFor(c.id)),
    postingRules: companies.flatMap((c) => postingRulesFor(c.id, Object.fromEntries(bankAccounts().filter((b) => b.companyId === c.id).map((b) => [b.id, b.accountCode])))),
    periods: companies.flatMap((c) => periodsFor(c.id)), approvalPolicies: approvalPolicies(),
  };
}

/** RP3: finish the audit trail of the seed. The later seeders replay older dates after the newer ones, so the trail is put in time order and renumbered (the real server appends in time order: ids count up and the clock never goes back);
 *  then the events with no screen yet are produced by their commands: logins (a user, and an agent over MCP), company switches, a posting-rule change and a tax-table change (each put back, so the seed's rules and rates stay what the documents were issued under). */
export function seedAudit(st: MockState): void {
  st.audit = st.audit.map((a, i) => ({ a, i })).sort((x, y) => x.a.at.localeCompare(y.a.at) || x.i - y.i).map(({ a }, i) => ({ ...a, id: `aud-${i + 1}`, traceId: `trc-${i + 1}` }));
  const last = st.audit.at(-1)?.at ?? new Date(Date.parse('2026-10-14T10:00:00+07:00')).toISOString();
  withFixedClock(new Date(Date.parse(last) + 60_000).toISOString(), () => {
    recordLogin(st, USER, 'co-vat');
    recordCompanySwitch(st, USER, 'co-vat', 'co-nonvat');
    recordCompanySwitch(st, USER, 'co-nonvat', 'co-vat');
    recordLogin(st, AGENT, 'co-vat');
    recordLogin(st, AGENT, 'co-nonvat');
    const rule = { role: 'Expense', level: 'category', key: 'advertising' } as const;
    changePostingRule(st, USER, 'co-vat', rule, '5110');
    changePostingRule(st, USER, 'co-vat', rule, '5130');
    changeTaxRate(st, USER, 'co-vat', 'ADS', 300, '2026-10-14'); // dated on the mock's today (no future row); one date for the change and its revert: the revert REPLACES the row, so no day ever has 3%
    changeTaxRate(st, USER, 'co-vat', 'ADS', 200, '2026-10-14');
  });
}
