import type { FilingBlocker, FilingBox, FilingModel } from '@/domain/filings';
import type { MockState } from '../../store';
import { MockError } from '../log';
import { fromSatang, toSatang } from '../money';
import { monthLabelTh } from '../periods';
import { type Filing, type PayrollRow, PERIOD, boxOf, chainBlockers, dueDateOf, fnv, tie } from './pp30';
import { baseBlockers, deriveRows, draftWarnings, nidBlockers, payrollHref, payrollMovement, payrollSnapInvariants, rateOf, runRefs, runsOf, ssoOpen } from './pnd1';

/** PY3: สปส.1-10 (the social security return of a month). Wage base and contributions come from the STORED slips (the slip's own floor / ceiling), employee and employer totals are Σ slip `sso` / `ssoEmployer` (ruling 6). */
const sat = (m: string | undefined) => toSatang(m ?? '0.00');
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);

/** TIS-620: ASCII 0x20-0x7E, Thai U+0E01-U+0E3A -> 0xA1-0xDA and U+0E3F-U+0E5B -> 0xDF-0xFB. Anything else (an emoji, an accented Latin letter) has no byte. A byte is one character of the 135-column line. */
export const tis620Byte = (ch: string): number | undefined => {
  const c = ch.codePointAt(0)!;
  return c >= 0x20 && c <= 0x7e ? c : c >= 0x0e01 && c <= 0x0e3a ? c - 0x0e01 + 0xa1 : c >= 0x0e3f && c <= 0x0e5b ? c - 0x0e3f + 0xdf : undefined;
};
export const encodable = (s: string) => [...s].every((ch) => tis620Byte(ch) !== undefined);

const COLUMNS = [['no', 'ลำดับ'], ['nationalId', 'เลขประจำตัวประชาชน'], ['name', 'ชื่อผู้ประกันตน'], ['wage', 'ค่าจ้างที่ใช้คำนวณ'], ['employee', 'เงินสมทบส่วนลูกจ้าง'], ['employer', 'เงินสมทบส่วนนายจ้าง']] as const;
export const ssoAttachment = (rows: PayrollRow[]): NonNullable<FilingModel['attachment']> => ({ columns: COLUMNS.map(([key, labelTh]) => ({ key, labelTh })),
  rows: rows.map((r, i) => ({ no: String(i + 1), nationalId: r.nationalId, name: r.name, wage: r.wageBase ?? '0.00', employee: r.sso, employer: r.ssoEmployer })) });
const sum = (rows: PayrollRow[], f: (r: PayrollRow) => string | undefined) => rows.reduce((n, r) => n + sat(f(r)), 0);
export const ssoBoxes = (rows: PayrollRow[]): FilingBox[] => [{ code: 'employees', labelTh: 'จำนวนผู้ประกันตน (ราย)', amount: String(rows.length), kind: 'count' },
  { code: 'wage', labelTh: 'ค่าจ้างที่ใช้คำนวณเงินสมทบรวม', amount: fromSatang(sum(rows, (r) => r.wageBase)) }, { code: 'employee', labelTh: 'เงินสมทบส่วนของผู้ประกันตน', amount: fromSatang(sum(rows, (r) => r.sso)) },
  { code: 'employer', labelTh: 'เงินสมทบส่วนของนายจ้าง', amount: fromSatang(sum(rows, (r) => r.ssoEmployer)) },
  { code: 'total', labelTh: 'เงินสมทบที่ต้องนำส่งทั้งสิ้น', amount: fromSatang(sum(rows, (r) => r.sso) + sum(rows, (r) => r.ssoEmployer)) }];
/** Σ employee + employer contributions = the month's 2160 credit movement from the payroll runs; anything else on 2160 is a separate line. */
export function ssoTies(st: MockState, companyId: string, period: string, boxes: FilingBox[]) {
  const m = payrollMovement(st, companyId, 'SsoPayable', period);
  return [tie('filing.tie.ssoGl', boxOf(boxes, 'total'), m.runs), tie('filing.tie.ssoOther', m.other, 0)];
}

export function ssoModel(st: MockState, companyId: string, period: string): FilingModel {
  if (!PERIOD.test(period)) throw fail(422, 'filing.bad_period', 'งวดต้องอยู่ในรูปแบบ ปปปป-ดด');
  const runs = runsOf(st, companyId, period), rows = deriveRows(runs, 'sso'), boxes = ssoBoxes(rows), co = st.companies.find((c) => c.id === companyId);
  const blockers: FilingBlocker[] = [...baseBlockers(st, companyId)];
  if (ssoOpen(co)) blockers.push({ code: 'sso_account', labelTh: 'ยังไม่ได้ระบุเลขที่บัญชีนายจ้างประกันสังคม (10 หลัก) ของบริษัท', href: '/settings/company' }); // the exit is the company settings page
  if (!rows.length) blockers.push({ code: 'no_documents', labelTh: `เดือน ${monthLabelTh(period)} ไม่มีผู้ประกันตนในรอบเงินเดือนที่ออกแล้ว จึงไม่มีรายการยื่น สปส.1-10` });
  blockers.push(...nidBlockers(rows));
  for (const r of rows) if (!encodable(r.name)) blockers.push({ code: 'name_encoding', labelTh: `ชื่อ ${r.name} มีอักขระที่เข้ารหัส TIS-620 ไม่ได้ (ไฟล์ส่งประกันสังคมใช้ TIS-620) แก้ชื่อพนักงานก่อน`, href: `/payroll/employees/${r.employeeId}` });
  if (co && !encodable(co.legalNameTh)) blockers.push({ code: 'name_encoding', labelTh: `ชื่อบริษัท ${co.legalNameTh} มีอักขระที่เข้ารหัส TIS-620 ไม่ได้`, href: '/settings/company' });
  blockers.push(...chainBlockers(st, companyId, 'SSO1-10', period, 'สปส.1-10', (p) => payrollHref('sso', p), (p) => runsOf(st, companyId, p).length > 0));
  return { form: 'SSO1-10', period, status: 'draft', boxes, tieOuts: ssoTies(st, companyId, period, boxes), blockers, warnings: draftWarnings(st, companyId, period), attachment: ssoAttachment(rows),
    version: fnv(JSON.stringify([runRefs(runs), rows, co?.ssoEmployerAccountNo ?? ''])), dueDate: dueDateOf(period), exports: ['rdprep-txt', 'pdf'] };
}
export const ssoSnapshot = (st: MockState, companyId: string, period: string): Pick<Filing, 'payroll' | 'docs' | 'carryIn' | 'pp36'> => {
  const runs = runsOf(st, companyId, period);
  return { payroll: { runs: runRefs(runs), rows: deriveRows(runs, 'sso'), ...(rateOf(runs) !== undefined ? { rateBp: rateOf(runs)! } : {}) }, docs: [], carryIn: '0.00', pp36: '0.00' };
};

/** Ruling 6 export "ไฟล์ส่งประกันสังคม": fixed-width text, 135 columns a line (one TIS-620 byte a column), CRLF, built ONLY from the finalized return's stored rows and the company as filed.
 *  [SP-R] the field layout is a mock rule (discovery 01 gives the 135-column width and the TIS-620 encoding, not the columns; the real layout is verified against the SSO's specification at SP2):
 *  header '1' | account (10) | branch (6) | period MMYYYY BE (6) | employer name (60) | rate % x100 (4) | employees (6) | wages in satang (15) | contributions in satang (15) | blank (12);
 *  detail '2' | national id (13) | name (60) | wage in satang (15) | employee share (15) | employer share (15) | blank (16). */
export function ssoFileText(f: Filing): string {
  const co = f.company, rows = f.payroll!.rows, num = (m: string | undefined, w: number) => String(sat(m)).padStart(w, '0');
  const txt = (s: string, w: number) => s.slice(0, w).padEnd(w, ' ');
  const total = (g: (r: PayrollRow) => string | undefined) => fromSatang(sum(rows, g));
  const be = `${f.period.slice(5, 7)}${Number(f.period.slice(0, 4)) + 543}`;
  const lines = [`1${txt(co.ssoEmployerAccountNo ?? '', 10)}${co.branchCode.padStart(6, '0')}${be}${txt(co.legalNameTh, 60)}${String(f.payroll!.rateBp ?? 500).padStart(4, '0')}${String(rows.length).padStart(6, '0')}${num(total((r) => r.wageBase), 15)}${num(fromSatang(sum(rows, (r) => r.sso) + sum(rows, (r) => r.ssoEmployer)), 15)}${' '.repeat(12)}`,
    ...rows.map((r) => `2${txt(r.nationalId, 13)}${txt(r.name, 60)}${num(r.wageBase, 15)}${num(r.sso, 15)}${num(r.ssoEmployer, 15)}${' '.repeat(16)}`)];
  for (const l of lines) if (l.length !== 135 || ![...l].every((ch) => tis620Byte(ch) !== undefined)) throw fail(500, 'filing.sso_layout', 'ไฟล์ประกันสังคมสร้างไม่ถูกรูปแบบ (135 ตัวอักษร / TIS-620)');
  return `${lines.join('\r\n')}\r\n`;
}

export function ssoInvariants(st: MockState, f: Filing, w: string, out: string[]): void {
  const rows = f.payroll!.rows;
  payrollSnapInvariants(st, f, w, out, 'sso');
  if (JSON.stringify(ssoBoxes(rows)) !== JSON.stringify(f.boxes)) out.push(`${w}: the stored boxes are not Σ its stored rows`);
  const t = f.tieOuts[0];
  if (f.tieOuts.length !== 2 || t.labelKey !== 'filing.tie.ssoGl' || f.tieOuts[1].labelKey !== 'filing.tie.ssoOther') out.push(`${w}: tie-outs filing.tie.ssoGl / ssoOther are missing`);
  else if (sat(t.left) !== boxOf(f.boxes, 'total')) out.push(`${w}: tie-out filing.tie.ssoGl left ${t.left} is not the stored box`);
  if (ssoOpen(f.company)) out.push(`${w}: filed without a valid SSO employer account (10 digits)`);
  for (const r of rows) if (!encodable(r.name)) out.push(`${w}: ${r.employeeId} name cannot be encoded in TIS-620`);
}
