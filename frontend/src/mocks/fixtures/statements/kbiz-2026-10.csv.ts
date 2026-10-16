import { KBANK_ACCOUNT_NO, KBANK_SEP_CLOSING, withBalances, type StatementLine } from './kplus-2026-09';

const csv = (cells: string[]) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
/** 2026-10-08 -> 08-10-26 (CE year, two digits: Appendix A.8). */
const ddmmyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(2, 4)}`;

/** A KBiz statement the way the bank writes it: UTF-8 BOM, metadata rows found by their Thai label (spacer cells vary), the "ยอดยกมา" row as the opening anchor, `DD-MM-YY` dates.
 *  A row has a withdrawal or a deposit, never both. */
export function kbizCsv(s: { accountNo: string; accountName: string; from: string; opening: string; lines: StatementLine[]; declaredClosing?: string }): string {
  const money = (m: string) => Number(m).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = [
    csv(['รายการเดินบัญชี']),
    csv(['เลขที่บัญชี', '', s.accountNo]),
    csv(['ชื่อบัญชี', s.accountName]),
    ...(s.declaredClosing ? [csv(['ยอดคงเหลือสิ้นสุด', '', money(s.declaredClosing)])] : []),
    '',
    csv(['วันที่', 'รายการ', 'ถอนเงิน', 'ฝากเงิน', 'ยอดคงเหลือ']),
    csv([ddmmyy(s.from), 'ยอดยกมา', '', '', money(s.opening)]),
    ...s.lines.map((l) => csv([ddmmyy(l.date), l.description, Number(l.amount) < 0 ? money(l.amount.slice(1)) : '', Number(l.amount) > 0 ? money(l.amount) : '', money(l.balance)])),
  ];
  return `﻿${rows.join('\r\n')}\r\n`;
}

/** The October file the e2e uploads: twelve lines of ba-kbank, opening = the September closing; receipts equal to the seeded rc-009, rc-multi, rc-nocert and rc-dep cash. */
export const KBIZ_OCT_LINES: StatementLine[] = withBalances(KBANK_SEP_CLOSING, [
  ['2026-10-01', 'โอนเงิน ค่าเช่าสำนักงาน', '-35000.00'],
  ['2026-10-02', 'โอนเงิน ชำระเจ้าหนี้การค้า', '-12840.00'],
  ['2026-10-03', 'โอนเงิน ค่าขนส่ง', '-5350.00'],
  ['2026-10-06', 'รับโอน เงินมัดจำ', '10000.00'],
  ['2026-10-07', 'โอนเงิน ชำระเจ้าหนี้การค้า', '-8560.00'],
  ['2026-10-08', 'รับโอน ชำระค่าสินค้า/บริการ', '6420.00'],
  ['2026-10-09', 'โอนเงิน ค่าบริการวิชาชีพ', '-3210.00'],
  ['2026-10-10', 'รับโอน ชำระค่าบริการ', '15000.00'],
  ['2026-10-12', 'รับโอน ชำระค่าสินค้า/บริการ', '1470.00'],
  ['2026-10-13', 'รับโอน ชำระค่าสินค้า/บริการ', '9700.00'],
  ['2026-10-13', 'รับโอน เงินรับล่วงหน้า', '5000.00'],
  ['2026-10-13', 'ค่าธรรมเนียมธนาคาร', '-25.00'],
]);
export const KBIZ_OCT_NAME = 'KBIZ_Statement_Oct2026.csv';
export const KBIZ_2026_10 = kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'บริษัท ตัวอย่าง จำกัด', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: KBIZ_OCT_LINES });

/** The non-VAT company's September file: eight lines, four of them the seeded rc-ivs1 / rc-ivp1 / rc-ivs2 / rc-ivp2 cash. */
export const NBANK_SEP_OPENING = '40000.00';
export const NBANK_SEP_LINES: StatementLine[] = withBalances(NBANK_SEP_OPENING, [
  ['2026-09-03', 'โอนเงิน ค่าเช่าร้าน', '-8000.00'],
  ['2026-09-10', 'โอนเงิน ค่าวัสดุ', '-1250.00'],
  ['2026-09-17', 'รับโอน ขายสินค้า', '4200.00'],
  ['2026-09-24', 'รับโอน ชำระค่าสินค้า', '2000.00'],
  ['2026-09-25', 'รับโอน ชำระค่าสินค้า', '3000.00'],
  ['2026-09-26', 'รับโอน ชำระค่าสินค้า', '1500.00'],
  ['2026-09-28', 'รับโอน ชำระค่าสินค้า', '2500.00'],
  ['2026-09-30', 'ค่าธรรมเนียมธนาคาร', '-25.00'],
]);
export const NBANK_SEP_NAME = 'KBIZ_Statement_Sep2026.csv';
export const NBANK_SEP_CSV = kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'ร้าน ตัวอย่าง', from: '2026-09-01', opening: NBANK_SEP_OPENING, lines: NBANK_SEP_LINES });
