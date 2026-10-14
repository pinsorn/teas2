import type { DocType } from '@/domain/types';

/** Every key starts with the active companyId (except `me`) so a company switch can never hit another company's cache. */
export const qk = {
  me: () => ['me'] as const,
  home: (c: string) => [c, 'home'] as const,
  docs: (c: string, type: DocType, params: object) => [c, 'docs', type, params] as const,
  doc: (c: string, type: DocType, id: string) => [c, 'doc', type, id] as const,
  chain: (c: string, type: DocType, id: string) => [c, 'chain', type, id] as const,
  activity: (c: string, type: DocType, id: string) => [c, 'activity', type, id] as const,
  revisions: (c: string, type: DocType, id: string) => [c, 'revisions', type, id] as const,
  paper: (c: string, type: DocType, id: string, copy: boolean) => [c, 'paper', type, id, copy] as const,
  ledger: (c: string, type: DocType, id: string) => [c, 'ledger', type, id] as const,
};
