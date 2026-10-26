import type { HomeSection } from './types';

const ANY = (re: RegExp) => (perms: string[]) => perms.some((p) => re.test(p));
/** HC1: the permission each Home section needs; a section the role cannot see is neither shown nor queried (the endpoint refuses it too). */
export const HOME_NEEDS: Record<HomeSection, (perms: string[]) => boolean> = {
  kpis: (p) => p.includes('report.arap.read'),
  approvals: ANY(/^doc\.[A-Z]+\.approve$/),
  drafts: ANY(/^doc\.[A-Z]+\.create$/),
  overdue: (p) => ['TI', 'IV', 'PB', 'EX'].some((t) => p.includes(`doc.${t}.read`)),
  deadlines: (p) => p.includes('tax.read'),
  bank: (p) => p.includes('bank.read'),
  agent: ANY(/^doc\.[A-Z]+\.read$/),
  alerts: (p) => p.includes('audit.read') || p.includes('tax.read') || p.includes('doc.PB.read') || p.includes('doc.DP.read') || ANY(/^doc\.[A-Z]+\.create$/)(p),
};
export const HOME_SECTIONS = Object.keys(HOME_NEEDS) as HomeSection[];
export const homeSectionsFor = (perms: string[]): HomeSection[] => HOME_SECTIONS.filter((s) => HOME_NEEDS[s](perms));
