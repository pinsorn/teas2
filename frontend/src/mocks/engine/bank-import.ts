import type { Actor, BankImport, BankLine, IsoDate } from '@/domain/types';
import { formatDateBE } from '@/lib/format';
import { KPLUS_SAMPLE, KPLUS_SAMPLE_NAME, type ParsedStatement } from '../fixtures/statements/kplus-2026-09';
import type { MockState } from '../store';
import { addImportFile } from './attachments';
import { MockError, logAudit, stamp } from './log';
import { fromSatang, toSatang } from './money';

/** Appendix A.8: the statement file is checked on its bytes before anything is parsed. */
export const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;
export interface StatementInput { fileName: string; format: BankImport['format']; /** CSV text, or the PDF as base64. */ content: string; /** K PLUS only. Used to open the file and then forgotten: never stored, logged or echoed. */ password?: string }

const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const digits = (s: string) => s.replace(/\D/g, '');

// ---------------- KBiz CSV (Appendix A.8) ----------------

/** RFC 4180: quoted commas, doubled quotes and embedded newlines. A leading BOM is dropped. Every record keeps its place (blank ones too) so errors can name the record number. */
function readCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const unreadable = (why: string) => fail(422, 'bank.csv_unreadable', `อ่านไฟล์ CSV ไม่ได้ — ${why} (ต้องเป็นไฟล์รายการเดินบัญชีจาก K BIZ)`);
/** A KBiz money cell ("12,840.00") to a 2-dp decimal string; blank = undefined. */
function money(cell: string | undefined, row: number): string | undefined {
  const t = (cell ?? '').trim().replace(/,/g, '');
  if (!t) return undefined;
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) throw unreadable(`บรรทัดที่ ${row}: จำนวนเงิน “${(cell ?? '').trim().slice(0, 20)}” ไม่ถูกต้อง`);
  return fromSatang(toSatang(t));
}
/** DD-MM-YY, CE (the BE year of a document reference must never be used). */
function ddmmyy(cell: string | undefined, row: number): IsoDate {
  const m = /^(\d{2})-(\d{2})-(\d{2})$/.exec((cell ?? '').trim());
  const iso = m ? `20${m[3]}-${m[2]}-${m[1]}` : '';
  if (!m || Number.isNaN(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) throw unreadable(`บรรทัดที่ ${row}: วันที่ต้องเป็นรูปแบบ วว-ดด-ปป`);
  return iso;
}

export type ParsedLine = ParsedStatement['lines'][number] & { row: number };
type Parsed = Omit<ParsedStatement, 'lines'> & { lines: ParsedLine[] };

export function parseKbizCsv(text: string): Parsed {
  const rows = readCsv(text);
  const cellsOf = (r: string[]) => r.map((c) => c.trim());
  const head = rows.findIndex((r) => cellsOf(r).includes('วันที่') && cellsOf(r).includes('ยอดคงเหลือ'));
  if (head < 0) throw unreadable('ไม่พบหัวตาราง วันที่ / ยอดคงเหลือ');
  const col = (label: string) => cellsOf(rows[head]).indexOf(label);
  const [cDate, cDesc, cOut, cIn, cBal] = ['วันที่', 'รายการ', 'ถอนเงิน', 'ฝากเงิน', 'ยอดคงเหลือ'].map(col);
  if (cOut < 0 || cIn < 0) throw unreadable('ไม่พบคอลัมน์ ถอนเงิน / ฝากเงิน');
  /** A metadata value is found by its Thai label, never by column: the first filled cell after it. */
  const meta = (label: string): string | undefined => {
    for (const r of rows.slice(0, head)) { const c = cellsOf(r), k = c.indexOf(label); if (k >= 0) return c.slice(k + 1).find((x) => x); }
    return undefined;
  };
  const accountNo = meta('เลขที่บัญชี');
  if (!accountNo) throw unreadable('ไม่พบเลขที่บัญชี');
  const declared = meta('ยอดคงเหลือสิ้นสุด');

  let opening: string | undefined, from: IsoDate | undefined;
  const lines: ParsedLine[] = [];
  rows.slice(head + 1).forEach((r, i) => {
    const row = head + 2 + i, c = cellsOf(r);
    if (!c.some((x) => x)) return;
    const bal = money(c[cBal], row);
    if (bal === undefined) throw unreadable(`บรรทัดที่ ${row}: ไม่มียอดคงเหลือ`);
    const date = ddmmyy(c[cDate], row);
    if (opening === undefined) { // the first row is the "ยอดยกมา" anchor
      if (!(c[cDesc] ?? '').includes('ยอดยกมา')) throw unreadable('ไม่พบแถว ยอดยกมา');
      opening = bal; from = date;
      return;
    }
    const out = money(c[cOut], row), inn = money(c[cIn], row);
    if (out !== undefined && inn !== undefined && toSatang(out) !== 0 && toSatang(inn) !== 0) throw fail(422, 'bank.line_both_sides', `บรรทัดที่ ${row}: มีทั้งยอดถอนและยอดฝากในแถวเดียวกัน`);
    const amount = out !== undefined && toSatang(out) !== 0 ? fromSatang(-toSatang(out)) : (inn ?? '0.00');
    lines.push({ date, description: c[cDesc] ?? '', amount, balance: bal, row });
  });
  if (opening === undefined || !from) throw unreadable('ไม่พบแถว ยอดยกมา');
  const closing = declared === undefined ? (lines.length ? lines[lines.length - 1].balance : opening) : money(declared, head) ?? opening;
  return { accountNo, from, to: lines.length ? lines[lines.length - 1].date : from, opening, closing, lines };
}

// ---------------- the integrity triple-check ----------------

/** Per line, balance delta = amount (naming the row); then opening + Σ in - Σ out = closing. The account-number check needs the account and follows in `importStatement`. */
export function checkIntegrity(p: Parsed): void {
  let prev = toSatang(p.opening), net = 0;
  for (const l of p.lines) {
    const amount = toSatang(l.amount), bal = toSatang(l.balance);
    if (bal - prev !== amount) throw fail(422, 'bank.line_mismatch', `บรรทัดที่ ${l.row}: ยอดคงเหลือ ${l.balance} ไม่ตรงกับยอดก่อนหน้า ${fromSatang(prev)} ${amount < 0 ? '−' : '+'} ${fromSatang(Math.abs(amount))} — ไม่นำเข้า`);
    prev = bal; net += amount;
  }
  if (toSatang(p.opening) + net !== toSatang(p.closing)) {
    throw fail(422, 'bank.totals_mismatch', `ยอดยกมา ${p.opening} + ฝาก − ถอน ${fromSatang(net)} ไม่เท่ากับยอดคงเหลือสิ้นสุด ${p.closing} — ไม่นำเข้า`);
  }
}

// ---------------- the command ----------------

const b64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Reads, checks and stores one statement. Everything is judged before anything is written; the raw file's bytes go first (a refused write is a 507 with nothing else touched), then the import and its lines
 *  enter the state in one go - the caller makes the single state write. Posts NOTHING (FN2 matches and posts). */
export function importStatement(st: MockState, companyId: string, accountId: string, input: StatementInput, actor: Actor, opts: { seed?: boolean } = {}): BankImport {
  const acct = st.bankAccounts.find((b) => b.id === accountId && b.companyId === companyId);
  if (!acct) throw fail(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
  if (acct.kind === 'cash' || !acct.accountNo) throw fail(422, 'bank.no_statement_for_cash', 'บัญชีเงินสดไม่มีรายการเดินบัญชีให้นำเข้า');
  if (!input || typeof input.fileName !== 'string' || !input.fileName.trim() || typeof input.content !== 'string' || (input.format !== 'kbiz-csv' && input.format !== 'kplus-pdf')) {
    throw fail(422, 'bank.invalid_request', 'ข้อมูลการนำเข้าไม่ถูกต้อง');
  }
  const csv = input.format === 'kbiz-csv';
  const b64 = csv ? '' : input.content.replace(/\s/g, '');
  const bytes = csv ? new TextEncoder().encode(input.content).length : b64Bytes(b64);
  if (bytes > MAX_STATEMENT_BYTES) throw fail(422, 'bank.file_too_large', 'ไฟล์ใหญ่เกิน 2 MB');

  let parsed: Parsed;
  if (csv) parsed = parseKbizCsv(input.content);
  else { // the mock does not parse PDFs: the sample name stands for a file whose extraction the fixture supplies
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || !b64.startsWith('JVBER') || input.fileName.trim().toLowerCase() !== KPLUS_SAMPLE_NAME.toLowerCase()) {
      throw fail(422, 'bank.pdf_unreadable', 'อ่านไฟล์ PDF ไม่ได้ — ลองไฟล์ CSV จาก K BIZ');
    }
    parsed = { ...KPLUS_SAMPLE, lines: KPLUS_SAMPLE.lines.map((l, i) => ({ ...l, row: i + 1 })) };
  }
  checkIntegrity(parsed);
  if (digits(parsed.accountNo) !== digits(acct.accountNo)) {
    throw fail(422, 'bank.account_mismatch', `เลขที่บัญชีในไฟล์ไม่ตรงกับบัญชี ${acct.nameTh} ${acct.accountNo} — ไม่นำเข้า`);
  }

  const warnings = st.bankImports
    .filter((i) => i.companyId === companyId && i.accountId === accountId && !(parsed.to < i.from || parsed.from > i.to))
    .map((i) => `ช่วงวันที่ ${formatDateBE(parsed.from)} – ${formatDateBE(parsed.to)} ทับซ้อนกับไฟล์ที่นำเข้าแล้ว (${i.fileName}, ${formatDateBE(i.from)} – ${formatDateBE(i.to)})`);

  const id = `bi-${String(st.bankImports.length + 1).padStart(3, '0')}`;
  const mime = csv ? 'text/csv' : 'application/pdf';
  addImportFile(st, companyId, id, { name: input.fileName.trim(), mime, size: bytes, dataUrl: `data:${mime};base64,${csv ? toBase64(input.content) : b64}` }, actor.name, opts.seed);
  const imp: BankImport = { id, accountId, fileName: input.fileName.trim(), format: input.format, from: parsed.from, to: parsed.to, opening: parsed.opening, closing: parsed.closing, lines: parsed.lines.length, at: stamp(), warnings };
  st.bankImports.push({ ...imp, companyId });
  const lines: (BankLine & { companyId: string })[] = parsed.lines.map((l, i) => ({
    companyId, id: `${id}-${String(i + 1).padStart(3, '0')}`, accountId, importId: id, date: l.date, description: l.description, amount: l.amount, balance: l.balance, status: 'unmatched' as const,
  }));
  st.bankLines.push(...lines);
  logAudit(st, actor, companyId, 'bank.import', id, undefined, imp); // the import, never the request: the password is not in it
  return imp;
}
