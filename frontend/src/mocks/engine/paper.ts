import type { Company, Doc, DocType, Money, PaperModel, PayslipPaperModel } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import type { ctx } from '../handlers/common';
import { reasonTh } from '../fixtures/reason-codes';
import { bahtText } from './bahtText';
import { compute } from './commands';
import { jvBalance, jvEntryLines, nextMonthStart } from './journal';
import { fromSatang, toSatang } from './money';
import { notesUpTo } from './notes';
import { monthLabelTh } from './periods';
import { cashBankId, freezeWht } from './settlement';
type Ctx = ReturnType<typeof ctx>;

const branchLabel = (code?: string) => (!code ? undefined : code === '00000' ? 'สำนักงานใหญ่ (00000)' : `สาขา ${code}`);

interface Look { titleTh: string; titleEn: string; signatures: string[]; dueLabel?: string }
const LOOK: Partial<Record<DocType, Look>> = {
  TI: { titleTh: 'ใบกำกับภาษี', titleEn: 'TAX INVOICE', signatures: ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'] },
  SO: { titleTh: 'ใบสั่งขาย', titleEn: 'SALES ORDER', signatures: ['ผู้สั่งซื้อ', 'ผู้อนุมัติ', 'ผู้รับคำสั่งซื้อ'], dueLabel: 'กำหนดส่ง' },
  DO: { titleTh: 'ใบส่งของ', titleEn: 'DELIVERY ORDER', signatures: ['ผู้ส่งของ', 'ผู้รับของ', 'ผู้อนุมัติ'] },
  IV: { titleTh: 'ใบแจ้งหนี้', titleEn: 'INVOICE', signatures: ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'] },
  BL: { titleTh: 'ใบวางบิล', titleEn: 'BILLING STATEMENT', signatures: ['ผู้วางบิล', 'ผู้รับวางบิล', 'ผู้มีอำนาจลงนาม'], dueLabel: 'นัดชำระเงิน' },
  RC: { titleTh: 'ใบเสร็จรับเงิน', titleEn: 'RECEIPT', signatures: ['ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'] },
  CN: { titleTh: 'ใบลดหนี้', titleEn: 'CREDIT NOTE', signatures: ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'] },
  DN: { titleTh: 'ใบเพิ่มหนี้', titleEn: 'DEBIT NOTE', signatures: ['ผู้รับสินค้า/บริการ', 'ผู้รับเงิน', 'ผู้มีอำนาจลงนาม'] },
  PO: { titleTh: 'ใบสั่งซื้อ', titleEn: 'PURCHASE ORDER', signatures: ['ผู้สั่งซื้อ', 'ผู้อนุมัติ'], dueLabel: 'กำหนดรับของ' },
  PV: { titleTh: 'ใบสำคัญจ่าย', titleEn: 'PAYMENT VOUCHER', signatures: ['ผู้จัดทำ', 'ผู้ตรวจ', 'ผู้อนุมัติ', 'ผู้รับเงิน'] },
  EX: { titleTh: 'ใบเบิกค่าใช้จ่าย', titleEn: 'EXPENSE CLAIM', signatures: ['ผู้เบิก', 'ผู้ตรวจ', 'ผู้อนุมัติ'] },
  WT: { titleTh: 'หนังสือรับรองการหักภาษี ณ ที่จ่าย', titleEn: 'WITHHOLDING TAX CERTIFICATE', signatures: ['ผู้จ่ายเงิน', 'ผู้มีอำนาจลงนาม'] },
  JV: { titleTh: 'ใบสำคัญทั่วไป', titleEn: 'JOURNAL VOUCHER', signatures: ['ผู้จัดทำ', 'ผู้ตรวจ', 'ผู้อนุมัติ'] },
  QT: { titleTh: 'ใบเสนอราคา', titleEn: 'QUOTATION', signatures: ['ผู้เสนอราคา', 'ผู้อนุมัติ', 'ลูกค้ายืนยันสั่งซื้อ'], dueLabel: 'ยืนราคาถึง' },
};

/** Paper from the stored snapshots; amounts and words are the engine's, never recomputed in the UI. A company outside VAT gets no VAT rows at all. */
function paperOf(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const look = LOOK[d.type]!;
  const co: Company = c.company;
  const calc = compute(c.st, co.id, d.type, { header: d.header, lines: d.lines }).lines;
  const net = new Map(calc.map((l) => [l.id, l.net]));
  const sum = (code: string, k: 'net' | 'vat') => fromSatang(d.lines.reduce((a, l, i) => a + (l.taxCode === code ? toSatang(calc[i][k]) : 0), 0));
  const has = (code: string) => d.lines.some((l) => l.taxCode === code);
  const vatLines = [
    ...(has('Z0') ? [{ label: 'ยอดขายอัตราร้อยละ 0', amount: sum('Z0', 'net') }] : []),
    ...(has('EX') ? [{ label: 'ยอดขายที่ได้รับยกเว้น', amount: sum('EX', 'net') }] : []),
    has('S7') ? { label: 'ภาษีมูลค่าเพิ่ม 7%', amount: sum('S7', 'vat') } : { label: 'ภาษีมูลค่าเพิ่ม', amount: '0.00' },
  ];
  const other = (id?: string) => c.st.docs.find((x) => x.id === id);
  const old = other(d.replacesId), nw = other(d.replacedById);
  return {
    titleTh: look.titleTh, titleEn: look.titleEn, copyLabel: copy ? 'สำเนา' : 'ต้นฉบับ',
    number: d.number ?? '-', documentDate: d.header.documentDate, dueDate: d.header.dueDate, reference: d.header.reference,
    seller: { name: co.legalNameTh, nameEn: co.legalNameEn, address: co.address, phone: co.phone, taxId: co.taxId, branchLabel: branchLabel(co.branchCode) },
    buyer: { name: d.party?.name ?? '-', address: d.party?.address ?? '', taxId: d.party?.taxId, branchLabel: d.party?.taxId ? branchLabel(d.party.branchCode) : undefined },
    lines: d.lines.map((l, i) => ({ no: i + 1, description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, amount: net.get(l.id) ?? '0.00', taxCode: l.taxCode, ...(l.discountPct ? { discountPct: l.discountPct } : {}) })),
    totals: d.totals, notes: d.header.notes, ...(co.vatRegistered ? { vatLines } : {}),
    ...(look.dueLabel ? { dueLabel: look.dueLabel } : {}),
    ...(d.correctionClass === 'N' && d.revision > 0 ? { revisionLabel: `ฉบับแก้ไขครั้งที่ ${d.revision}` } : {}),
    ...(old ? { replacementNote: `ยกเลิกและออกแทนฉบับเดิม เลขที่ ${old.number ?? '-'} ลงวันที่ ${formatDateBE(old.header.documentDate)}` } : {}),
    ...(d.status === 'replaced' ? { voidMark: { label: 'ถูกแทนที่', note: nw?.number ? `ออกแทนด้วยเลขที่ ${nw.number}` : undefined } }
      : d.status === 'cancelled' ? { voidMark: { label: 'ยกเลิก', note: d.cancel?.reasonText } } : {}),
    signatures: look.signatures,
  };
}

const TYPE_TH: Partial<Record<DocType, string>> = { TI: 'ใบกำกับภาษี', IV: 'ใบแจ้งหนี้', PB: 'บันทึกซื้อ', EX: 'ใบเบิกค่าใช้จ่าย' };
/** BL: one row per grouped document with the amount the server recorded at issue; a statement is not a tax document, so no VAT rows. */
function billingPaper(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const { vatLines, ...m } = paperOf(c, d, copy); void vatLines;
  const lines = (d.allocations ?? []).map((a, i) => {
    const t = c.st.docs.find((x) => x.id === a.targetId);
    return { no: i + 1, description: `${TYPE_TH[a.targetType] ?? a.targetType} ${a.targetNumber ?? a.targetId}${t ? ` ลงวันที่ ${formatDateBE(t.header.documentDate)}` : ''}`,
      qty: '1', unit: 'ฉบับ', unitPrice: a.amount, amount: a.amount, taxCode: 'EX' as const };
  });
  return { ...m, lines };
}

/** How the money came in, as the server words it: method + the account (or the cheque). An issued document prints the account as frozen at issue (I3); a draft reads the live one. */
function paymentLine(c: Ctx, d: Doc): string {
  const h = d.header, bank = h.bankSnapshot ? { nameTh: h.bankSnapshot.accountName, accountNo: h.bankSnapshot.accountNo } : c.st.bankAccounts.find((b) => b.id === cashBankId(c.st, c.company.id, h));
  const acct = bank ? `${bank.nameTh}${bank.accountNo ? ` ${bank.accountNo}` : ''}` : '';
  if (h.paymentMethod === 'cheque' && h.cheque) return `เช็ค ${h.cheque.number} ลงวันที่ ${formatDateBE(h.cheque.date)} ${h.cheque.bank}`.trim();
  return `${h.paymentMethod === 'cash' ? 'เงินสด' : h.paymentMethod === 'cheque' ? 'เช็ค' : 'โอนเงิน'}${acct ? ` · ${acct}` : ''}`;
}
/** RC: one row per settled document (number, date, amount, the tax the customer withheld on it), the deposit remainder, then a non-VAT cash bill's own lines. A receipt is not a tax document: no VAT rows. */
function receiptPaper(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const { vatLines, ...m } = paperOf(c, d, copy); void vatLines;
  const settled = (d.allocations ?? []).map((a) => {
    const t = c.st.docs.find((x) => x.id === a.targetId);
    return { description: `${TYPE_TH[a.targetType] ?? a.targetType} ${a.targetNumber ?? a.targetId}${t ? ` ลงวันที่ ${formatDateBE(t.header.documentDate)}` : ''}`,
      qty: '', unit: '', unitPrice: '', amount: a.amount, taxCode: 'EX' as const, ...(a.wht ? { wht: a.wht } : {}) };
  });
  const deposit = toSatang(d.header.depositAmount ?? '0.00') > 0
    ? [{ description: 'เงินรับล่วงหน้า', qty: '', unit: '', unitPrice: '', amount: d.header.depositAmount!, taxCode: 'EX' as const }] : [];
  return { ...m, payment: paymentLine(c, d), lines: [...settled, ...deposit, ...m.lines].map((l, i) => ({ ...l, no: i + 1 })) };
}

/** PV: the settled bills (number, the vendor's own number, date, amount paid), the voucher's own expense lines, the tax withheld per WHT type, the payment, and the server's cash / withheld / total.
 *  A voucher is an internal payment record, not a tax document: no VAT rows. */
function voucherPaper(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const { vatLines, ...m } = paperOf(c, d, copy); void vatLines;
  const settled = (d.allocations ?? []).map((a) => {
    const t = c.st.docs.find((x) => x.id === a.targetId);
    const vno = t?.header.vendorDocNumber ? ` (เอกสารผู้ขาย ${t.header.vendorDocNumber})` : '';
    return { description: `${TYPE_TH[a.targetType] ?? a.targetType} ${a.targetNumber ?? a.targetId}${vno}${t ? ` ลงวันที่ ${formatDateBE(t.header.documentDate)}` : ''}`, qty: '', unit: '', unitPrice: '', amount: a.amount, taxCode: 'EX' as const };
  });
  const whtLines = (d.whtFrozen ?? freezeWht(c.st, c.company.id, d, d.id)).lines.map((l) => ({ label: `${l.nameTh} ${l.rate} (ฐาน ${formatMoney(l.base)})`, base: l.base, tax: l.tax }));
  const prepaid = toSatang(d.header.depositAmount ?? '0.00') > 0 ? [{ description: 'เงินจ่ายล่วงหน้า', qty: '', unit: '', unitPrice: '', amount: d.header.depositAmount!, taxCode: 'EX' as const }] : []; // FN3: the vendor prepayment is part of the total
  return { ...m, partyLabel: 'ผู้รับเงิน', payment: paymentLine(c, d), whtLines, lines: [...settled, ...prepaid, ...m.lines].map((l, i) => ({ ...l, no: i + 1 })) };
}

/** EX: the employee is the party; a line with a vendor tax invoice names it (number, vendor, date) under its description, and the approval trail is printed as a note. A claim is an internal record: no VAT rows. */
function claimPaper(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const { vatLines, ...m } = paperOf(c, d, copy); void vatLines;
  const lines = m.lines.map((l, i) => {
    const v = d.lines[i].vendorInvoice;
    return v ? { ...l, description: `${l.description} (ใบกำกับภาษี ${v.number} ${v.vendorName} ลงวันที่ ${formatDateBE(v.date)})` } : l;
  });
  const a = d.approval;
  const trail = a?.approvedBy ? `ส่งอนุมัติโดย ${a.submittedBy.name} · อนุมัติโดย ${a.approvedBy.name} เมื่อ ${formatDateBE(a.approvedAt!.slice(0, 10))}` : undefined;
  return { ...m, partyLabel: 'ผู้เบิก', lines, ...(trail || m.notes ? { notes: [m.notes, trail].filter(Boolean).join('\n') } : {}) };
}

/** JV (AC1): the account lines as posted (account, note, debit, credit) and the server's two totals; no party, no tax. An accrual says when it reverses itself. */
function journalPaper(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const { vatLines, ...m } = paperOf(c, d, copy); void vatLines;
  const posted = jvEntryLines(c.st, c.company.id, d.lines), used = d.lines.filter((l) => l.accountCode);
  const b = jvBalance(d.lines), auto = d.header.autoReverse ? `กลับรายการอัตโนมัติ วันที่ ${formatDateBE(nextMonthStart(d.header.documentDate))}` : undefined;
  return { ...m, journal: { lines: posted.map((l, i) => ({ no: i + 1, accountCode: l.accountCode, accountName: l.accountName, description: used[i]?.description ?? '', debit: l.debit, credit: l.credit })), debit: b.debit, credit: b.credit },
    ...(auto || m.notes ? { notes: [m.notes, auto].filter(Boolean).join('\n') } : {}) };
}

/** WT (50 ทวิ, D-21): payer = our company, payee = the voucher's payee, one income type and its tax. Built from the stored certificate and the voucher that issued it; after the first print the
 *  paper IS the stored snapshot (I7) - only the copy label and the void stamp follow the document as it is now. */
function certificatePaper(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const stampOf = (): Pick<PaperModel, 'voidMark'> => (d.status === 'cancelled' || d.status === 'replaced' ? { voidMark: { label: 'ยกเลิก', note: d.cancel?.reasonText } } : {});
  const frozen = c.st.prints.find((p) => p.docId === d.id && p.paper)?.paper;
  if (frozen) { const { voidMark, ...rest } = frozen; void voidMark; return { ...rest, copyLabel: copy ? 'สำเนา' : 'ต้นฉบับ', ...stampOf() }; }
  const co: Company = c.company, look = LOOK.WT!;
  const pv = c.st.docs.find((x) => x.id === c.st.links.find((l) => l.kind === 'issues' && l.to === d.id)?.from);
  const mode = pv?.header.whtMode ?? 'deduct';
  const tax = d.header.whtTax ?? d.totals.wht ?? '0.00', income = d.totals.total;
  return {
    titleTh: look.titleTh, titleEn: look.titleEn, copyLabel: copy ? 'สำเนา' : 'ต้นฉบับ', number: d.number ?? '-', documentDate: d.header.documentDate, ...(pv?.number ? { reference: pv.number } : {}),
    seller: { name: co.legalNameTh, nameEn: co.legalNameEn, address: co.address, phone: co.phone, taxId: co.taxId, branchLabel: branchLabel(co.branchCode) },
    buyer: { name: d.party?.name ?? '-', address: d.party?.address ?? '', taxId: d.party?.taxId, branchLabel: d.party?.taxId ? branchLabel(d.party.branchCode) : undefined },
    partyLabel: 'ผู้ถูกหักภาษี ณ ที่จ่าย',
    lines: d.lines.map((l, i) => ({ no: i + 1, description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, amount: l.unitPrice, taxCode: 'EX' as const })),
    totals: d.totals, signatures: look.signatures,
    certificate: { form: d.header.whtForm ?? 'PND53', incomeType: d.header.whtIncomeType ?? '', incomeLabel: d.lines[0]?.description ?? '', paidOn: d.header.documentDate, income, tax, taxInWords: bahtText(tax),
      condition: mode === 'grossup_always' ? 'forever' : mode === 'grossup_once' ? 'once' : 'withhold', ...(pv?.number ? { voucher: pv.number } : {}) },
    ...stampOf(),
  };
}

/** CN / DN (ม.86/10): the invoice adjusted (number, date), its value, the correct value after this note and the difference - this note's own net; its VAT and total are the document's.
 *  The correct value runs through the notes issued up to this one; the reason is the Thai wording, never the code. */
function adjustmentPaper(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const m = paperOf(c, d, copy);
  const ti = c.st.docs.find((x) => x.id === d.header.refDocId);
  if (!ti) return m;
  if (d.adjustSnapshot) return { ...m, adjusts: { number: ti.number ?? '-', date: ti.header.documentDate, originalNet: d.adjustSnapshot.originalNet, correctNet: d.adjustSnapshot.correctNet, diffNet: d.adjustSnapshot.diffNet, reason: reasonTh(d.header) } }; // taken at issue
  const signed = (n: { type: DocType; totals: { net: string } }) => (n.type === 'CN' ? -1 : 1) * toSatang(n.totals.net);
  const before = notesUpTo(c.st, ti, d.id).filter((n) => n.id !== d.id);
  const correct = toSatang(ti.totals.net) + before.reduce((a, n) => a + signed(n), 0) + signed(d);
  return { ...m, adjusts: { number: ti.number ?? '-', date: ti.header.documentDate, originalNet: ti.totals.net, correctNet: fromSatang(correct), diffNet: d.totals.net, reason: reasonTh(d.header) } };
}

/** The 13-digit national id with only its last four digits shown (X-XXXX-XXXXd-dd-d); anything not 13 digits keeps just its last four. */
const maskNationalId = (id: string | undefined): string | undefined => {
  const d = (id ?? '').replace(/\D/g, '');
  if (!d) return undefined;
  return d.length === 13 ? `X-XXXX-XXXX${d[9]}-${d.slice(10, 12)}-${d[12]}` : `${'X'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
};
const NOTE_50_TAWI = 'หนังสือรับรองตามมาตรา 50 ทวิ ออกให้ปีละครั้ง (ภ.ง.ด.1ก)';

/** PR (PY2): one payslip per employee, every figure the frozen slip's (nothing is recomputed, the master data is never read): the income items, the deductions (PIT ม.50(1), SSO, รายการหักอื่น), the net and its words, the employer's SSO, the year to date.
 *  The employee is the one the slip froze (name, national id); the company is printed as it is now, like every other paper. A payslip is an internal record, not a tax document. */
function payslipPaper(c: Ctx, d: Doc, copy: boolean): PaperModel {
  const co: Company = c.company, slips = d.payroll?.slips ?? [];
  const payslips: PayslipPaperModel[] = slips.map((s) => {
    const it = s.items, nz = (label: string, amount: Money) => (toSatang(amount) > 0 ? [{ label, amount }] : []);
    const salaryLabel = s.proratedDays !== undefined ? `เงินเดือน (${s.proratedDays}/${s.daysInMonth} วัน)` : 'เงินเดือน';
    const ded = [{ label: 'ภาษีเงินได้หัก ณ ที่จ่าย (มาตรา 50(1))', amount: s.pit }, { label: 'ประกันสังคม', amount: s.sso }, ...nz('รายการหักอื่น', s.otherDeduction)];
    return { employeeId: s.employeeId, name: s.name, ...(maskNationalId(s.employee.nationalId) ? { nationalId: maskNationalId(s.employee.nationalId) } : {}), period: monthLabelTh(s.month), payDate: d.header.documentDate,
      ...(s.proratedDays !== undefined ? { proratedDays: s.proratedDays } : {}), daysInMonth: s.daysInMonth,
      income: [{ label: salaryLabel, amount: s.salaryPaid }, ...nz('ค่าล่วงเวลา', it.overtime ?? '0.00'), ...nz('เบี้ยเลี้ยง / ค่าตอบแทน', it.allowance ?? '0.00'), ...nz('โบนัส', it.bonus ?? '0.00'), ...nz('รายได้อื่น', it.otherIncome ?? '0.00')],
      deductions: ded, gross: s.gross, totalDeductions: fromSatang(ded.reduce((n, x) => n + toSatang(x.amount), 0)), net: s.net, netInWords: bahtText(s.net), ssoEmployer: s.ssoEmployer,
      ytd: { income: s.ytdIncome, pit: s.ytdPit, sso: s.ytdSso }, note: NOTE_50_TAWI };
  });
  return {
    titleTh: 'ใบจ่ายเงินเดือน', titleEn: 'PAYSLIP', copyLabel: copy ? 'สำเนา' : 'ต้นฉบับ', number: d.number ?? '-', documentDate: d.header.documentDate, ...(d.header.reference ? { reference: d.header.reference } : {}),
    seller: { name: co.legalNameTh, nameEn: co.legalNameEn, address: co.address, phone: co.phone, taxId: co.taxId, branchLabel: branchLabel(co.branchCode) }, buyer: { name: '-', address: '' },
    lines: [], totals: d.totals, signatures: ['ผู้จ่ายเงิน', 'ผู้รับเงิน'], payslips,
    ...(d.status === 'cancelled' ? { voidMark: { label: 'ยกเลิก', note: d.cancel?.reasonText } } : {}),
  };
}

export const PAPER_BUILDERS: Partial<Record<DocType, (c: Ctx, d: Doc, copy: boolean) => PaperModel>> = { TI: paperOf, QT: paperOf, SO: paperOf, DO: paperOf, IV: paperOf, BL: billingPaper, RC: receiptPaper, CN: adjustmentPaper, DN: adjustmentPaper, PO: paperOf, PV: voucherPaper, EX: claimPaper, JV: journalPaper, WT: certificatePaper, PR: payslipPaper };
