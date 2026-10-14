import type { Role } from '@/domain/types';

const TI = ['doc.TI.read', 'doc.TI.create', 'doc.TI.issue'];
export const PERMISSIONS_BY_ROLE: Record<Role, string[]> = {
  operator: [...TI, 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.QT.read', 'doc.QT.create', 'party.read', 'item.read'],
  accountant: [...TI, 'doc.TI.cancel', 'doc.TI.correct', 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.RC.cancel',
    'doc.RC.correct', 'doc.CN.create', 'doc.CN.issue', 'doc.DN.create', 'doc.DN.issue', 'doc.QT.read', 'doc.QT.create',
    'party.read', 'item.read', 'ledger.read', 'audit.read'],
  admin: ['settings.manage', 'users.manage', 'party.read', 'item.read', 'audit.read'],
};
