import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/types';
import { formatDateBE } from '@/lib/format';
import { KBIZ_2026_10, KBIZ_OCT_LINES, KBIZ_OCT_NAME, kbizCsv } from '../fixtures/statements/kbiz-2026-10.csv';
import { KBANK_ACCOUNT_NO, KBANK_SEP_CLOSING, KPLUS_SAMPLE_BASE64, KPLUS_SAMPLE_NAME } from '../fixtures/statements/kplus-2026-09';
import { buildSeedState, type MockState } from '../store';
import { MAX_STATEMENT_BYTES, importStatement, utf8Base64 } from './bank-import';
import type { MockError } from './log';

const ACTOR: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const VAT = 'co-vat';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); st.bankImports = []; st.bankLines = []; st.attachments = []; });

const csv = (content: string, fileName = KBIZ_OCT_NAME) => ({ fileName, format: 'kbiz-csv' as const, content: utf8Base64(content) }); // the client sends the file's own bytes, base64 (M4)
const fail = (fn: () => unknown): MockError => {
  try { fn(); } catch (e) { return e as MockError; }
  throw new Error('expected the import to be refused');
};
const state = () => JSON.stringify([st.bankImports, st.bankLines, st.attachments, st.journals.length, st.audit.length]);

describe('KBiz CSV import', () => {
  it('reads the BOM file by its Thai labels: lines unmatched, dates CE, opening from ยอดยกมา, and posts nothing', () => {
    const journals = st.journals.length;
    const imp = importStatement(st, VAT, 'ba-kbank', csv(KBIZ_2026_10), ACTOR);
    expect(KBIZ_2026_10.charCodeAt(0)).toBe(0xfeff);
    expect(imp).toMatchObject({ accountId: 'ba-kbank', format: 'kbiz-csv', from: '2026-10-01', to: '2026-10-13', opening: KBANK_SEP_CLOSING, closing: KBIZ_OCT_LINES[11].balance, lines: 12, warnings: [] });
    const lines = st.bankLines.filter((l) => l.importId === imp.id);
    expect(lines).toHaveLength(12);
    expect(lines.every((l) => l.status === 'unmatched' && l.accountId === 'ba-kbank')).toBe(true);
    expect(lines[0]).toMatchObject({ date: '2026-10-01', amount: '-35000.00' });
    expect(lines[5]).toMatchObject({ date: '2026-10-08', amount: '6420.00' });
    expect(st.journals).toHaveLength(journals); // import is data, not posting
  });

  it('stores the raw file as an attachment of the import, outside the state blob', () => {
    const imp = importStatement(st, VAT, 'ba-kbank', csv(KBIZ_2026_10), ACTOR);
    const att = st.attachments.filter((a) => a.docId === imp.id);
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ name: KBIZ_OCT_NAME, mime: 'text/csv', companyId: VAT });
    expect(JSON.stringify(st)).not.toContain('data:text/csv'); // the bytes live under their own key
  });

  it('a tampered balance names the row (the file record number) and writes nothing', () => {
    const lines = KBIZ_2026_10.split('\r\n');
    const i = lines.findIndex((l) => l.startsWith('"08-10-26"'));
    lines[i] = lines[i].replace(/"[^"]*"$/, '"1.00"'); // the balance cell
    const before = state();
    const e = fail(() => importStatement(st, VAT, 'ba-kbank', csv(lines.join('\r\n')), ACTOR));
    expect(e).toMatchObject({ status: 422, code: 'bank.line_mismatch' });
    expect(e.title).toContain(`บรรทัดที่ ${i + 1}`);
    expect(state()).toBe(before);
  });

  it('a statement of another account number is refused (digits-only compare)', () => {
    expect(fail(() => importStatement(st, VAT, 'ba-scb', csv(KBIZ_2026_10), ACTOR))).toMatchObject({ status: 422, code: 'bank.account_mismatch' });
    // the same number written without dashes is the same account
    const plain = kbizCsv({ accountNo: KBANK_ACCOUNT_NO.replace(/-/g, ''), accountName: 'x', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: KBIZ_OCT_LINES });
    expect(importStatement(st, VAT, 'ba-kbank', csv(plain), ACTOR).lines).toBe(12);
  });

  it('a declared closing balance that is not opening + in - out is refused', () => {
    const bad = kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'x', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: KBIZ_OCT_LINES, declaredClosing: '1.00' });
    expect(fail(() => importStatement(st, VAT, 'ba-kbank', csv(bad), ACTOR))).toMatchObject({ status: 422, code: 'bank.totals_mismatch' });
    const ok = kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'x', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: KBIZ_OCT_LINES, declaredClosing: KBIZ_OCT_LINES[11].balance });
    expect(importStatement(st, VAT, 'ba-kbank', csv(ok), ACTOR).closing).toBe(KBIZ_OCT_LINES[11].balance);
  });

  // a different file over part of the same period (a re-export of the first week)
  const partial = () => kbizCsv({ accountNo: KBANK_ACCOUNT_NO, accountName: 'x', from: '2026-10-01', opening: KBANK_SEP_CLOSING, lines: KBIZ_OCT_LINES.slice(0, 5) });

  it('a different file over the same period imports with a warning, not an error', () => {
    importStatement(st, VAT, 'ba-kbank', csv(KBIZ_2026_10), ACTOR);
    const again = importStatement(st, VAT, 'ba-kbank', csv(partial(), 'again.csv'), ACTOR);
    expect(again.warnings).toHaveLength(1);
    expect(again.warnings[0]).toContain(KBIZ_OCT_NAME);
    expect(st.bankLines.filter((l) => l.accountId === 'ba-kbank')).toHaveLength(17);
  });

  it('M3: the same file again (same bytes, any name) is refused 409 naming the earlier import, and writes nothing', () => {
    const first = importStatement(st, VAT, 'ba-kbank', csv(KBIZ_2026_10), ACTOR);
    const before = state();
    const e = fail(() => importStatement(st, VAT, 'ba-kbank', csv(KBIZ_2026_10, 'renamed.csv'), ACTOR));
    expect(e).toMatchObject({ status: 409, code: 'bank.duplicate_import' });
    expect(e.title).toContain(KBIZ_OCT_NAME);
    expect(e.title).toContain(formatDateBE(first.from));
    expect(state()).toBe(before);
    // the hash is per account: the same bytes against another account is that account's own business (refused for its own reason here)
    expect(fail(() => importStatement(st, VAT, 'ba-scb', csv(KBIZ_2026_10), ACTOR)).code).toBe('bank.account_mismatch');
  });

  it('M4: the stored file is the bytes that were sent - BOM and all', () => {
    const imp = importStatement(st, VAT, 'ba-kbank', csv(KBIZ_2026_10), ACTOR);
    const att = st.attachments.find((a) => a.docId === imp.id)!;
    expect(localStorage.getItem(`teas2.mock.att.${att.id}`)).toBe(`data:text/csv;base64,${utf8Base64(KBIZ_2026_10)}`);
    expect(atob(utf8Base64(KBIZ_2026_10)).startsWith('\xEF\xBB\xBF')).toBe(true); // EF BB BF survives
    expect(att.size).toBe(new TextEncoder().encode(KBIZ_2026_10).length);
  });

  it('M4: bytes that are not valid base64 are refused', () => {
    expect(fail(() => importStatement(st, VAT, 'ba-kbank', { fileName: 'x.csv', format: 'kbiz-csv', content: '"not base64"' }, ACTOR))).toMatchObject({ status: 422 });
  });

  it('a row with both a withdrawal and a deposit is refused', () => {
    const lines = KBIZ_2026_10.split('\r\n');
    const i = lines.findIndex((l) => l.startsWith('"08-10-26"'));
    lines[i] = lines[i].replace(',"",', ',"5.00",'); // a withdrawal next to the deposit
    expect(fail(() => importStatement(st, VAT, 'ba-kbank', csv(lines.join('\r\n')), ACTOR))).toMatchObject({ status: 422, code: 'bank.line_both_sides' });
  });

  it('a file that is not a KBiz statement is unreadable', () => {
    expect(fail(() => importStatement(st, VAT, 'ba-kbank', csv('a,b\r\n1,2\r\n'), ACTOR))).toMatchObject({ status: 422, code: 'bank.csv_unreadable' });
  });

  it('is capped at 2 MB, measured on the bytes (multi-byte text counts for what it weighs)', () => {
    const thai = 'ก'.repeat(Math.floor(MAX_STATEMENT_BYTES / 3) + 1); // 1 char < 1 MB of characters, over 2 MB of bytes
    expect(thai.length).toBeLessThan(MAX_STATEMENT_BYTES);
    expect(fail(() => importStatement(st, VAT, 'ba-kbank', csv(thai), ACTOR))).toMatchObject({ status: 422, code: 'bank.file_too_large' });
  });

  it('refuses a cash box, another company\'s account and an unknown account', () => {
    expect(fail(() => importStatement(st, VAT, 'ba-cash', csv(KBIZ_2026_10), ACTOR))).toMatchObject({ status: 422, code: 'bank.no_statement_for_cash' });
    expect(fail(() => importStatement(st, VAT, 'nba-kbank', csv(KBIZ_2026_10), ACTOR))).toMatchObject({ status: 404, code: 'record.not_found' });
    expect(fail(() => importStatement(st, VAT, 'nope', csv(KBIZ_2026_10), ACTOR))).toMatchObject({ status: 404 });
  });
});

describe('K PLUS PDF import', () => {
  const pdf = (fileName: string, password?: string) => ({ fileName, format: 'kplus-pdf' as const, content: KPLUS_SAMPLE_BASE64, ...(password ? { password } : {}) });

  it('the sample file name yields the fixture lines (18, September)', () => {
    const imp = importStatement(st, VAT, 'ba-kbank', pdf(KPLUS_SAMPLE_NAME), ACTOR);
    expect(imp).toMatchObject({ format: 'kplus-pdf', from: '2026-09-01', to: '2026-09-30', lines: 18, closing: KBANK_SEP_CLOSING });
    expect(st.bankLines.filter((l) => l.importId === imp.id)).toHaveLength(18);
    expect(st.attachments.find((a) => a.docId === imp.id)).toMatchObject({ mime: 'application/pdf', name: KPLUS_SAMPLE_NAME });
  });

  it('any other PDF is unreadable, with the CSV hint', () => {
    const e = fail(() => importStatement(st, VAT, 'ba-kbank', pdf('other.pdf'), ACTOR));
    expect(e).toMatchObject({ status: 422, code: 'bank.pdf_unreadable' });
    expect(e.title).toBe('อ่านไฟล์ PDF ไม่ได้ — ลองไฟล์ CSV จาก K BIZ');
  });

  it('the password is never stored, logged or echoed in an error', () => {
    const secret = 'S3cr3t-pw-9';
    importStatement(st, VAT, 'ba-kbank', pdf(KPLUS_SAMPLE_NAME, secret), ACTOR);
    expect(JSON.stringify(st)).not.toContain(secret);
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    const e = fail(() => importStatement(st, VAT, 'ba-kbank', pdf('other.pdf', secret), ACTOR));
    expect(`${e.code} ${e.title} ${e.message}`).not.toContain(secret);
    expect(JSON.stringify(st)).not.toContain(secret);
  });
});
