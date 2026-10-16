import { fromSatang, toSatang } from '../../engine/money';

export interface StatementLine { date: string; description: string; amount: string; balance: string }
export interface ParsedStatement { accountNo: string; from: string; to: string; opening: string; closing: string; lines: StatementLine[] }

/** [date, description, signed amount]: the amounts become running balances from `opening` (the same arithmetic the integrity check re-does). */
export function withBalances(opening: string, rows: [date: string, description: string, amount: string][]): StatementLine[] {
  let bal = toSatang(opening);
  return rows.map(([date, description, amount]) => { bal += toSatang(amount); return { date, description, amount, balance: fromSatang(bal) }; });
}

/** The only PDF name the mock can "read": it does not parse PDFs, so this fixture supplies what the extraction would have produced. */
export const KPLUS_SAMPLE_NAME = 'KPLUS_Statement_Sep2026.pdf';
export const KBANK_ACCOUNT_NO = '012-3-45678-9';
export const KBANK_SEP_OPENING = '300000.00';

/** Eighteen September lines of ba-kbank: four receipts equal to the seeded RC cash (rc-013, rc-012, rc-011, rc-010), ten vendor payments, two other receipts, a bank fee and the interest. */
export const KBANK_SEP_LINES: StatementLine[] = withBalances(KBANK_SEP_OPENING, [
  ['2026-09-02', 'โอนเงิน ค่าเช่าสำนักงาน', '-35000.00'],
  ['2026-09-04', 'โอนเงิน ชำระเจ้าหนี้การค้า', '-12840.00'],
  ['2026-09-05', 'รับโอน ชำระค่าสินค้า/บริการ', '6955.00'],
  ['2026-09-08', 'โอนเงิน ชำระเจ้าหนี้การค้า', '-8560.00'],
  ['2026-09-09', 'โอนเงิน ค่าบริการวิชาชีพ', '-3210.00'],
  ['2026-09-11', 'รับโอน ชำระค่าสินค้า/บริการ', '64200.00'],
  ['2026-09-12', 'โอนเงิน ชำระเจ้าหนี้การค้า', '-21400.00'],
  ['2026-09-14', 'รับโอน เงินมัดจำ', '10000.00'],
  ['2026-09-15', 'โอนเงิน ค่าขนส่ง', '-5350.00'],
  ['2026-09-17', 'รับโอน ชำระค่าสินค้า/บริการ', '18297.00'],
  ['2026-09-18', 'โอนเงิน ชำระเจ้าหนี้การค้า', '-14980.00'],
  ['2026-09-22', 'โอนเงิน ค่าวัสดุสิ้นเปลือง', '-6420.00'],
  ['2026-09-23', 'รับโอน ชำระค่าสินค้า/บริการ', '43228.00'],
  ['2026-09-25', 'โอนเงิน ชำระเจ้าหนี้การค้า', '-9630.00'],
  ['2026-09-26', 'รับโอน ชำระค่าบริการ', '7490.00'],
  ['2026-09-28', 'โอนเงิน ชำระเจ้าหนี้การค้า', '-17120.00'],
  ['2026-09-30', 'ค่าธรรมเนียมธนาคาร', '-25.00'],
  ['2026-09-30', 'ดอกเบี้ยรับ', '3.12'],
]);

export const KBANK_SEP_CLOSING = KBANK_SEP_LINES[KBANK_SEP_LINES.length - 1].balance;

/** What "reading" KPLUS_Statement_Sep2026.pdf yields. */
export const KPLUS_SAMPLE: ParsedStatement = {
  accountNo: KBANK_ACCOUNT_NO, from: '2026-09-01', to: '2026-09-30', opening: KBANK_SEP_OPENING, closing: KBANK_SEP_CLOSING, lines: KBANK_SEP_LINES,
};

/** A minimal file that starts like a PDF (base64 of "%PDF-1.4"): the seed and the e2e upload it under the sample name. */
export const KPLUS_SAMPLE_BASE64 = 'JVBERi0xLjQKJSVFT0YK';
