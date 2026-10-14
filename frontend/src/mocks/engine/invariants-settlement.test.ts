import { describe, expect, it } from 'vitest';
import { USER as U } from '../fixtures/documents';
import { fixtureIds } from '../fixtures/ids';
import { buildSeedState, type MockState } from '../store';
import { addAdjustment, createDraft, issue } from './commands';
import { checkInvariants } from './invariants';

const msgs = (st: MockState) => checkInvariants(st).join('\n');

describe('receipts and vouchers: allocations, WHT and the PV balance identity (F5), each rule with a corrupted-state test', () => {
  /** A seed plus: a two-target RC with WHT and a deposit, a deduct PV, a gross-up PV and a PV paying a bill. Each is issued through the real command. */
  function world() {
    const st = buildSeedState();
    const ids = fixtureIds(st);
    const rc = createDraft(st, 'co-vat', 'RC', { header: { partyId: 'pc-01', documentDate: '2026-10-14', depositAmount: '200.00' }, lines: [], allocations: [
      { targetId: ids.rcTargetsA, targetType: 'TI', amount: '1000.00', wht: '30.00', whtTypeCode: 'SVC' }, { targetId: ids.rcTargetsB, targetType: 'TI', amount: '500.00' }] }, U, 'iw-rc');
    const pvLine = (id: string, price: string) => ({ id, description: 'ค่าถ่ายภาพ', qty: '1', unit: 'งาน', unitPrice: price, taxCode: 'EX' as const, whtTypeCode: 'SVC' });
    const mk = (mode: 'deduct' | 'grossup_once' | 'grossup_always', k: string) => createDraft(st, 'co-vat', 'PV', { header: { partyId: 'pv-01', documentDate: '2026-10-14', whtMode: mode }, lines: [pvLine('l1', '5000.00')] }, U, k);
    const pb = createDraft(st, 'co-vat', 'PB', { header: { partyId: 'pv-01', documentDate: '2026-10-14' }, lines: [{ id: 'l1', description: 'วัสดุ', qty: '1', unit: 'ชุด', unitPrice: '1000.00', taxCode: 'S7' }] }, U, 'iw-pb');
    const pbDone = issue(st, pb.id, pb.version, U);
    const pvBill = createDraft(st, 'co-vat', 'PV', { header: { partyId: 'pv-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: pbDone.id, targetType: 'PB', amount: '600.00' }] }, U, 'iw-pvb');
    const done = [rc, mk('deduct', 'iw-d'), mk('grossup_always', 'iw-g'), pvBill, mk('grossup_once', 'iw-o')].map((d) => issue(st, d.id, d.version, U));
    return { st, rc: done[0], pvD: done[1], pvG: done[2], pvB: done[3], pvO: done[4], ids };
  }
  const entry = (st: MockState, id: string) => st.journals.find((j) => j.docId === id)!.preview.entries[0];
  const find = (st: MockState, id: string, code: string) => entry(st, id).lines.find((l) => l.accountCode === code)!;
  const D = (st: MockState, id: string) => st.docs.find((d) => d.id === id)!;
  const bump = (m: string, by: number) => (Number(m) + by).toFixed(2);

  it('hold for real receipts and vouchers issued through the engine (deposit, deduct and gross-up all appear)', () => {
    const { st, rc, pvD, pvG } = world();
    expect(msgs(st)).toBe('');
    expect([D(st, rc.id).totals.total, D(st, pvD.id).totals.cash, D(st, pvG.id).totals.cash]).toEqual(['1700.00', '4850.00', '5000.00']);
  });
  it('gross-up once (RD ป.96/2543 ex. 6) holds: income 5,150.00 = payee 4,995.50 + tax 154.50, we bear 150.00; the old cash = total / expense = tax is reported (can fail)', () => {
    const a = world();
    expect([D(a.st, a.pvO.id).totals.cash, find(a.st, a.pvO.id, '5180').debit]).toEqual(['4995.50', '150.00']);
    expect(msgs(a.st)).toBe('');
    D(a.st, a.pvO.id).totals.cash = '5000.00'; // the pre-fix formula
    expect(msgs(a.st)).toContain("PV cash 5000.00 is wrong for mode grossup_once (total 5000.00, expected 4995.50)");
    const b = world();
    const exp = find(b.st, b.pvO.id, '5180'), line = find(b.st, b.pvO.id, '5100');
    exp.debit = '154.50'; line.debit = '4995.50'; // still Dr = Cr, expense booked as the whole tax
    const out = msgs(b.st);
    expect(out).not.toMatch(/unbalanced/);
    expect(out).toContain("WHT expense 154.50 is wrong for mode grossup_once (expected 150.00)");
  });
  it('report an allocation that no longer has its settles link, and a link whose amount differs from its allocation (can fail)', () => {
    const a = world();
    a.st.links.find((x) => x.from === a.rc.id && x.active)!.active = false;
    expect(msgs(a.st)).toMatch(new RegExp(`${a.rc.id}: allocations .* but the active settles links`));
    const b = world();
    b.st.links.find((x) => x.from === b.rc.id && x.active)!.amount = '999.00';
    expect(msgs(b.st)).toMatch(new RegExp(`${b.rc.id}: allocations`));
  });
  it('report an RC whose cash + WHT is not Σ allocations + deposit + cash-bill, and a wht that is not Σ allocation wht (can fail)', () => {
    const a = world(); D(a.st, a.rc.id).totals.cash = bump(D(a.st, a.rc.id).totals.cash!, 1);
    expect(msgs(a.st)).toMatch(/RC cash .* is not Σ allocations \+ deposit/);
    const b = world(); D(b.st, b.rc.id).totals.wht = bump(D(b.st, b.rc.id).totals.wht!, 0.01);
    expect(msgs(b.st)).toMatch(/RC wht .* is not Σ allocation wht/);
    const c = world(); D(c.st, c.rc.id).totals.total = bump(D(c.st, c.rc.id).totals.total, 1);
    expect(msgs(c.st)).toMatch(/RC total .* is not Σ allocations \+ deposit/);
  });
  it('report an RC journal that moves a satang between cash and WHT receivable while still balancing, and a lost deposit line (can fail)', () => {
    const a = world();
    const cash = find(a.st, a.rc.id, '1121'), wht = find(a.st, a.rc.id, '1180');
    cash.debit = bump(cash.debit, -0.01); wht.debit = bump(wht.debit, 0.01); // Dr = Cr still holds
    const out = msgs(a.st);
    expect(out).not.toMatch(/unbalanced/);
    expect(out).toMatch(/journal cash/);
    expect(out).toMatch(/journal WHT receivable/);
    const b = world(); const dep = find(b.st, b.rc.id, '2140'), ar = find(b.st, b.rc.id, '1130');
    dep.credit = bump(dep.credit, -0.01); ar.credit = bump(ar.credit, 0.01);
    expect(msgs(b.st)).toMatch(/journal deposit/);
  });
  it('report a PV wht that is not round-half-away(base x rate) per WHT type, and an unknown WHT type (can fail)', () => {
    const a = world(); D(a.st, a.pvD.id).totals.wht = bump(D(a.st, a.pvD.id).totals.wht!, 0.01);
    expect(msgs(a.st)).toMatch(/PV wht 150\.01 but .* gives 150\.00/);
    const b = world(); D(b.st, b.pvG.id).lines[0].unitPrice = '6000.00'; // the stored wht no longer follows the line
    expect(msgs(b.st)).toMatch(/PV wht 154.64 but .* gives/);
    const c = world(); D(c.st, c.pvD.id).lines[0].whtTypeCode = 'NOPE';
    expect(msgs(c.st)).toMatch(/unknown WHT type NOPE/);
  });
  it('report a PV cash that does not match its mode, in both directions (can fail)', () => {
    const a = world(); D(a.st, a.pvD.id).totals.cash = D(a.st, a.pvD.id).totals.total; // deduct must pay total - wht
    expect(msgs(a.st)).toMatch(/PV cash .* wrong for mode deduct/);
    const b = world(); D(b.st, b.pvG.id).totals.cash = bump(D(b.st, b.pvG.id).totals.cash!, -154.64); // gross-up must pay the whole total
    expect(msgs(b.st)).toMatch(/PV cash .* wrong for mode grossup_always/);
  });
  it('report a gross-up PV whose WHT expense was folded into the expense line (the balance identity) and a deduct PV that books one (can fail)', () => {
    const a = world();
    const exp = find(a.st, a.pvG.id, '5180'), line = find(a.st, a.pvG.id, '5100');
    line.debit = bump(line.debit, Number(exp.debit));
    entry(a.st, a.pvG.id).lines = entry(a.st, a.pvG.id).lines.filter((l) => l !== exp);
    const out = msgs(a.st);
    expect(out).not.toMatch(/unbalanced/);
    expect(out).toMatch(/WHT expense 0\.00 is wrong for mode grossup_always/);
    expect(out).toMatch(/is not cash \+ WHT/);
    const b = world(); // a deduct voucher claiming a WHT expense: move 1 satang of the expense line to WhtExpense (still balanced)
    const ln = find(b.st, b.pvD.id, '5100');
    ln.debit = bump(ln.debit, -0.01);
    entry(b.st, b.pvD.id).lines.push({ accountCode: '5180', accountName: 'ภาษีหัก ณ ที่จ่ายที่ออกแทน', debit: '0.01', credit: '0.00', rule: 'ค่าเริ่มต้นบริษัท: WhtExpense → 5180' });
    expect(msgs(b.st)).toMatch(/WHT expense 0\.01 is wrong for mode deduct/);
  });
  it('report a PV journal that clears more payables than its allocations, and a WHT payable that differs from the voucher WHT (can fail)', () => {
    const a = world();
    find(a.st, a.pvB.id, '2110').debit = '601.00'; find(a.st, a.pvB.id, '1121').credit = '601.00';
    expect(msgs(a.st)).toMatch(/journal payables 601\.00 but the allocations clear 600\.00/);
    const b = world();
    const pay = find(b.st, b.pvD.id, '2132'), bank = find(b.st, b.pvD.id, '1121');
    pay.credit = bump(pay.credit, 0.01); bank.credit = bump(bank.credit, -0.01);
    expect(msgs(b.st)).toMatch(/journal WHT payable/);
  });
  it('a doctored over-settlement is caught through the outstanding rule; a negative outstanding after a later credit note is NOT a violation (Ham ruling, no static settled <= total check)', () => {
    const a = world();
    a.st.links.find((x) => x.from === a.rc.id && x.active)!.amount = '99999999.00';
    D(a.st, a.rc.id).allocations![0].amount = '99999999.00';
    expect(msgs(a.st)).toMatch(/outstanding .* but the links say/);
    const b = world(); // pay a target in full, then a credit note pushes it below zero: shown, never an invariant violation
    const ti = D(b.st, b.ids.rcTargetsB);
    const pay = createDraft(b.st, 'co-vat', 'RC', { header: { partyId: ti.header.partyId, documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: ti.id, targetType: 'TI', amount: D(b.st, ti.id).outstanding! }] }, U, 'neg-rc');
    issue(b.st, pay.id, pay.version, U);
    expect(D(b.st, ti.id).outstanding).toBe('0.00');
    const cn = createDraft(b.st, 'co-vat', 'CN', { header: { partyId: ti.header.partyId, documentDate: '2026-10-14' }, lines: [{ id: 'c', description: 'ลดหนี้', qty: '1', unit: 'งาน', unitPrice: '50.00', taxCode: 'S7' }] }, U, 'neg-cn');
    const cnDone = issue(b.st, cn.id, cn.version, U);
    addAdjustment(b.st, cnDone.id, ti.id, cnDone.totals.total);
    expect(D(b.st, ti.id).outstanding).toBe('-53.50');
    expect(msgs(b.st)).toBe('');
  });
});
