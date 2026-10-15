import { describe, expect, it } from 'vitest';
import { NAV } from '@/app-shell/nav';
import { PERMISSIONS } from '@/domain/permissions';
import th from '@/messages/th.json';
import { RECORDS, recordByPath } from '@/records';
import type { RecordDescriptor } from './records';

export function checkRecord(r: RecordDescriptor): string[] {
  const e: string[] = [];
  if (!(r.permissions.read in PERMISSIONS)) e.push('read perm');
  if (!(r.permissions.manage in PERMISSIONS)) e.push('manage perm');
  const nav = NAV.flatMap((g) => g.items).find((i) => i.href === r.basePath);
  if (!nav || nav.permission !== r.permissions.read) e.push('nav');
  const get = (k: string) => k.split('.').reduce<unknown>((a, x) => (a as Record<string, unknown>)?.[x], th);
  for (const k of [r.titleKey, r.searchPlaceholderKey, ...r.columns.map((c) => c.labelKey), ...r.fields.map((f) => f.labelKey),
    ...r.fields.flatMap((f) => f.options?.map((o) => o.labelKey) ?? [])]) if (typeof get(k) !== 'string') e.push(`msg:${k}`);
  for (const f of r.fields) if (f.showWhen && !r.fields.some((g) => g.key === f.showWhen!.key)) e.push(`showWhen:${f.key}`);
  for (const f of r.fields) for (const c of f.requiredWhen ?? []) if (!r.fields.some((g) => g.key === c.key)) e.push(`requiredWhen:${f.key}`);
  return e;
}
describe('record registry', () => {
  for (const [kind, r] of Object.entries(RECORDS)) it(`${kind} satisfies the contract`, () => {
    expect(checkRecord(r!)).toEqual([]); expect(recordByPath(r!.basePath)).toBe(r);
  });
  it('M1 registers customers and vendors', () => expect(Object.keys(RECORDS).sort()).toEqual(['customer', 'vendor']));
  it('the checker reports a broken record (can fail)', () => {
    expect(checkRecord({ ...RECORDS.customer!, permissions: { read: 'nope', manage: 'party.manage' }, titleKey: 'no.such' }))
      .toEqual(expect.arrayContaining(['read perm', 'msg:no.such']));
  });
  it('the checker reports a broken showWhen (can fail)', () => {
    const c = RECORDS.customer!;
    expect(checkRecord({ ...c, fields: [...c.fields, { key: 'x', kind: 'text', labelKey: 'records.fields.name', showWhen: { key: 'ghost', equals: true } }] }))
      .toEqual(['showWhen:x']);
  });
});
