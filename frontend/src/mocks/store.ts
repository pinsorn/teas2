import type {
  ActivityEntry, Allocation, Attachment, AuditEntry, ChainEdge, Company, CorrectionPlan, Doc, DocHeader, DocLine, ItemSummary, JournalPreview, Membership, PaperModel, PartySummary, Revision, Role,
} from '@/domain/types';
import { DOC_TYPES, LIVE } from '@/domain/doc-types';
import { recomputeSettlement } from './engine/commands';
import { ledgerFor } from './engine/ledger';
import { adjustSnapshot, hasSnapshot } from './engine/notes';
import type { Period } from './engine/periods';
import type { PostingRule } from './engine/posting';
import type { BankAccount } from './fixtures/bank-accounts';
import type { CompanyAccount } from './fixtures/coa';
import type { CompanyWhtType } from './fixtures/wht-types';
import { SEED_SPECS } from './fixtures';
import { runSeed } from './fixtures/seed-runner';
import { buildSeed } from './fixtures';
import { clearAttachmentBlobs } from './engine/attachments';
import { getSettings } from './settings';

export interface MockState {
  version: 20;
  companies: Company[];
  memberships: (Membership & { userId: string })[];
  /** `active` (default true) and `version` (default 1) are the master record's; documents keep their own party snapshot. */
  parties: (PartySummary & { companyId: string; active?: boolean; version?: number })[];
  /** `version` (default 1) is the master record's. */
  items: (ItemSummary & { companyId: string; version?: number })[];
  docs: (Doc & { companyId: string })[];
  links: (ChainEdge & { companyId: string })[];
  activity: (ActivityEntry & { docId: string })[];
  revisions: (Revision & { docId: string })[];
  journals: { docId: string; preview: JournalPreview }[];
  accounts: CompanyAccount[];
  postingRules: PostingRule[];
  periods: Period[];
  bankAccounts: BankAccount[];
  /** [SP-R] mock WHT types per company (fixtures/wht-types.ts). */
  whtTypes: CompanyWhtType[];
  audit: AuditEntry[];
  /** Attachment METADATA only. The bytes live under their own localStorage key `teas2.mock.att.<id>` (engine/attachments.ts): they must never be part of this blob, whose save swallows quota errors. */
  attachments: (Omit<Attachment, 'dataUrl'> & { companyId: string })[];
  /** Print log of issued documents; `printCount` on a read is derived from it. `copy` = printed as สำเนา. */
  prints: { docId: string; at: string; by: string; copy: boolean; /** WT only: the paper as printed the first time (I7); every later print shows this. */ paper?: PaperModel }[];
  series: Record<string, number>;
  /** `companyId|type|Idempotency-Key` -> draft id. */
  idempotency?: Record<string, string>;
  /** Correction plans awaiting execution (single use). */
  plans?: Record<string, { docId: string; proposed: { header: DocHeader; lines: DocLine[]; allocations?: Allocation[] }; role: Role; plan: CorrectionPlan }>;
}

const KEY = 'teas2.mock.state.v20';

/** The seed for a given role (default accountant: the screen index resolves fixture ids on the server, where there is no toolbar). */
export function buildSeedState(role: Role = 'accountant'): MockState {
  const s = buildSeed(role);
  for (const d of s.docs) if (DOC_TYPES[d.type].outstanding) recomputeSettlement(s, d.id); // balances follow the links (§7.11)
  for (const d of s.docs) {
    if (d.status === 'draft') continue;
    const preview = ledgerFor(s, d);
    if (preview.entries.length) s.journals.push({ docId: d.id, preview });
  }
  for (const d of s.docs) { // seeded notes enter directly: give them the ม.86/10 snapshot an issued note has, so the paper never recomputes them
    const ti = hasSnapshot(d.type) && LIVE.includes(d.status) && d.header.refDocId ? s.docs.find((x) => x.id === d.header.refDocId) : undefined;
    if (ti && !d.adjustSnapshot) d.adjustSnapshot = adjustSnapshot(s, ti, d);
  }
  runSeed(s, SEED_SPECS); // later groups' documents, produced through the engine (D-23)
  return s;
}

export const seed = (): MockState => buildSeedState(getSettings().role);

export function loadState(): MockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw) as MockState; if (s.version === 20) return s; }
  } catch { /* fall through to a fresh seed */ }
  return seed();
}

/** False when the browser refused the write (quota / private mode): the state then lives for this call only. Most callers ignore it; a command that must not lose data checks it. */
export function saveState(s: MockState): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(s)); return true; } catch { return false; }
}

export function resetState(): MockState {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  clearAttachmentBlobs();
  const s = seed();
  saveState(s);
  return s;
}
