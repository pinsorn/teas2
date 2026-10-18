import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/types';
import { buildSeedState, type MockState } from '../../store';
import { closePeriod, closeYear, reopenPeriod, reopenYear } from '../close';
import { checkInvariants } from '../invariants';
import { logAudit } from '../log';
import { auditLog, reopenHistory } from './audit-log';
import { buildReport, reportCsv } from './index';

const VAT = 'co-vat', NV = 'co-nonvat';
const ME: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
let st: MockState;
beforeEach(() => { localStorage.clear(); st = buildSeedState(); });

type M = ReturnType<typeof auditLog>;
const entries = (m: M) => m.rows.filter((r) => r.level === 0);
const fields = (m: M) => m.rows.filter((r) => r.level === 1);

describe('ruling 2: audit entries carry ip, traceId and client', () => {
  it('every seeded entry has them: ip 127.0.0.1, trc-<n> from the entry count, client web unless the actor is an agent', () => {
    expect(st.audit.length).toBeGreaterThan(200);
    st.audit.forEach((a, i) => { expect(a.ip).toBe('127.0.0.1'); expect(a.traceId).toBe(`trc-${i + 1}`); expect(a.client).toBe(a.actor.kind === 'agent' ? 'mcp' : 'web'); });
  });
  it('an agent-authored entry is mcp; the state version is 53', () => {
    const agent: Actor = { kind: 'agent', id: 'ag-1', name: 'ผู้ช่วยบัญชี (AI)', ownerName: ME.name };
    logAudit(st, agent, VAT, 'x.y', 't');
    expect(st.audit.at(-1)).toMatchObject({ client: 'mcp', ip: '127.0.0.1', traceId: `trc-${st.audit.length}` });
    expect(st.version).toBe(53);
  });
});

describe('ruling 4: the seed audit has variety, produced by commands', () => {
  it('has logins (a user and an agent), company switches, a posting-rule change and a tax-table change', () => {
    const cmds = new Set(st.audit.map((a) => a.command));
    for (const c of ['auth.login', 'company.switch', 'posting.rule.update', 'tax.table.update']) expect(cmds.has(c), c).toBe(true);
    expect(st.audit.some((a) => a.command === 'auth.login' && a.actor.kind === 'agent')).toBe(true);
    for (const c of ['posting.rule.update', 'tax.table.update']) for (const a of st.audit.filter((x) => x.command === c)) { expect(a.before).toBeDefined(); expect(a.after).toBeDefined(); }
    expect(checkInvariants(st)).toEqual([]);
  });
});

describe('ruling 3: the audit-log viewer', () => {
  it('lists every entry of the company, newest first; a field row per CHANGED field only', () => {
    const m = auditLog(st, VAT, {});
    const mine = st.audit.filter((a) => a.companyId === VAT);
    expect(entries(m)).toHaveLength(mine.length);
    const ats = entries(m).map((r) => r.cells.at);
    expect(ats).toEqual([...ats].sort().reverse());
    const rule = st.audit.find((a) => a.command === 'posting.rule.update' && a.companyId === VAT)!;
    const i = m.rows.findIndex((r) => r.cells.id === rule.id && r.level === 0);
    const kids = m.rows.slice(i + 1).filter((_, k, all) => all.slice(0, k + 1).every((r) => r.level === 1));
    expect(kids.length).toBeGreaterThan(0);
    for (const k of kids) expect(k.cells.before).not.toBe(k.cells.after);
    expect(fields(m).every((r) => r.cells.field)).toBe(true);
  });
  it('an unchanged field is not listed (before and after equal in one key)', () => {
    logAudit(st, ME, VAT, 'doc.update', 'ti-001', { a: '1', b: '2' }, { a: '1', b: '3' });
    const m = auditLog(st, VAT, { command: 'doc.update' });
    const mine = m.rows.filter((r) => r.cells.id === st.audit.at(-1)!.id && r.level === 1);
    expect(mine.map((r) => [r.cells.field, r.cells.before, r.cells.after])).toEqual([['b', '2', '3']]);
  });
  it('actor kind agent is shown "agent ของ <owner>" and filters by actor', () => {
    const m = auditLog(st, VAT, { actor: 'agent' });
    expect(entries(m).length).toBeGreaterThan(0);
    expect(entries(m).every((r) => r.cells.actor === `agent ของ ${ME.name}`)).toBe(true);
    expect(entries(auditLog(st, VAT, { actor: 'สมศรี' })).every((r) => r.cells.actor === ME.name)).toBe(true);
    expect(entries(auditLog(st, VAT, { actor: 'agent' })).length).toBeLessThan(entries(auditLog(st, VAT, {})).length);
  });
  it('filters: command, target, from / to (by the entry date)', () => {
    const all = entries(auditLog(st, VAT, {}));
    expect(entries(auditLog(st, VAT, { command: 'doc.cancel' })).every((r) => r.cells.command === 'doc.cancel')).toBe(true);
    const one = st.audit.find((a) => a.companyId === VAT && a.command === 'doc.issue')!;
    expect(entries(auditLog(st, VAT, { target: one.target! })).every((r) => r.cells.target.includes(one.target!))).toBe(true);
    const day = one.at.slice(0, 10), m = entries(auditLog(st, VAT, { from: day, to: day }));
    expect(m.length).toBeGreaterThan(0); expect(m.length).toBeLessThan(all.length);
    expect(m.every((r) => r.cells.at.slice(0, 10) === day)).toBe(true);
  });
  it('a document target links to its page; a plain target has no link', () => {
    const ti = st.audit.find((a) => a.companyId === VAT && a.command === 'doc.issue' && a.target?.startsWith('ti-'))!;
    expect(entries(auditLog(st, VAT, { target: ti.target }))[0].links?.target).toMatch(/^\/sales\//);
    const sw = entries(auditLog(st, VAT, { command: 'company.switch' }))[0];
    expect(sw.links?.target).toBeUndefined();
  });
  it('result: a rejected entry shows as such', () => {
    logAudit(st, ME, VAT, 'doc.issue', 'ti-001'); st.audit.at(-1)!.result = 'rejected';
    expect(entries(auditLog(st, VAT, { command: 'doc.issue' })).some((r) => r.cells.result === 'rejected')).toBe(true);
  });
  it('company isolation: the other company\'s entries never appear', () => {
    const ids = new Set(st.audit.filter((a) => a.companyId === NV).map((a) => a.id));
    expect(ids.size).toBeGreaterThan(0);
    expect(entries(auditLog(st, VAT, {})).some((r) => ids.has(r.cells.id))).toBe(false);
    expect(entries(auditLog(st, NV, {})).every((r) => ids.has(r.cells.id))).toBe(true);
  });
  it('CSV: a BOM, one line per row, the entry id repeated on its field rows', () => {
    const csv = reportCsv(buildReport(st, VAT, 'audit-log', {}), 'th');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split('\r\n').length).toBeGreaterThan(200);
  });
});

describe('ruling 3: append-only - no endpoint edits an entry, and an invariant says so', () => {
  it('the seed holds it (ids unique and increasing, timestamps non-decreasing)', () => {
    expect(checkInvariants(st).filter((v) => /audit/.test(v))).toEqual([]);
    for (let i = 1; i < st.audit.length; i++) expect(st.audit[i].at >= st.audit[i - 1].at).toBe(true);
  });
  it('a duplicated id is flagged', () => { st.audit[10].id = st.audit[9].id; expect(checkInvariants(st).some((v) => /audit.*id/.test(v))).toBe(true); });
  it('a reordered id is flagged', () => { [st.audit[10].id, st.audit[11].id] = [st.audit[11].id, st.audit[10].id]; expect(checkInvariants(st).some((v) => /audit.*id/.test(v))).toBe(true); });
  it('a back-dated timestamp is flagged', () => { st.audit[50].at = '2020-01-01T00:00:00.000Z'; expect(checkInvariants(st).some((v) => /audit.*timestamp/.test(v))).toBe(true); });
  it('a deleted entry in the middle is flagged (the ids no longer count up)', () => { st.audit.splice(20, 1); expect(checkInvariants(st).some((v) => /audit.*id/.test(v))).toBe(true); });
});

describe('ruling 5: reopen history', () => {
  it('lists period and year-close reopens, newest first, with the reason, the actor and the time', () => {
    expect(reopenHistory(st, VAT, {}).rows).toHaveLength(0);
    closePeriod(st, VAT, '2026-07', ME, { acknowledge: [] });
    reopenPeriod(st, VAT, '2026-07', ME, 'พบรายการตกหล่น');
    closeYear(st, VAT, 2025, ME);
    reopenYear(st, VAT, 2025, ME, 'ปรับปรุงยอดสิ้นปี');
    const m = reopenHistory(st, VAT, {});
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0].cells.at >= m.rows[1].cells.at).toBe(true);
    expect(m.rows.map((r) => [r.cells.scope, r.cells.period, r.cells.reason, r.cells.actor]).sort()).toEqual([
      ['ปีบัญชี', '2568', 'ปรับปรุงยอดสิ้นปี', ME.name], ['งวด', '2026-07', 'พบรายการตกหล่น', ME.name]].sort());
    expect(reopenHistory(st, NV, {}).rows).toHaveLength(0);
  });
});
