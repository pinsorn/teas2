import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, DocLine } from '@/domain/types';
import { USER as me } from '../../fixtures/documents';
import { seed, type MockState } from '../../store';
import { cancel, createDraft, issue, revise } from '../commands';
import { withFixedClock } from '../log';
import { checkInvariants } from '../invariants';
import { derivedLocks } from '../locks';
import { toSatang } from '../money';
import { buildReport } from '../reports';
import { finalizeFiling, getFiling } from './index';
import { pp30Model, pp36VatOf } from './pp30';
import { pp36Model, pp36Rows, pp36Vat } from './pp36';

// TX2: the ภ.พ.36 is computed from the vouchers' `pnd36` lines in the PAYMENT month; finalize posts the VAT dated that month's last day; the VAT is input VAT of the NEXT month's ภ.พ.30, once.
const CO = 'co-vat', FOREIGN = 'pv-12';
let st: MockState, n = 0;
beforeEach(() => { st = seed(); });
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const sat = (m: string) => toSatang(m);
const box = (m: { boxes: { code: string; amount: string }[] }, code: string) => m.boxes.find((b) => b.code === code)!.amount;
const err = (fn: () => unknown): { code?: string } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
const L = (id: string, price: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `บริการ ${id}`, qty: '1', unit: 'งาน', unitPrice: price, taxCode: 'EX', expenseCategory: 'services', whtTypeCode: 'FOR-SVC', pnd36: true, ...p });
const pv = (date: string, lines: DocLine[], header: Partial<Doc['header']> = {}, company = CO, party = FOREIGN): Doc => {
  const d = createDraft(st, company, 'PV', { header: { partyId: party, documentDate: date, ...header }, lines }, me, `p36-${++n}`);
  return issue(st, d.id, d.version, me);
};
const fin = (form: 'PP36' | 'PP30', period: string, company = CO) => finalizeFiling(st, company, form, period, (form === 'PP36' ? pp36Model(st, company, period) : pp30Model(st, company, period)).version, me);
const input = (period: string) => sat(box(pp30Model(st, CO, period), '7'));

describe('the draft (October is the seed month: pv-foreign)', () => {
  it('lists the voucher of the payment month with its base and the VAT', () => {
    const m = pp36Model(st, CO, '2026-10');
    expect([box(m, 'base'), box(m, 'vat')]).toEqual(['10000.00', '700.00']);
    expect(m.attachment!.rows).toMatchObject([{ number: get('pv-foreign').number, name: 'Cloudberry Software Ltd. (ไอร์แลนด์)', base: '10000.00' }]);
    expect(m.blockers.map((b) => b.code)).toEqual(['period_not_ended']); // October is still open on the anchor
    expect(m.exports).toEqual(['pdf']);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a payee under VAT-D files no ภ.พ.36', () => {
    st.parties.find((p) => p.id === FOREIGN)!.vatDRegistered = true;
    st.docs.find((d) => d.id === 'pv-foreign')!.party!.vatDRegistered = true;
    expect(pp36Rows(st, CO, '2026-10')).toEqual([]);
  });
});

describe('the VAT (G3): rounded half away from zero, once over the month', () => {
  it.each([['10000.05', '10000.05', '700.00'], ['357.14', '357.14', '25.00'], ['0.50', '0.50', '0.04'], ['0.07', '0.07', '0.00']])('base %s -> VAT %s', (price, base, vat) => {
    pv('2026-09-10', [L('a', price)]);
    const m = pp36Model(st, CO, '2026-09');
    expect([box(m, 'base'), box(m, 'vat')]).toEqual([base, vat]);
  });
  it('two vouchers round once on the month, not each', () => {
    pv('2026-09-10', [L('a', '0.50')]); pv('2026-09-11', [L('b', '0.50')]);
    expect(pp36Vat(pp36Rows(st, CO, '2026-09'))).toBe(7); // 1.00 x 7 % = 0.07; rounded each it would be 0.08
  });
  it('only lines flagged pnd36 are the base', () => {
    pv('2026-09-10', [L('a', '1000.00'), L('b', '500.00', { pnd36: false })]);
    expect(box(pp36Model(st, CO, '2026-09'), 'base')).toBe('1000.00');
  });
});

describe('finalize: the entry, the claim month, the tie-outs', () => {
  beforeEach(() => { pv('2026-09-10', [L('a', '10000.05')]); });
  it('posts Dr 1170 / Cr 2152 dated the payment month last day (not the day it is finalized); the books and the registers hold', () => {
    const f = fin('PP36', '2026-09');
    expect(f).toMatchObject({ status: 'finalized', finalizedBy: me.name });
    const e = st.filings.find((x) => x.form === 'PP36')!.journal!;
    expect(e).toHaveLength(1);
    expect([e[0].date, e[0].kind]).toEqual(['2026-09-30', 'original']);
    expect(e[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['1170', '700.00', '0.00'], ['2152', '0.00', '700.00']]);
    expect(f.tieOuts.map((t) => [t.labelKey, t.diff])).toEqual([['filing.tie.pp36Gl', '0.00']]);
    expect(checkInvariants(st)).toEqual([]);
    const tb = buildReport(st, CO, 'trial-balance', { asOf: '2026-10-14' }); // the entry is in the ledger
    expect(JSON.stringify(tb.rows)).toContain('2152');
  });
  it('the VAT enters exactly one ภ.พ.30: not the payment month, once the next, not again after', () => {
    const [sep, oct, nov] = [input('2026-09'), input('2026-10'), input('2026-11')];
    fin('PP36', '2026-09');
    expect(input('2026-09')).toBe(sep);
    expect(input('2026-10')).toBe(oct + 70000);
    expect(input('2026-11')).toBe(nov);
  });
  it('the ภ.พ.30 tie-outs stay 0.00 in both months, the payment month with a NAMED reconciling line', () => {
    fin('PP36', '2026-09');
    const sep = pp30Model(st, CO, '2026-09').tieOuts.find((t) => t.labelKey === 'filing.tie.inputGl')!;
    expect(sep).toMatchObject({ diff: '0.00', reconciling: [{ labelTh: expect.stringContaining('ภ.พ.36 เดือน ก.ย. 2569'), amount: '700.00' }] });
    for (const p of ['2026-09', '2026-10', '2026-11']) for (const t of pp30Model(st, CO, p).tieOuts) expect({ p, k: t.labelKey, diff: t.diff }).toEqual({ p, k: t.labelKey, diff: '0.00' });
    const oct = pp30Model(st, CO, '2026-10').tieOuts.find((t) => t.labelKey === 'filing.tie.inputGl')!;
    expect(oct.reconciling).toBeUndefined();
    fin('PP30', '2026-09'); // a ภ.พ.30 filed after the entry freezes the named line with it
    expect(getFiling(st, CO, 'PP30', '2026-09').tieOuts.find((t) => t.labelKey === 'filing.tie.inputGl')!.reconciling).toHaveLength(1);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('m3: the tie-out compares the VAT box with the 2152 credit movement of the payment month, not with its own entry', () => {
    st.bankJournals.push({ companyId: CO, entries: [{ date: '2026-09-15', kind: 'original', postedAt: '', lines: [{ accountCode: '2152', accountName: 'x', debit: '0.00', credit: '5.00', rule: 'x' }] }] } as never);
    const t = fin('PP36', '2026-09').tieOuts[0];
    expect([t.left, t.right, t.diff]).toEqual(['700.00', '705.00', '-5.00']);
  });
  it('a ภ.พ.36 whose claim month is already filed is blocked (the VAT would never be claimed)', () => {
    st.filings.push({ ...structuredClone(st.filings.find((x) => x.form === 'PP30')!), period: '2026-10' });
    expect(pp36Model(st, CO, '2026-09').blockers.map((b) => b.code)).toContain('claim_month_filed');
    expect(err(() => fin('PP36', '2026-09')).code).toBe('filing.blocked');
  });
  it('a closed payment month blocks (the entry is posted on its last day)', () => {
    st.periods.find((p) => p.companyId === CO && p.month === '2026-09')!.status = 'closed';
    expect(pp36Model(st, CO, '2026-09').blockers.map((b) => b.code)).toContain('period_closed');
  });
  it('one per company x form x period; a stale preview is refused; nothing to file is blocked', () => {
    const v = pp36Model(st, CO, '2026-09').version;
    expect(err(() => finalizeFiling(st, CO, 'PP36', '2026-09', v + 1, me)).code).toBe('filing.stale');
    fin('PP36', '2026-09');
    expect(err(() => fin('PP36', '2026-09')).code).toBe('filing.already_finalized');
    expect(pp36Model(st, CO, '2026-08').blockers.map((b) => b.code)).toContain('no_documents');
  });
  it('the chain (ruling 4): from the first filed ภ.พ.36 on, the previous month with vouchers must be filed', () => {
    const f = st.filings; // pretend August was the first filed month
    fin('PP36', '2026-09');
    f.splice(0, f.length, ...f.filter((x) => x.form !== 'PP36'));
    expect(pp36Model(st, CO, '2026-09').blockers.map((b) => b.code)).not.toContain('previous_open'); // no chain at all
    f.push({ ...structuredClone(f[0]), form: 'PP36', period: '2026-07', claims: true, journal: [], wht: undefined, p36: [], boxes: [{ code: 'base', labelTh: '', amount: '0.00' }, { code: 'vat', labelTh: '', amount: '0.00' }], tieOuts: [], docs: [] });
    expect(pp36Model(st, CO, '2026-09').blockers.find((b) => b.code === 'previous_open')).toBeUndefined(); // 2026-08 has no vouchers: not owed
    expect(pp36Model(st, CO, '2026-10').blockers.find((b) => b.code === 'previous_open')?.href).toBe('/tax/wht?tab=pp36&period=2026-09');
  });
  it('a company outside VAT: the VAT is cost (InputVatUnclaimed), never in any ภ.พ.30', () => {
    const p = { ...structuredClone(st.parties.find((x) => x.id === FOREIGN)!), id: 'nv-foreign', companyId: 'co-nonvat' };
    st.parties.push(p);
    pv('2026-09-12', [L('a', '1000.00')], {}, 'co-nonvat', 'nv-foreign');
    fin('PP36', '2026-09', 'co-nonvat');
    const f = st.filings.find((x) => x.companyId === 'co-nonvat' && x.form === 'PP36')!;
    expect(f.claims).toBe(false);
    expect(f.journal![0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([['5170', '70.00', '0.00'], ['2152', '0.00', '70.00']]);
    expect(f.journal![0].date).toBe('2026-09-30');
    expect(pp36VatOf(st, 'co-nonvat', '2026-10')).toBe(0); // no claim month for it, in any ภ.พ.30
    expect(pp36Model(st, 'co-nonvat', '2026-09').warnings[0]).toContain('ต้นทุน');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('each single fault fails the invariant', () => {
    fin('PP36', '2026-09');
    const f = () => st.filings.find((x) => x.form === 'PP36')!;
    const fresh = () => { st = seed(); pv('2026-09-10', [L('a', '10000.05')]); fin('PP36', '2026-09'); };
    expect(checkInvariants(st)).toEqual([]);
    f().boxes[1].amount = '701.00'; expect(checkInvariants(st).join()).toContain('boxes are not what its stored vouchers give');
    fresh(); f().journal![0].date = '2026-10-14'; expect(checkInvariants(st).join()).toContain('its journal is not the one entry');
    fresh(); f().journal![0].lines[0].debit = '1.00'; expect(checkInvariants(st).join()).toContain('its journal is not the one entry');
    fresh(); f().journal![0].lines[0].accountCode = '5170'; expect(checkInvariants(st).join()).toContain('its debit is not in the account its claim status says');
    fresh(); f().p36!.pop(); expect(checkInvariants(st).join()).toContain('missing from the snapshot');
    fresh(); f().p36![0].base = '9999.00'; expect(checkInvariants(st).join()).toContain('no longer carries the figures');
    fresh(); get(f().p36![0].id).status = 'cancelled'; expect(checkInvariants(st).join()).toContain('gone or no longer live');
    fresh(); f().p36![0].partyName = 'TAMPER'; expect(checkInvariants(st).join()).toContain('partyName');
    fresh(); f().tieOuts = []; expect(checkInvariants(st).join()).toContain('tie-out filing.tie.pp36Gl is missing');
    fresh(); st.filings.push(structuredClone(f())); expect(checkInvariants(st).join()).toContain('finalized twice');
  });
});

describe('fix1 H1: the ภ.พ.36 of a month is filed before its ภ.พ.30', () => {
  beforeEach(() => { pv('2026-09-10', [L('a', '10000.00')]); });
  const gl = (p: string) => getFiling(st, CO, 'PP30', p).tieOuts.find((t) => t.labelKey === 'filing.tie.inputGl')!;
  it('the ภ.พ.30 is blocked while the ภ.พ.36 of the same month has vouchers and is not finalized', () => {
    expect(pp30Model(st, CO, '2026-09').blockers.find((b) => b.code === 'pp36_open')).toMatchObject({ labelTh: 'ยังไม่ได้ยืนยันแบบ ภ.พ.36 เดือน ก.ย. 2569', href: '/tax/wht?tab=pp36&period=2026-09' });
    expect(err(() => fin('PP30', '2026-09')).code).toBe('filing.blocked');
    expect(pp30Model(st, CO, '2026-08').blockers.map((b) => b.code)).not.toContain('pp36_open'); // no vouchers: nothing to wait for
  });
  it('in the statutory order both file; both months tie 0.00 and the payment month carries the named line; invariants hold', () => {
    fin('PP36', '2026-09');
    expect(pp30Model(st, CO, '2026-09').blockers.map((b) => b.code)).not.toContain('pp36_open');
    fin('PP30', '2026-09');
    expect(gl('2026-09')).toMatchObject({ diff: '0.00', reconciling: [{ labelTh: expect.stringContaining('ภ.พ.36 เดือน ก.ย. 2569'), amount: '700.00' }] });
    for (const p of ['2026-09', '2026-10']) for (const t of getFiling(st, CO, 'PP30', p).tieOuts) expect({ p, k: t.labelKey, diff: t.diff }).toEqual({ p, k: t.labelKey, diff: '0.00' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a voucher with a pnd36 line cannot be issued, or revised, into a month whose ภ.พ.30 is finalized', () => {
    expect(err(() => withFixedClock('2026-08-25T10:00:00+07:00', () => pv('2026-08-25', [L('b', '1000.00')]))).code).toBe('filing.period_filed'); // the seed filed ภ.พ.30 of August
    const id = pv('2026-09-12', [L('c', '1000.00')]).id, d = get(id);
    expect(err(() => revise(st, id, { header: { ...d.header, documentDate: '2026-08-20' }, lines: d.lines, allocations: d.allocations }, d.version, 'x', me)).code).toBe('filing.period_filed');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('the lock on a voucher a ภ.พ.36 took (ruling 3)', () => {
  let id: string;
  beforeEach(() => { id = pv('2026-09-10', [L('a', '10000.00')]).id; fin('PP36', '2026-09'); });
  const edit = (patch: { header?: Partial<Doc['header']>; lines?: DocLine[] }) => { const d = get(id); return revise(st, id, { header: { ...d.header, ...patch.header }, lines: patch.lines ?? d.lines, allocations: d.allocations }, d.version, 'x', me); };
  it('reads with the filing lock naming the ภ.พ.36', () => {
    expect(derivedLocks(st, get(id)).find((l) => l.kind === 'filing')).toMatchObject({ reason: 'ภ.พ.36 เดือน ก.ย. 2569 ยื่นแล้ว', href: '/tax/wht?tab=pp36&period=2026-09' });
  });
  it.each([
    ['the service base', () => edit({ lines: [{ ...get(id).lines[0], unitPrice: '11000.00' }] })],
    ['the pnd36 flag', () => edit({ lines: [{ ...get(id).lines[0], pnd36: false }] })],
    ['the payment date', () => edit({ header: { documentDate: '2026-09-11' } })],
  ])('a revise that moves %s is refused; notes are free', (_n, run) => {
    expect(err(run).code).toBe('filing.locked');
    edit({ header: { notes: 'หมายเหตุ' } });
    expect(get(id).header.notes).toBe('หมายเหตุ');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancel is refused', () => {
    expect(err(() => cancel(st, id, get(id).version, 'OTHER', 'x', me)).code).toBe('filing.locked');
  });
  it('nothing enters the filed payment month: a new voucher with a pnd36 line dated in September is refused; without the flag it is free', () => {
    expect(err(() => pv('2026-09-20', [L('b', '100.00', { whtTypeCode: undefined })])).code).toBe('filing.period_filed');
    expect(err(() => pv('2026-09-20', [L('b', '100.00', { pnd36: false, whtTypeCode: undefined })])).code).toBeUndefined();
  });
});
