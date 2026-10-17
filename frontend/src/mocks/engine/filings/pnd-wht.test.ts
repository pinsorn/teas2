import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, DocLine } from '@/domain/types';
import { USER as me } from '../../fixtures/documents';
import { seed, type MockState } from '../../store';
import { cancel, createDraft, issue, reissue, revise } from '../commands';
import { correctionPlan } from '../corrections';
import { checkInvariants } from '../invariants';
import { derivedLocks } from '../locks';
import { checklistOf } from '../close';
import { toSatang } from '../money';
import { chainStart, exportFilingText, filingHistory, finalizeFiling, getFiling, unfiledForms } from './index';
import { pndModel, pndRows } from './pnd-wht';

// TX2: the ภ.ง.ด. are computed from the WT documents of the month by form (I12); a finalized one is a frozen snapshot. The seed files ภ.ง.ด.3 / 53 for 2026-08 and 2026-09 and leaves October a draft.
const CO = 'co-vat';
let st: MockState, n = 0;
beforeEach(() => { st = seed(); });
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const box = (m: { boxes: { code: string; amount: string }[] }, code: string) => m.boxes.find((b) => b.code === code)!.amount;
const sat = (m: string) => toSatang(m);
const err = (fn: () => unknown): { code?: string; title?: string } => { try { fn(); } catch (e) { return e as { code?: string }; } return {}; };
const L = (id: string, price: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `รายการ ${id}`, qty: '1', unit: 'งาน', unitPrice: price, taxCode: 'EX', expenseCategory: 'services', whtTypeCode: 'SVC', ...p });
const pv = (partyId: string, date: string, lines: DocLine[], header: Partial<Doc['header']> = {}): Doc => {
  const d = createDraft(st, CO, 'PV', { header: { partyId, documentDate: date, ...header }, lines }, me, `tx2-${++n}`);
  return issue(st, d.id, d.version, me);
};
const revisePv = (id: string, patch: { header?: Partial<Doc['header']>; lines?: DocLine[] }) => { const d = get(id); return revise(st, id, { header: { ...d.header, ...patch.header }, lines: patch.lines ?? d.lines, allocations: d.allocations }, d.version, 'x', me); };

describe('the seed', () => {
  it('files ภ.ง.ด.3 and ภ.ง.ด.53 for 2026-08 and 2026-09; the chain of each form starts at 2026-08', () => {
    expect(st.filings.filter((f) => f.companyId === CO && f.form !== 'PP30').map((f) => `${f.form} ${f.period}`)).toEqual(['PND3 2026-08', 'PND53 2026-08', 'PND3 2026-09', 'PND53 2026-09']);
    expect([chainStart(st, CO, 'PND3'), chainStart(st, CO, 'PND53'), chainStart(st, CO, 'PND54')]).toEqual(['2026-08', '2026-08', undefined]);
    expect(getFiling(st, CO, 'PND53', '2026-08')).toMatchObject({ status: 'finalized', finalizedBy: me.name, blockers: [] });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('every tie-out is 0.00 on every month and form of the seed', () => {
    for (const form of ['PND2', 'PND3', 'PND53', 'PND54'] as const) for (const p of ['2026-08', '2026-09', '2026-10']) for (const t of getFiling(st, CO, form, p).tieOuts) expect({ form, p, k: t.labelKey, diff: t.diff }).toEqual({ form, p, k: t.labelKey, diff: '0.00' });
  });
  it('2026-10 is a draft: routing by form puts each certificate in exactly one return, and the totals are the certificates', () => {
    const forms = ['PND2', 'PND3', 'PND53', 'PND54'] as const;
    const rows = forms.flatMap((f) => pndRows(st, CO, f, '2026-10'));
    const wts = st.docs.filter((d) => d.type === 'WT' && d.status === 'issued' && d.header.documentDate.startsWith('2026-10'));
    expect(rows.map((r) => r.id).sort()).toEqual(wts.map((d) => d.id).sort());
    expect(pndRows(st, CO, 'PND54', '2026-10').map((r) => r.partyName)).toEqual(['Cloudberry Software Ltd. (ไอร์แลนด์)']);
    expect(pndRows(st, CO, 'PND3', '2026-10').map((r) => [r.partyName, r.income, r.tax])).toEqual([['คุณอนันต์ ภาพดี (ช่างภาพอิสระ)', '5154.64', '154.64']]); // grossed up: income 5,154.64, the tax is ours
    for (const f of forms) { const m = getFiling(st, CO, f, '2026-10'); expect(sat(box(m, 'tax'))).toBe(pndRows(st, CO, f, '2026-10').reduce((a, r) => a + sat(r.tax), 0)); }
    expect(sat(box(getFiling(st, CO, 'PND53', '2026-08'), 'tax'))).toBe(60000);
    expect(box(getFiling(st, CO, 'PND53', '2026-08'), 'payees')).toBe('1');
  });
});

describe('blockers and finalize', () => {
  it('a payee without a real TIN blocks the return (I10), naming the payee; a foreign payee (ภ.ง.ด.54) needs none', () => {
    const wt = st.docs.find((d) => d.type === 'WT' && d.header.whtForm === 'PND53' && d.header.documentDate.startsWith('2026-10'))!;
    expect(pndModel(st, CO, 'PND53', '2026-10').blockers.map((b) => b.code)).not.toContain('payee_tin');
    delete wt.party!.taxId;
    const m = pndModel(st, CO, 'PND53', '2026-10');
    expect(m.blockers.map((b) => b.code)).toContain('payee_tin');
    expect(m.blockers.find((b) => b.code === 'payee_tin')?.labelTh).toBe(`ผู้รับเงิน ${wt.party!.name} ไม่มีเลขประจำตัวผู้เสียภาษี`);
    expect(pndModel(st, CO, 'PND54', '2026-10').blockers.map((b) => b.code)).not.toContain('payee_tin');
  });
  it('ภ.ง.ด.2 needs an income code per certificate', () => {
    pv('pv-09', '2026-10-12', [L('a', '1000.00', { whtTypeCode: 'INT-IND' })]);
    expect(pndModel(st, CO, 'PND2', '2026-10').blockers.map((b) => b.code)).not.toContain('income_code');
    const wt = st.docs.find((d) => d.type === 'WT' && d.header.whtForm === 'PND2')!;
    wt.header.whtIncomeType = '';
    expect(pndModel(st, CO, 'PND2', '2026-10').blockers.map((b) => b.code)).toContain('income_code');
  });
  it('finalize: a month still open, an empty month, a stale preview and a second finalize are refused; the chain blocks from the first filed month on (ruling 4)', () => {
    expect(pndModel(st, CO, 'PND53', '2026-10').blockers.map((b) => b.code)).toContain('period_not_ended');
    expect(err(() => finalizeFiling(st, CO, 'PND53', '2026-10', pndModel(st, CO, 'PND53', '2026-10').version, me)).code).toBe('filing.blocked');
    expect(pndModel(st, CO, 'PND3', '2026-11').blockers.map((b) => b.code)).toContain('no_documents');
    expect(err(() => finalizeFiling(st, CO, 'PND53', '2026-08', pndModel(st, CO, 'PND53', '2026-08').version, me)).code).toBe('filing.already_finalized');
    expect(pndModel(st, CO, 'PND53', '2026-07').blockers.map((b) => b.code)).toContain('before_chain'); // a month before the chain is not owed
    st.filings.splice(st.filings.findIndex((f) => f.form === 'PND53' && f.period === '2026-09'), 1); // a gap AFTER the chain start blocks the later month; the other form's chain is untouched
    expect(pndModel(st, CO, 'PND53', '2026-10').blockers.find((b) => b.code === 'previous_open')?.href).toBe('/tax/wht?tab=pnd53&period=2026-09');
    expect(pndModel(st, CO, 'PND3', '2026-10').blockers.map((b) => b.code)).not.toContain('previous_open');
    expect(pndModel(st, CO, 'PND54', '2026-10').blockers.map((b) => b.code)).not.toContain('previous_open'); // no finalized ภ.ง.ด.54: no chain
  });
  it('a stale preview is refused (a new certificate landed after it)', () => {
    const v = pndModel(st, CO, 'PND3', '2026-10').version;
    pv('pv-09', '2026-10-12', [L('a', '1000.00')]);
    expect(err(() => finalizeFiling(st, CO, 'PND3', '2026-10', v, me)).code).toBe('filing.stale');
  });
  it('exports: ภ.ง.ด.3 / 53 give an RD Prep text of the frozen rows (CRLF); ภ.ง.ด.54 is PDF only', () => {
    const txt = exportFilingText(st, CO, 'PND53', '2026-08');
    expect(txt.split('\r\n')[0]).toMatch(/^H\|PND53\|\d{13}\|/);
    expect(txt).toContain('|20000.00|600.00|');
    expect(txt.endsWith('\r\n')).toBe(true);
    expect(err(() => exportFilingText(st, CO, 'PND54', '2026-10')).code).toBe('filing.not_finalized');
    expect(getFiling(st, CO, 'PND54', '2026-10').exports).toEqual(['pdf']);
  });
  it('history lists the frozen tax of each filed month', () => {
    expect(filingHistory(st, CO, 'PND53').map((h) => [h.period, h.net])).toEqual([['2026-09', '450.00'], ['2026-08', '600.00']]);
  });
});

describe('frozen at finalize (ruling 1)', () => {
  const tamper = (fn: () => void) => { fn(); return checkInvariants(st); };
  it('later reads show the snapshot, not the documents', () => {
    const f = st.filings.find((x) => x.form === 'PND53' && x.period === '2026-08')!;
    f.wht![0].partyName = 'ชื่อที่ยื่นไว้'; // what the return took is what the page shows
    expect(getFiling(st, CO, 'PND53', '2026-08').attachment!.rows[0].name).toBe('ชื่อที่ยื่นไว้');
  });
  it('each single fault fails the invariant', () => {
    const f = () => st.filings.find((x) => x.form === 'PND53' && x.period === '2026-08')!;
    expect(checkInvariants(st)).toEqual([]);
    expect(tamper(() => { f().boxes[2].amount = '1.00'; })[0]).toContain('boxes are not what its stored certificates give');
    st = seed();
    expect(tamper(() => { f().wht![0].tax = '1.00'; }).join()).toContain('no longer carries the figures');
    st = seed();
    expect(tamper(() => { f().wht![0].tin = '0000000000000'; }).join()).toContain('no longer carries the figures'); // the payee as the return took it
    st = seed();
    expect(tamper(() => { f().wht!.pop(); }).join()).toContain('missing from the snapshot');
    st = seed();
    expect(tamper(() => { get(st.links.find((l) => l.kind === 'issues' && l.from === 'pv-aug-53')!.to).status = 'cancelled'; }).join()).toMatch(/PND53 2026-08.*listed live but is cancelled/);
    st = seed();
    expect(tamper(() => { f().tieOuts = []; }).join()).toContain('tie-out filing.tie.pndGl is missing');
    st = seed();
    expect(tamper(() => { f().tieOuts[0].diff = '5.00'; }).join()).toContain('is not left - right');
    st = seed();
    expect(tamper(() => { st.filings.push(structuredClone(f())); }).join()).toContain('finalized twice');
  });
  it.each(['partyName', 'rate', 'nameTh', 'entityKind'] as const)('a tampered %s on a stored row fails the invariant (m1)', (k) => {
    expect(checkInvariants(st)).toEqual([]);
    (st.filings.find((x) => x.form === 'PND53' && x.period === '2026-08')!.wht![0] as unknown as Record<string, string>)[k] = 'TAMPER';
    // single fault: only this field differs from the source
    expect(checkInvariants(st).join()).toContain(k);
  });
});

describe('the GL tie-out is by the voucher month (M1)', () => {
  const ties = (p: string) => getFiling(st, CO, 'PND54', p).tieOuts.map((t) => [t.left, t.right, t.diff]);
  it('a September ภ.ง.ด.54 voucher cancelled in October ties 0.00 in both months', () => {
    const v = pv('pv-12', '2026-09-20', [L('a', '10000.00', { whtTypeCode: 'FOR-SVC' })]);
    expect(ties('2026-09')[0][2]).toBe('0.00');
    cancel(st, v.id, get(v.id).version, 'OTHER', 'x', me);
    expect(ties('2026-09')).toEqual([['0.00', '0.00', '0.00']]);
    expect(ties('2026-10')[0][2]).toBe('0.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a September voucher revised in October still ties 0.00 in both months', () => {
    const v = pv('pv-12', '2026-09-20', [L('a', '10000.00', { whtTypeCode: 'FOR-SVC' })]);
    revisePv(v.id, { lines: [{ ...v.lines[0], unitPrice: '12000.00' }] });
    expect(ties('2026-09')[0][2]).toBe('0.00');
    expect(ties('2026-10')[0][2]).toBe('0.00');
  });
});

describe('the filing lock on a voucher (ruling 2)', () => {
  const lines = () => get('pv-aug-53').lines;
  it('the voucher and its certificate read with the filing lock and the working exit', () => {
    for (const id of ['pv-aug-53', st.links.find((l) => l.kind === 'issues' && l.from === 'pv-aug-53')!.to]) {
      const d = get(id), lk = derivedLocks(st, d).find((l) => l.kind === 'filing')!;
      expect(lk.reason).toContain('ภ.ง.ด.53 เดือน');
      expect(lk.exits[0]).toContain('ออกใบสำคัญจ่ายใหม่ในงวดถัดไป');
      expect(lk.href).toBe('/tax/wht?tab=pnd53&period=2026-08');
    }
    expect(derivedLocks(st, get('pv-pay1')).some((l) => l.kind === 'filing')).toBe(false); // October: not filed
  });
  it.each([
    ['the WHT base', () => revisePv('pv-aug-53', { lines: [{ ...lines()[0], unitPrice: '21000.00' }] })],
    ['the WHT type', () => revisePv('pv-aug-53', { lines: [{ ...lines()[0], whtTypeCode: 'ADS' }] })],
    ['the income (a line dropped its type)', () => revisePv('pv-aug-53', { lines: [{ ...lines()[0], whtTypeCode: undefined }] })],
    ['the payment date', () => revisePv('pv-aug-53', { header: { documentDate: '2026-08-21' } })],
    ['the payer condition (gross-up)', () => revisePv('pv-aug-53', { header: { whtMode: 'grossup_always' } })],
  ])('a revise that moves %s is refused', (_n, run) => {
    expect(err(run).code).toBe('filing.locked');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a revise that moves nothing the return took is free (notes, reference, bank account)', () => {
    revisePv('pv-aug-53', { header: { notes: 'หมายเหตุ', reference: 'อ้างอิงใหม่' } });
    expect(get('pv-aug-53').header.notes).toBe('หมายเหตุ');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('cancel and reissue are refused', () => {
    expect(err(() => cancel(st, 'pv-aug-53', get('pv-aug-53').version, 'OTHER', 'x', me)).code).toBe('filing.locked');
    expect(err(() => reissue(st, 'pv-aug-53', { header: get('pv-aug-53').header, lines: lines() }, me, 'x')).code).toBe('filing.locked');
    expect(get('pv-aug-53').status).toBe('issued');
  });
  it('a correction plan that moves what the return took is refused before it is shown', () => {
    const d = get('pv-aug-53'), before = Object.keys(st.plans ?? {}).length;
    const body = { header: d.header, lines: [{ ...lines()[0], unitPrice: '21000.00' }], allocations: d.allocations };
    expect(err(() => correctionPlan(st, 'pv-aug-53', body, 'accountant')).code).toBe('filing.locked');
    expect(Object.keys(st.plans ?? {}).length).toBe(before);
    const same = { header: { ...d.header, notes: 'x' }, lines: d.lines, allocations: d.allocations };
    expect(correctionPlan(st, 'pv-aug-53', same, 'accountant').steps.length).toBe(1);
  });
  it('a certificate cannot be cancelled while its return stands', () => {
    const wt = st.links.find((l) => l.kind === 'issues' && l.from === 'pv-aug-53')!.to;
    expect(err(() => cancel(st, wt, get(wt).version, 'OTHER', 'x', me)).code).toBe('filing.locked');
  });
  it('nothing enters a filed month: a voucher dated in 2026-08 whose form is filed is refused; another form (not filed) is free', () => {
    expect(err(() => pv('pv-02', '2026-09-25', [L('a', '1000.00')])).code).toBe('filing.period_filed'); // a ภ.ง.ด.53 certificate in a filed ภ.ง.ด.53 month
    expect(err(() => pv('pv-09', '2026-09-25', [L('a', '1000.00')])).code).toBe('filing.period_filed'); // ภ.ง.ด.3 of 2026-09
    expect(err(() => pv('pv-12', '2026-09-25', [L('a', '1000.00', { whtTypeCode: 'FOR-SVC' })])).code).toBeUndefined(); // ภ.ง.ด.54 of September is not filed
    expect(err(() => pv('pv-02', '2026-09-26', [L('a', '1000.00', { whtTypeCode: undefined })])).code).toBeUndefined(); // no WHT: nothing enters a return
  });
  it('a revise INTO a filed month is refused', () => {
    expect(err(() => revisePv('pv-pay1', { header: { documentDate: '2026-09-10' } })).code).toBe('filing.period_filed'); // pv-pay1 pays pb-1 (53)
  });
  it('a voucher still unfiled in an open month stays free to cancel', () => {
    cancel(st, 'pv-gross', get('pv-gross').version, 'OTHER', 'x', me);
    expect(get('pv-gross').status).toBe('cancelled');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('the period close checklist (ruling 5)', () => {
  const item = (month: string) => checklistOf(st, CO, month).find((i) => i.code === 'filings_not_finalized')!;
  it('counts the ภ.พ.30 and each ภ.ง.ด. / ภ.พ.36 with documents in the month that is not finalized', () => {
    expect(unfiledForms(st, CO, '2026-10')).toEqual(['PP30', 'PND3', 'PND53', 'PND54', 'PP36']);
    expect(item('2026-10')).toMatchObject({ count: 5, severity: 'warning', href: '/tax/vat?period=2026-10' });
    expect(item('2026-09').count).toBe(1); // only the ภ.พ.30 of September is open; ภ.ง.ด.3 / 53 are filed
    expect(item('2026-08').count).toBe(0);
    expect(item('2026-07').count).toBe(0); // before every chain
  });
  it('a filed form drops out; with the ภ.พ.30 filed the item points at the first open ภ.ง.ด.', () => {
    st.filings.push({ ...st.filings.find((f) => f.form === 'PND54' || f.form === 'PND53')!, form: 'PND54', period: '2026-10', wht: [] });
    expect(unfiledForms(st, CO, '2026-10')).not.toContain('PND54');
  });
  it('the non-VAT company counts its ภ.ง.ด. but never a ภ.พ.30', () => {
    expect(unfiledForms(st, 'co-nonvat', '2026-10')).not.toContain('PP30');
  });
  it('m2: a form counts from its own chain start; a never-filed form from the earliest filing of ANY form; a company with none counts nothing', () => {
    st.filings = st.filings.filter((f) => f.form === 'PND53' && f.period === '2026-09');
    expect(unfiledForms(st, CO, '2026-09')).toEqual(['PP30', 'PND3']); // PP30 / PND3 never filed: owed from 2026-09 on (the PND53 itself is filed)
    expect(unfiledForms(st, CO, '2026-08')).toEqual([]); // before the earliest filing of any form: PND3 / PND53 have documents but are not owed
    st.filings = [];
    expect(unfiledForms(st, CO, '2026-09')).toEqual([]);
    expect(unfiledForms(st, CO, '2026-10')).toEqual([]);
  });
  it('a month with the whole set filed counts 0 (a ภ.ง.ด.3 / 53 chain month closes clean)', () => {
    expect(unfiledForms(st, CO, '2026-08')).toEqual([]);
  });
});

describe('ruling 7: entering a withholding certificate number late is a paper-only edit', () => {
  const rc = () => get('rc-nocert');
  const missing = () => st.docs.filter((d) => d.type === 'RC' && d.status === 'issued').flatMap((d) => (d.allocations ?? []).filter((a) => a.wht && !a.certNumber).map(() => d.id));
  const enter = (number = 'ท.2569/0999') => { const d = rc(); return revise(st, d.id, { header: d.header, lines: d.lines, allocations: d.allocations!.map((a) => (a.wht && !a.certNumber ? { ...a, certNumber: number } : a)) }, d.version, 'x', me); };
  it('the seed receipt is on the missing list; entering the number takes it off (revision + activity say which number)', () => {
    expect(missing()).toContain('rc-nocert');
    enter();
    expect(missing()).not.toContain('rc-nocert');
    expect(rc().allocations!.find((a) => a.certNumber)?.certNumber).toBe('ท.2569/0999');
    expect(st.activity.filter((a) => a.docId === 'rc-nocert').at(-1)?.detail).toContain('ท.2569/0999');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('allowed in a closed period', () => {
    const m = rc().header.documentDate.slice(0, 7);
    for (const p of st.periods.filter((x) => x.companyId === CO && x.month <= m)) p.status = 'closed';
    expect(derivedLocks(st, rc()).some((l) => l.kind === 'period')).toBe(true);
    enter();
    expect(missing()).not.toContain('rc-nocert');
  });
  it('allowed under a reconciliation match (a hand-made match: the lock is read, the edit moves no cash, bank account or date)', () => {
    const d = rc(), bank = st.bankAccounts.find((b) => b.companyId === CO)!;
    st.bankLines.push({ id: 'bl-x', companyId: CO, accountId: bank.id, date: d.header.documentDate, amount: d.totals.cash!, status: 'matched', matches: [{ docId: d.id, docCash: d.totals.cash!, docDate: d.header.documentDate, accountId: bank.id }] } as never);
    expect(derivedLocks(st, d).some((l) => l.kind === 'reconciliation')).toBe(true);
    enter();
    expect(missing()).not.toContain('rc-nocert');
  });
});
