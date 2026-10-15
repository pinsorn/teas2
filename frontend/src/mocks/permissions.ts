import type { Role } from '@/domain/types';

const TI = ['doc.TI.read', 'doc.TI.create', 'doc.TI.issue'];
const READ = ['doc.SO.read', 'doc.DO.read', 'doc.CN.read', 'doc.DN.read'];
export const PERMISSIONS_BY_ROLE: Record<Role, string[]> = {
  operator: [...TI, 'doc.IV.read', ...READ, 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.SO.create', 'doc.IV.create', 'party.read', 'party.manage', 'item.read'],
  accountant: [...TI, 'doc.IV.read', ...READ, 'doc.TI.cancel', 'doc.TI.correct', 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.RC.cancel',
    'doc.RC.correct', 'doc.CN.create', 'doc.CN.issue', 'doc.DN.create', 'doc.DN.issue', 'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.QT.cancel', 'doc.QT.correct', 'doc.SO.create', 'doc.IV.create',
    'party.read', 'party.manage', 'item.read', 'item.manage', 'ledger.read', 'audit.read', 'report.read'],
  admin: ['settings.manage', 'users.manage', 'party.read', 'item.read', 'item.manage', 'audit.read', 'report.read'],
};
