import type {
  ActivityEntry, AuditEntry, ChainEdge, Company, CorrectionPlan, Doc, DocHeader, DocLine, ItemSummary, JournalPreview, Membership, PartySummary, Revision, Role,
} from '@/domain/types';
import { recomputeSettlement } from './engine/commands';
import { ledgerFor } from './engine/ledger';
import type { Period } from './engine/periods';
import type { PostingRule } from './engine/posting';
import type { BankAccount } from './fixtures/bank-accounts';
import type { CompanyAccount } from './fixtures/coa';
import { SEED_SPECS } from './fixtures';
import { runSeed } from './fixtures/seed-runner';
import { buildSeed } from './fixtures';
import { getSettings } from './settings';

export interface MockState {
  version: 3;
  companies: Company[];
  memberships: (Membership & { userId: string })[];
  parties: (PartySummary & { companyId: string })[];
  items: (ItemSummary & { companyId: string })[];
  docs: (Doc & { companyId: string })[];
  links: (ChainEdge & { companyId: string })[];
  activity: (ActivityEntry & { docId: string })[];
  revisions: (Revision & { docId: string })[];
  journals: { docId: string; preview: JournalPreview }[];
  accounts: CompanyAccount[];
  postingRules: PostingRule[];
  periods: Period[];
  bankAccounts: BankAccount[];
  audit: AuditEntry[];
  series: Record<string, number>;
  /** `companyId|type|Idempotency-Key` -> draft id. */
  idempotency?: Record<string, string>;
  /** Correction plans awaiting execution (single use). */
  plans?: Record<string, { docId: string; proposed: { header: DocHeader; lines: DocLine[] }; role: Role; plan: CorrectionPlan }>;
}

const KEY = 'teas2.mock.state.v3';

/** The seed for a given role (default accountant: the screen index resolves fixture ids on the server, where there is no toolbar). */
export function buildSeedState(role: Role = 'accountant'): MockState {
  const s = buildSeed(role);
  for (const d of s.docs) if (d.type === 'TI' || d.type === 'IV') recomputeSettlement(s, d.id); // balances follow the links (§7.11)
  for (const d of s.docs) {
    if (d.status === 'draft') continue;
    const preview = ledgerFor(s, d);
    if (preview.entries.length) s.journals.push({ docId: d.id, preview });
  }
  runSeed(s, SEED_SPECS); // later groups' documents, produced through the engine (D-23)
  return s;
}

export const seed = (): MockState => buildSeedState(getSettings().role);

export function loadState(): MockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw) as MockState; if (s.version === 3) return s; }
  } catch { /* fall through to a fresh seed */ }
  return seed();
}

export function saveState(s: MockState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota/private mode: state lives for this call only */ }
}

export function resetState(): MockState {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  const s = seed();
  saveState(s);
  return s;
}
