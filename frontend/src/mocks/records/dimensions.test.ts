import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { compute, createDraft, issue, revise } from '../engine/commands';
import { buildPlan } from '../engine/corrections';
import { checkInvariants } from '../engine/invariants';
import { AGENT, USER } from '../fixtures/documents';
import { setSettings } from '../settings';
import { buildSeedState, loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { createDimensionType, createDimensionValue, deleteDimensionType, deleteDimensionValue, dimensionsView, listAccountRules, setAccountRules, updateDimensionValue } from './dimensions';

// ST2 ruling 4 (types / values / in use / the tag invariant) and ruling 5 (account rules: required / forbidden at issue, revise and the plan; never retroactive).
const V = 'co-vat';
const seed = () => buildSeedState('accountant');
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };
const msg = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message; } return ''; };
let n = 0;
const line = (id: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `x ${id}`, qty: '1', unit: 'u', unitPrice: '1000.00', taxCode: 'S7', ...p });
const draft = (st: ReturnType<typeof seed>, dims?: Record<string, string>, lp: Partial<DocLine> = {}) =>
  createDraft(st, V, 'TI', { header: { partyId: 'pc-01', documentDate: '2026-10-01', ...(dims ? { dimensions: dims } : {}) }, lines: [line('a', lp)] }, USER, `d-${n++}`);
const tiIssued = (st: ReturnType<typeof seed>, dims?: Record<string, string>, lp: Partial<DocLine> = {}) => { const d = draft(st, dims, lp); return issue(st, d.id, d.version, USER); };
const rule = (st: ReturnType<typeof seed>, account: string, rules: Record<string, 'required' | 'forbidden' | 'optional'>) => {
  const a = listAccountRules(st, V).find((x) => x.code === account)!;
  return setAccountRules(st, USER, V, account, { rules, version: a.version });
};
const dimsOn = (st: ReturnType<typeof seed>, id: string, account: string) => st.journals.find((j) => j.docId === id)!.preview.entries[0].lines.find((l) => l.accountCode === account)!.dimensions;

describe('ruling 4: types and values', () => {
  it('the seed has แผนก (ออกแบบ, การตลาด, บริหาร) and โปรเจกต์ (P-A, P-B), RP1\'s tags stay valid, invariants []', () => {
    const st = seed(), v = dimensionsView(st, V);
    expect(v.maxTypes).toBe(4);
    expect(v.types.map((t) => [t.key, t.nameTh])).toEqual([['department', 'แผนก'], ['project', 'โปรเจกต์']]);
    expect(v.types[0].values.map((x) => x.nameTh)).toEqual(['ออกแบบ', 'การตลาด', 'บริหาร']);
    expect(v.types[1].values.map((x) => [x.code, x.nameTh])).toEqual([['P-A', 'เว็บไซต์ลูกค้า A'], ['P-B', 'งานบรรจุภัณฑ์ B']]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('at most four types: the fifth is refused (dimension.max_types); a duplicate key too; audited', () => {
    const st = seed();
    createDimensionType(st, USER, V, { key: 'region', nameTh: 'ภูมิภาค' });
    createDimensionType(st, USER, V, { key: 'channel', nameTh: 'ช่องทาง' });
    expect(st.audit.at(-1)).toMatchObject({ command: 'dimension.type.create', after: { key: 'channel' } });
    const audit = st.audit.length;
    expect(code(() => createDimensionType(st, USER, V, { key: 'fifth', nameTh: 'อื่น' }))).toBe('dimension.max_types');
    expect(code(() => createDimensionType(st, USER, V, { key: 'project', nameTh: 'ซ้ำ' }))).toBe('dimension.duplicate');
    expect(st.audit.length).toBe(audit);
    expect(dimensionsView(st, 'co-nonvat').types).toHaveLength(2); // another company is its own
  });
  it('a value or type in use (a document, a line or a posted line) cannot be deleted - deactivate instead (dimension.in_use); an unused one can', () => {
    const st = seed();
    expect(code(() => deleteDimensionValue(st, USER, 'co-nonvat', 'project', 'P-A', 1))).toBe('dimension.in_use'); // iv-p1 / iv-s1 carry it
    expect(code(() => deleteDimensionType(st, USER, 'co-nonvat', 'project', 1))).toBe('dimension.in_use');
    const used = tiIssued(st, undefined, { dimensions: { department: 'D-02' } }); // a LINE tag counts too
    expect(code(() => deleteDimensionValue(st, USER, V, 'department', 'D-02', 1))).toBe('dimension.in_use');
    expect(used.id).toBeTruthy();
    createDimensionValue(st, USER, V, 'department', { code: 'D-09', nameTh: 'ชั่วคราว' });
    deleteDimensionValue(st, USER, V, 'department', 'D-09', 1);
    expect(st.audit.at(-1)).toMatchObject({ command: 'dimension.value.delete', before: { code: 'D-09' } });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a deactivated value is not accepted on a new document but the old ones keep it and the books stay clean', () => {
    const st = seed();
    const old = tiIssued(st, { project: 'P-A' });
    updateDimensionValue(st, USER, V, 'project', 'P-A', { active: false, version: 1 });
    expect(msg(() => tiIssued(st, { project: 'P-A' }))).toMatch(/doc.incomplete.*P-A.*ปิดใช้งาน/);
    expect(dimsOn(st, old.id, '4100')).toEqual({ project: 'P-A' });
    expect(dimensionsView(st, V).types[1].values[0]).toMatchObject({ code: 'P-A', active: false, inUse: true });
    tiIssued(st, { project: 'P-B' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('an unknown type or value is refused at issue', () => {
    const st = seed();
    expect(msg(() => tiIssued(st, { project: 'P-Z' }))).toMatch(/doc.incomplete.*P-Z/);
    expect(msg(() => tiIssued(st, { colour: 'red' }))).toMatch(/doc.incomplete.*colour/);
  });
  it('INVARIANT: a tag naming a type or value the company does not have is reported (single fault, single message)', () => {
    const st = seed();
    const d = tiIssued(st, { project: 'P-A' });
    const l = st.journals.find((j) => j.docId === d.id)!.preview.entries[0].lines.find((x) => x.accountCode === '4100')!;
    l.dimensions = { project: 'P-ZZ' };
    expect(checkInvariants(st)).toEqual([expect.stringContaining('carries dimension project = P-ZZ')]);
    l.dimensions = { nope: 'P-A' };
    expect(checkInvariants(st)).toEqual([expect.stringContaining('carries dimension nope = P-A')]);
    l.dimensions = { project: 'P-B' }; // another value of the same type is a fine tag
    expect(checkInvariants(st)).toEqual([]);
  });
  it('agent refused, stale version 409, and a bad key is a field error', () => {
    const st = seed(), audit = st.audit.length;
    expect(code(() => createDimensionType(st, AGENT, V, { key: 'region', nameTh: 'ภูมิภาค' }))).toBe('agent.forbidden_setting');
    expect(code(() => setAccountRules(st, AGENT, V, '4100', { rules: {}, version: 1 }))).toBe('agent.forbidden_setting');
    expect(code(() => updateDimensionValue(st, USER, V, 'project', 'P-A', { active: false, version: 9 }))).toBe('record.version_conflict');
    expect(code(() => createDimensionType(st, USER, V, { key: 'Bad Key', nameTh: 'x' }))).toBe('record.invalid');
    expect(st.audit.length).toBe(audit);
  });
});

describe('ruling 5: account rules', () => {
  it('only a postable account with a known type takes a rule; optional clears it; audited with before / after', () => {
    const st = seed();
    expect(code(() => setAccountRules(st, USER, V, '4000', { rules: { department: 'required' }, version: 1 }))).toBe('dimension.rule_invalid'); // not an account
    expect(code(() => rule(st, '4100', { nope: 'required' }))).toBe('dimension.rule_invalid');
    expect(code(() => rule(st, '4100', { department: 'sometimes' as 'required' }))).toBe('dimension.rule_invalid');
    rule(st, '4100', { department: 'required' });
    expect(st.audit.at(-1)).toMatchObject({ command: 'dimension.rules.update', target: '4100', before: {}, after: { department: 'required' } });
    expect(listAccountRules(st, V).find((a) => a.code === '4100')!.rules).toEqual({ department: 'required' });
    rule(st, '4100', { department: 'optional' });
    expect(listAccountRules(st, V).find((a) => a.code === '4100')!.rules).toEqual({});
  });
  it('REQUIRED blocks the issue with the message and the exit; the header value satisfies it; a line value overrides the header; the editor sees it in "missing" first', () => {
    const st = seed();
    rule(st, '4100', { department: 'required' });
    const d = draft(st);
    const m = compute(st, V, 'TI', { header: d.header, lines: d.lines }, { docId: d.id }).missing.map((x) => x.message).join(';');
    expect(m).toContain('บัญชี 4100 ต้องระบุแผนก');
    expect(m).toContain('ระบุมิติที่หัวเอกสาร');
    const audit = st.audit.length, journals = st.journals.length;
    expect(msg(() => issue(st, d.id, d.version, USER))).toMatch(/doc\.incomplete: .*บัญชี 4100 ต้องระบุแผนก.*ระบุมิติที่หัวเอกสาร/);
    expect([st.audit.length, st.journals.length, st.docs.find((x) => x.id === d.id)!.status]).toEqual([audit, journals, 'draft']); // nothing written
    const ok = tiIssued(st, { department: 'D-01' });
    expect(dimsOn(st, ok.id, '4100')).toEqual({ department: 'D-01' });
    const over = tiIssued(st, { department: 'D-01' }, { dimensions: { department: 'D-02' } });
    expect(dimsOn(st, over.id, '4100')).toEqual({ department: 'D-02' }); // the line wins over the header default
    expect(checkInvariants(st)).toEqual([]);
  });
  it('FORBIDDEN blocks a document that tags the account', () => {
    const st = seed();
    rule(st, '4100', { project: 'forbidden' });
    expect(msg(() => tiIssued(st, { project: 'P-A' }))).toMatch(/doc\.incomplete: บัญชี 4100 ห้ามระบุโปรเจกต์/);
    tiIssued(st, { department: 'D-01' });
  });
  it('NOT retroactive: a rule made required later leaves issued documents valid (invariants []), and an unrelated revise of one is not blocked', () => {
    const st = seed();
    const d = createDraft(st, V, 'PB', { header: { partyId: 'pv-03', documentDate: '2026-10-01' }, lines: [line('a', { expenseCategory: 'supplies' })] }, USER, 'pb-old');
    const pb = issue(st, d.id, d.version, USER);
    rule(st, '5160', { department: 'required' });
    rule(st, '4100', { department: 'required' });
    expect(checkInvariants(st)).toEqual([]);
    revise(st, pb.id, { header: { ...pb.header, notes: 'หมายเหตุใหม่' }, lines: pb.lines }, pb.version, 'แก้หมายเหตุ', USER); // the old fault is not introduced by this revise
    expect(checkInvariants(st)).toEqual([]);
  });
  it('REVISE refuses a change that INTRODUCES a fault (a tag removed from a required account)', () => {
    const st = seed();
    rule(st, '5160', { department: 'required' });
    const d = createDraft(st, V, 'PB', { header: { partyId: 'pv-03', documentDate: '2026-10-01', dimensions: { department: 'D-01' } }, lines: [line('a', { expenseCategory: 'supplies' })] }, USER, 'pb-new');
    const pb = issue(st, d.id, d.version, USER);
    const jn = JSON.stringify(st.journals.find((j) => j.docId === pb.id));
    expect(msg(() => revise(st, pb.id, { header: { ...pb.header, dimensions: {} }, lines: pb.lines }, pb.version, 'เอามิติออก', USER))).toMatch(/doc\.incomplete: บัญชี 5160 ต้องระบุแผนก/);
    expect(JSON.stringify(st.journals.find((j) => j.docId === pb.id))).toBe(jn);
    revise(st, pb.id, { header: { ...pb.header, dimensions: { department: 'D-03' } }, lines: pb.lines }, pb.version, 'เปลี่ยนแผนก', USER);
    expect(st.journals.find((j) => j.docId === pb.id)!.preview.entries.at(-1)!.lines.find((l) => l.accountCode === '5160')!.dimensions).toEqual({ department: 'D-03' }); // the repost carries the new tag
  });
  it('the CORRECTION PLAN is refused before it is shown when it introduces the fault; a plan that keeps the tag is shown', () => {
    const st = seed();
    const ti = tiIssued(st, { department: 'D-01' });
    rule(st, '4100', { department: 'required' });
    const body = { header: ti.header, lines: ti.lines };
    expect(msg(() => buildPlan(st, ti.id, { header: { ...ti.header, dimensions: {} }, lines: ti.lines }, 'accountant'))).toMatch(/doc\.incomplete: บัญชี 4100 ต้องระบุแผนก/);
    expect(buildPlan(st, ti.id, { ...body, lines: [{ ...ti.lines[0], unitPrice: '1200.00' }] }, 'accountant').steps.length).toBeGreaterThan(0);
  });
});

describe('wire', () => {
  beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => testServer.resetHandlers());
  afterAll(() => testServer.close());
  beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' }); });
  const call = (method: string, path: string, body?: unknown, agent = false) =>
    fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(agent ? { 'x-teas-actor': 'agent' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

  it('the admin edits the dimensions and the account rules, the accountant and operator only READ the dimensions, an agent is 403 before the body, nothing changes on a refusal', async () => {
    const made = await call('POST', '/settings/dimensions/department/values', { code: 'D-04', nameTh: 'บัญชี' });
    expect(made.status).toBe(201);
    expect((await call('PUT', '/settings/dimensions/account-rules/4100', { rules: { department: 'required' }, version: 1 })).status).toBe(200);
    expect(((await json(await call('GET', '/settings/dimensions/account-rules'))).items as { code: string; rules: object }[]).find((a) => a.code === '4100')!.rules).toEqual({ department: 'required' });
    const before = JSON.stringify(loadState());
    for (const [m, p, b] of [['POST', '/settings/dimensions', { nonsense: 1 }], ['PUT', '/settings/dimensions/department', 'garbage'], ['DELETE', '/settings/dimensions/department/values/D-04?version=1', undefined],
      ['PUT', '/settings/dimensions/account-rules/4100', {}], ['POST', '/settings/dimensions/department/values', {}]] as const) {
      const a = await call(m, p, b, true);
      expect([m, p, a.status, (await json(a)).code]).toEqual([m, p, 403, 'agent.forbidden_setting']);
    }
    expect(JSON.stringify(loadState())).toBe(before);
    const used = await call('DELETE', '/settings/dimensions/project/values/P-A?version=1'); // company: VAT; P-A is on a non-VAT invoice only, so it is free here
    expect(used.status).toBe(200);
    setSettings({ companyKey: 'nonvat', role: 'admin', screenState: 'normal' });
    const busy = await call('DELETE', '/settings/dimensions/project/values/P-A?version=1');
    expect([busy.status, (await json(busy)).code]).toEqual([409, 'dimension.in_use']);
    setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' });
    expect((await call('GET', '/settings/dimensions')).status).toBe(200);
    expect((await call('POST', '/settings/dimensions', { key: 'region', nameTh: 'ภูมิภาค' })).status).toBe(403);
    expect((await call('GET', '/settings/dimensions/account-rules')).status).toBe(403);
  });
});
