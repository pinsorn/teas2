import type { Company, Role } from '@/domain/types';
import type { MockState } from '../store';
import companiesJson from './companies.json';
import type { Period } from '../engine/periods';
import { postingRulesFor } from './posting-profiles';
import { bankAccounts } from './bank-accounts';
import { chartOfAccounts } from './coa';
import { buildDocs } from './documents';
import type { SeedSpec } from './seed-runner';
import { nonVatItems, vatItems } from './items';
import { whtTypesFor } from './wht-types';
import { nonVatParties, vatParties } from './parties';

/** Documents later groups seed THROUGH the engine (`fixtures/specs/<group>.ts`, appended here in group order). */
export const SEED_SPECS: SeedSpec[] = [];

/** Months 2025-01 .. 2026-12; everything up to 2026-06 is closed (D-10), closed at the 10th of the following month. */
const periodsFor = (companyId: string): Period[] => Array.from({ length: 24 }, (_, i) => {
  const month = `${2025 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  if (month > '2026-06') return { companyId, month, status: 'open' as const };
  const next = i % 12 === 11 ? `${2026 + Math.floor(i / 12)}-01` : `${2025 + Math.floor(i / 12)}-${String((i % 12) + 2).padStart(2, '0')}`;
  return { companyId, month, status: 'closed' as const, closedAt: `${next}-10T09:00:00+07:00` };
});

/** Deterministic seed: no Math.random, no clock. */
export function buildSeed(role: Role): MockState {
  const companies: Company[] = companiesJson.companies.map(({ key, fiscalYearStartMonth: _f, ...c }) => {
    void _f;
    return { id: `co-${key}`, ...c };
  });
  const parties = [...vatParties(), ...nonVatParties()];
  const items = [...vatItems(), ...nonVatItems()];
  const { docs, links, activity, revisions, series } = buildDocs(parties, items);
  return {
    version: 5,
    companies,
    memberships: companies.map((c) => ({ userId: 'u-1', companyId: c.id, companyName: c.legalNameTh, role: c.vatRegistered ? role : 'operator' })),
    parties, items, docs, links, activity, revisions, journals: [], audit: [], series,
    accounts: companies.flatMap((c) => chartOfAccounts().map((a) => ({ ...a, companyId: c.id }))),
    bankAccounts: bankAccounts(), whtTypes: companies.flatMap((c) => whtTypesFor(c.id)),
    postingRules: companies.flatMap((c) => postingRulesFor(c.id, Object.fromEntries(bankAccounts().filter((b) => b.companyId === c.id).map((b) => [b.id, b.accountCode])))),
    periods: companies.flatMap((c) => periodsFor(c.id)),
  };
}
