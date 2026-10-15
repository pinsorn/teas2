import { beforeEach, describe, expect, it } from 'vitest';
import { seed } from '../store';
import { revise } from './commands';
import { correctionPlan, executePlan } from './corrections';
import { assertBalanced, type MockStateLike } from './test-helpers';

const me = { kind: 'user' as const, id: 'u-1', name: 'สมศรี บัญชีดี' };
let st: MockStateLike;

beforeEach(() => { st = seed(); });

const openTi = () => st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length && !st.links.some((l) => l.to === d.id && l.active))!;

describe('S6 carry 2: a header dimension change on an issued tax invoice is a correction, never an in-place edit', () => {
  it('revise in place refuses it with the exit to the correction plan', () => {
    const ti = openTi();
    expect(() => revise(st, ti.id, { header: { ...ti.header, dimensions: { project: 'P-NEW' } }, lines: ti.lines }, ti.version, 'x', me))
      .toThrow(/doc.revise_not_allowed/);
  });
  it('the plan reissues the invoice and the new journal carries the new dimension', () => {
    const ti = openTi();
    const proposed = { header: { ...ti.header, dimensions: { project: 'P-NEW' } }, lines: ti.lines };
    const plan = correctionPlan(st, ti.id, proposed, 'accountant');
    expect(plan.steps.map((s) => [s.action, s.docType])).toEqual([['reissue', 'TI']]);
    const res = executePlan(st, plan.planId, plan.planHash, me);
    const nd = res.affected.find((a) => a.type === 'TI' && a.docId !== ti.id)!;
    const rows = st.journals.find((j) => j.docId === nd.docId)!.preview.entries.flatMap((e) => e.lines);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l) => l.dimensions?.project === 'P-NEW')).toBe(true);
    assertBalanced(st);
  });
  it('a notes-only edit still stays in place', () => {
    const ti = openTi();
    expect(revise(st, ti.id, { header: { ...ti.header, notes: 'หมายเหตุใหม่' }, lines: ti.lines }, ti.version, 'x', me).header.notes).toBe('หมายเหตุใหม่');
  });
});

describe('S6 carry 3: a proposal that omits the header bank account is not a money change', () => {
  it('a notes-only API edit of a receipt with a stored bank account stays in place', () => {
    const rc = st.docs.find((d) => d.type === 'RC' && d.status === 'issued' && d.header.bankAccountId)!;
    const { bankAccountId, ...rest } = rc.header; void bankAccountId;
    const plan = correctionPlan(st, rc.id, { header: { ...rest, notes: 'แก้หมายเหตุ' }, lines: rc.lines, allocations: rc.allocations }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
  });
  it('a different bank account is still a money change', () => {
    const rc = st.docs.find((d) => d.type === 'RC' && d.status === 'issued' && d.header.bankAccountId)!;
    const other = st.bankAccounts.find((b) => b.id !== rc.header.bankAccountId && b.companyId === rc.companyId);
    if (!other) return;
    const plan = correctionPlan(st, rc.id, { header: { ...rc.header, bankAccountId: other.id }, lines: rc.lines, allocations: rc.allocations }, 'accountant');
    expect(plan.steps.map((s) => s.action)).not.toEqual(['revise']);
  });
});
