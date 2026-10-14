import type { DocType } from '@/domain/types';

/** Every key starts with the active companyId (except `me`) so a company switch can never hit another company's cache. */
export const qk = {
  me: () => ['me'] as const,
  home: (c: string) => [c, 'home'] as const,
  docs: (c: string, type: DocType, params: object) => [c, 'docs', type, params] as const,
  doc: (c: string, type: DocType, id: string) => [c, 'doc', type, id] as const,
  chain: (c: string, id: string) => [c, 'chain', id] as const,
  activity: (c: string, id: string) => [c, 'activity', id] as const,
  revisions: (c: string, id: string) => [c, 'revisions', id] as const,
  ledger: (c: string, id: string) => [c, 'ledger', id] as const,
};
