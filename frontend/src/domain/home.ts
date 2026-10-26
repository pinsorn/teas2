import type { HomeSection } from './types';

const ANY = (re: RegExp) => (perms: string[]) => perms.some((p) => re.test(p));
/** The right behind each KPI tile (the engine that owns the figure). The VAT tile also needs the month filed or the preview right, which the server decides. */
export const KPI_TILES: ((perms: string[]) => boolean)[] = [
  (p) => p.includes('bank.read') || p.includes('ledger.read'), // cash
  (p) => p.includes('report.arap.read'), // receivables
  (p) => p.includes('report.arap.read'), // payables
  (p) => p.includes('tax.read'), // VAT this month (a VAT company)
];

/** HC1: the permission each Home section needs; a section the role cannot see is neither shown nor queried (the endpoint refuses it too). */
export const HOME_NEEDS: Record<HomeSection, (perms: string[]) => boolean> = {
  kpis: (p) => KPI_TILES.some((t) => t(p)), // the section shows when at least one tile is visible
  approvals: ANY(/^doc\.[A-Z]+\.(approve|issue)$/), // pending documents to approve, and agent drafts to look at for whoever may issue
  drafts: ANY(/^doc\.[A-Z]+\.create$/),
  overdue: (p) => ['TI', 'IV', 'PB', 'EX'].some((t) => p.includes(`doc.${t}.read`)),
  deadlines: (p) => p.includes('tax.read'),
  bank: (p) => p.includes('bank.read'),
  agent: ANY(/^doc\.[A-Z]+\.read$/),
  alerts: (p) => p.includes('audit.read') || p.includes('tax.read') || p.includes('doc.PB.read') || p.includes('doc.DP.read') || ANY(/^doc\.[A-Z]+\.create$/)(p),
};
export const HOME_SECTIONS = Object.keys(HOME_NEEDS) as HomeSection[];
export const homeSectionsFor = (perms: string[]): HomeSection[] => HOME_SECTIONS.filter((s) => HOME_NEEDS[s](perms));
