import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureIds } from '../fixtures/ids';
import { assertBalanced, type Actor, type DocLine, type MockStateLike } from './test-helpers';
import { seed } from '../store';
import { buildChain } from './chain';
import { cancel, convert, createDraft, issue, revise } from './commands';
import { closeRemainder, remainingOf, setMark } from './marks';
import { MockError } from './log';

const me: Actor = { kind: 'user', id: 'u-1', name: 'สมศรี บัญชีดี' };
const line = (id: string, qty: string): DocLine => ({ id, description: `สินค้า ${id}`, qty, unit: 'ชิ้น', unitPrice: '100.00', taxCode: 'S7' });
let st: MockStateLike;
let co: string, vendor: string, n = 0;

beforeEach(() => {
  st = seed();
  co = 'co-vat';
  vendor = st.parties.find((p) => p.companyId === co && p.kind === 'vendor' && p.active !== false)!.id;
});
const po = () => {
  const d = createDraft(st, co, 'PO', { header: { partyId: vendor, documentDate: '2026-10-14' }, lines: [line('l1', '20'), line('l2', '10')] }, me, `k-${++n}`);
  return issue(st, d.id, d.version, me);
};
const get = (id: string) => st.docs.find((d) => d.id === id)!;
const progress = (id: string) => buildChain(st, id).nodes.find((x) => x.id === id)?.progress;
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof MockError ? e.code : String(e); } return 'no error'; };

describe('purchase order (P1)', () => {
  it('seed: the PO fixtures resolve and the draft, sent, partly billed, closed and non-VAT POs are what they promise', () => {
    const ids = fixtureIds(st);
    expect(get(ids.poDraft)).toMatchObject({ type: 'PO', status: 'draft', companyId: 'co-vat' });
    expect(get(ids.poSent)).toMatchObject({ status: 'issued', lines: expect.arrayContaining([expect.anything()]) });
    expect(get(ids.poSent).lines).toHaveLength(3);
    expect(get(ids.poSent).marks?.sent).toBeTruthy();
    expect(get(ids.poPartlyBilled).status).toBe('issued');
    expect(get(ids.poClosed).marks?.closed).toBeTruthy();
    expect(get(ids.npoIssued)).toMatchObject({ companyId: 'co-nonvat', status: 'issued' });
    expect(get(ids.npoIssued).lines[0]).toMatchObject({ description: 'ข้าวเปลือก', qty: '2000', unit: 'กก.' });
    assertBalanced(st);
  });

  it('progress is "รับวางบิลแล้ว x/y" and counts only ISSUED PB targets; a draft PB only reserves', () => {
    const p = po();
    expect(progress(p.id)).toBe('รับวางบิลแล้ว 0/30');
    const draft = convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '5' }], me);
    expect(progress(p.id)).toBe('รับวางบิลแล้ว 0/30');
    expect(remainingOf(st, p.id)[0].remaining).toBe('15');
    issue(st, draft.id, draft.version, me);
    expect(progress(p.id)).toBe('รับวางบิลแล้ว 5/30');
    expect(code(() => convert(st, p.id, 'PV', [{ sourceLineId: 'l1', qty: '1' }], me))).toBe('doc.conversion_not_allowed'); // PV is made from open items
  });

  it('PO -> PB over the remaining quantity is refused (doc.over_conversion), exactly the remainder is allowed', () => {
    const p = po();
    expect(code(() => convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '20.0001' }], me))).toBe('doc.over_conversion');
    convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '12' }], me);
    expect(code(() => convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '9' }], me))).toBe('doc.over_conversion');
    expect(code(() => convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '8' }], me))).toBe('no error');
  });

  it('the sent mark: live PO only, version-checked, in activity and audit, not a revision; a draft or cancelled PO refuses it', () => {
    const d = createDraft(st, co, 'PO', { header: { partyId: vendor, documentDate: '2026-10-14' }, lines: [line('l1', '1')] }, me, 'k-draft');
    expect(code(() => setMark(st, d.id, 'sent', d.version, me))).toBe('doc.not_live');
    const p = po();
    expect(code(() => setMark(st, p.id, 'sent', p.version + 1, me))).toBe('doc.version_conflict');
    expect(code(() => setMark(st, p.id, 'accepted', p.version, me))).toBe('mark.not_allowed'); // a PO is not accepted by a customer
    const marked = setMark(st, p.id, 'sent', p.version, me);
    expect(marked.marks?.sent).toMatchObject({ by: me.name });
    expect(marked.revision).toBe(p.revision);
    expect(marked.totals).toEqual(p.totals);
    expect(st.activity.filter((a) => a.docId === p.id).map((a) => a.action)).toContain('send');
    expect(st.audit.some((a) => a.command === 'doc.mark' && a.target === p.id)).toBe(true);
    const q = po();
    cancel(st, q.id, q.version, 'OTHER', 'x', me);
    expect(code(() => setMark(st, q.id, 'sent', get(q.id).version, me))).toBe('doc.not_live');
  });

  it('a closed PO converts nothing (doc.closed, even for a draft that is already there being issued is fine); a revision reopens it', () => {
    const p = po();
    convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '5' }], me);
    const closed = closeRemainder(st, p.id, p.version, 'ผู้ขายส่งของไม่ครบ', me);
    expect(code(() => convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '1' }], me))).toBe('doc.closed');
    expect(remainingOf(st, p.id).every((l) => l.remaining === '0')).toBe(true);
    expect(progress(p.id)).toBe('รับวางบิลแล้ว 0/30 (ปิดยอดคงเหลือ)');
    expect(st.activity.filter((a) => a.docId === p.id).map((a) => a.action)).toContain('close');
    expect(st.audit.some((a) => a.command === 'doc.mark' && a.target === p.id)).toBe(true);
    expect(code(() => closeRemainder(st, p.id, closed.version + 1, 'x', me))).toBe('doc.version_conflict');
    const rev = revise(st, p.id, { header: get(p.id).header, lines: get(p.id).lines }, closed.version, 'แก้ไข', me);
    expect(rev.marks?.closed).toBeUndefined();
    expect(code(() => convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '1' }], me))).toBe('no error');
  });

  it('closing a PO needs the remainder: nothing remaining refuses', () => {
    const p = po();
    const d = convert(st, p.id, 'PB', [{ sourceLineId: 'l1', qty: '20' }, { sourceLineId: 'l2', qty: '10' }], me);
    issue(st, d.id, d.version, me);
    expect(code(() => closeRemainder(st, p.id, get(p.id).version, 'x', me))).toBe('doc.nothing_remaining');
  });
});
