import type {
  ActivityEntry, AuditEntry, ChainEdge, Company, Doc, ItemSummary, JournalPreview, Membership, PartySummary, Revision,
} from '@/domain/types';
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
}

const KEY = 'teas2.mock.state.v1';

export const seed = (): MockState => buildSeed(getSettings().role);

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
