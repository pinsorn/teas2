import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocLine } from '@/domain/types';
import { createDraft, issue, revise } from '../engine/commands';
import { checkInvariants } from '../engine/invariants';
import { ledgerFor } from '../engine/ledger';
import { ROLES, ROLE_FIT, roleProblem } from '../engine/posting';
import { agingReport } from '../engine/reports/ar-aging';
import { assetRegister } from '../engine/reports/asset-register';
import { partyStatement } from '../engine/reports/customer-statement';
import { whtReceivable } from '../engine/reports/wht-receivable';
import { profitLoss } from '../engine/reports/profit-loss';
import { trialBalance } from '../engine/reports/trial-balance';
import { AGENT, USER } from '../fixtures/documents';
import { setSettings } from '../settings';
import { buildSeedState, loadState, resetState } from '../store';
import { testServer } from '../test-server';
import { listCategories, updateCategory } from './expense-categories';
import { CONTROL_ROLES, createPostingRule, deletePostingRule, listPostingRules, previewPosting, ruleId, updatePostingRule } from './posting-rules';

// ST2 rulings 1 / 2 / 3: policy changes never move a posted entry; a rule is saved only when its account fits the role; the preview is the posting itself.
const V = 'co-vat';
const seed = () => buildSeedState('accountant');
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };
let n = 0;
const line = (id: string, p: Partial<DocLine> = {}): DocLine => ({ id, description: `x ${id}`, qty: '1', unit: 'u', unitPrice: '1000.00', taxCode: 'S7', ...p });
const ti = (st: ReturnType<typeof seed>, p: Partial<DocLine> = {}) => {
  const d = createDraft(st, V, 'TI', { header: { partyId: 'pc-01', documentDate: '2026-10-01' }, lines: [line('a', p)] }, USER, `st2-${n++}`);
  return issue(st, d.id, d.version, USER);
};
const journalOf = (st: ReturnType<typeof seed>, id: string) => JSON.stringify(st.journals.find((j) => j.docId === id)!.preview);

describe('ruling 2: a rule is saved only when its account fits the role', () => {
  it('every seeded rule passes the one role -> class table (the table accepts the seed)', () => {
    const st = seed();
    for (const r of st.postingRules) expect(roleProblem(st, r.companyId, r.role, r.accountCode)?.message, `${r.role} ${r.level} ${r.key ?? ''} -> ${r.accountCode}`).toBeUndefined();
    expect(Object.keys(ROLE_FIT).sort()).toEqual([...ROLES].sort());
  });
  it('class mismatch, an account that is a header or closed, and a duplicate are refused; nothing is written or audited', () => {
    const st = seed(), audit = st.audit.length, rules = st.postingRules.length;
    expect(code(() => createPostingRule(st, USER, V, { level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '1130' }))).toBe('posting.class_mismatch'); // Revenue -> a receivable
    expect(code(() => createPostingRule(st, USER, V, { level: 'item', key: 'SV-02', role: 'OutputVat', accountCode: '4200' }))).toBe('posting.class_mismatch'); // OutputVat -> revenue
    expect(code(() => createPostingRule(st, USER, V, { level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '4000' }))).toBe('posting.account_invalid'); // not in the chart
    st.accounts.find((a) => a.companyId === V && a.code === '4200')!.active = false;
    expect(code(() => createPostingRule(st, USER, V, { level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '4200' }))).toBe('posting.account_invalid'); // closed
    st.accounts.find((a) => a.companyId === V && a.code === '4200')!.active = true;
    expect(code(() => createPostingRule(st, USER, V, { level: 'default', role: 'Revenue', accountCode: '4200' }))).toBe('posting.duplicate'); // one rule per (level, key, role)
    expect(code(() => createPostingRule(st, USER, V, { level: 'item', key: 'NOPE', role: 'Revenue', accountCode: '4200' }))).toBe('posting.key_invalid');
    expect([st.audit.length, st.postingRules.length]).toEqual([audit, rules]);
  });
  it('the company default of a role cannot be deleted; a keyed or item rule can; every change is audited with before / after', () => {
    const st = seed();
    expect(code(() => deletePostingRule(st, USER, V, ruleId({ level: 'default', role: 'Revenue' }), 1))).toBe('posting.default_required');
    const made = createPostingRule(st, USER, V, { level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '4200' });
    expect(st.audit.at(-1)).toMatchObject({ command: 'posting.rule.create', before: undefined, after: { accountCode: '4200' } });
    const up = updatePostingRule(st, USER, V, made.id, { accountCode: '4210', version: made.version });
    expect(up.version).toBe(made.version + 1);
    expect(st.audit.at(-1)).toMatchObject({ command: 'posting.rule.update', before: { accountCode: '4200' }, after: { accountCode: '4210' } });
    deletePostingRule(st, USER, V, made.id, up.version);
    expect(st.audit.at(-1)).toMatchObject({ command: 'posting.rule.delete', before: { accountCode: '4210' } });
    expect(listPostingRules(st, V).items.some((r) => r.id === made.id)).toBe(false);
    deletePostingRule(st, USER, V, ruleId({ level: 'default', key: 'loss', role: 'DisposalGainLoss' }), 1); // a keyed default is not "the" default (a FREE role's; a control role's is guarded)
  });
  it('an agent is refused (agent.forbidden_setting) and a stale version is a 409', () => {
    const st = seed(), audit = st.audit.length;
    expect(code(() => createPostingRule(st, AGENT, V, { level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '4200' }))).toBe('agent.forbidden_setting');
    const id = ruleId({ level: 'default', role: 'Revenue' });
    expect(code(() => updatePostingRule(st, AGENT, V, id, { accountCode: '4200', version: 1 }))).toBe('agent.forbidden_setting');
    expect(code(() => deletePostingRule(st, AGENT, V, ruleId({ level: 'default', key: 'PND1', role: 'WhtPayable' }), 1))).toBe('agent.forbidden_setting');
    expect(code(() => updatePostingRule(st, USER, V, id, { accountCode: '4200', version: 7 }))).toBe('record.version_conflict');
    expect(st.audit.length).toBe(audit);
  });
  it('company isolation: another company\'s account is not an account here, and its rules are not listed', () => {
    const st = seed();
    updatePostingRule(st, USER, 'co-nonvat', 'default||Revenue', { accountCode: '4200', version: 1 });
    expect(st.postingRules.find((r) => r.companyId === V && r.role === 'Revenue' && r.level === 'default')!.accountCode).toBe('4100'); // the VAT company untouched
    expect(st.postingRules.find((r) => r.companyId === 'co-nonvat' && r.role === 'Revenue' && r.level === 'default')!.accountCode).toBe('4200');
    expect(st.audit.at(-1)).toMatchObject({ command: 'posting.rule.update', companyId: 'co-nonvat' });
    expect(listPostingRules(st, V).items.find((r) => r.id === 'default||Revenue')!.accountCode).toBe('4100');
    expect(code(() => createPostingRule(st, USER, 'co-nonvat', { level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '4200' }))).toBe('posting.key_invalid'); // SV-02 is the VAT company's item
  });
});

describe('ruling 1: a policy change never moves a posted entry', () => {
  it('issue a TI, re-point Revenue: invariants stay [], the stored journal and every report figure are unchanged; the NEXT TI posts with the new rule', () => {
    const st = seed(), doc = ti(st);
    const before = journalOf(st, doc.id), tb = JSON.stringify(trialBalance(st, V, { asOf: '2026-10-31' })), pl = JSON.stringify(profitLoss(st, V, { from: '2026-01-01', to: '2026-12-31' }));
    // ST2b m6: and the readers that resolve a role LIVE - the AR aging, the customer statement, the asset register, the WHT receivable
    const readers = () => JSON.stringify([agingReport('AR', st, V, { asOf: '2026-10-31' }), partyStatement('AR', st, V, { party: 'pc-01', from: '2026-01-01', to: '2026-12-31' }), assetRegister(st, V, { asOf: '2026-10-31' }), whtReceivable(st, V, { asOf: '2026-10-31' })]);
    const rd = readers();
    expect(ledgerFor(st, { ...doc, companyId: V }).entries[0].lines.some((l) => l.accountCode === '4100')).toBe(true);
    const r = listPostingRules(st, V).items.find((x) => x.id === ruleId({ level: 'default', role: 'Revenue' }))!;
    updatePostingRule(st, USER, V, r.id, { accountCode: '4200', version: r.version });
    expect(checkInvariants(st)).toEqual([]);
    expect(journalOf(st, doc.id)).toBe(before);
    expect(JSON.stringify(trialBalance(st, V, { asOf: '2026-10-31' }))).toBe(tb);
    expect(JSON.stringify(profitLoss(st, V, { from: '2026-01-01', to: '2026-12-31' }))).toBe(pl);
    expect(readers()).toBe(rd);
    const next = ti(st);
    expect(st.journals.find((j) => j.docId === next.id)!.preview.entries[0].lines.map((l) => l.accountCode)).toContain('4200');
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a later revise of an issued bill posts its correction with the NEW rule; the first entry stays where it was', () => {
    const st = seed();
    const d = createDraft(st, V, 'PB', { header: { partyId: 'pv-03', documentDate: '2026-10-01' }, lines: [line('a', { expenseCategory: 'supplies' })] }, USER, 'st2-pb');
    const pb = issue(st, d.id, d.version, USER);
    const first = st.journals.find((j) => j.docId === pb.id)!.preview.entries[0];
    expect(first.lines.map((l) => l.accountCode)).toContain('5160');
    const r = listPostingRules(st, V).items.find((x) => x.id === ruleId({ level: 'category', key: 'supplies', role: 'Expense' }))!;
    updatePostingRule(st, USER, V, r.id, { accountCode: '5130', version: r.version });
    expect(checkInvariants(st)).toEqual([]);
    revise(st, pb.id, { header: pb.header, lines: [line('a', { expenseCategory: 'supplies', unitPrice: '1200.00' })] }, pb.version, 'แก้ราคา', USER);
    const entries = st.journals.find((j) => j.docId === pb.id)!.preview.entries;
    expect(entries[0]).toEqual(first); // the posted entry is untouched
    expect(entries.at(-1)!.lines.map((l) => l.accountCode)).toContain('5130'); // the repost uses the rule in force now
    expect(checkInvariants(st)).toEqual([]);
  });
  it('EVERY role: a re-point either is refused (a control account that holds postings) or leaves invariants [] and the journals unchanged', () => {
    for (const role of ROLES) {
      const st = seed();
      const rule = listPostingRules(st, V).items.find((x) => x.role === role && x.level === 'default' && x.key === undefined);
      if (!rule) continue;
      const to = st.accounts.find((a) => a.companyId === V && a.postable && a.code !== rule.accountCode && !roleProblem(st, V, role, a.code));
      if (!to) continue;
      const journals = JSON.stringify(st.journals);
      let refused: string | undefined;
      try { updatePostingRule(st, USER, V, rule.id, { accountCode: to.code, version: rule.version }); } catch (e) { refused = (e as { message: string }).message.split(':')[0]; }
      if (refused) expect({ role, refused, control: CONTROL_ROLES.has(role) }).toEqual({ role, refused: 'posting.control_in_use', control: true });
      expect({ role, invariants: checkInvariants(st), unchanged: JSON.stringify(st.journals) === journals }).toEqual({ role, invariants: [], unchanged: true });
    }
  }, 120_000); // 34 roles, each on its own seed
});

describe('ST2b ruling 1: a control role is set at the company default only; create and delete are guarded like update', () => {
  const swallow = (f: () => unknown) => { try { f(); } catch { /* refused */ } };
  it('the set is the roles a reader resolves now; the seed has no control rule below the default level', () => {
    expect([...CONTROL_ROLES].sort()).toEqual(['AP', 'AR', 'Cash', 'CustomerDeposit', 'EmployeePayable', 'InputVat', 'InputVatUnclaimed', 'OpeningBalanceEquity', 'OutputVat', 'PayrollDeductionPayable', 'PitPayable',
      'Pnd36VatPayable', 'RetainedEarnings', 'SalaryPayable', 'SsoPayable', 'VatCarryForward', 'VatPayable', 'VendorPrepayment', 'WhtPayable', 'WhtReceivable'].sort());
    expect(seed().postingRules.filter((r) => CONTROL_ROLES.has(r.role) && r.level !== 'default')).toEqual([]);
  });
  it('create at docType / partyGroup / category / item for a control role: posting.control_level; nothing written (probes P3 P4 P6 Q2)', () => {
    const st = seed(), audit = st.audit.length, rules = st.postingRules.length;
    for (const [level, key, role, accountCode] of [['docType', 'TI', 'AR', '1150'], ['docType', 'JV', 'AR', '1150'], ['docType', 'JV', 'AR', '1140'], ['docType', 'PV', 'WhtPayable', '2131'], ['partyGroup', 'government', 'AR', '1150'], ['item', 'SV-02', 'OutputVat', '2110']])
      expect(code(() => createPostingRule(st, USER, V, { level, key, role, accountCode })), `${level} ${key} ${role}`).toMatch(/^posting\.(control_level|class_mismatch|control_account)$/);
    expect(code(() => createPostingRule(st, USER, V, { level: 'docType', key: 'JV', role: 'AR', accountCode: '1130' }))).toBe('posting.control_level');
    expect(code(() => createPostingRule(st, USER, V, { level: 'docType', key: 'PV', role: 'WhtPayable', accountCode: '2131' }))).toBe('posting.control_level');
    expect([st.audit.length, st.postingRules.length]).toEqual([audit, rules]);
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a new KEYED default for a control role is refused while the account it takes over (the keyless fall-through) or the new account holds postings', () => {
    const st = seed();
    const form = ['PND1', 'PND2', 'PND3', 'PND54'].find((k) => !st.postingRules.some((r) => r.companyId === V && r.role === 'WhtPayable' && r.key === k))!;
    expect(form, 'a WHT form without its own rule').toBeTruthy();
    const used = new Set(st.journals.flatMap((j) => j.preview.entries.flatMap((e) => e.lines.map((l) => l.accountCode))));
    const free = st.accounts.find((a) => a.companyId === V && a.postable && !a.controlRole && !used.has(a.code) && !roleProblem(st, V, 'WhtPayable', a.code))!;
    expect(free, 'an unused liability account').toBeTruthy();
    expect(code(() => createPostingRule(st, USER, V, { level: 'default', key: form, role: 'WhtPayable', accountCode: free.code }))).toBe('posting.control_in_use'); // the fall-through account 2131 carries postings
    expect(code(() => createPostingRule(st, USER, V, { level: 'default', key: form, role: 'WhtPayable', accountCode: '2133' }))).toBe('posting.control_in_use'); // the new account carries postings
    expect(checkInvariants(st)).toEqual([]);
    st.journals = []; // a company with no postings yet: the keyed default is free to be set
    expect(createPostingRule(st, USER, V, { level: 'default', key: form, role: 'WhtPayable', accountCode: free.code }).accountCode).toBe(free.code);
  });
  it('delete of a keyed control default is refused while its account holds postings (probe P5); the keyless default stays undeletable', () => {
    const st = seed();
    const rules = st.postingRules.length;
    expect(code(() => deletePostingRule(st, USER, V, ruleId({ level: 'default', key: 'PND53', role: 'WhtPayable' }), 1))).toBe('posting.control_in_use');
    expect(st.postingRules.length).toBe(rules);
    expect(checkInvariants(st)).toEqual([]);
    expect(code(() => deletePostingRule(st, USER, V, ruleId({ level: 'default', role: 'AR' }), 1))).toBe('posting.default_required');
  });
  it('every attempted create of a control role at any non-default level leaves invariants []', () => {
    const st = seed();
    for (const role of CONTROL_ROLES) for (const level of ['docType', 'partyGroup', 'category', 'item'] as const)
      swallow(() => createPostingRule(st, USER, V, { level, key: level === 'docType' ? 'JV' : level === 'partyGroup' ? 'government' : level === 'item' ? 'SV-02' : 'supplies', role, accountCode: '1150' }));
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('ST2b ruling 2: a control account stands behind its own role only', () => {
  it('Expense -> 1140, Cash -> 1130, OutputVat -> 2110 are refused (probes R1 P9 R2); the role itself still takes its account', () => {
    const st = seed();
    expect(code(() => createPostingRule(st, USER, V, { level: 'category', key: 'supplies', role: 'Expense', accountCode: '1140' }))).toBe('posting.control_account');
    expect(roleProblem(st, V, 'Expense', '1140')?.message).toMatch(/^posting\.control_account/);
    expect(roleProblem(st, V, 'Cash', '1130')?.message).toMatch(/^posting\.control_account/);
    expect(roleProblem(st, V, 'OutputVat', '2110')?.message).toMatch(/^posting\.control_account/);
    expect(roleProblem(st, V, 'AR', '1130')).toBeUndefined();
    const r = listPostingRules(st, V).items.find((x) => x.id === ruleId({ level: 'category', key: 'supplies', role: 'Expense' }))!;
    expect(code(() => updatePostingRule(st, USER, V, r.id, { accountCode: '1140', version: r.version }))).toBe('posting.control_account');
    expect(listPostingRules(st, V).roles.find((x) => x.role === 'Expense')!.accountCodes).not.toContain('1140'); // the form never offers it
  });
});

describe('ST2b ruling 7: a category\'s own Expense rule is edited through the category', () => {
  it('deleting category|X|Expense is refused posting.category_rule', () => {
    const st = seed();
    expect(code(() => deletePostingRule(st, USER, V, ruleId({ level: 'category', key: 'supplies', role: 'Expense' }), 1))).toBe('posting.category_rule');
    expect(st.postingRules.some((r) => r.level === 'category' && r.key === 'supplies' && r.role === 'Expense')).toBe(true);
  });
});

describe('ST2b ruling 3: no reader re-derives a posted account from today\'s rules', () => {
  const rule = (st: ReturnType<typeof seed>, level: string, key: string, role: string) => listPostingRules(st, V).items.find((x) => x.id === ruleId({ level: level as 'category', key, role }))!;
  it('amortisation source: re-pointing the Expense rule of a prepaid category, editing its account, or switching it to capex leaves invariants [] (probes P1 P2 R3)', () => {
    let st = seed();
    expect(checkInvariants(st)).toEqual([]);
    const r = rule(st, 'category', 'prepaid', 'Expense');
    updatePostingRule(st, USER, V, r.id, { accountCode: '5100', version: r.version });
    expect(checkInvariants(st)).toEqual([]);
    st = seed();
    const c = listCategories(st, V).find((x) => x.code === 'prepaid')!;
    updateCategory(st, USER, V, 'prepaid', { ...c, accountCode: '5100' });
    expect(checkInvariants(st)).toEqual([]);
    st = seed();
    const c2 = listCategories(st, V).find((x) => x.code === 'prepaid')!;
    updateCategory(st, USER, V, 'prepaid', { ...c2, capex: true, assetClass: 'equipment' });
    expect(checkInvariants(st)).toEqual([]);
  });
  it('asset register: an unregistered capex bill keeps its cost on the account it posted when the FixedAsset rule of its class moves (tie-outs 0)', () => {
    const st = seed();
    const d = createDraft(st, V, 'PB', { header: { partyId: 'pv-03', documentDate: '2026-10-01' }, lines: [line('a', { expenseCategory: 'capex-equipment', unitPrice: '12345.00' })] }, USER, 'st2b-capex');
    issue(st, d.id, d.version, USER);
    const ties = () => assetRegister(st, V, { asOf: '2026-10-31' }).tieOuts!.map((t) => t.diff);
    expect(ties().every((x) => Number(x) === 0)).toBe(true);
    const before = JSON.stringify(assetRegister(st, V, { asOf: '2026-10-31' }));
    const r = rule(st, 'category', 'equipment', 'FixedAsset');
    updatePostingRule(st, USER, V, r.id, { accountCode: '1220', version: r.version });
    expect(checkInvariants(st)).toEqual([]);
    expect(JSON.stringify(assetRegister(st, V, { asOf: '2026-10-31' }))).toBe(before);
    expect(ties().every((x) => Number(x) === 0)).toBe(true);
  });
});

describe('ruling 3: the preview is the posting - one resolver, the winning level per role', () => {
  it('SV-02 -> 4200 at the item level wins over the company default, and a real TI posts the same lines', () => {
    const st = seed();
    const plain = previewPosting(st, V, { docType: 'TI', itemId: 'SV-02' });
    expect(plain.winners.find((w) => w.role === 'Revenue')).toMatchObject({ accountCode: '4100', rule: 'ค่าเริ่มต้นบริษัท: Revenue → 4100' });
    createPostingRule(st, USER, V, { level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '4200' });
    const p = previewPosting(st, V, { docType: 'TI', itemId: 'SV-02' });
    expect(p.winners.find((w) => w.role === 'Revenue')).toMatchObject({ accountCode: '4200', rule: expect.stringMatching(/^สินค้า\/บริการ SV-02: Revenue → 4200/) });
    expect(p.winners.find((w) => w.role === 'AR')!.rule).toMatch(/^ค่าเริ่มต้นบริษัท/);
    expect(p.winners.find((w) => w.role === 'Revenue')).toMatchObject({ level: 'item', key: 'SV-02' }); // ST2b m2: the level / key come from the resolver, not from the Thai text
    expect(p.winners.find((w) => w.role === 'AR')).toMatchObject({ level: 'default' });
    expect(p.winners.find((w) => w.role === 'AR')).not.toHaveProperty('key');
    const real = ti(st, { itemId: 'SV-02', unitPrice: '100.00' });
    const posted = st.journals.find((j) => j.docId === real.id)!.preview.entries[0].lines;
    expect(p.journal.entries[0].lines.map((l) => [l.accountCode, l.rule])).toEqual(posted.map((l) => [l.accountCode, l.rule]));
    expect(previewPosting(st, V, { docType: 'TI', itemId: 'SV-01' }).winners.find((w) => w.role === 'Revenue')!.accountCode).toBe('4100'); // a rule applies to its own key only
  });
  it('a party-group rule applies to that group\'s documents (the group reaches the resolver), and the preview writes nothing', () => {
    const st = seed(), audit = st.audit.length, docs = st.docs.length;
    const party = st.parties.find((p) => p.companyId === V && p.kind === 'customer' && p.partyGroup === 'government') ?? st.parties.find((p) => p.companyId === V && p.kind === 'customer')!;
    createPostingRule(st, USER, V, { level: 'partyGroup', key: party.partyGroup!, role: 'Revenue', accountCode: '4210' });
    const p = previewPosting(st, V, { docType: 'TI', partyId: party.id });
    expect(p.winners.find((w) => w.role === 'Revenue')!.accountCode).toBe('4210');
    expect([st.audit.length, st.docs.length]).toEqual([audit + 1, docs]); // only the rule's own audit row
  });
});

// ---------------------------------------------------------------- the wire: permissions, agent refusal before the body, persistence, company isolation
describe('wire', () => {
  beforeAll(() => testServer.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => testServer.resetHandlers());
  afterAll(() => testServer.close());
  beforeEach(() => { localStorage.clear(); resetState(); setSettings({ companyKey: 'vat', role: 'accountant', screenState: 'normal' }); });
  const call = (method: string, path: string, body?: unknown, agent = false) =>
    fetch(`http://localhost/bff/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(agent ? { 'x-teas-actor': 'agent' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

  it('the accountant manages rules and categories; the operator and the admin are forbidden; the dimensions and categories are READABLE by anyone', async () => {
    expect((await call('GET', '/settings/posting/rules')).status).toBe(200);
    expect((await call('POST', '/settings/posting/preview', { docType: 'TI', itemId: 'SV-02' })).status).toBe(200);
    setSettings({ companyKey: 'vat', role: 'operator', screenState: 'normal' });
    expect((await call('GET', '/settings/posting/rules')).status).toBe(403);
    expect((await call('POST', '/settings/expense-categories', { code: 'zz', nameTh: 'x', accountCode: '5140', recoverableVat: true })).status).toBe(403);
    expect((await call('GET', '/settings/expense-categories')).status).toBe(200);
    expect((await call('GET', '/settings/dimensions')).status).toBe(200);
    expect((await call('PUT', '/settings/dimensions/account-rules/4100', { rules: {}, version: 1 })).status).toBe(403);
    setSettings({ companyKey: 'vat', role: 'admin', screenState: 'normal' });
    expect((await call('GET', '/settings/posting/rules')).status).toBe(403);
  });
  it('a rule is created and survives a reload; a class mismatch is a 422 with its code; an agent is 403 before the body; a stale version is 409', async () => {
    const r = await call('POST', '/settings/posting/rules', { level: 'item', key: 'SV-02', role: 'Revenue', accountCode: '4200' });
    expect(r.status).toBe(201);
    const made = (await json(r)) as { id: string; version: number };
    expect(((await json(await call('GET', '/settings/posting/rules'))).items as { id: string }[]).some((x) => x.id === made.id)).toBe(true);
    const bad = await call('POST', '/settings/posting/rules', { level: 'item', key: 'SV-01', role: 'Revenue', accountCode: '1130' });
    expect([bad.status, (await json(bad)).code]).toEqual([422, 'posting.class_mismatch']);
    const before = JSON.stringify(loadState());
    for (const [m, p, b] of [['POST', '/settings/posting/rules', { nonsense: 1 }], ['PUT', `/settings/posting/rules/${encodeURIComponent(made.id)}`, 'garbage'], ['DELETE', `/settings/posting/rules/${encodeURIComponent(made.id)}?version=1`, undefined],
      ['POST', '/settings/expense-categories', {}]] as const) {
      const a = await call(m, p, b, true);
      expect([m, p, a.status, (await json(a)).code]).toEqual([m, p, 403, 'agent.forbidden_setting']);
    }
    expect(JSON.stringify(loadState())).toBe(before);
    const stale = await call('PUT', `/settings/posting/rules/${encodeURIComponent(made.id)}`, { accountCode: '4210', version: 99 });
    expect([stale.status, (await json(stale)).code]).toEqual([409, 'record.version_conflict']);
    const del = await call('DELETE', `/settings/posting/rules/${encodeURIComponent('default||Revenue')}?version=1`);
    expect([del.status, (await json(del)).code]).toEqual([409, 'posting.default_required']);
  });
  it('the other company is its own: its categories are listed separately', async () => {
    await call('POST', '/settings/expense-categories', { code: 'only-vat', nameTh: 'เฉพาะ VAT', accountCode: '5140', recoverableVat: true });
    expect(((await json(await call('GET', '/settings/expense-categories'))).items as { code: string }[]).some((c) => c.code === 'only-vat')).toBe(true);
    setSettings({ companyKey: 'nonvat', role: 'accountant', screenState: 'normal' });
    expect(((await json(await call('GET', '/settings/expense-categories'))).items as { code: string }[]).some((c) => c.code === 'only-vat')).toBe(false);
  });
});
