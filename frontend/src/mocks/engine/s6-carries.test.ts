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
    expect(() => revise(st, ti.id, { header: { ...ti.header, dimensions: { project: 'P-B' } }, lines: ti.lines }, ti.version, 'x', me))
      .toThrow(/doc.revise_not_allowed/);
  });
  it('the plan reissues the invoice and the new journal carries the new dimension', () => {
    const ti = openTi();
    const proposed = { header: { ...ti.header, dimensions: { project: 'P-B' } }, lines: ti.lines };
    const plan = correctionPlan(st, ti.id, proposed, 'accountant');
    expect(plan.steps.map((s) => [s.action, s.docType])).toEqual([['reissue', 'TI']]);
    const res = executePlan(st, plan.planId, plan.planHash, me);
    const nd = res.affected.find((a) => a.type === 'TI' && a.docId !== ti.id)!;
    const rows = st.journals.find((j) => j.docId === nd.docId)!.preview.entries.flatMap((e) => e.lines);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l) => l.dimensions?.project === 'P-B')).toBe(true);
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

describe('S6 fix round 1', () => {
  it('I2: dimensions AND amount in one TI correction are refused (nothing written); each alone still works', () => {
    const ti = openTi();
    const lines = ti.lines.map((l, i) => (i === 0 ? { ...l, qty: String(Number(l.qty) + 1) } : l));
    const snapshot = JSON.stringify(st);
    expect(() => correctionPlan(st, ti.id, { header: { ...ti.header, dimensions: { project: 'P-B' } }, lines }, 'accountant'))
      .toThrow(expect.objectContaining({ status: 422, code: 'correction.dimension_with_amount' }));
    expect(JSON.stringify(st)).toBe(snapshot);
    expect(correctionPlan(st, ti.id, { header: ti.header, lines }, 'accountant').steps.map((s) => s.action)).toEqual(['issue_dn']); // amount only: notes
    expect(correctionPlan(st, ti.id, { header: { ...ti.header, dimensions: { project: 'P-B' } }, lines: ti.lines }, 'accountant').steps.map((s) => s.action)).toEqual(['reissue']); // dimension only
  });
  it('m1: an explicit null bank account is "unchanged", like an absent one', () => {
    const rc = st.docs.find((d) => d.type === 'RC' && d.status === 'issued' && d.header.bankAccountId)!;
    const plan = correctionPlan(st, rc.id, { header: { ...rc.header, bankAccountId: null as unknown as string, notes: 'x' }, lines: rc.lines, allocations: rc.allocations }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
    executePlan(st, plan.planId, plan.planHash, me);
    expect(st.docs.find((d) => d.id === rc.id)!.header.bankAccountId).toBe(rc.header.bankAccountId);
  });
  it('m2: missing dimensions are "unchanged" (a notes-only proposal that omits them stays in place and keeps them)', () => {
    const ti = openTi();
    const withDims = revise(st, ti.id, { header: ti.header, lines: ti.lines }, ti.version, 'x', me); // no change
    void withDims;
    const t2 = st.docs.find((d) => d.type === 'TI' && d.status === 'issued' && !d.locks.length && !st.links.some((l) => l.to === d.id && l.active) && d.header.dimensions)
      ?? (() => { const d = st.docs.find((x) => x.id === ti.id)!; d.header = { ...d.header, dimensions: { project: 'P-1' } }; return d; })();
    const { dimensions, ...rest } = t2.header; void dimensions;
    const plan = correctionPlan(st, t2.id, { header: { ...rest, notes: 'ใหม่' }, lines: t2.lines }, 'accountant');
    expect(plan.steps.map((s) => s.action)).toEqual(['revise']);
    executePlan(st, plan.planId, plan.planHash, me);
    expect(st.docs.find((d) => d.id === t2.id)!.header.dimensions).toEqual(t2.header.dimensions);
  });
});
