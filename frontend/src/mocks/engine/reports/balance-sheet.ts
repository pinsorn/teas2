import type { ReportModel, ReportRow } from '@/domain/reports';
import { GROUP_OF, type AccountClass, type AccountGroup } from '@/records/accounts';
import type { MockState } from '../../store';
import { fromSatang } from '../money';
import { balancesRange, isPl, plOf, yearBack } from './profit-loss';
import { type Acct, UNCLOSED_TH, badParam, classSections, dbdSections, glLink, money, needDate, sectionRows, secTotal, sumV } from './statement-lines';

export interface BsParams { asOf?: string; compare?: string; format?: string }

const BS_CLASSES: AccountClass[] = ['current-asset', 'non-current-asset', 'current-liability', 'non-current-liability', 'equity'];
const GROUP_TH: Record<'asset' | 'liability' | 'equity', string> = { asset: 'สินทรัพย์', liability: 'หนี้สิน', equity: 'ส่วนของเจ้าของ' };

/** ReportModel `balance-sheet`: every entry dated up to `asOf`, the year-end closing entries INCLUDED, classified current / non-current by account class (or by DBD line, [SP-R]). A closed year's profit has moved to retained earnings;
 *  the still-open years' profit shows as "กำไร (ขาดทุน) ที่ยังไม่ได้ปิดบัญชี" (= - Σ revenue / expense balances up to asOf), so the tie-out assets = liabilities + equity is a real check, not a plug.
 *  A live view of the GL: nothing is frozen at issue (the freeze rule is about documents and filings). */
export function balanceSheet(st: MockState, companyId: string, p: BsParams): ReportModel {
  const asOf = needDate('asOf', p.asOf), cmpMode = p.compare ?? '', dbd = p.format === 'dbd';
  if (cmpMode && cmpMode !== 'lastYear' && cmpMode !== 'yearEnd') throw badParam('ตัวเลือกเปรียบเทียบไม่ถูกต้อง');
  if (p.format && !dbd) throw badParam('รูปแบบงบไม่ถูกต้อง');
  const dates = [asOf, ...(cmpMode ? [cmpMode === 'lastYear' ? yearBack(asOf) : `${Number(asOf.slice(0, 4)) - 1}-12-31`] : [])];
  const cols = dates.map((d) => { const m = balancesRange(st, companyId, '', d, true); return { m, unclosed: -plOf(st, companyId, m).reduce((a, [, v]) => a + v, 0) }; });
  const diff = !!cmpMode, keys = [...(diff ? ['cur', 'cmp', 'diff'] : ['cur'])], n = keys.length;
  const ext = (v: number[]) => (diff ? [...v, v[0] - v[1]] : v);
  const mine = st.accounts.filter((a) => a.companyId === companyId);

  const accts: Acct[] = mine.filter((a) => !isPl(st, companyId, a.code) && cols.some((c) => (c.m.get(a.code) ?? 0) !== 0)).sort((a, b) => a.code.localeCompare(b.code)).map((a) => {
    const g = GROUP_OF[a.class], sgn = g === 'asset' ? 1 : -1;
    return { code: a.code, name: a.nameTh, group: g, ...(a.dbdLine ? { dbdLine: a.dbdLine } : {}), v: ext(cols.map((c) => sgn * (c.m.get(a.code) ?? 0))) };
  });
  if (cols.some((c) => c.unclosed !== 0)) accts.push({ code: '', name: UNCLOSED_TH, group: 'equity', dbdLine: 'bs-unappropriated', plain: true, v: ext(cols.map((c) => c.unclosed)) }); // unappropriated retained earnings of the years not yet closed
  const secs = dbd ? dbdSections(accts, 'bs') : classSections(accts, (c) => (c ? (mine.find((a) => a.code === c)!.class) : 'equity'), BS_CLASSES);

  const link = { href: (code: string) => glLink(code, { to: asOf }) };
  const total = (g: AccountGroup) => sumV(secs.filter((s) => s.group === g).map((s) => secTotal(s, n)), n);
  const rows: ReportRow[] = [];
  for (const g of ['asset', 'liability', 'equity'] as const) {
    const mineSecs = secs.filter((s) => s.group === g);
    if (!mineSecs.length) continue;
    for (const s of mineSecs) rows.push(...sectionRows(s, keys, link));
    rows.push({ level: 0, kind: 'total', cells: { code: '', name: GROUP_TH[g], ...money(keys, total(g)) } });
  }
  const le = sumV([total('liability'), total('equity')], n), assets = total('asset');
  if (rows.length) rows.push({ level: 0, kind: 'total', cells: { code: '', name: 'หนี้สินและส่วนของเจ้าของ', ...money(keys, le) } });
  const tie = (i: number, labelKey: string) => ({ labelKey, left: fromSatang(assets[i]), right: fromSatang(le[i]), diff: fromSatang(assets[i] - le[i]) });
  return {
    kind: 'balance-sheet', titleKey: 'reports.bs.title', asOf, params: Object.fromEntries(Object.entries({ asOf, compare: cmpMode, format: p.format ?? '' }).filter(([, v]) => v)),
    columns: [{ key: 'code', labelKey: 'reports.tb.code', kind: 'text' }, { key: 'name', labelKey: 'reports.tb.name', kind: 'text' },
      { key: 'cur', labelKey: 'reports.bs.cur', kind: 'money', align: 'end' },
      ...(diff ? [{ key: 'cmp', labelKey: 'reports.bs.cmp', kind: 'money' as const, align: 'end' as const }, { key: 'diff', labelKey: 'reports.pl.diff', kind: 'money' as const, align: 'end' as const }] : [])],
    rows,
    tieOuts: rows.length ? [tie(0, 'reports.bs.tie'), ...(diff ? [tie(1, 'reports.bs.tie')] : [])] : [],
    ...(diff ? { notes: [`เปรียบเทียบกับ ณ วันที่ ${dates[1]}`] } : {}),
  };
}
