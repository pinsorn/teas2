import { describe, expect, it } from 'vitest';
import { DOC_TYPES } from './doc-types';
import { PERMISSIONS } from './permissions';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';

describe('permission catalogue', () => {
  it('has a Thai and English label for every code a role holds', () => {
    for (const code of new Set(Object.values(PERMISSIONS_BY_ROLE).flat())) {
      expect(PERMISSIONS[code], code).toBeDefined();
      expect(PERMISSIONS[code].th && PERMISSIONS[code].en, code).toBeTruthy();
    }
  });
  it('covers doc.<T>.{read,create,issue,cancel,correct} for all 21 types', () => {
    expect(Object.keys(DOC_TYPES)).toHaveLength(21);
    for (const t of Object.keys(DOC_TYPES)) for (const v of ['read', 'create', 'issue', 'cancel', 'correct']) expect(PERMISSIONS[`doc.${t}.${v}`], `${t}.${v}`).toBeDefined();
    expect(PERMISSIONS['doc.QT.read'].th).toBe('ดูใบเสนอราคา');
    expect(PERMISSIONS['doc.QT.correct'].th).toBe('แก้ไขใบเสนอราคาที่ออกแล้ว');
  });
});
