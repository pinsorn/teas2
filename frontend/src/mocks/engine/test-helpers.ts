import { expect } from 'vitest';
import type { MockState } from '../store';
import { toSatang } from './money';

export type { Actor, DocLine } from '@/domain/types';
export type MockStateLike = MockState;

/** Every journal entry must balance to the satang. */
export const assertBalanced = (s: MockState) => {
  for (const j of s.journals) for (const e of j.preview.entries) {
    for (const l of e.lines) for (const amount of [l.debit, l.credit]) {
      expect(Number.isSafeInteger(toSatang(amount))).toBe(true);
      expect(toSatang(amount)).toBeGreaterThanOrEqual(0);
    }
    const dr = e.lines.reduce((a, l) => a + toSatang(l.debit), 0);
    const cr = e.lines.reduce((a, l) => a + toSatang(l.credit), 0);
    expect({ doc: j.docId, kind: e.kind, dr }).toEqual({ doc: j.docId, kind: e.kind, dr: cr });
  }
};
