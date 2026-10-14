import { describe, expect, it } from 'vitest';
import { seed } from '../store';
import { ledgerFor } from './ledger';
import { resolveRole } from './posting';

const CO = 'co-vat';

describe('posting resolution (SP0 §5.5)', () => {
  it('resolution order: item rule beats category, category beats docType, docType beats default', () => {
    const st = seed(); const ctx = { companyId: CO, docType: 'TI' as const, itemId: 'SV-01', expenseCategory: 'cat1', partyGroup: 'g1' };
    expect(resolveRole(st, 'Revenue', ctx)).toMatchObject({ code: '4100', rule: 'ค่าเริ่มต้นบริษัท: Revenue → 4100' });
    const add = (level: 'item' | 'category' | 'partyGroup' | 'docType', key: string, accountCode: string) =>
      st.postingRules.push({ companyId: CO, level, key, role: 'Revenue', accountCode });
    add('docType', 'TI', '4200');
    expect(resolveRole(st, 'Revenue', ctx)).toMatchObject({ code: '4200', rule: 'ประเภทเอกสาร TI: Revenue → 4200' });
    add('partyGroup', 'g1', '4210');
    expect(resolveRole(st, 'Revenue', ctx).code).toBe('4210'); // party group beats document type
    add('category', 'cat1', '4120');
    const cat = resolveRole(st, 'Revenue', ctx);
    expect(cat.code).toBe('4120'); // category beats party group
    expect(cat.rule).toMatch(/^หมวด/);
    add('item', 'SV-01', '4110');
    const item = resolveRole(st, 'Revenue', ctx);
    expect(item).toMatchObject({ code: '4110', name: 'รับคืนสินค้า/ลดหนี้' });
    expect(item.rule).toMatch(/^สินค้า\/บริการ SV-01: Revenue → 4110/);
    expect(resolveRole(st, 'Revenue', { companyId: CO, docType: 'TI', itemId: 'OTHER' }).code).toBe('4200'); // a rule only applies to its key
    expect(resolveRole(st, 'Revenue', { companyId: 'co-nonvat', docType: 'IV' }).code).toBe('4100'); // other company untouched
  });
  it('an unresolvable role throws posting.unresolved naming the role', () => {
    const st = seed(); st.postingRules = st.postingRules.filter((r) => r.role !== 'Revenue');
    expect(() => resolveRole(st, 'Revenue', { companyId: CO, docType: 'TI' })).toThrow(/posting\.unresolved.*Revenue/);
    st.postingRules.push({ companyId: CO, level: 'default', role: 'Revenue', accountCode: '9999' }); // a rule onto a missing account is unresolved too
    expect(() => resolveRole(st, 'Revenue', { companyId: CO, docType: 'TI' })).toThrow(/posting\.unresolved.*Revenue/);
  });
  it('keyed company defaults: WHT form accounts, bank accounts, asset classes', () => {
    const st = seed();
    expect(resolveRole(st, 'WhtPayable', { companyId: CO, docType: 'PV', whtForm: 'PND53' }).code).toBe('2132');
    expect(resolveRole(st, 'WhtPayable', { companyId: CO, docType: 'PV', whtForm: 'PND3' }).code).toBe('2131');
    expect(resolveRole(st, 'Cash', { companyId: CO, docType: 'RC', bankAccountId: 'ba-kbank' }).code).toBe('1121');
    expect(resolveRole(st, 'Cash', { companyId: CO, docType: 'RC' }).code).toBe('1120');
    expect(resolveRole(st, 'FixedAsset', { companyId: CO, docType: 'FA', assetClass: 'vehicle' }).code).toBe('1220');
  });
  it('a TI journal names the rule that chose each account (§5.5 "ดู JE")', () => {
    const st = seed(); const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'issued')!;
    expect(ledgerFor(st, ti).entries[0].lines.map((l) => l.rule)).toEqual(
      ['ค่าเริ่มต้นบริษัท: AR → 1130', 'ค่าเริ่มต้นบริษัท: Revenue → 4100', 'ค่าเริ่มต้นบริษัท: OutputVat → 2151']);
  });
  it('a docType rule changes the account a TI posts to, and the journal says why', () => {
    const st = seed(); const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'issued')!;
    st.postingRules.push({ companyId: CO, level: 'docType', key: 'TI', role: 'Revenue', accountCode: '4200' });
    const lines = ledgerFor(st, ti).entries[0].lines;
    expect(lines.map((l) => l.accountCode)).toEqual(['1130', '4200', '2151']);
    expect(lines[1].rule).toBe('ประเภทเอกสาร TI: Revenue → 4200');
  });
  it('TI / CN / RC postings keep the SP1ab account codes (1130/4100/2151, 1120/1180/1130); a CN returns through 4110', () => {
    const st = seed();
    const ti = st.docs.find((d) => d.type === 'TI' && d.status === 'issued')!;
    expect(ledgerFor(st, ti).entries[0].lines.map((l) => l.accountCode)).toEqual(['1130', '4100', '2151']);
    const cn = st.docs.find((d) => d.type === 'CN')!;
    expect(ledgerFor(st, cn).entries[0].lines.map((l) => [l.accountCode, l.debit !== '0.00'])).toEqual([['1130', false], ['4110', true], ['2151', true]]);
    const rc = { ...structuredClone(ti), type: 'RC' as const, totals: { ...ti.totals, wht: '10.00' } };
    expect(ledgerFor(st, rc).entries[0].lines.map((l) => l.accountCode)).toEqual(['1120', '1180', '1130']);
  });
});
