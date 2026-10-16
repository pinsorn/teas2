import { LIVE } from '@/domain/doc-types';
import type { Actor, DocLine, WhtLine } from '@/domain/types';
import type { MockState } from '../store';
import { bahtText } from './bahtText';
import { logActivity, stamp } from './log';
import { SeriesAllocator } from './numbering';
import { freezeWht } from './settlement';
import { whtTypeOf } from './wht';

type Stored = MockState['docs'][number];

/** SP0 7.3 / I7: the reason a withholding certificate carries when its payment voucher is cancelled or revised away from it. */
export const WT_CANCEL_REASON = 'ยกเลิกตามใบสำคัญจ่าย';

/** The certificates (50 ทวิ) a voucher currently issues: its active `issues` links and the WT behind each. */
export const wtsOfPv = (st: MockState, pvId: string): { link: MockState['links'][number]; wt: Stored }[] =>
  st.links.filter((l) => l.active && l.kind === 'issues' && l.from === pvId)
    .flatMap((link) => { const wt = st.docs.find((d) => d.id === link.to && d.type === 'WT'); return wt ? [{ link, wt }] : []; });

/** What identifies the money on a certificate: change any of it and the old certificate is void (a new one is issued, §7.3 L), keep it all and the certificate stands. */
const figures = (type: string, income: string, tax: string, form: string, partyId: string | undefined, date: string) => [type, income, tax, form, partyId ?? '', date].join('|');
const wantKey = (l: WhtLine, pv: Stored) => figures(l.code, l.income, l.tax, l.form, pv.header.partyId, pv.header.documentDate);
const haveKey = (wt: Stored) => figures(wt.header.whtTypeCode ?? '', wt.totals.total, wt.header.whtTax ?? '', wt.header.whtForm ?? '', wt.header.partyId, wt.header.documentDate);

function cancelWt(st: MockState, wt: Stored, link: MockState['links'][number], actor: Actor): void {
  const at = stamp();
  st.docs[st.docs.findIndex((d) => d.id === wt.id)] = { ...wt, status: 'cancelled', version: wt.version + 1, cancel: { reasonCode: 'PV_CANCELLED', reasonText: WT_CANCEL_REASON, at } };
  link.active = false;
  logActivity(st, wt.id, actor, 'cancel', WT_CANCEL_REASON);
}

/** One certificate per WHT type of the voucher, numbered and linked (PV --issues--> WT) in the same command as the voucher. */
function issueWt(st: MockState, pv: Stored, l: WhtLine, actor: Actor): void {
  let n = st.docs.length + 1;
  while (st.docs.some((d) => d.id === `doc-wt-${n}`)) n++;
  const id = `doc-wt-${n}`;
  const alloc = new SeriesAllocator(st.series);
  const number = alloc.next(pv.companyId, 'WT', pv.header.documentDate);
  st.series = alloc.toJSON();
  const incomeType = whtTypeOf(st, l.code, pv.party!, pv.header.documentDate).incomeType;
  const line: DocLine = { id: `${id}-l1`, description: `${incomeType} ${l.nameTh}`, qty: '1', unit: 'รายการ', unitPrice: l.income, taxCode: 'EX', whtTypeCode: l.code };
  const doc: Stored = {
    companyId: pv.companyId, id, type: 'WT', number, status: 'issued', correctionClass: 'T', revision: 0, version: 1,
    header: { partyId: pv.header.partyId, documentDate: pv.header.documentDate, ...(pv.number ? { reference: pv.number } : {}), whtForm: l.form, whtTypeCode: l.code, whtIncomeType: incomeType, whtTax: l.tax },
    ...(pv.party ? { party: pv.party } : {}), lines: [line],
    totals: { gross: l.income, discount: '0.00', net: l.income, vat: '0.00', total: l.income, wht: l.tax, amountInWords: bahtText(l.tax) },
    locks: [], createdBy: actor, issuedAt: stamp(),
  };
  st.docs.push(doc);
  const { companyId: _c, ...pub } = doc; void _c;
  st.revisions.push({ docId: id, revision: 0, at: doc.issuedAt!, actor, snapshot: structuredClone(pub), diff: [] });
  st.links.push({ companyId: pv.companyId, from: pv.id, to: id, kind: 'issues', amount: l.tax, active: true });
  logActivity(st, id, actor, 'issue', `จาก ${pv.number ?? pv.id}`);
}

/** Brings the voucher's certificates in line with what it withholds now: a type whose figures are unchanged keeps its certificate; a changed or dropped type has its certificate cancelled
 *  (reason "ยกเลิกตามใบสำคัญจ่าย") and a changed or new one is issued afresh. A cancelled / replaced voucher keeps none. Runs inside the voucher's own command. */
export function syncWts(st: MockState, pvId: string, actor: Actor): void {
  const pv = st.docs.find((d) => d.id === pvId)!;
  const want = LIVE.includes(pv.status) ? (pv.whtFrozen ?? freezeWht(st, pv.companyId, pv, pv.id)).lines : [];
  const kept = new Set<string>();
  for (const { link, wt } of wtsOfPv(st, pvId)) {
    const hit = want.find((l) => l.code === wt.header.whtTypeCode && wantKey(l, pv) === haveKey(wt) && !kept.has(l.code));
    if (hit) kept.add(hit.code); else cancelWt(st, wt, link, actor);
  }
  const fresh = want.filter((l) => !kept.has(l.code));
  for (const l of fresh) issueWt(st, pv, l, actor);
  if (fresh.length) logActivity(st, pvId, actor, 'ออกหนังสือรับรองหัก ณ ที่จ่าย', `${fresh.length} ฉบับ`);
}

/** A cancelled voucher takes its certificates with it (called by `cancel` before the voucher's links are released). */
export const cancelWtsOfPv = (st: MockState, pvId: string, actor: Actor): void => {
  for (const { link, wt } of wtsOfPv(st, pvId)) cancelWt(st, wt, link, actor);
};
