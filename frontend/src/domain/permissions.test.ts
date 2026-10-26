import { describe, expect, it } from 'vitest';
import { NAV } from '@/app-shell/nav';
import { PERMISSIONS_BY_ROLE } from '@/mocks/permissions';
import { DOC_TYPES } from './doc-types';
import { PERMISSIONS } from './permissions';

/** The master plan's permission catalog (docs/plans/2026-10-14-sp1c-all-screens.md): the shared contract. */
const APPROVAL = ['QT', 'SO', 'DO', 'BL', 'IV', 'TI', 'RC', 'CN', 'DN', 'PO', 'PB', 'PCN', 'PDN', 'PV', 'EX', 'JV'];
const VERBS = ['read', 'create', 'issue', 'cancel', 'correct'];
const expectedDocCodes = Object.keys(DOC_TYPES).flatMap((t) =>
  (t === 'WT' ? ['read'] : VERBS).map((v) => `doc.${t}.${v}`).concat(APPROVAL.includes(t) ? [`doc.${t}.approve`] : []));
const NON_DOC = ['doc.PR.pay', 'audit.read', 'bank.manage', 'bank.read', 'bank.reconcile', 'item.manage', 'item.read', 'ledger.coa.manage', 'ledger.posting.manage', 'ledger.read', 'ledger.period.close', 'ledger.period.reopen', 'ledger.schedule.manage', 'party.manage', 'party.read', 'payroll.read', 'employee.read', 'employee.manage', 'report.arap.read', 'report.read', 'settings.manage', 'tax.filing.finalize', 'tax.filing.preview', 'tax.read', 'tax.settings.manage', 'users.manage', 'connect.manage'];

describe('permission catalogue', () => {
  it('is exactly the master catalog for what exists today (WT read-only, approve on 16 types)', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...expectedDocCodes, ...NON_DOC].sort());
    expect(Object.keys(DOC_TYPES)).toHaveLength(21);
    expect(Object.keys(PERMISSIONS).filter((c) => c.endsWith('.approve'))).toHaveLength(16);
    expect(PERMISSIONS['doc.WT.approve']).toBeUndefined();
    expect(PERMISSIONS['doc.WT.create']).toBeUndefined();
  });
  it('has a Thai and English label for every code, and the spec labels', () => {
    for (const [code, l] of Object.entries(PERMISSIONS)) expect(l.th && l.en, code).toBeTruthy();
    expect(PERMISSIONS['doc.QT.read'].th).toBe('ดูใบเสนอราคา');
    expect(PERMISSIONS['doc.QT.correct'].th).toBe('แก้ไขใบเสนอราคาที่ออกแล้ว');
  });
  it('connect.manage is the administrator alone and gates the TEAS Connect nav item (HC2)', () => {
    expect(Object.entries(PERMISSIONS_BY_ROLE).filter(([, p]) => p.includes('connect.manage')).map(([r]) => r)).toEqual(['admin']);
    expect(NAV.flatMap((g) => g.items).find((i) => i.key === 'settingsConnect')?.permission).toBe('connect.manage');
  });
  it('every code a mock role holds and every NAV permission is in the catalogue', () => {
    for (const code of new Set(Object.values(PERMISSIONS_BY_ROLE).flat())) expect(PERMISSIONS[code], code).toBeDefined();
    for (const i of NAV.flatMap((g) => g.items)) if (i.permission) expect(PERMISSIONS[i.permission], `nav ${i.key}`).toBeDefined();
  });
});
