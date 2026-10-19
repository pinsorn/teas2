import { beforeEach, describe, expect, it } from 'vitest';
import { derivedLocks } from './engine/locks';
import { isValidTin } from '@/domain/tin';
import { toSatang } from './engine/money';
import { USER as me, AGENT } from './fixtures/documents';
import { createDraft, issue, publicDoc, revise } from './engine/commands';
import { checkInvariants } from './engine/invariants';
import { optionsOf, templatesView, updateTemplate } from './engine/look';
import { PAPER_BUILDERS, PAPER_RAW, DEFAULT_SIGNATURES } from './engine/paper';
import { buildSeedState, loadState, resetState, saveState, seed, type MockState } from './store';

describe('mock store', () => {
  beforeEach(() => localStorage.clear());
  it('seeds two companies from fixtures/companies.json with valid TINs', () => {
    const s = seed();
    expect(s.companies.map((c) => c.vatRegistered)).toEqual([true, false]);
    for (const p of s.parties) if (p.taxId) expect(isValidTin(p.taxId)).toBe(true);
  });
  it('seed money: no credit note exceeds its target TI total, and no TI without a settlement has negative outstanding', () => {
    const s = seed();
    const cns = s.links.filter((l) => l.kind === 'adjusts' && l.active);
    expect(cns.length).toBeGreaterThan(0);
    for (const l of cns) {
      const ti = s.docs.find((d) => d.id === l.to)!;
      expect({ id: ti.id, ok: toSatang(l.amount!) <= toSatang(ti.totals.total) }).toEqual({ id: ti.id, ok: true });
    }
    for (const d of s.docs.filter((x) => x.type === 'TI' && x.outstanding !== undefined && !s.links.some((l) => l.kind === 'settles' && l.active && l.to === x.id))) {
      expect({ id: d.id, neg: toSatang(d.outstanding!) < 0 }).toEqual({ id: d.id, neg: false });
    }
  });
  it('seed is deterministic', () => {
    expect(JSON.stringify(seed())).toBe(JSON.stringify(seed()));
  });
  it('persists and resets through localStorage', () => {
    const s = loadState();
    s.docs = s.docs.slice(0, 1);
    saveState(s);
    expect(loadState().docs).toHaveLength(1);
    expect(resetState().docs.length).toBeGreaterThan(1);
  });
  it('has the TI mix the screens need', () => {
    const tis = seed().docs.filter((d) => d.type === 'TI');
    const by = (st: string) => tis.filter((d) => d.status === st).length;
    expect(by('draft')).toBeGreaterThanOrEqual(3);
    expect(by('issued')).toBeGreaterThanOrEqual(5);
    expect(by('settled')).toBeGreaterThanOrEqual(10);
    expect(by('replaced')).toBeGreaterThanOrEqual(1);
    expect(tis.some((d) => d.createdBy.kind === 'agent')).toBe(true);
  });
  it('a browser holding the previous (v5) persisted state is reseeded and picks up the purchase items', () => {
    const old = { ...seed(), version: 5, items: [] as unknown[] };
    localStorage.setItem('teas2.mock.state.v5', JSON.stringify(old));
    const s = loadState();
    expect(s.version).toBe(61);
    expect(s.items.some((i) => i.id === 'EXP-01')).toBe(true);
    expect(s.parties.some((p) => p.id === 'pv-12')).toBe(true);
  });
  it('seeds the fixtures later tasks depend on', () => {
    const s = seed();
    const vat = s.parties.filter((p) => p.companyId === 'co-vat');
    expect(vat.filter((p) => p.kind === 'customer')).toHaveLength(13); // + pc-13 (inactive, M1)
    expect(vat.filter((p) => p.kind === 'vendor')).toHaveLength(12); // + pv-12 (foreign, M1), pv-11 (FN3: the vendor side of pc-02)
    expect(s.items.filter((i) => i.companyId === 'co-vat')).toHaveLength(28); // 20 sales + 8 purchase (M2)
    const nonvat = s.parties.filter((p) => p.companyId === 'co-nonvat');
    expect([nonvat.filter((p) => p.kind === 'customer').length, nonvat.filter((p) => p.kind === 'vendor').length]).toEqual([9, 6]); // + nc-09 (inactive, M1)
    expect(s.items.filter((i) => i.companyId === 'co-nonvat')).toHaveLength(15); // 12 sales + 3 purchase (M2)
    const nava = vat.find((p) => p.name === 'บริษัท นาวาพาณิชย์ จำกัด')!;
    expect([nava.taxId, nava.branchCode, nava.usualItemIds]).toEqual(['0105568024684', '00000', ['SV-01']]);
    expect(vat.find((p) => p.name === 'บริษัท ปิ่นทองการพิมพ์ จำกัด')?.taxId).toBe('0105565077124');
    const noTin = vat.find((p) => p.name === 'ห้างหุ้นส่วนจำกัด สมบูรณ์ค้าไม้')!;
    expect([noTin.vatRegistered, noTin.taxId]).toEqual([true, undefined]);
    const sv1 = s.items.find((i) => i.id === 'SV-01')!;
    expect([sv1.name, sv1.unitPrice, sv1.taxCode]).toEqual(['ออกแบบอัตลักษณ์องค์กร', '60000.00', 'S7']);
    const kinds = (t: string) => s.docs.filter((d) => d.type === t);
    const tis = kinds('TI').filter((d) => !d.id.startsWith('spike-')); // rendering-spike TIs (ADR-0001) are extra issued docs
    const n = (st: string) => tis.filter((d) => d.status === st).length;
    expect([n('draft'), n('settled'), n('partly_settled'), n('replaced')]).toEqual([6, 31, 8, 3]); // 6 partly paid in the history + ti-057 (rc-multi) and ti-037 (rc-nocert), S4; ti-dep2 is paid up from a deposit (FN3)
    expect(n('issued')).toBe(13); // 12 before S4 settled ti-057 and ti-037 in part; FN3 adds ti-dep and ti-net (open) and ti-dep2 (paid up); AC5 adds the invoice of fa-sold's sale (open)
    expect(tis.filter((d) => d.createdBy.kind === 'agent')).toHaveLength(2);
    const rcTargets = s.links.filter((l) => l.kind === 'settles' && s.docs.find((d) => d.id === l.to)?.type === 'TI').map((l) => l.to).filter((id) => !id.startsWith('spike-')).sort(); // (S3's receipts settle IVs; rc-multi also pays spike-60, outside this count)
    expect(rcTargets).toEqual(tis.filter((d) => d.status === 'settled' || d.status === 'partly_settled').map((d) => d.id).sort());
    expect(s.links.filter((l) => l.kind === 'replaces')).toHaveLength(3);
    expect(s.links.filter((l) => l.kind === 'adjusts')).toHaveLength(9); // cn-1, cn-2 + S5's cn-ret, dn-1, cn-full + P2's pcn-1, pdn-1 + AC1's jv-1-auto, jv-rev (a reversing JV links `adjusts` to its original)
    expect(kinds('CN')).toHaveLength(4);
    expect(s.links.filter((l) => l.kind === 'converted_from')).toHaveLength(17); // + P2's pb-po
    const delivered = new Set(s.links.filter((l) => l.kind === 'converted_from').map((l) => l.to));
    expect(kinds('SO').filter((d) => d.status === 'issued' && !delivered.has(d.id))).toHaveLength(2);
    const qt = kinds('QT').find((d) => d.revision === 1)!;
    expect(qt.status).toBe('issued');
    expect(s.revisions.filter((r) => r.docId === qt.id).map((r) => r.revision)).toEqual([0, 1]);
    expect(tis.filter((d) => d.locks.some((l) => l.kind === 'filing'))).toHaveLength(0); // TX1: the filing lock is derived from the finalized ภ.พ.30 (July and August), never stored
    expect(tis.filter((d) => derivedLocks(s, d).some((l) => l.kind === 'filing')).length).toBeGreaterThan(0);
    for (const d of s.docs.filter((x) => x.status !== 'draft' && x.status !== 'pending' && x.status !== 'approved' && !x.header.obBatchId)) { // an opening item is numbered with the old document's number
      expect(d.number).toMatch(/^[A-Z]+-\d{6}-\d{4}$/);
      expect(s.revisions.some((r) => r.docId === d.id && r.revision === 0)).toBe(true);
    }
    // numbering is per company (each has its own series)
    expect(new Set(s.docs.filter((d) => d.number).map((d) => `${d.companyId}|${d.number}`)).size).toBe(s.docs.filter((d) => d.number).length);
  });
  it('every seeded doc has the SP0 §7.3 correction class', () => {
    const T = ['TI', 'RC', 'CN', 'DN', 'WT'], N = ['QT', 'SO', 'DO', 'BL', 'PO'];
    const docs = seed().docs;
    expect(docs.some((d) => d.type === 'RC')).toBe(true);
    for (const d of docs) expect(d.correctionClass).toBe(T.includes(d.type) ? 'T' : N.includes(d.type) ? 'N' : 'L');
  });
});

// ---- SP1c ST4: templates + the logo / stamp / signature on every paper, frozen at issue ----
const PNG = (c: string) => `data:image/png;base64,${c.repeat(8)}`;
const [LOGO_A, LOGO_B, STAMP_A, SIG_A, SIG_B] = [PNG('A'), PNG('B'), PNG('C'), PNG('D'), PNG('E')];
describe('ST4 images and templates on the paper', () => {
  let st: MockState;
  const VAT = 'co-vat';
  const co = (id = VAT) => st.companies.find((c) => c.id === id)!;
  const staff = () => st.staff.find((m) => m.companyId === VAT && m.userId === 'u-1')!;
  const ctxOf = (id = VAT) => ({ st, company: co(id), s: {}, perms: [] }) as never;
  const paper = (id: string, raw = false) => { const d = st.docs.find((x) => x.id === id)!; return (raw ? PAPER_RAW : PAPER_BUILDERS)[d.type]!(ctxOf(d.companyId), publicDoc(d), false); };
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { code?: string }).code ?? String(e); } return 'no error'; };
  const body = { header: { partyId: 'pc-01', documentDate: '2026-10-14' }, lines: [{ id: 'l1', description: 'งานทดสอบ', qty: '1', unit: 'งาน', unitPrice: '100.00', taxCode: 'S7' as const }] };
  let n = 0;
  const newTi = () => { const d = createDraft(st, VAT, 'TI', body, me, `st4-${++n}`); return issue(st, d.id, d.version, me); };
  beforeEach(() => { st = buildSeedState('admin'); co().logoDataUrl = LOGO_A; co().stampDataUrl = STAMP_A; staff().signatureDataUrl = SIG_A; });

  it('an issued TI keeps the logo, stamp and signature it was issued with after a new upload; a new TI shows the new ones', () => {
    const old = newTi();
    co().logoDataUrl = LOGO_B; staff().signatureDataUrl = SIG_B;
    const fresh = newTi();
    expect(paper(old.id).images).toEqual({ logo: LOGO_A, stamp: STAMP_A, signature: SIG_A });
    expect(paper(fresh.id).images).toEqual({ logo: LOGO_B, stamp: STAMP_A, signature: SIG_B });
    expect(paper(old.id).issuer).toMatchObject({ name: 'สมศรี บัญชีดี', position: 'หัวหน้าฝ่ายบัญชี', signatureAt: 'ผู้มีอำนาจลงนาม', stampAt: 'ผู้มีอำนาจลงนาม' });
    expect(Object.values(st.images!).filter((v) => v === LOGO_A)).toHaveLength(1); // content-addressed: once
    expect(JSON.stringify(st.docs.find((d) => d.id === old.id))).not.toContain(LOGO_A); // the document keeps a hash, never the picture
    expect(checkInvariants(st)).toEqual([]);
  });
  it('a deactivated issuer (or a removed signature) leaves the signature on the papers they issued', () => {
    const old = newTi();
    staff().active = false; delete staff().signatureDataUrl; delete co().logoDataUrl;
    expect(paper(old.id).images).toMatchObject({ logo: LOGO_A, signature: SIG_A });
  });
  it('a draft prints the live logo and no signature, no stamp', () => {
    const d = createDraft(st, VAT, 'TI', body, me, 'st4-draft');
    const p = PAPER_BUILDERS.TI!(ctxOf(), d, false);
    expect(p.images).toEqual({ logo: LOGO_A });
    expect(p.issuer).toBeUndefined();
  });
  it('a revise re-snapshots the seller and the pictures (a new upload before it shows after it)', () => {
    const d = newTi();
    co().logoDataUrl = LOGO_B; co().legalNameTh = 'บริษัท ใหม่ จำกัด';
    expect(paper(d.id).seller.name).not.toBe('บริษัท ใหม่ จำกัด');
    const cur = st.docs.find((x) => x.id === d.id)!;
    revise(st, d.id, { header: { ...cur.header, notes: 'แก้หมายเหตุ' }, lines: cur.lines }, cur.version, 'หมายเหตุ', me);
    expect(paper(d.id).images?.logo).toBe(LOGO_B);
    expect(paper(d.id).seller.name).toBe('บริษัท ใหม่ จำกัด');
  });
  it('a missing image entry keeps the empty line (no broken image) - and the invariant names it', () => {
    const d = newTi();
    const ref = st.docs.find((x) => x.id === d.id)!.issueLook!.signature!;
    delete st.images![ref];
    expect(paper(d.id).images?.signature).toBeUndefined();
    expect(paper(d.id).issuer?.name).toBeUndefined();
    expect(checkInvariants(st).some((m) => m.includes(d.id) && m.includes('image store'))).toBe(true);
  });
  it('every issued printable carries a seller snapshot (single fault: delete one -> red)', () => {
    const d = newTi();
    delete st.docs.find((x) => x.id === d.id)!.sellerSnapshot;
    expect(checkInvariants(st).some((m) => m.includes(d.id) && m.includes('seller snapshot'))).toBe(true);
  });
  it('template toggles change the paper model; the options are the company own and audited', () => {
    const d = newTi(), other = st.docs.find((x) => x.companyId === 'co-nonvat' && x.type === 'QT' && x.status !== 'draft')!;
    const v0 = optionsOf(st, VAT, 'TI').version;
    updateTemplate(st, me, VAT, 'TI', { showLogo: false, showStamp: false, showSignature: true, version: v0 });
    expect(paper(d.id).images).toEqual({ signature: SIG_A });
    updateTemplate(st, me, VAT, 'TI', { showLogo: true, showStamp: true, showSignature: false, version: v0 + 1 });
    expect(paper(d.id).signatures).toEqual([]);
    expect(paper(d.id).images).toEqual({ logo: LOGO_A, stamp: STAMP_A }); // no signature; the stamp does not depend on the lines (ST4a m3): it sits beside the block
    expect(paper(d.id).issuer?.stampAt).toBeUndefined();
    updateTemplate(st, me, VAT, 'TI', { showLogo: true, showStamp: true, showSignature: true, signatureLabels: ['ผู้รับเงิน', 'ผู้อนุมัติ'], version: v0 + 2 });
    expect(paper(d.id).signatures).toEqual(['ผู้รับเงิน', 'ผู้อนุมัติ']);
    expect(paper(d.id).issuer?.signatureAt).toBeUndefined(); // ST4a M1: the issuer's own line is not in the list: nothing is signed (never the last line)
    expect(paper(d.id).images).toEqual({ logo: LOGO_A, stamp: STAMP_A });
    expect(paper(d.id).issuer?.stampAt).toBeUndefined();
    updateTemplate(st, me, VAT, 'QT', { showLogo: false, showStamp: false, showSignature: false, version: 1 });
    expect(optionsOf(st, 'co-nonvat', 'QT')).toMatchObject({ showSignature: true, version: 1 }); // another company's template is untouched
    expect(paper(other.id).signatures.length).toBeGreaterThan(0);
    expect(st.audit.filter((a) => a.command === 'template.update')).toHaveLength(4);
    expect(templatesView(st, VAT, DEFAULT_SIGNATURES()).items.find((t) => t.type === 'TI')).toMatchObject({ signatureLabels: ['ผู้รับเงิน', 'ผู้อนุมัติ'], version: v0 + 3 });
  });
  it('ST4a M1: a template with only counterparty lines prints no signature and no stamp on them (QT and TI probes)', () => {
    const qt = st.docs.find((x) => x.companyId === VAT && x.type === 'QT' && x.status !== 'draft')!;
    const cur = st.docs.find((x) => x.id === qt.id)!;
    revise(st, qt.id, { header: { ...cur.header }, lines: cur.lines }, cur.version, 'ทดสอบ', me); // re-snapshot with the pictures on
    updateTemplate(st, me, VAT, 'QT', { showLogo: true, showStamp: true, showSignature: true, signatureLabels: ['ผู้อนุมัติ', 'ลูกค้ายืนยันสั่งซื้อ'], version: 1 });
    const q = paper(qt.id);
    expect(q.issuer?.signatureAt).toBeUndefined();
    expect(q.issuer?.stampAt).toBeUndefined();
    expect(q.images?.signature).toBeUndefined();
    const ti = newTi();
    updateTemplate(st, me, VAT, 'TI', { showLogo: true, showStamp: true, showSignature: true, signatureLabels: ['ผู้ส่งของ', 'ผู้รับของ'], version: 1 });
    const p = paper(ti.id);
    expect([p.issuer?.signatureAt, p.issuer?.stampAt, p.images?.signature]).toEqual([undefined, undefined, undefined]);
    expect(p.images?.stamp).toBe(STAMP_A); // beside the block, on no line
  });
  it('ST4a m1: an issued printable without its issue look is caught (single fault)', () => {
    const d = newTi();
    delete st.docs.find((x) => x.id === d.id)!.issueLook;
    expect(checkInvariants(st).some((m) => m.includes(d.id) && m.includes('issue look'))).toBe(true);
  });
  it('ST4a m2: the payslip row carries its default labels and a Save of toggles pins nothing; labels already set are kept', () => {
    expect(templatesView(st, VAT, DEFAULT_SIGNATURES()).items.find((t) => t.type === 'PR')!.signatureLabels).toEqual(['ผู้จ่ายเงิน', 'ผู้รับเงิน']);
    updateTemplate(st, me, VAT, 'PR', { showLogo: false, showStamp: true, showSignature: true, version: 1 });
    expect(st.printTemplates!.find((t) => t.type === 'PR')!.signatureLabels).toBeUndefined();
    updateTemplate(st, me, VAT, 'QT', { showLogo: true, showStamp: true, showSignature: true, signatureLabels: ['ผู้เสนอราคา'], version: 1 });
    updateTemplate(st, me, VAT, 'QT', { showLogo: false, showStamp: true, showSignature: true, version: 2 });
    expect(st.printTemplates!.find((t) => t.type === 'QT')!.signatureLabels).toEqual(['ผู้เสนอราคา']);
  });
  it('a template write: agent refused, stale version 409, label outside the fixed list or a duplicate refused - and nothing is written', () => {
    const ok = { showLogo: true, showStamp: true, showSignature: true, version: 1 };
    expect(code(() => updateTemplate(st, AGENT, VAT, 'TI', ok))).toBe('agent.forbidden_setting');
    expect(code(() => updateTemplate(st, me, VAT, 'TI', { ...ok, version: 7 }))).toBe('record.version_conflict');
    expect(code(() => updateTemplate(st, me, VAT, 'TI', { ...ok, signatureLabels: ['ผู้ยิ่งใหญ่'] }))).toBe('template.bad_label');
    expect(code(() => updateTemplate(st, me, VAT, 'TI', { ...ok, signatureLabels: ['ผู้รับเงิน', 'ผู้รับเงิน'] }))).toBe('template.bad_label');
    expect(code(() => updateTemplate(st, me, VAT, 'TI', { ...ok, signatureLabels: null }))).toBe('template.bad_label'); // null is refused; an absent key keeps the stored labels
    expect(code(() => updateTemplate(st, me, VAT, 'FA', ok))).toBe('template.unknown_type');
    expect(st.printTemplates ?? []).toEqual([]);
    expect(st.audit.some((a) => a.command === 'template.update')).toBe(false);
  });
  it('a payslip keeps the issue-time pictures after a new upload; a deactivated issuer leaves the signature', () => {
    const line = { id: 'ps-l1', description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX' as const, employeeId: 'emp-02', pay: { salary: '30000.00' } };
    const d = createDraft(st, VAT, 'PR', { header: { documentDate: '2026-10-14', reference: 'ทดสอบ' }, lines: [line] }, me, 'st4-pr');
    const pr = issue(st, d.id, d.version, me);
    co().logoDataUrl = LOGO_B; staff().signatureDataUrl = SIG_B; staff().active = false;
    expect(paper(pr.id).images).toEqual({ logo: LOGO_A, stamp: STAMP_A, signature: SIG_A });
    expect(paper(pr.id).issuer?.signatureAt).toBe('ผู้จ่ายเงิน'); // the payslip has no authorised-signatory line: the stamp sits beside the payer's line
    expect(paper(pr.id).issuer?.stampAt).toBe('ผู้จ่ายเงิน');
  });
  it('a WT 50 ทวิ keeps the issue-time pictures; the stored paper (I7) keeps hashes, not pictures, and still follows the template', () => {
    const pb = createDraft(st, VAT, 'PB', { header: { partyId: 'pv-01', documentDate: '2026-10-14', vendorDocNumber: 'V-st4', vendorDocDate: '2026-10-14' }, lines: [{ id: 'b-l1', description: 'ค่าเช่า', qty: '1', unit: 'งาน', unitPrice: '25000.00', taxCode: 'S7' as const, itemId: 'EXP-01', expenseCategory: 'rent' }] }, me, 'st4-pb');
    const bill = issue(st, pb.id, pb.version, me);
    const pvd = createDraft(st, VAT, 'PV', { header: { partyId: 'pv-01', documentDate: '2026-10-14' }, lines: [], allocations: [{ targetId: bill.id, targetType: 'PB', amount: bill.totals.total }] }, me, 'st4-pv');
    const pv = issue(st, pvd.id, pvd.version, me);
    const wt = st.docs.find((x) => st.links.some((l) => l.kind === 'issues' && l.from === pv.id && l.to === x.id))!;
    expect(wt.issueLook).toMatchObject({ issuerName: 'สมศรี บัญชีดี' });
    co().logoDataUrl = LOGO_B; staff().signatureDataUrl = SIG_B;
    expect(paper(wt.id).images).toEqual({ logo: LOGO_A, stamp: STAMP_A, signature: SIG_A });
    const frozen = PAPER_RAW.WT!(ctxOf(), publicDoc(wt), false); // what markPrinted stores at the first print
    expect(JSON.stringify(frozen)).not.toContain('data:image');
    st.prints.push({ docId: wt.id, at: 'x', by: 'y', copy: false, paper: frozen });
    updateTemplate(st, me, VAT, 'WT', { showLogo: false, showStamp: true, showSignature: true, version: 1 });
    expect(paper(wt.id).images).toEqual({ stamp: STAMP_A, signature: SIG_A }); // a template is read at print time, even from the stored paper
    expect(checkInvariants(st)).toEqual([]);
  });
});
