import type {
  ActivityEntry, AuditEntry, ChainEdge, Company, Doc, DocHeader, DocLine, ItemSummary, JournalPreview, Membership, PartySummary, Revision, Role,
} from '@/domain/types';
import { recomputeSettlement } from './engine/commands';
import { ledgerFor } from './engine/ledger';
import { buildSeed } from './fixtures';
import { getSettings } from './settings';

export interface MockState {
  version: 1;
  companies: Company[];
  memberships: (Membership & { userId: string })[];
  parties: (PartySummary & { companyId: string })[];
  items: (ItemSummary & { companyId: string })[];
  docs: (Doc & { companyId: string })[];
  links: (ChainEdge & { companyId: string })[];
  activity: (ActivityEntry & { docId: string })[];
  revisions: (Revision & { docId: string })[];
  journals: { docId: string; preview: JournalPreview }[];
  audit: AuditEntry[];
  series: Record<string, number>;
  /** `companyId|type|Idempotency-Key` -> draft id. */
  idempotency?: Record<string, string>;
  /** Correction plans awaiting execution (single use). */
  plans?: Record<string, { docId: string; proposed: { header: DocHeader; lines: DocLine[] }; role: Role }>;
}

const KEY = 'teas2.mock.state.v1';

export function seed(): MockState {
  const s = buildSeed(getSettings().role);
  for (const d of s.docs) if (d.type === 'TI' || d.type === 'IV') recomputeSettlement(s, d.id); // balances follow the links (§7.11)
  for (const d of s.docs) {
    if (d.status === 'draft') continue;
    const preview = ledgerFor(s, d);
    if (preview.entries.length) s.journals.push({ docId: d.id, preview });
  }
  return s;
}

export function loadState(): MockState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw) as MockState; if (s.version === 1) return s; }
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
