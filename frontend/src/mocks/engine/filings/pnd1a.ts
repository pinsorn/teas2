import { LIVE } from '@/domain/doc-types';
import type { FilingBlocker, FilingBox, FilingModel } from '@/domain/filings';
import type { IssueLook, PaperModel } from '@/domain/types';
import type { MockState } from '../../store';
import { USER } from '../../fixtures/documents';
import { bahtText } from '../bahtText';
import { finishPaper, snapshotLook } from '../look';
import { MockError, today } from '../log';
import { fromSatang, toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { type Filing, type PayrollRow, boxOf, fnv, tie } from './pp30';
import { baseBlockers, nidBlockers, payrollHref, runsOf } from './pnd1';

/** PY3: ภ.ง.ด.1ก (the year). Ruling 5: per employee = the employee's opening-balance payroll YTD (AC3; only an opening balance OF THIS YEAR counts, labelled "ก่อนใช้ระบบ") + Σ the year's FINALIZED ภ.ง.ด.1 months (their stored rows). Frozen at finalize like the monthly returns;
 *  the invariant re-derives the rows from the stored months and the stored opening part. The annual 50 ทวิ for employees is printed from these stored rows (ruling 8). */
const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
export const YEAR = /^\d{4}$/;
type Ob = { income: number; pit: number; sso: number; name: string; nationalId: string };

/** The finalized ภ.ง.ด.1 months of the year, in month order. */
export const monthsOf = (st: MockState, companyId: string, year: string): Filing[] =>
  st.filings.filter((f) => f.companyId === companyId && f.form === 'PND1' && f.period.startsWith(year) && !!f.payroll).sort((a, b) => a.period.localeCompare(b.period));

/** AC3: the payroll year to date of the company's live opening balances dated in `year`, per employee, with the employee as the master names them (frozen into the row at finalize). */
function obOf(st: MockState, companyId: string, year: string): Map<string, Ob> {
  const out = new Map<string, Ob>();
  for (const d of st.docs) {
    if (d.companyId !== companyId || d.type !== 'OB' || !d.opening || !LIVE.includes(d.status) || d.header.documentDate.slice(0, 4) !== year) continue;
    for (const r of d.opening.payrollYtd) {
      const p = st.parties.find((x) => x.id === r.employeeId && x.companyId === companyId), o = out.get(r.employeeId) ?? { income: 0, pit: 0, sso: 0, name: p?.name ?? r.employeeId, nationalId: p?.taxId ?? '' };
      out.set(r.employeeId, { ...o, income: o.income + sat(r.income), pit: o.pit + sat(r.pit), sso: o.sso + sat(r.sso) });
    }
  }
  return out;
}

/** The rows from the finalized months and the opening part (one function for finalize and for the invariant). Name and national id are the LAST month's row when the employee was paid in the system, else the opening part's. Ordered by employee id. */
export function yearRows(months: Filing[], ob: Map<string, Ob>): PayrollRow[] {
  const acc = new Map<string, { name: string; nationalId: string; income: number; pit: number; sso: number; ssoEmployer: number }>();
  for (const [id, o] of ob) acc.set(id, { name: o.name, nationalId: o.nationalId, income: o.income, pit: o.pit, sso: o.sso, ssoEmployer: 0 });
  for (const f of months) for (const r of f.payroll!.rows) {
    const a = acc.get(r.employeeId) ?? { name: r.name, nationalId: r.nationalId, income: 0, pit: 0, sso: 0, ssoEmployer: 0 };
    acc.set(r.employeeId, { name: r.name, nationalId: r.nationalId, income: a.income + sat(r.income), pit: a.pit + sat(r.pit), sso: a.sso + sat(r.sso), ssoEmployer: a.ssoEmployer + sat(r.ssoEmployer) });
  }
  return [...acc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([employeeId, a]) => {
    const o = ob.get(employeeId);
    return { employeeId, name: a.name, nationalId: a.nationalId, income: fromSatang(a.income), pit: fromSatang(a.pit), sso: fromSatang(a.sso), ssoEmployer: fromSatang(a.ssoEmployer),
      ...(o ? { ob: { income: fromSatang(o.income), pit: fromSatang(o.pit), sso: fromSatang(o.sso) } } : {}) };
  });
}

const COLUMNS = [['no', 'ลำดับ'], ['nationalId', 'เลขประจำตัวประชาชน'], ['name', 'ชื่อผู้มีเงินได้'], ['obIncome', 'เงินได้ก่อนใช้ระบบ (ยอดยกมา)'], ['income', 'เงินได้ทั้งปี'], ['tax', 'ภาษีที่หักทั้งปี'], ['sso', 'ประกันสังคมที่จ่ายทั้งปี']] as const;
export const pnd1aAttachment = (rows: PayrollRow[]): NonNullable<FilingModel['attachment']> => ({ columns: COLUMNS.map(([key, labelTh]) => ({ key, labelTh })),
  rows: rows.map((r, i) => ({ no: String(i + 1), nationalId: r.nationalId, name: r.name, obIncome: r.ob?.income ?? '-', income: r.income, tax: r.pit ?? '0.00', sso: r.sso })) });
const sum = (rows: PayrollRow[], f: (r: PayrollRow) => string | undefined) => rows.reduce((n, r) => n + sat(f(r)), 0);
export const pnd1aBoxes = (rows: PayrollRow[]): FilingBox[] => [{ code: 'payees', labelTh: 'จำนวนผู้มีเงินได้ (ราย)', amount: String(rows.length), kind: 'count' },
  { code: 'income', labelTh: 'เงินได้ที่จ่ายทั้งปี', amount: fromSatang(sum(rows, (r) => r.income)) }, { code: 'tax', labelTh: 'ภาษีที่หักและนำส่งทั้งปี', amount: fromSatang(sum(rows, (r) => r.pit)) },
  { code: 'sso', labelTh: 'เงินสมทบประกันสังคมที่ผู้มีเงินได้จ่ายทั้งปี', amount: fromSatang(sum(rows, (r) => r.sso)) }];
/** 1ก Σ tax = the opening part + Σ the tax boxes of the finalized months (ruling 5 invariant, also shown on the page). */
const monthsTax = (months: Filing[], rows: PayrollRow[]) => months.reduce((n, f) => n + boxOf(f.boxes, 'tax'), 0) + sum(rows, (r) => r.ob?.pit);
const ties = (months: Filing[], rows: PayrollRow[], boxes: FilingBox[]) => [tie('filing.tie.pnd1aMonths', boxOf(boxes, 'tax'), monthsTax(months, rows))];
/** [SP-R] the ภ.ง.ด.1ก is due at the end of February of the next year. */
const due = (year: string) => `${Number(year) + 1}-02-${new Date(Date.UTC(Number(year) + 1, 2, 0)).getUTCDate()}`;

export function pnd1aModel(st: MockState, companyId: string, year: string): FilingModel {
  if (!YEAR.test(year)) throw fail(422, 'filing.bad_period', 'ปีต้องอยู่ในรูปแบบ ปปปป');
  const months = monthsOf(st, companyId, year), rows = yearRows(months, obOf(st, companyId, year)), boxes = pnd1aBoxes(rows);
  const blockers: FilingBlocker[] = [...baseBlockers(st, companyId)];
  if (!rows.length) blockers.push({ code: 'no_documents', labelTh: `ปี ${Number(year) + 543} ไม่มีรอบเงินเดือนหรือยอดยกมาเงินเดือนสะสมที่ต้องยื่น ภ.ง.ด.1ก` });
  for (let m = 1; m <= 12; m++) { // a month of the year with an issued run whose ภ.ง.ด.1 is not finalized
    const p = `${year}-${String(m).padStart(2, '0')}`;
    if (runsOf(st, companyId, p).length && !months.some((f) => f.period === p)) blockers.push({ code: 'pnd1_open', labelTh: `ยังไม่ได้ยืนยันแบบ ภ.ง.ด.1 เดือน ${monthLabelTh(p)}`, href: payrollHref('pnd1', p) });
  }
  blockers.push(...nidBlockers(rows));
  // PY3a B1: like the CIT year forms, a year is filed only once it is over: a filed ภ.ง.ด.1ก refuses every later run of the year and nothing reopens it
  if (today() <= `${year}-12-31`) blockers.push({ code: 'year_not_closed', labelTh: `ปี ${Number(year) + 543} ยังไม่สิ้นปี ยืนยัน ภ.ง.ด.1ก ได้หลังสิ้นปี (เมื่อยืนยันแล้วออกรอบเงินเดือนของปีนี้เพิ่มไม่ได้)` });
  const warnings: string[] = [];
  return { form: 'PND1A', period: year, status: 'draft', boxes, tieOuts: ties(months, rows, boxes), blockers, warnings, attachment: pnd1aAttachment(rows), version: fnv(JSON.stringify([months.map((f) => f.period), rows])), dueDate: due(year), exports: ['rdprep-txt', 'pdf'] };
}
/** ST4: the finalize also freezes the logo, the stamp and the signer's signature the employees' 50 ทวิ print (references into `st.images`; beside the company as filed, NOT part of its fingerprint). A finalize is a signed-in user's act. */
export const pnd1aSnapshot = (st: MockState, companyId: string, year: string): Pick<Filing, 'payroll' | 'docs' | 'carryIn' | 'pp36'> & { look: IssueLook } => {
  const months = monthsOf(st, companyId, year);
  return { payroll: { runs: [], rows: yearRows(months, obOf(st, companyId, year)), months: months.map((f) => f.period) }, docs: [], carryIn: '0.00', pp36: '0.00', look: snapshotLook(st, companyId, USER) };
};

/** Ruling 5: the stored months are exactly the finalized ภ.ง.ด.1 of the year; each row is its stored opening part + Σ those months' stored rows; the boxes are Σ rows; 1ก Σ = opening + Σ months. */
export function pnd1aInvariants(st: MockState, f: Filing, w: string, out: string[]): void {
  const snap = f.payroll!, year = f.period, months = monthsOf(st, f.companyId, year);
  if (JSON.stringify(snap.months ?? []) !== JSON.stringify(months.map((m) => m.period))) { out.push(`${w}: it took months ${(snap.months ?? []).join(', ') || 'none'} but the finalized ภ.ง.ด.1 of the year are ${months.map((m) => m.period).join(', ') || 'none'}`); return; }
  const ob = new Map<string, Ob>(snap.rows.filter((r) => r.ob).map((r) => [r.employeeId, { income: sat(r.ob!.income), pit: sat(r.ob!.pit), sso: sat(r.ob!.sso), name: r.name, nationalId: r.nationalId }]));
  const want = yearRows(months, ob), have = snap.rows;
  if (want.length !== have.length) out.push(`${w}: the stored rows are ${have.length} but the stored opening part and months give ${want.length}`);
  for (const [i, r] of have.entries()) {
    const x = want[i] as PayrollRow | undefined;
    if (!x) continue;
    for (const k of new Set([...Object.keys(r), ...Object.keys(x)]) as Set<keyof PayrollRow>) if (JSON.stringify(r[k]) !== JSON.stringify(x[k])) out.push(`${w}: row ${r.employeeId} ${k} ${JSON.stringify(r[k]) ?? 'none'} but opening + months give ${JSON.stringify(x[k]) ?? 'none'}`);
  }
  const live = obOf(st, f.companyId, year), kept = new Map(have.filter((r) => r.ob).map((r) => [r.employeeId, r.ob!])); // PY3a M2: the opening balance the 1ก took is still what the books hold
  for (const id of new Set([...live.keys(), ...kept.keys()])) {
    const a = live.get(id), b = kept.get(id);
    if (!a || !b || a.income !== sat(b.income) || a.pit !== sat(b.pit) || a.sso !== sat(b.sso)) out.push(`${w}: the opening payroll year to date of ${id} on the return (${b ? `${b.income} / ${b.pit} / ${b.sso}` : 'none'}) is not what the opening balance holds now (${a ? `${fromSatang(a.income)} / ${fromSatang(a.pit)} / ${fromSatang(a.sso)}` : 'none'})`);
  }
  if (JSON.stringify(pnd1aBoxes(have)) !== JSON.stringify(f.boxes)) out.push(`${w}: the stored boxes are not Σ its stored rows`);
  const t = f.tieOuts[0];
  if (f.tieOuts.length !== 1 || t.labelKey !== 'filing.tie.pnd1aMonths') out.push(`${w}: tie-out filing.tie.pnd1aMonths is missing`);
  else if (sat(t.left) !== boxOf(f.boxes, 'tax') || sat(t.right) !== monthsTax(months, have) || sat(t.diff) !== 0) out.push(`${w}: tie-out filing.tie.pnd1aMonths is not 1ก Σ tax = opening + Σ finalized months`);
}

const branchLabel = (code: string) => (code === '00000' ? 'สำนักงานใหญ่ (00000)' : `สาขา ${code}`);
/** Ruling 8: one 50 ทวิ per employee from the FINALIZED ภ.ง.ด.1ก rows: income 40(1), the PIT withheld, the SSO paid in the funds field, the ภ.ง.ด.1ก box ticked. Payer = the company as filed (name, tax id, branch). The paper shows the stored figures; it computes nothing. */
export function employeeCertificates(st: MockState, companyId: string, year: string): PaperModel[] {
  if (!YEAR.test(year)) throw fail(422, 'filing.bad_period', 'ปีต้องอยู่ในรูปแบบ ปปปป');
  const f = st.filings.find((x) => x.companyId === companyId && x.form === 'PND1A' && x.period === year);
  if (!f?.payroll) throw fail(409, 'filing.not_finalized', 'ยืนยัน ภ.ง.ด.1ก ก่อนจึงจะออกหนังสือรับรองการหักภาษี ณ ที่จ่ายของพนักงานได้');
  const look = (f as Filing & { look?: IssueLook }).look ?? {};
  return f.payroll.rows.map((r, i) => {
    const p = st.parties.find((x) => x.id === r.employeeId && x.companyId === companyId), tax = r.pit ?? '0.00';
    return {
      titleTh: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย', titleEn: 'WITHHOLDING TAX CERTIFICATE', copyLabel: 'ต้นฉบับ', number: `${Number(year) + 543}-${String(i + 1).padStart(3, '0')}`, documentDate: f.finalizedAt.slice(0, 10), reference: `ภ.ง.ด.1ก ปี ${Number(year) + 543}`,
      seller: { name: f.company.legalNameTh, nameEn: f.company.legalNameEn, address: f.company.address ?? '', phone: f.company.phone, taxId: f.company.taxId, branchLabel: branchLabel(f.company.branchCode) },
      buyer: { name: r.name, address: p?.address ?? '', taxId: r.nationalId },
      partyLabel: 'ผู้ถูกหักภาษี ณ ที่จ่าย', lines: [], totals: { gross: r.income, discount: '0.00', net: r.income, vat: '0.00', total: r.income, amountInWords: bahtText(r.income) }, signatures: ['ผู้จ่ายเงิน', 'ผู้มีอำนาจลงนาม'],
      certificate: { form: 'PND1A', incomeType: '40(1) เงินเดือน ค่าจ้าง', incomeLabel: 'เงินเดือน ค่าจ้าง เบี้ยเลี้ยง โบนัส ฯลฯ', paidOn: `${year}-12-31`, income: r.income, tax, taxInWords: bahtText(tax), condition: 'withhold', ssoPaid: r.sso },
      images: { ...(look.logo ? { logo: look.logo } : {}), ...(look.stamp ? { stamp: look.stamp } : {}), ...(look.signature ? { signature: look.signature } : {}) }, issuer: { ...(look.issuerName ? { name: look.issuerName } : {}), ...(look.issuerPosition ? { position: look.issuerPosition } : {}) },
    } as PaperModel;
  }).map((m) => finishPaper(st, companyId, 'WT', m)); // the 50 ทวิ template's options (ST4); the pictures are the ones the return was finalized with
}
