import type { Actor } from '@/domain/types';
import { importStatement, utf8Base64 } from '../../engine/bank-import';
import { withFixedClock } from '../../engine/log';
import type { MockState } from '../../store';
import { NBANK_SEP_CSV, NBANK_SEP_NAME } from './kbiz-2026-10.csv';
import { KPLUS_SAMPLE_BASE64, KPLUS_SAMPLE_NAME } from './kplus-2026-09';

const USER: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };

/** FN1 seed: the VAT company's September K PLUS statement (18 lines) and the non-VAT company's September KBiz file (8 lines), imported through the same command the upload uses, on a pinned clock.
 *  ba-scb and the cash boxes have no imports. */
export function seedBankStatements(st: MockState): void {
  withFixedClock('2026-10-01T09:00:00+07:00', () => {
    importStatement(st, 'co-vat', 'ba-kbank', { fileName: KPLUS_SAMPLE_NAME, format: 'kplus-pdf', content: KPLUS_SAMPLE_BASE64 }, USER, { seed: true });
    importStatement(st, 'co-nonvat', 'nba-kbank', { fileName: NBANK_SEP_NAME, format: 'kbiz-csv', content: utf8Base64(NBANK_SEP_CSV) }, USER, { seed: true });
  });
}
