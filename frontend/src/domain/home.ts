import type { HomeSection } from './types';

const ANY = (re: RegExp) => (perms: string[]) => perms.some((p) => re.test(p));
/** The right behind each KPI tile (the engine that owns the figure). The VAT tile: a VAT company, `tax.read`, and the preview right (the current month is never filed, so the register would refuse without it). */
export const KPI_TILES: ((perms: string[], vat: boolean) => boolean)[] = [
  (p) => p.includes('bank.read') || p.includes('ledger.read'), // cash
  (p) => p.includes('report.arap.read'), // receivables
  (p) => p.includes('report.arap.read'), // payables
  (p, vat) => vat && p.includes('tax.read') && p.includes('tax.filing.preview'), // VAT this month
];

/** HC1: the permission each Home section needs; a section the role cannot see is neither shown nor queried (the endpoint refuses it too). */
export const HOME_NEEDS: Record<HomeSection, (perms: string[], vat?: boolean) => boolean> = {
  kpis: (p, vat = true) => KPI_TILES.some((t) => t(p, vat)), // the section shows when at least one tile is visible
  approvals: ANY(/^doc\.[A-Z]+\.(approve|issue)$/), // pending documents to approve, and agent drafts to look at for whoever may issue
  drafts: ANY(/^doc\.[A-Z]+\.create$/),
  overdue: (p) => ['TI', 'IV', 'PB', 'EX'].some((t) => p.includes(`doc.${t}.read`)),
  deadlines: (p) => p.includes('tax.read'),
  bank: (p) => p.includes('bank.read'),
  agent: ANY(/^doc\.[A-Z]+\.read$/),
  alerts: (p) => p.includes('audit.read') || p.includes('tax.read') || p.includes('doc.PB.read') || p.includes('doc.DP.read') || ANY(/^doc\.[A-Z]+\.create$/)(p),
};
export const HOME_SECTIONS = Object.keys(HOME_NEEDS) as HomeSection[];
export const homeSectionsFor = (perms: string[], vat = true): HomeSection[] => HOME_SECTIONS.filter((s) => HOME_NEEDS[s](perms, vat));
