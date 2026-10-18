import { describe, expect, it } from 'vitest';
import { tinCheckDigit } from '@/domain/tin';
import type { Company, Doc } from '@/domain/types';
import { AGENT, USER } from '../fixtures/documents';
import { buildSeedState } from '../store';
import { closePeriod } from './close';
import { companySettings, updateCompany } from './company';
import { checkInvariants } from './invariants';
import { PAPER_BUILDERS } from './paper';

const seed = () => buildSeedState('admin');
type St = ReturnType<typeof seed>;
/** The paper as the print route builds it (`ctx()` is the live company of the toolbar). */
const paperFor = (st: St, companyId: string, docId: string) => { const d = st.docs.find((x) => x.id === docId)!; return PAPER_BUILDERS[d.type]!({ st, company: st.companies.find((c) => c.id === companyId)!, s: {}, perms: [] } as never, d, false); };
const VAT = 'co-vat';
const reopenAll = (st: ReturnType<typeof seed>) => { for (const p of st.periods) { p.status = 'open'; delete p.closedAt; } };
const TIN = `010550000000${tinCheckDigit('010550000000')}`;
const BAD_TIN = `010550000000${(tinCheckDigit('010550000000') + 1) % 10}`;
const fe = (f: () => unknown) => { try { f(); } catch (e) { return (e as { fieldErrors?: Record<string, string[]> }).fieldErrors; } return undefined; };
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { message: string }).message.split(':')[0]; } return undefined; };

describe('company settings (ST1)', () => {
  it('the seed keeps the fiscal year start (D-33) and the profile fields; SSO account name is unchanged (PY3)', () => {
    const co = seed().companies.find((c) => c.id === VAT)!;
    expect(co.fiscalYearStartMonth).toBe(1);
    expect(co.ssoEmployerAccountNo).toBe('1234567890');
    expect(co.registrationNo).toBeTruthy();
    expect(co.defaultNotes?.QT).toBeTruthy();
  });

  // ruling 2
  it('fiscal year: locked in the seed (periods are closed), and it LOCKS the moment a period closes (the transition, not a seeded state)', () => {
    const st = seed();
    expect(companySettings(st, VAT).fiscalYearLocked).toBe(true);
    reopenAll(st);
    expect(companySettings(st, VAT).fiscalYearLocked).toBe(false);
    expect(updateCompany(st, USER, VAT, 'fiscal', { fiscalYearStartMonth: 1 }).fiscalYearLocked).toBe(false);
    closePeriod(st, VAT, '2025-01', USER, { acknowledge: [] });
    expect(companySettings(st, VAT).fiscalYearLocked).toBe(true);
    expect(code(() => updateCompany(st, USER, VAT, 'fiscal', { fiscalYearStartMonth: 4 }))).toBe('company.fiscal_year_locked');
    expect(st.companies.find((c) => c.id === VAT)!.fiscalYearStartMonth).toBe(1);
  });
  it('fiscal year: any value but 1 is refused 422 company.fiscal_year_unsupported and never stored', () => {
    const st = seed(); reopenAll(st);
    const before = st.audit.length;
    for (const v of [4, 12, 0, 13]) expect(code(() => updateCompany(st, USER, VAT, 'fiscal', { fiscalYearStartMonth: v }))).toMatch(/company\.fiscal_year_unsupported|record\.invalid/);
    expect(code(() => updateCompany(st, USER, VAT, 'fiscal', { fiscalYearStartMonth: 4 }))).toBe('company.fiscal_year_unsupported');
    expect(st.companies.find((c) => c.id === VAT)!.fiscalYearStartMonth).toBe(1);
    expect(st.audit.length).toBe(before); // a refusal writes no audit row
  });

  // ruling 3
  it('legal identity: needs the confirmation; TIN checksum; VAT status is read-only here', () => {
    const st = seed();
    const ok = { legalNameTh: 'บริษัท ใหม่ จำกัด', taxId: TIN, branchCode: '00000', address: '1 ถนนใหม่' };
    expect(code(() => updateCompany(st, USER, VAT, 'identity', ok))).toBe('company.confirm_required');
    expect(fe(() => updateCompany(st, USER, VAT, 'identity', { ...ok, taxId: BAD_TIN, confirm: true }))?.taxId).toHaveLength(1);
    expect(fe(() => updateCompany(st, USER, VAT, 'identity', { ...ok, legalNameTh: ' ', confirm: true }))?.legalNameTh).toHaveLength(1);
    expect(code(() => updateCompany(st, USER, VAT, 'identity', { ...ok, vatRegistered: false, confirm: true }))).toBe('company.vat_readonly');
    expect(st.companies.find((c) => c.id === VAT)!.vatRegistered).toBe(true);
  });
  it('editing the name: an issued TI paper and a finalized filing keep the old name; invariants stay []', () => {
    const st = seed();
    const ti = st.docs.find((d) => d.companyId === VAT && d.type === 'TI' && d.issuedAt && d.number) as Doc & { companyId: string };
    const filing = st.filings.find((f) => f.companyId === VAT)!;
    const oldName = st.companies.find((c) => c.id === VAT)!.legalNameTh, oldFiling = filing.company.legalNameTh;
    const draft = st.docs.find((d) => d.companyId === VAT && d.status === 'draft')!;
    expect(paperFor(st, VAT, ti.id).seller.name).toBe(oldName);
    updateCompany(st, USER, VAT, 'identity', { legalNameTh: 'บริษัท ชื่อใหม่ จำกัด', taxId: '0105569012345', branchCode: '00000', address: 'ที่อยู่ใหม่ 1', confirm: true });
    expect(st.companies.find((c) => c.id === VAT)!.legalNameTh).toBe('บริษัท ชื่อใหม่ จำกัด');
    expect(paperFor(st, VAT, ti.id).seller).toMatchObject({ name: oldName });
    expect(paperFor(st, VAT, ti.id).seller.address).not.toBe('ที่อยู่ใหม่ 1');
    expect(paperFor(st, VAT, draft.id).seller.name).toBe('บริษัท ชื่อใหม่ จำกัด'); // a draft is not issued: it follows the company
    expect(filing.company.legalNameTh).toBe(oldFiling);
    expect(checkInvariants(st)).toEqual([]);
  });

  // ruling 4
  it('images: validated by the data URL header and decoded size on the server side', () => {
    const st = seed();
    const png = `data:image/png;base64,${Buffer.from('x'.repeat(100)).toString('base64')}`;
    const big = `data:image/png;base64,${Buffer.alloc(1_048_577).toString('base64')}`;
    const exactly = `data:image/png;base64,${Buffer.alloc(1_048_576).toString('base64')}`;
    expect(updateCompany(st, USER, VAT, 'images', { logoDataUrl: png, stampDataUrl: png }).logoDataUrl).toBe(png);
    expect(fe(() => updateCompany(st, USER, VAT, 'images', { logoDataUrl: big }))?.logoDataUrl).toHaveLength(1);
    expect(fe(() => updateCompany(st, USER, VAT, 'images', { logoDataUrl: exactly }))).toBeUndefined();
    expect(fe(() => updateCompany(st, USER, VAT, 'images', { logoDataUrl: 'data:image/gif;base64,AAAA' }))?.logoDataUrl).toHaveLength(1);
    expect(fe(() => updateCompany(st, USER, VAT, 'images', { stampDataUrl: 'data:text/html;base64,AAAA' }))?.stampDataUrl).toHaveLength(1);
    expect(fe(() => updateCompany(st, USER, VAT, 'images', { stampDataUrl: 'data:image/svg+xml;base64,AAAA' }))?.stampDataUrl).toHaveLength(1); // stamp: no svg
    expect(fe(() => updateCompany(st, USER, VAT, 'images', { logoDataUrl: 'data:image/svg+xml;base64,AAAA' }))).toBeUndefined(); // the logo may be svg
    expect(fe(() => updateCompany(st, USER, VAT, 'images', { logoDataUrl: 'https://evil.example/x.png' }))?.logoDataUrl).toHaveLength(1);
    expect(updateCompany(st, USER, VAT, 'images', { logoDataUrl: '' }).logoDataUrl).toBeUndefined(); // cleared
  });

  // ruling 5
  it('every section audits before / after (images redacted); an agent is refused with agent.forbidden_setting', () => {
    const st = seed();
    const base = st.audit.length;
    updateCompany(st, USER, VAT, 'contact', { tradeName: 'ชื่อการค้าใหม่', phone: '02-111-2222', email: 'a@b.example', website: 'https://x.example' });
    updateCompany(st, USER, VAT, 'payroll', { ssoEmployerAccountNo: '0987654321' });
    updateCompany(st, USER, VAT, 'notes', { defaultNotes: { QT: 'หมายเหตุใหม่' } });
    updateCompany(st, USER, VAT, 'images', { logoDataUrl: `data:image/png;base64,${Buffer.from('abc').toString('base64')}` });
    const rows = st.audit.slice(base);
    expect(rows.map((r) => r.command)).toEqual(['company.update.contact', 'company.update.payroll', 'company.update.notes', 'company.update.images']);
    expect(rows[1]).toMatchObject({ before: { ssoEmployerAccountNo: '1234567890' }, after: { ssoEmployerAccountNo: '0987654321' }, companyId: VAT });
    expect(JSON.stringify(rows[3])).not.toContain('base64'); // never the picture itself
    const n = st.audit.length;
    for (const section of ['identity', 'contact', 'payroll', 'fiscal', 'images', 'notes'] as const) {
      expect(code(() => updateCompany(st, AGENT, VAT, section, { confirm: true, tradeName: 'x' }))).toBe('agent.forbidden_setting');
    }
    expect(st.audit.length).toBe(n);
    expect(st.companies.find((c) => c.id === VAT)!.tradeName).toBe('ชื่อการค้าใหม่');
  });
  it('SSO account is 10 digits (or cleared); the filings still read it (PY3)', () => {
    const st = seed();
    expect(fe(() => updateCompany(st, USER, VAT, 'payroll', { ssoEmployerAccountNo: '123' }))?.ssoEmployerAccountNo).toHaveLength(1);
    expect((updateCompany(st, USER, VAT, 'payroll', { ssoEmployerAccountNo: '' }) as Company).ssoEmployerAccountNo).toBeUndefined();
  });
  it('default notes: only known document types, edited per company', () => {
    const st = seed();
    expect(fe(() => updateCompany(st, USER, VAT, 'notes', { defaultNotes: { WT: 'x' } }))).toBeDefined();
    updateCompany(st, USER, VAT, 'notes', { defaultNotes: { QT: '', SO: 'ใหม่' } });
    const co = st.companies.find((c) => c.id === VAT)!;
    expect(co.defaultNotes?.QT).toBeUndefined();
    expect(co.defaultNotes?.SO).toBe('ใหม่');
    expect(st.companies.find((c) => c.id === 'co-nonvat')!.defaultNotes?.SO).not.toBe('ใหม่'); // company isolation
  });
});
