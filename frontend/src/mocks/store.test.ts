import { beforeEach, describe, expect, it } from 'vitest';
import { isValidTin } from '@/domain/tin';
import { toSatang } from './engine/money';
import { loadState, resetState, saveState, seed } from './store';

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
  it('seeds the fixtures later tasks depend on', () => {
    const s = seed();
    const vat = s.parties.filter((p) => p.companyId === 'co-vat');
    expect(vat.filter((p) => p.kind === 'customer')).toHaveLength(12);
    expect(vat.filter((p) => p.kind === 'vendor')).toHaveLength(10);
    expect(s.items.filter((i) => i.companyId === 'co-vat')).toHaveLength(20);
    const nonvat = s.parties.filter((p) => p.companyId === 'co-nonvat');
    expect([nonvat.filter((p) => p.kind === 'customer').length, nonvat.filter((p) => p.kind === 'vendor').length]).toEqual([8, 6]);
    expect(s.items.filter((i) => i.companyId === 'co-nonvat')).toHaveLength(12);
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
    expect([n('draft'), n('settled'), n('partly_settled'), n('replaced')]).toEqual([6, 30, 6, 3]);
    expect(n('issued')).toBe(12);
    expect(tis.filter((d) => d.createdBy.kind === 'agent')).toHaveLength(2);
    const rcTargets = s.links.filter((l) => l.kind === 'settles').map((l) => l.to).sort();
    expect(rcTargets).toEqual(tis.filter((d) => d.status === 'settled' || d.status === 'partly_settled').map((d) => d.id).sort());
    expect(s.links.filter((l) => l.kind === 'replaces')).toHaveLength(3);
    expect(s.links.filter((l) => l.kind === 'adjusts')).toHaveLength(2);
    expect(kinds('CN')).toHaveLength(2);
    expect(s.links.filter((l) => l.kind === 'converted_from')).toHaveLength(12);
    const delivered = new Set(s.links.filter((l) => l.kind === 'converted_from').map((l) => l.to));
    expect(kinds('SO').filter((d) => d.status === 'issued' && !delivered.has(d.id))).toHaveLength(2);
    const qt = kinds('QT').find((d) => d.revision === 1)!;
    expect(qt.status).toBe('issued');
    expect(s.revisions.filter((r) => r.docId === qt.id).map((r) => r.revision)).toEqual([0, 1]);
    expect(tis.filter((d) => d.locks.some((l) => l.kind === 'filing'))).toHaveLength(1);
    for (const d of s.docs.filter((x) => x.status !== 'draft')) {
      expect(d.number).toMatch(/^[A-Z]+-\d{6}-\d{4}$/);
      expect(s.revisions.some((r) => r.docId === d.id && r.revision === 0)).toBe(true);
    }
    expect(new Set(s.docs.map((d) => d.number).filter(Boolean)).size).toBe(s.docs.filter((d) => d.number).length);
  });
  it('every seeded doc has the SP0 §7.3 correction class', () => {
    const T = ['TI', 'RC', 'CN', 'DN', 'WT'], N = ['QT', 'SO', 'DO', 'BL', 'PO'];
    const docs = seed().docs;
    expect(docs.some((d) => d.type === 'RC')).toBe(true);
    for (const d of docs) expect(d.correctionClass).toBe(T.includes(d.type) ? 'T' : N.includes(d.type) ? 'N' : 'L');
  });
});
