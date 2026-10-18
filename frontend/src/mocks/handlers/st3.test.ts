import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { approve, setSelfApproval, setTolerance, submit, updateApprovalRule } from '../engine/approval';
import { createDraft, issue, revise } from '../engine/commands';
import { checkInvariants } from '../engine/invariants';
import { MockError, changeTaxRate } from '../engine/log';
import { allocateNumber, parseNumber, previewNumbering, updateNumbering } from '../engine/numbering';
import { buildReport } from '../engine/reports';
import { postSettlement } from '../engine/settlement-records';
import { setWhtActive } from '../engine/wht';
import { AGENT, USER as me } from '../fixtures/documents';
import { setSettings } from '../settings';
import { buildSeedState, loadState, resetState, type MockState } from '../store';
import { testServer } from '../test-server';

// SP1c ST3: tax settings (dated WHT rates), numbering series (frozen format per series key), approval policy (frozen per document), settlement tolerance (frozen per settlement).
const CO = 'co-vat';
const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return e instanceof MockError ? e.code : String(e); } return undefined; };
const L = (id: string, price: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `x ${id}`, qty: '1', unit: 'ครั้ง', unitPrice: price, taxCode: 'EX', expenseCategory: 'transport', ...p });
let n = 0;
const pv = (st: MockState, price: string, date = '2026-10-14', p: Partial<DocLine> = {}) => createDraft(st, CO, 'PV', { header: { partyId: 'pv-01', documentDate: date }, lines: [L(`v${n}`, price, p)] }, me, `st3-${n++}`);
const qt = (st: MockState, date: string) => {
  const d = createDraft(st, CO, 'QT', { header: { partyId: 'pc-02', documentDate: date, dueDate: '2026-12-01' }, lines: [{ id: `q${n}`, description: 'q', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'S7' }] }, me, `st3q-${n++}`);
  return issue(st, d.id, d.version, me);
};
const get = (st: MockState, id: string) => st.docs.find((d) => d.id === id)!;
const fmt = (o: object = {}) => ({ prefix: 'QT', scope: 'monthly', format: '{PREFIX}/{YY}{MM}/{####}', version: 1, ...o });
const gaps = (st: MockState) => buildReport(st, CO, 'number-gaps', {}) as unknown as { rows: { cells: Record<string, string> }[] };
const four = (x: number) => String(x).padStart(4, '0');
/** A world where the type has no numbers at all (every seeded type has numbers in 2026, which a scope switch must respect): its documents, their links / history and its series are removed. */
const clearType = (st: MockState, type: string) => {
  const ids = new Set(st.docs.filter((d) => d.companyId === CO && d.type === type).map((d) => d.id));
  st.docs = st.docs.filter((d) => !ids.has(d.id)); st.links = st.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
  st.activity = st.activity.filter((a) => !ids.has(a.docId)); st.revisions = st.revisions.filter((r) => !ids.has(r.docId)); st.journals = st.journals.filter((j) => !ids.has(j.docId));
  for (const k of Object.keys(st.series)) if (k.startsWith(`${CO}|${type}|`)) delete st.series[k];
  for (const k of Object.keys(st.seriesFormats ?? {})) if (k.startsWith(`${CO}|${type}|`)) delete st.seriesFormats![k];
};

describe('ST3 numbering: the format is frozen per series key', () => {
  it("the default config reproduces today's numbers exactly", () => {
    const st = buildSeedState();
    expect(checkInvariants(st)).toEqual([]);
    expect(get(st, 'ti-dep').number).toMatch(/^TI-\d{6}-\d{4}$/);
    expect(qt(st, '2026-09-10').number).toBe('QT-202609-0001');
  });
  it('validation: monthly needs {MM} and a year token, yearly a year token and no {MM}, a counter is required, {BRANCH} needs a branch', () => {
    const st = buildSeedState();
    const put = (b: object) => code(() => updateNumbering(st, me, CO, 'QT', b as never));
    expect(put(fmt({ format: '{PREFIX}-{YYYY}-{####}' }))).toBe('numbering.missing_token');
    expect(put(fmt({ format: '{PREFIX}-{MM}-{####}' }))).toBe('numbering.missing_token');
    expect(put(fmt({ format: '{PREFIX}-{YYYY}{MM}' }))).toBe('numbering.missing_token');
    expect(put(fmt({ scope: 'yearly', format: '{PREFIX}-{YYYY}{MM}-{####}' }))).toBe('numbering.missing_token');
    expect(put(fmt({ format: '{BRANCH}-{YYYY}{MM}-{####}' }))).toBe('numbering.bad_token');
    expect(put(fmt({ format: '{PREFIX}-{YYYY}{MM}-{####}', branch: 'HQ' }))).toBeUndefined();
  });
  it('a change applies to a key with no numbers; a key that has them keeps its stored format; old numbers still parse, the gap audit is clean, invariants []', () => {
    const st = buildSeedState();
    const used = st.series['co-vat|QT|2026-10'];
    const r = updateNumbering(st, me, CO, 'QT', fmt() as never);
    expect(r.notice?.code).toBe('numbering.in_use'); // 2026-10 already has QT numbers
    expect(qt(st, '2026-10-14').number).toBe(`QT-202610-${four(used + 1)}`); // the key's stored (legacy) format, next counter
    expect(qt(st, '2026-09-10').number).toBe('QT/2609/0001'); // the key had no numbers: the new format
    expect(qt(st, '2026-09-11').number).toBe('QT/2609/0002');
    updateNumbering(st, me, CO, 'QT', fmt({ format: '{PREFIX}.{YYYY}{MM}.{####}', version: 2 }) as never);
    expect(qt(st, '2026-09-12').number).toBe('QT/2609/0003'); // 2026-09 stays on the format of its first number
    expect(checkInvariants(st)).toEqual([]);
    expect(gaps(st).rows.filter((x) => x.cells.state === 'มีปัญหา')).toEqual([]);
    expect(gaps(st).rows.some((x) => x.cells.series === 'QT 2026-09' && x.cells.state === 'ครบ')).toBe(true);
    delete st.docs.find((d) => d.number === 'QT/2609/0002')!.number; // tamper: a gap in the series that carries the new format - the audit names the missing number in THAT format
    expect(gaps(st).rows.some((x) => x.cells.series === 'QT/2609/0002' && x.cells.state === 'เลขขาด')).toBe(true);
  });
  it('a yearly series: one counter per year; the issue year is judged; the gap audit is clean', () => {
    const st = buildSeedState();
    clearType(st, 'QT');
    expect(checkInvariants(st)).toEqual([]);
    updateNumbering(st, me, CO, 'QT', fmt({ scope: 'yearly', format: '{PREFIX}-{YYYY}-{####}' }) as never);
    expect(qt(st, '2026-09-10').number).toBe('QT-2026-0001');
    const d = qt(st, '2026-10-14');
    expect(d.number).toBe('QT-2026-0002');
    expect(checkInvariants(st)).toEqual([]);
    expect(gaps(st).rows.some((x) => x.cells.series === 'QT 2026' && x.cells.state === 'ครบ')).toBe(true);
    get(st, d.id).header.documentDate = '2025-10-14'; // tamper: the number's year is not the year it was issued in (the revision-0 snapshot, when there is one, is what is judged)
    for (const r of st.revisions) if (r.docId === d.id && r.revision === 0) r.snapshot.header.documentDate = '2025-10-14';
    expect(checkInvariants(st).some((m) => m.includes('numbering') && m.includes(d.id))).toBe(true);
  });
  it('a config whose next number already exists is refused (numbering.collision)', () => {
    const st = buildSeedState();
    const d = qt(st, '2026-09-10');
    get(st, d.id).number = 'QT-2027-0001'; // a number the yearly series would hand out next (this year already has monthly numbers: the yearly series starts 2027)
    expect(code(() => updateNumbering(st, me, CO, 'QT', fmt({ scope: 'yearly', format: '{PREFIX}-{YYYY}-{####}' }) as never))).toBe('numbering.collision');
    expect(st.numbering?.length ?? 0).toBe(0);
  });
  it('invariant: a number is unique per company and type', () => {
    const st = buildSeedState();
    const a = qt(st, '2026-09-10'), b = qt(st, '2026-09-11');
    expect(checkInvariants(st)).toEqual([]);
    get(st, b.id).number = a.number; // one fault: the same number twice
    expect(checkInvariants(st).some((m) => m.includes('duplicate number'))).toBe(true);
  });
  it('the preview comes from the server and refuses what a save would', () => {
    const st = buildSeedState();
    expect(previewNumbering(st, CO, 'QT', fmt() as never)).toMatchObject({ next: 'QT/2611/0001', period: '2026-11', inUse: true }); // 2026-10 has QT numbers: the new format starts next period
    expect(code(() => previewNumbering(st, CO, 'QT', fmt({ format: '{PREFIX}' }) as never))).toBe('numbering.missing_token');
  });
  it('allocation: the first allocation of a key stores the format in force', () => {
    const st = buildSeedState();
    updateNumbering(st, me, CO, 'QT', { prefix: 'QT', scope: 'monthly', format: '{PREFIX}{YYYY}{MM}{####}', version: 1 } as never);
    expect(allocateNumber(st, CO, 'QT', '2026-09-03')).toBe('QT2026090001');
    expect(st.seriesFormats?.['co-vat|QT|2026-09']).toBe('QT{YYYY}{MM}{####}');
  });
});

describe('ST3a M1: a year keeps one scope; a number parses to exactly one key', () => {
  it('yearly -> monthly in one year: the back-dated QT stays in the yearly series, invariants [], no runaway gap rows', () => {
    const st = buildSeedState();
    clearType(st, 'QT');
    updateNumbering(st, me, CO, 'QT', { prefix: 'QT', scope: 'yearly', format: '{PREFIX}{YYYY}{####}', version: 1 } as never);
    expect([qt(st, '2026-09-10').number, qt(st, '2026-09-11').number]).toEqual(['QT20260001', 'QT20260002']);
    const r = updateNumbering(st, me, CO, 'QT', { prefix: 'QT', scope: 'monthly', format: '{PREFIX}{YYYY}{MM}{####}', version: 2 } as never);
    expect(r.notice?.title).toContain('2027'); // the new scope starts with the first year without numbers
    expect(qt(st, '2026-09-12').number).toBe('QT20260003');
    expect(checkInvariants(st)).toEqual([]);
    expect(gaps(st).rows.filter((x) => x.cells.series.startsWith('QT')).length).toBeLessThan(6);
    expect(gaps(st).rows.filter((x) => x.cells.state === 'เลขขาด')).toEqual([]);
  });
  it('monthly -> yearly in one year: the year (it has monthly numbers) keeps the monthly series in its own format', () => {
    const st = buildSeedState();
    const r = updateNumbering(st, me, CO, 'QT', fmt({ scope: 'yearly', format: '{PREFIX}-{YYYY}-{####}' }) as never);
    expect(r.notice?.title).toContain('2027');
    expect(qt(st, '2026-09-10').number).toBe('QT-202609-0001'); // 2026-09 had no numbers, but 2026 is a monthly year
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a number that matches the stored formats of two different keys is malformed, never assigned to a guessed key', () => {
    const st = buildSeedState();
    clearType(st, 'QT');
    st.seriesFormats = { ...st.seriesFormats, 'co-vat|QT|2026': 'QT{YYYY}{####}', 'co-vat|QT|2026-09': 'QT{YYYY}{MM}{####}' };
    expect(parseNumber(st, CO, 'QT', 'QT2026090001')).toBeUndefined();
    expect(parseNumber(st, CO, 'QT', 'QT20260001')).toEqual({ key: 'co-vat|QT|2026', seq: 1 });
  });
  it('allocation refuses a number that would not parse back to its own key (numbering.ambiguous), writing nothing', () => {
    const st = buildSeedState();
    clearType(st, 'QT');
    st.seriesFormats = { 'co-vat|QT|2026': 'QT{YYYY}{####}', 'co-vat|QT|2026-10': 'QT{YYYY}{MM}{####}' };
    st.series['co-vat|QT|2026'] = 100000; // the yearly counter's next number QT2026100001 is also the first of the monthly key 2026-10
    const before = JSON.stringify([st.series, st.seriesFormats]);
    let e: unknown;
    try { allocateNumber(st, CO, 'QT', '2026-09-12'); } catch (x) { e = x; }
    expect(e).toMatchObject({ status: 409, code: 'numbering.ambiguous' });
    expect((e as Error).message).toContain('แก้รูปแบบเลขที่ในหน้าตั้งค่า');
    expect(JSON.stringify([st.series, st.seriesFormats])).toBe(before);
  });
});

describe('ST3 approvals: the policy applying to a document is frozen on it', () => {
  it('a PV submitted over the threshold still needs approval after the threshold is raised; a new PV of the same amount does not', () => {
    const st = buildSeedState();
    const d = pv(st, '60000.00');
    submit(st, d.id, d.version, me);
    updateApprovalRule(st, me, CO, 'PV', { enabled: true, minAmount: '90000.00', version: 1 });
    expect(code(() => issue(st, d.id, get(st, d.id).version, me))).toBe('approval.pending');
    approve(st, d.id, get(st, d.id).version, me);
    issue(st, d.id, get(st, d.id).version, me);
    expect(get(st, d.id).policy?.minAmount).toBe('50000.00');
    expect(checkInvariants(st)).toEqual([]);
    const e = pv(st, '60000.00');
    expect(code(() => issue(st, e.id, e.version, me))).toBeUndefined();
    expect(checkInvariants(st)).toEqual([]);
  });
  it('lowering the threshold or switching approvals off changes no issued document (the invariants judge the frozen policy)', () => {
    const st = buildSeedState();
    const a = pv(st, '10000.00'); issue(st, a.id, a.version, me);
    updateApprovalRule(st, me, CO, 'PV', { enabled: true, minAmount: '1.00', version: 1 });
    expect(checkInvariants(st)).toEqual([]);
    updateApprovalRule(st, me, CO, 'PV', { enabled: false, version: 2 });
    const b = pv(st, '60000.00'); issue(st, b.id, b.version, me);
    updateApprovalRule(st, me, CO, 'PV', { enabled: true, minAmount: '1.00', version: 3 });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('self-approval is frozen at submit: switching it off later does not stop the submitter approving a pending document; a document submitted after does', () => {
    const st = buildSeedState();
    const d = pv(st, '60000.00');
    submit(st, d.id, d.version, me);
    setSelfApproval(st, me, CO, { selfApproval: false, version: 1 });
    expect(code(() => approve(st, d.id, get(st, d.id).version, me))).toBeUndefined();
    const e = pv(st, '60000.00');
    submit(st, e.id, e.version, me);
    expect(code(() => approve(st, e.id, get(st, e.id).version, me))).toBe('approval.self_not_allowed');
  });
  it('a rule change is audited, versioned (409) and refused for an agent', () => {
    const st = buildSeedState();
    updateApprovalRule(st, me, CO, 'PV', { enabled: true, minAmount: '70000.00', version: 1 });
    expect(st.audit.at(-1)?.command).toBe('approval.rule.update');
    expect(code(() => updateApprovalRule(st, me, CO, 'PV', { enabled: true, minAmount: '1.00', version: 1 }))).toBe('record.version_conflict');
    expect(code(() => updateApprovalRule(st, AGENT, CO, 'PV', { enabled: true, minAmount: '1.00', version: 2 }))).toBe('agent.forbidden_setting');
    expect(code(() => updateApprovalRule(st, me, CO, 'PV', { enabled: true, minAmount: '-1', version: 2 }))).toBe('approval.invalid_amount');
  });
});

describe('ST3a M2: re-approval on a revise-up is judged by the stricter of the frozen and the live policy', () => {
  it('a PV issued while approvals were off cannot be raised to 900,000.00 without an approver once they are on again; the same revise with an approver is accepted and invariants hold', () => {
    const st = buildSeedState();
    updateApprovalRule(st, me, CO, 'PV', { enabled: false, version: 1 });
    const d = pv(st, '10000.00'), i = issue(st, d.id, d.version, me);
    updateApprovalRule(st, me, CO, 'PV', { enabled: true, minAmount: '50000.00', version: 2 });
    const raise = (approver?: typeof me) => revise(st, i.id, { header: i.header, lines: [L(i.lines[0].id, '900000.00')] }, get(st, i.id).version, 'raise', me, approver ? { approver } : undefined);
    expect(code(() => raise())).toBe('approval.required_on_revise');
    expect(get(st, i.id).totals.total).toBe('10000.00');
    expect(code(() => raise({ ...me, id: 'u-2', name: 'ผู้อนุมัติ' }))).toBeUndefined();
    expect(get(st, i.id).approval?.approvedBy?.id).toBe('u-2');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('ST3 FN3 M-4: each settlement stores the tolerance in force at its creation', () => {
  it('each settlement is judged against ITS OWN stored tolerance, in creation order (m1)', () => {
    const st = buildSeedState();
    const wo = (amount: string) => ({ kind: 'write_off' as const, date: '2026-10-14', partyId: 'pc-02', targets: [{ docId: 'ti-net', amount }], difference: { role: 'SmallWriteOff' as const, amount } });
    setTolerance(st, me, CO, { rounding: '1.00', smallWriteOff: '200.00', version: 1 });
    postSettlement(st, CO, wo('50.00'), me);
    setTolerance(st, me, CO, { rounding: '1.00', smallWriteOff: '100.00', version: 2 });
    const b = postSettlement(st, CO, wo('50.00'), me); // 50 + 50 = 100, within the 100.00 it was made under
    expect(checkInvariants(st)).toEqual([]);
    const rec = st.settlements.find((x) => x.id === b.id)!;
    rec.difference!.amount = '120.00'; // one fault: B alone now breaks the 100.00 it was made under (50 + 120 = 170 <= the older 200.00)
    expect(checkInvariants(st).some((m) => m.includes('exceed the tolerance 100.00'))).toBe(true);
  });
  it('changing the tolerance leaves existing settlements as they were; new ones follow the new value', () => {
    const st = buildSeedState();
    const wo = (amount: string) => ({ kind: 'write_off' as const, date: '2026-10-14', partyId: 'pc-02', targets: [{ docId: 'ti-net', amount }], difference: { role: 'SmallWriteOff' as const, amount } });
    const s = postSettlement(st, CO, wo('90.00'), me);
    expect(st.settlements.find((x) => x.id === s.id)?.tolerance).toEqual({ rounding: '1.00', smallWriteOff: '100.00' });
    setTolerance(st, me, CO, { rounding: '1.00', smallWriteOff: '10.00', version: 1 });
    expect(checkInvariants(st)).toEqual([]); // 90.00 is above 10.00 now, but the settlement was within the tolerance it was made under
    expect(st.settlements.find((x) => x.id === s.id)?.tolerance?.smallWriteOff).toBe('100.00');
    expect(code(() => postSettlement(st, CO, wo('5.00'), me))).toBe('settle.beyond_tolerance'); // 90 already taken + 5 > 10
    expect(code(() => setTolerance(st, me, CO, { rounding: '-1', smallWriteOff: '10.00', version: 2 }))).toBe('approval.invalid_amount');
    expect(code(() => setTolerance(st, me, CO, { rounding: '1.00', smallWriteOff: '10.00', version: 1 }))).toBe('record.version_conflict');
    expect(code(() => setTolerance(st, AGENT, CO, { rounding: '1.00', smallWriteOff: '10.00', version: 2 }))).toBe('agent.forbidden_setting');
  });
});

describe('ST3a B1: a rate row a live document used is never changed', () => {
  it("the reviewer's SVC scenario: a same-date correction of the row a voucher froze is refused tax.rate_in_use, invariants stay []", () => {
    const st = buildSeedState();
    changeTaxRate(st, me, CO, 'SVC', 500, '2026-10-10');
    const d = pv(st, '10000.00', '2026-10-14', { whtTypeCode: 'SVC' }); issue(st, d.id, d.version, me);
    expect(checkInvariants(st)).toEqual([]);
    expect(code(() => changeTaxRate(st, me, CO, 'SVC', 400, '2026-10-10'))).toBe('tax.rate_in_use');
    expect(st.whtTypes.find((t) => t.companyId === CO && t.code === 'SVC' && t.effectiveFrom === '2026-10-10')?.rateBp).toBe(500);
    expect(checkInvariants(st)).toEqual([]);
    expect(code(() => changeTaxRate(st, me, CO, 'SVC', 400, '2026-10-15'))).toBeUndefined(); // the exit: a new row with a later date
  });
  it('the seed 2020-01-01 row (seven seeded vouchers froze it) cannot be replaced; an unused row still can', () => {
    const st = buildSeedState();
    expect(code(() => changeTaxRate(st, me, CO, 'SVC', 500, '2020-01-01'))).toBe('tax.rate_in_use');
    expect(checkInvariants(st)).toEqual([]);
    changeTaxRate(st, me, CO, 'SVC', 500, '2027-06-01');
    expect(code(() => changeTaxRate(st, me, CO, 'SVC', 600, '2027-06-01'))).toBeUndefined(); // no live document is dated in that row's span
    expect(st.whtTypes.find((t) => t.companyId === CO && t.code === 'SVC' && t.effectiveFrom === '2027-06-01')?.rateBp).toBe(600);
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('ST3 tax: dated WHT rates', () => {
  it("a change dated before the type's first row is refused tax.rate_before_first (an unknown code stays tax.type_not_found)", () => {
    const st = buildSeedState();
    expect(code(() => changeTaxRate(st, me, CO, 'SVC', 500, '2019-01-01'))).toBe('tax.rate_before_first');
    expect(code(() => changeTaxRate(st, me, CO, 'NOPE', 500, '2026-10-14'))).toBe('tax.type_not_found');
  });
  it('a PV dated before a rate change keeps the old rate; the change is a new dated row, never an edit', () => {
    const st = buildSeedState();
    changeTaxRate(st, me, CO, 'SVC', 500, '2026-10-10');
    expect(st.whtTypes.filter((t) => t.companyId === CO && t.code === 'SVC').map((t) => [t.effectiveFrom, t.rateBp])).toEqual([['2020-01-01', 300], ['2026-10-10', 500]]);
    const old = pv(st, '10000.00', '2026-10-05', { whtTypeCode: 'SVC' }), cur = pv(st, '10000.00', '2026-10-14', { whtTypeCode: 'SVC' });
    expect(issue(st, old.id, old.version, me).totals.wht).toBe('300.00');
    expect(issue(st, cur.id, cur.version, me).totals.wht).toBe('500.00');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a deactivated type is not introduced on a new line; a document already carrying it keeps working', () => {
    const st = buildSeedState();
    const carried = pv(st, '10000.00', '2026-10-14', { whtTypeCode: 'SVC' }), draft = pv(st, '10000.00', '2026-10-14', { whtTypeCode: 'SVC' });
    const issued = issue(st, carried.id, carried.version, me);
    setWhtActive(st, me, CO, 'SVC', { active: false, version: 1 });
    expect(st.audit.at(-1)?.command).toBe('tax.wht.active');
    expect(code(() => issue(st, draft.id, draft.version, me))).toBe('wht.type_inactive'); // introduced at issue: the draft never carried it on an issued document
    expect(code(() => revise(st, issued.id, { header: { ...issued.header, notes: 'x' }, lines: issued.lines }, issued.version, 'แก้หมายเหตุ', me))).toBeUndefined(); // the issued document keeps working
    expect(code(() => revise(st, issued.id, { header: issued.header, lines: [...get(st, issued.id).lines, L('new1', '100.00', { whtTypeCode: 'SVC' })] }, get(st, issued.id).version, 'เพิ่มรายการ', me))).toBe('wht.type_inactive'); // a NEW line carrying it is refused
    expect(code(() => setWhtActive(st, me, CO, 'SVC', { active: true, version: 1 }))).toBe('record.version_conflict');
    expect(code(() => setWhtActive(st, AGENT, CO, 'SVC', { active: true, version: 2 }))).toBe('agent.forbidden_setting');
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('ST3 wire', () => {
  beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => testServer.resetHandlers());
  afterAll(() => testServer.close());
  beforeEach(() => { localStorage.clear(); setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' }); resetState(); });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  it('permissions: tax needs tax.settings.manage (accountant yes, operator no); numbering and approvals need settings.manage (admin only)', async () => {
    setSettings({ role: 'accountant' });
    expect((await call('GET', '/settings/tax')).status).toBe(200);
    expect((await call('GET', '/settings/numbering')).status).toBe(403);
    expect((await call('GET', '/settings/approvals')).status).toBe(403);
    setSettings({ role: 'operator' });
    expect((await call('GET', '/settings/tax')).status).toBe(403);
    setSettings({ role: 'admin' });
    expect((await call('GET', '/settings/numbering')).status).toBe(200);
    expect((await call('GET', '/settings/approvals')).status).toBe(200);
    expect((await call('GET', '/settings/tax')).status).toBe(200);
  });
  it('tax: the view carries the sourced VAT status and WHT rows with history; a rate change adds a row; a VAT request stays pending and never flips the company', async () => {
    setSettings({ role: 'accountant' });
    const v = await json(await call('GET', '/settings/tax'));
    expect(v.vat).toMatchObject({ registered: true });
    expect(v.vat.source).toContain('SP-R');
    expect(v.taxCodes.map((c: { code: string }) => c.code)).toEqual(['S7', 'Z0', 'EX']);
    const svc = v.whtTypes.find((t: { code: string }) => t.code === 'SVC');
    expect(svc.rows).toHaveLength(1);
    const r = await call('POST', '/settings/tax/wht-types/SVC/rate', { rateBp: 500, effectiveFrom: '2026-10-01', version: svc.version });
    expect(r.status).toBe(200);
    expect((await json(await call('GET', '/settings/tax'))).whtTypes.find((t: { code: string }) => t.code === 'SVC').rows).toHaveLength(2);
    expect((await call('POST', '/settings/tax/wht-types/SVC/rate', { rateBp: 500, effectiveFrom: '2026-10-01', version: svc.version })).status).toBe(409);
    expect((await json(await call('POST', '/settings/tax/wht-types/SVC/rate', { rateBp: 500, effectiveFrom: '2019-01-01', version: svc.version + 1 }))).code).toBe('tax.rate_before_first');
    const q = await call('POST', '/settings/tax/vat-request', { register: false, effectiveFrom: '2027-01-01' });
    expect(q.status).toBe(201);
    const after = await json(await call('GET', '/settings/tax'));
    expect(after.vat.registered).toBe(true);
    expect(after.vat.requests).toEqual([expect.objectContaining({ status: 'pending', register: false, effectiveFrom: '2027-01-01' })]);
    expect(loadState().companies.find((c) => c.id === 'co-vat')?.vatRegistered).toBe(true);
  });
  it('an agent is refused on every write, a refused write leaves the state untouched, and the other company has its own rules', async () => {
    const before = JSON.stringify(loadState());
    const w: [string, string, unknown][] = [
      ['POST', '/settings/tax/wht-types/SVC/rate', { rateBp: 500, effectiveFrom: '2026-10-01', version: 1 }], ['POST', '/settings/tax/wht-types/SVC/active', { active: false, version: 1 }],
      ['POST', '/settings/tax/vat-request', { register: false, effectiveFrom: '2027-01-01' }], ['PUT', '/settings/numbering/QT', fmt()],
      ['PUT', '/settings/approvals/PV', { enabled: false, version: 1 }], ['PUT', '/settings/approvals/self-approval', { selfApproval: false, version: 1 }],
      ['PUT', '/settings/approvals/tolerance', { rounding: '1.00', smallWriteOff: '1.00', version: 1 }],
    ];
    for (const [m, p, b] of w) { const r = await call(m, p, b, { 'x-teas-actor': 'agent' }); expect([p, r.status, (await json(r)).code]).toEqual([p, 403, 'agent.forbidden_setting']); }
    expect(JSON.stringify(loadState())).toBe(before);
    expect((await call('PUT', '/settings/numbering/ZZ', fmt())).status).toBe(404);
    expect((await json(await call('GET', '/settings/approvals'))).items.map((r: { docType: string }) => r.docType)).toEqual(['EX', 'PV']);
    setSettings({ companyKey: 'nonvat' });
    expect((await json(await call('GET', '/settings/approvals'))).items.every((r: { enabled: boolean }) => !r.enabled)).toBe(true);
  });
  it('numbering: the list shows the next number, a save returns the notice, the preview comes from the server', async () => {
    const l = await json(await call('GET', '/settings/numbering'));
    const q = l.items.find((r: { docType: string }) => r.docType === 'QT');
    expect(q).toMatchObject({ prefix: 'QT', scope: 'monthly', format: '{PREFIX}-{YYYY}{MM}-{####}', version: 1 });
    expect(q.next).toMatch(/^QT-202610-\d{4}$/);
    const p = await json(await call('POST', '/settings/numbering/preview', { docType: 'QT', ...fmt() }));
    expect(p.next).toBe('QT/2611/0001');
    const bad = await call('POST', '/settings/numbering/preview', { docType: 'QT', ...fmt({ format: 'x' }) });
    expect([bad.status, (await json(bad)).code]).toEqual([422, 'numbering.missing_token']);
    const s = await json(await call('PUT', '/settings/numbering/QT', fmt()));
    expect(s.notice.code).toBe('numbering.in_use');
    expect(s.version).toBe(2);
  });
});
