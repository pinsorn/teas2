import { beforeEach, describe, expect, it } from 'vitest';
import { assertBalanced, type Actor, type DocLine, type MockStateLike } from './test-helpers';
import { seed } from '../store';
import { cancel, compute, convert, createDraft, issue, missingOf, revise, updateDraft } from './commands';
import { fromSatang, toSatang } from './money';

const me: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const line = (p: Partial<DocLine> = {}): DocLine => ({ id: 'l1', description: 'ออกแบบ', qty: '1', unit: 'งาน', unitPrice: '1000.00', taxCode: 'S7', ...p });
let st: MockStateLike;
let vatCo: string;
let vatCustomer: string;

beforeEach(() => {
  st = seed();
  vatCo = st.companies.find((c) => c.vatRegistered)!.id;
  vatCustomer = st.parties.find((p) => p.companyId === vatCo && p.kind === 'customer' && p.vatRegistered && p.taxId)!.id;
});

describe('drafts and issue', () => {
  it('one idempotency key = one draft', () => {
    const a = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k1');
    const b = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k1');
    expect(b.id).toBe(a.id);
  });
  it('stale version is refused', () => {
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k2');
    updateDraft(st, d.id, { header: d.header, lines: [line({ qty: '2' })] }, d.version, me);
    expect(() => updateDraft(st, d.id, { header: d.header, lines: [line()] }, d.version, me)).toThrow(/doc.version_conflict/);
  });
  it('issue allocates the next number, writes journal, revision 0, activity and audit', () => {
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k3');
    const before = { act: st.activity.length, aud: st.audit.length };
    const done = issue(st, d.id, d.version, me);
    expect(done.number).toMatch(/^TI-202610-\d{4}$/);
    expect(done.status).toBe('issued');
    expect(st.journals.find((j) => j.docId === d.id)?.preview.entries[0].lines.length).toBeGreaterThan(0);
    expect(st.revisions.filter((r) => r.docId === d.id).map((r) => r.revision)).toEqual([0]);
    expect(st.activity.length).toBe(before.act + 1);
    expect(st.audit.length).toBe(before.aud + 1);
  });
  it('issue is refused while something is missing (VAT buyer without TIN)', () => {
    const noTin = st.parties.find((p) => p.companyId === vatCo && p.kind === 'customer' && p.vatRegistered && !p.taxId)!.id;
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: noTin, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k4');
    expect(compute(st, vatCo, 'TI', { header: d.header, lines: d.lines }).missing.length).toBeGreaterThan(0);
    expect(() => issue(st, d.id, d.version, me)).toThrow(/doc.incomplete/);
  });
  it('cancel keeps the number and the next issue never reuses it', () => {
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k5');
    const a = issue(st, d.id, d.version, me);
    const c = cancel(st, a.id, a.version, 'WRONG_PARTY', 'ออกผิดราย', me);
    expect(c.number).toBe(a.number);
    expect(c.status).toBe('cancelled');
    const e = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k6');
    expect(issue(st, e.id, e.version, me).number).not.toBe(a.number);
  });
});

describe('revisions (classes N and L)', () => {
  it('an N-class revision keeps the number, bumps the revision and records a diff', () => {
    const qt = st.docs.find((d) => d.companyId === vatCo && d.type === 'QT' && d.status === 'issued')!;
    const r = revise(st, qt.id, { header: { ...qt.header, notes: 'ยืนราคา 45 วัน' }, lines: qt.lines }, qt.version, 'ลูกค้าขอขยายเวลา', me);
    expect(r.number).toBe(qt.number);
    expect(r.revision).toBe(qt.revision + 1);
    const rev = st.revisions.find((x) => x.docId === qt.id && x.revision === r.revision)!;
    expect(rev.diff).toContainEqual({ path: 'header.notes', before: qt.header.notes ?? null, after: 'ยืนราคา 45 วัน' });
  });
  it('an L-class revision writes a reversal plus a correcting entry, all balanced', () => {
    const d = createDraft(st, vatCo, 'IV', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line()] }, me, 'k7');
    const a = issue(st, d.id, d.version, me);
    const r = revise(st, a.id, { header: a.header, lines: [line({ unitPrice: '2500.00' })] }, a.version, 'แก้ราคา', me);
    expect(r.number).toBe(a.number);
    const kinds = st.journals.find((j) => j.docId === a.id)!.preview.entries.map((e) => e.kind);
    expect(kinds).toEqual(['original', 'reversal', 'correction']);
    assertBalanced(st);
  });
  it('a T-class doc refuses a fiscal revise (use a correction plan)', () => {
    const ti = st.docs.find((x) => x.type === 'TI' && x.status === 'issued')!;
    expect(() => revise(st, ti.id, { header: { ...ti.header, documentDate: '2026-01-01' }, lines: ti.lines }, ti.version, 'x', me))
      .toThrow(/doc.revise_not_allowed/);
  });
});

describe('convert', () => {
  it('refuses more than the remaining quantity and returns quantity when the target is cancelled', () => {
    const so = st.docs.find((d) => d.companyId === vatCo && d.type === 'SO' && d.status === 'issued'
      && !st.links.some((l) => l.kind === 'converted_from' && l.to === d.id && l.active))!; // an undelivered SO
    const l = so.lines[0];
    const half = String(Number(l.qty) / 2);
    const do1 = convert(st, so.id, 'DO', [{ sourceLineId: l.id, qty: half }], me);
    expect(() => convert(st, so.id, 'DO', [{ sourceLineId: l.id, qty: l.qty }], me)).toThrow(/doc.over_conversion/);
    const issued = issue(st, do1.id, do1.version, me);
    cancel(st, issued.id, issued.version, 'OTHER', 'ทดสอบ', me);
    expect(() => convert(st, so.id, 'DO', [{ sourceLineId: l.id, qty: l.qty }], me)).not.toThrow();
  });
});

describe('fix round 1: outstanding, seed validity, cancel blocks (SP0 7.4 / 7.11)', () => {
  it('seed: every live TI/IV outstanding = total - CN + DN - settlements (active links only)', () => {
    const s = seed();
    const live = s.docs.filter((d) => (d.type === 'TI' || d.type === 'IV') && ['issued', 'partly_settled', 'settled'].includes(d.status));
    expect(live.length).toBeGreaterThan(10);
    for (const d of live) {
      let out = toSatang(d.totals.total);
      for (const l of s.links) {
        if (!l.active || l.to !== d.id) continue;
        const t = s.docs.find((x) => x.id === l.from)!.type;
        if (l.kind === 'settles' || t === 'CN') out -= toSatang(l.amount!); else if (t === 'DN') out += toSatang(l.amount!);
      }
      expect({ id: d.id, out: d.outstanding }).toEqual({ id: d.id, out: fromSatang(out) });
    }
    const cn = s.links.find((l) => l.kind === 'adjusts')!;
    const ti = s.docs.find((d) => d.id === cn.to)!;
    expect(toSatang(ti.outstanding!)).toBe(toSatang(ti.totals.total) - toSatang(cn.amount!));
  });
  it('seed: every non-draft document passes the same validation as issue', () => {
    const s = seed();
    for (const d of s.docs.filter((x) => x.status !== 'draft')) {
      expect({ id: d.id, missing: missingOf(s, d.companyId, d.type, { header: d.header, lines: d.lines }) }).toEqual({ id: d.id, missing: [] });
    }
    const tinless = (id?: string) => s.parties.some((p) => p.id === id && p.vatRegistered && !p.taxId);
    expect(s.parties.some((p) => p.vatRegistered && !p.taxId)).toBe(true); // the TIN-less party still exists
    expect(s.docs.some((d) => d.status === 'draft' && tinless(d.header.partyId))).toBe(true); // ...as a draft buyer
  });
  it('a TI with an applied receipt cannot be cancelled; a QT with a converted child can', () => {
    const paid = st.docs.find((d) => d.type === 'TI' && d.status === 'settled' && !d.locks.length)!;
    expect(() => cancel(st, paid.id, paid.version, 'OTHER', 'x', me)).toThrow(/doc.has_dependents/);
    const qt = st.docs.find((d) => d.type === 'QT' && st.links.some((l) => l.to === d.id && l.active))!;
    expect(cancel(st, qt.id, qt.version, 'OTHER', 'x', me).status).toBe('cancelled');
  });
});

describe('ledger', () => {
  it('every journal entry in the seed balances to the satang', () => assertBalanced(seed()));
  it('stays balanced after issue and cancel; the reversal mirrors the original', () => {
    const d = createDraft(st, vatCo, 'TI', { header: { partyId: vatCustomer, documentDate: '2026-10-14' }, lines: [line({ qty: '3', unitPrice: '333.33', discountPct: '12.5' })] }, me, 'k8');
    const a = issue(st, d.id, d.version, me);
    assertBalanced(st);
    cancel(st, a.id, a.version, 'OTHER', 'ทดสอบ', me);
    assertBalanced(st);
    const [o, rv] = st.journals.find((j) => j.docId === a.id)!.preview.entries;
    expect(rv.kind).toBe('reversal');
    expect(rv.lines.map((x) => [x.accountCode, x.credit, x.debit])).toEqual(o.lines.map((x) => [x.accountCode, x.debit, x.credit]));
  });
});
