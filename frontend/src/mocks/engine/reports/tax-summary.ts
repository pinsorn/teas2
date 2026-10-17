import type { FilingForm } from '@/domain/filings';
import type { FormCatalogue, FormCatalogueItem, ReportChip, ReportColumn, ReportModel, ReportRow } from '@/domain/reports';
import type { MockState } from '../../store';
import { filingHref, getFiling, unfiledForms } from '../filings';
import { boxOf } from '../filings/pp30';
import { PND_FORMS, formName } from '../filings/pnd-wht';
import { MockError, today } from '../log';
import { fromSatang } from '../money';
import { monthLabelTh } from '../periods';
import { salesRevenue } from '../vat-threshold';
import { whtAllocations } from './wht-receivable';

const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
const lastDayOf = (m: string) => `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
/** The monthly returns a month can owe, in the order the status chips are drawn. */
const MONTHLY: FilingForm[] = ['PP30', 'PND2', 'PND3', 'PND53', 'PND54', 'PP36'];

/** The status chips of a month (state: finalized / paid / draft / owed / na). A finalized month is its snapshot; an unfiled one is owed once its month has ended (the SAME helper the
 *  close checklist uses: `unfiledForms`), a draft while it is still the current month. A month with no return to file says na; a future month says nothing. */
function chips(st: MockState, companyId: string, month: string): ReportChip[] {
  const now = today().slice(0, 7);
  if (month > now) return [];
  const owed = unfiledForms(st, companyId, month);
  const out = MONTHLY.flatMap((form) => {
    const f = st.filings.find((x) => x.companyId === companyId && x.form === form && x.period === month);
    const state = f ? (getFiling(st, companyId, form, month).payment?.status === 'paid' ? 'paid' : 'finalized') : owed.includes(form) ? (month < now ? 'owed' : 'draft') : '';
    return state ? [{ form: formName(form), state, href: filingHref(form, month) } as ReportChip] : [];
  });
  return out.length ? out : [{ form: '', state: 'na' }];
}

/** สรุปภาษีรายเดือน (TX3b): twelve months of a year x sales, output / input / net VAT (VAT companies), the tax withheld by form, the tax customers withheld from us, and a status chip per return. A finalized month reads its stored
 *  boxes, never recomputed; an unfiled month is computed only for a caller who may preview filings (`canPreview`), else it shows status only. */
export function taxSummary(st: MockState, companyId: string, p: Record<string, string>, canPreview: boolean): ReportModel {
  const year = p.year || today().slice(0, 4);
  if (!/^\d{4}$/.test(year)) throw new MockError(422, 'report.bad_param', 'ปีต้องเป็นตัวเลข 4 หลัก');
  const vat = st.companies.find((c) => c.id === companyId)?.vatRegistered === true, now = today().slice(0, 7);
  const t = (key: string, kind: ReportColumn['kind'] = 'money'): ReportColumn => ({ key, labelKey: `reports.taxSummary.${key}`, kind, ...(kind === 'money' ? { align: 'end' as const } : {}) });
  const columns = [t('month', 'text'), t('status', 'status'), t('sales'), ...(vat ? [t('outVat'), t('inVat'), t('netVat')] : []), ...PND_FORMS.map((f) => t(f.toLowerCase())), t('whtIn')];
  const kept = whtAllocations(st, companyId);
  const sums: Record<string, number> = {};
  const rows: ReportRow[] = MONTHS.map((mm) => {
    const month = `${year}-${mm}`, cells: Record<string, string> = { month: monthLabelTh(month), status: '' };
    if (month <= now) {
      const filed = (form: FilingForm) => st.filings.some((f) => f.companyId === companyId && f.form === form && f.period === month);
      const show = (form: FilingForm) => filed(form) || canPreview; // a finalized month needs no preview right
      const put = (key: string, sat: number) => { cells[key] = fromSatang(sat); sums[key] = (sums[key] ?? 0) + sat; };
      if (vat && show('PP30')) {
        const b = getFiling(st, companyId, 'PP30', month).boxes;
        put('sales', boxOf(b, '1')); put('outVat', boxOf(b, '5')); put('inVat', boxOf(b, '7')); put('netVat', boxOf(b, '5') - boxOf(b, '7')); // the month's own net, signed: boxes 11 / 12 are after the carry-in (box 10)
      } else if (!vat && canPreview) put('sales', salesRevenue(st, companyId, `${month}-01`, lastDayOf(month)));
      for (const form of PND_FORMS) if (show(form)) put(form.toLowerCase(), boxOf(getFiling(st, companyId, form, month).boxes, 'tax'));
      // what customers withheld from us is a receipt-side figure, not a filing: tax.read (the report's gate) is the intended right, no preview right needed
      put('whtIn', kept.filter((a) => a.date.startsWith(month)).reduce((n, a) => n + a.wht, 0));
    }
    return { level: 0, kind: 'row', cells, chips: chips(st, companyId, month), ...(vat ? { href: `/tax/vat?tab=output&period=${month}` } : {}) };
  });
  rows.push({ level: 0, kind: 'total', cells: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, fromSatang(v)])) });
  return { kind: 'tax-summary', titleKey: 'reports.taxSummary.title', params: { year }, columns, rows };
}

const FORMS: Omit<FormCatalogueItem, 'lastFinalized'>[] = [
  { form: 'PP30', nameTh: 'ภ.พ.30 แบบแสดงรายการภาษีมูลค่าเพิ่ม', periodKind: 'month', dueRuleTh: 'วันที่ 15 ของเดือนถัดไป', href: '/tax/vat' },
  { form: 'PP36', nameTh: 'ภ.พ.36 ภาษีมูลค่าเพิ่มที่ต้องนำส่งแทนผู้ขายต่างประเทศ', periodKind: 'month', dueRuleTh: 'วันที่ 7 ของเดือนถัดไป', href: '/tax/wht?tab=pp36' },
  ...(['PND2', 'PND3', 'PND53', 'PND54'] as const).map((f) => ({ form: f, nameTh: `${formName(f)} ภาษีเงินได้หัก ณ ที่จ่าย`, periodKind: 'month' as const, dueRuleTh: 'วันที่ 7 ของเดือนถัดไป', href: `/tax/wht?tab=${f.toLowerCase()}` })),
  { form: 'PND50', nameTh: 'ภ.ง.ด.50 ภาษีเงินได้นิติบุคคลประจำปี', periodKind: 'year', dueRuleTh: 'ภายใน 150 วันนับจากวันสิ้นรอบปีบัญชี', href: '/tax/cit?tab=pnd50' },
  { form: 'PND51', nameTh: 'ภ.ง.ด.51 ภาษีเงินได้นิติบุคคลครึ่งปี', periodKind: 'half-year', dueRuleTh: 'ภายใน 2 เดือนนับจากวันสิ้นเดือนที่ 6 ของรอบปีบัญชี', href: '/tax/cit?tab=pnd51' },
  { form: 'PP01', nameTh: 'ภ.พ.01 คำขอจดทะเบียนภาษีมูลค่าเพิ่ม', periodKind: 'event', dueRuleTh: 'ภายใน 30 วันนับแต่วันที่รายได้เกินเกณฑ์', href: '/tax/forms?print=PP01', printable: true },
  { form: 'PP09', nameTh: 'ภ.พ.09 คำขอแก้ไขเปลี่ยนแปลงข้อความในทะเบียนภาษีมูลค่าเพิ่ม', periodKind: 'event', dueRuleTh: 'ภายใน 30 วันนับแต่วันที่เปลี่ยนแปลง', href: '/tax/forms?print=PP09', printable: true },
]; // [SP-R] every due rule is a mock rule awaiting SP2's tax research

/** The form catalogue (every form, its period kind, due rule and last finalized period) and the filing history across forms: read-only, newest first, one row per finalized filing. ภ.พ.30 is absent for a company outside VAT. */
export function formCatalogue(st: MockState, companyId: string): FormCatalogue {
  const co = st.companies.find((c) => c.id === companyId)!, mine = st.filings.filter((f) => f.companyId === companyId);
  const forms = FORMS.filter((f) => f.form !== 'PP30' || co.vatRegistered).map((f) => ({ ...f, lastFinalized: mine.filter((x) => x.form === f.form).map((x) => x.period).sort().pop() ?? null }));
  const history = [...mine].sort((a, b) => b.finalizedAt.localeCompare(a.finalizedAt)).map((f) => ({
    form: f.form, nameTh: formName(f.form), period: f.period, finalizedAt: f.finalizedAt, finalizedBy: f.finalizedBy, exports: getFiling(st, companyId, f.form, f.period).exports, href: filingHref(f.form, f.period) }));
  return { forms, history, company: { legalNameTh: co.legalNameTh, taxId: co.taxId, branchCode: co.branchCode, address: co.address } };
}
