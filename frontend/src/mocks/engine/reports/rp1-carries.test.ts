import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/types';
import { buildSeedState, type MockState } from '../../store';
import { closeYear, reopenYear } from '../close';
import { checkInvariants } from '../invariants';
import { profitLoss } from './profit-loss';

const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const VAT = 'co-vat';
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

describe('RP2 ruling 8a: every posted line that names a party carries that party\'s id, of the same company', () => {
  const line = () => st.journals.flatMap((j) => j.preview.entries).flatMap((e) => e.lines).find((l) => l.partyName && l.partyId)!;
  it('the seed is clean', () => {
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a line with a name and no id is exactly one finding (single-fault tamper)', () => {
    const l = line();
    delete l.partyId;
    const found = checkInvariants(st);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('carries no partyId');
    expect(found[0]).toContain(l.accountCode);
  });
  it('an id of another company\'s party is exactly one finding', () => {
    const l = line();
    l.partyId = st.parties.find((p) => p.companyId !== st.parties.find((x) => x.id === l.partyId)!.companyId)!.id;
    const found = checkInvariants(st);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('not a party of this company');
  });
  it('an id that is no party at all is exactly one finding', () => {
    line().partyId = 'pc-nobody';
    expect(checkInvariants(st)).toHaveLength(1);
  });
  it('a settlement record\'s and a bank journal\'s lines are judged too', () => {
    const l = st.settlements[0].journal[0].lines.find((x) => x.partyName)!;
    delete l.partyId;
    expect(checkInvariants(st)).toHaveLength(1);
  });
});

describe('RP2 ruling 8b: the P&L closing-entry note is for a closed year, not a reopened one', () => {
  it('shown once the year is closed, gone when it is reopened, back when it is closed again', () => {
    const note = () => profitLoss(st, VAT, { from: '2025-01-01', to: '2025-12-31' }).notes?.join(' ') ?? '';
    expect(note()).toBe('');
    closeYear(st, VAT, 2025, ME);
    expect(note()).toContain('จะเป็นศูนย์หลังรายการปิดบัญชีสิ้นปี');
    reopenYear(st, VAT, 2025, ME, 'ทดสอบ');
    expect(note()).toBe('');
    closeYear(st, VAT, 2025, ME);
    expect(note()).toContain('จะเป็นศูนย์หลังรายการปิดบัญชีสิ้นปี');
  });
});
