import type { ReportModel, ReportRow } from '@/domain/reports';
import { GROUP_OF } from '@/records/accounts';
import type { MockState } from '../../store';
import { sources } from '../journal';
import { MockError } from '../log';
import { fromSatang, toSatang } from '../money';
import { badParam, needDate } from './statement-lines';
import { trialBalance } from './trial-balance';

export interface GlParams { account?: string; from?: string; to?: string; party?: string; dimension?: string }

/** ReportModel `general-ledger`: one account's lines in date order with a running balance computed here (never by the grid), framed by the opening (every entry before `from`, closing entries included) and the closing.
 *  Shown on the account's natural side (debit for assets and expenses, credit for the rest). A party / dimension filter filters the opening the same way. The party parameter is a party ID (the page picker sends it): matched by the id on the posted line (a line posted before RP1a has none and is never matched by a party filter), so a rename or a same-named party changes nothing. A live view of the GL, nothing frozen. */
export function generalLedger(st: MockState, companyId: string, p: GlParams): ReportModel {
  const code = p.account?.trim() ?? '';
  if (!code) throw badParam('ต้องระบุบัญชี');
  const account = st.accounts.find((a) => a.companyId === companyId && a.code === code);
  if (!account) throw new MockError(404, 'ledger.account_not_found', `ไม่พบบัญชี ${code} ในผังบัญชีของบริษัท`);
  const from = p.from ? needDate('from', p.from) : '', to = p.to ? needDate('to', p.to) : '';
  if (from && to && from > to) throw badParam('วันที่เริ่มต้นต้องไม่หลังวันที่สิ้นสุด');
  const key = p.party?.trim();
  const party = key ? st.parties.find((x) => x.companyId === companyId && x.id === key) : undefined;
  if (key && !party) throw new MockError(404, 'party.not_found', 'ไม่พบคู่ค้านี้ในบริษัท');
  const [dimType, ...dimRest] = (p.dimension ?? '').split(/[:=]/);
  const dimValue = dimRest.join(':'), filtered = !!party || !!dimType;
  if (p.dimension && (!dimType || !dimValue)) throw badParam('ตัวกรองมิติ (dimension) ต้องอยู่ในรูป ประเภท:ค่า เช่น project:P-A');
  const natural = ['asset', 'expense'].includes(GROUP_OF[account.class]) ? 1 : -1;

  const hit = (l: { accountCode: string; partyId?: string; dimensions?: Record<string, string> }) =>
    l.accountCode === code && (!party || l.partyId === party.id) && (!dimType || l.dimensions?.[dimType] === dimValue);
  let open = 0;
  const lines = sources(st, companyId).flatMap((s) => s.entries.flatMap((e) => e.lines.filter(hit).map((l) => ({ s, e, l }))))
    .filter(({ e, l }) => { if (from && e.date < from) { open += toSatang(l.debit) - toSatang(l.credit); return false; } return !to || e.date <= to; })
    .sort((a, b) => a.e.date.localeCompare(b.e.date) || (a.e.postedAt ?? '').localeCompare(b.e.postedAt ?? '') || a.s.label.localeCompare(b.s.label));
  open *= natural;

  let run = open, dr = 0, cr = 0;
  const rows: ReportRow[] = lines.map(({ s, e, l }): ReportRow => {
    const d = toSatang(l.debit), c = toSatang(l.credit);
    run += natural * (d - c); dr += d; cr += c;
    const kind = e.kind === 'reversal' ? ' (กลับรายการ)' : e.kind === 'correction' ? ' (แก้ไข)' : '';
    return { level: 0, kind: 'row', cells: { date: e.date, doc: s.label, desc: `${l.rule}${kind}`, party: l.partyName ?? '', debit: d ? l.debit : '', credit: c ? l.credit : '', balance: fromSatang(run) },
      ...(s.href ? { links: { doc: s.href } } : {}) };
  });
  const blank = { date: '', doc: '', party: '', debit: '', credit: '' };
  if (rows.length || open !== 0) {
    rows.unshift({ level: 0, kind: 'group', cells: { ...blank, desc: 'ยอดยกมา', balance: fromSatang(open) } });
    rows.push({ level: 0, kind: 'total', cells: { date: '', doc: '', desc: 'ยอดยกไป', party: '', debit: fromSatang(dr), credit: fromSatang(cr), balance: fromSatang(run) } });
  }
  // unfiltered, the closing is the trial balance of the account: the report is checked against the other statement, not against itself
  const tb = trialBalance(st, companyId, { asOf: to || '9999-12-31' }).rows.find((r) => r.kind === 'row' && r.cells.code === code)?.cells;
  const tbNet = natural * (tb ? toSatang(tb.debit) - toSatang(tb.credit) : 0);
  return {
    kind: 'general-ledger', titleKey: 'reports.gl.title', params: Object.fromEntries(Object.entries({ account: code, from, to, party: p.party ?? '', dimension: p.dimension ?? '' }).filter(([, v]) => v)),
    columns: [
      { key: 'date', labelKey: 'reports.gl.date', kind: 'date' }, { key: 'doc', labelKey: 'reports.gl.doc', kind: 'text' }, { key: 'desc', labelKey: 'reports.gl.desc', kind: 'text' }, { key: 'party', labelKey: 'reports.gl.party', kind: 'text' },
      { key: 'debit', labelKey: 'reports.tb.debit', kind: 'money', align: 'end' }, { key: 'credit', labelKey: 'reports.tb.credit', kind: 'money', align: 'end' }, { key: 'balance', labelKey: 'reports.gl.balance', kind: 'money', align: 'end' },
    ],
    rows,
    ...(rows.length && !filtered ? { tieOuts: [{ labelKey: 'reports.gl.tie', left: fromSatang(run), right: fromSatang(tbNet), diff: fromSatang(run - tbNet) }] } : { tieOuts: [] }),
    ...(filtered ? { notes: ['ยอดยกมาและยอดยกไปคำนวณจากรายการที่ตรงกับตัวกรอง (คู่ค้า / มิติ) เท่านั้น'] } : {}),
  };
}
