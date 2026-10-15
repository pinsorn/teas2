import { describe, expect, it } from 'vitest';
import { NAV } from '@/app-shell/nav';
import { CONVERSIONS, DOC_TYPES } from '@/domain/doc-types';
import type { DocDescriptor } from '@/domain/descriptors';
import { PERMISSIONS } from '@/domain/permissions';
import en from '@/messages/en.json';
import th from '@/messages/th.json';
import { DESCRIPTORS, descriptorByPath, docViewHref } from '.';

/** Returns every contract violation of one descriptor; [] = valid. Exported for later groups' negative tests. */
export function checkDescriptor(d: DocDescriptor): string[] {
  const e: string[] = [];
  const info = DOC_TYPES[d.type];
  if (d.correctionClass !== info.class) e.push('class');
  if (d.vat !== info.vat) e.push('vat');
  for (const [verb, code] of Object.entries(d.permissions)) {
    if (code !== `doc.${d.type}.${verb}`) e.push(`perm:${verb}`);
    if (!(code in PERMISSIONS)) e.push(`catalog:${code}`);
  }
  if (!/^\/[a-z-]+\/[a-z-]+$/.test(d.basePath)) e.push('basePath shape');
  const nav = NAV.flatMap((g) => g.items).find((i) => i.href === d.basePath);
  if (!nav || nav.permission !== d.permissions.read) e.push('nav');
  for (const t of d.convertsTo ?? []) if (!CONVERSIONS[d.type]?.includes(t)) e.push(`convert:${t}`);
  const msg = (m: unknown) => (m as Record<string, Record<string, Record<string, string>>>).docTypes?.[d.type];
  for (const k of ['title', 'issue', 'create', 'empty']) { if (!msg(th)?.[k]) e.push(`th:${k}`); if (!msg(en)?.[k]) e.push(`en:${k}`); }
  return e;
}

describe('descriptor registry', () => {
  for (const [type, d] of Object.entries(DESCRIPTORS)) {
    it(`${type} satisfies the contract`, () => {
      expect(d!.type).toBe(type);
      expect(checkDescriptor(d!)).toEqual([]);
      expect(descriptorByPath(d!.basePath)).toBe(d);
      expect(docViewHref(d!.type, 'x1')).toBe(`${d!.basePath}/x1`);
    });
  }
  it('the checker reports a broken descriptor (can fail)', () => {
    const bad = { ...DESCRIPTORS.TI!, correctionClass: 'N', vat: 'both', basePath: '/tax-invoices',
      permissions: { ...DESCRIPTORS.TI!.permissions, cancel: 'doc.TI.void' } } as DocDescriptor;
    expect(checkDescriptor(bad)).toEqual(expect.arrayContaining(['class', 'vat', 'perm:cancel', 'basePath shape']));
  });
  it('docViewHref is undefined for a type that is not built', () => { expect(docViewHref('OB', 'x')).toBeUndefined(); });
});
