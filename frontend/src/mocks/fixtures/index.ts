import type { Company, Role } from '@/domain/types';
import type { MockState } from '../store';
import companiesJson from './companies.json';
import { buildDocs } from './documents';
import { nonVatItems, vatItems } from './items';
import { nonVatParties, vatParties } from './parties';

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
    version: 2,
    companies,
    memberships: companies.map((c) => ({ userId: 'u-1', companyId: c.id, companyName: c.legalNameTh, role: c.vatRegistered ? role : 'operator' })),
    parties, items, docs, links, activity, revisions, journals: [], audit: [], series,
  };
}
