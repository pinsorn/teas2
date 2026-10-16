import type { Role } from '@/domain/types';

const TI = ['doc.TI.read', 'doc.TI.create', 'doc.TI.issue'];
const PO = ['doc.PO.read', 'doc.PO.create', 'doc.PO.issue']; // operator: author + issue; the accountant adds cancel / correct
const READ = ['doc.SO.read', 'doc.DO.read', 'doc.CN.read', 'doc.DN.read'];
const IV = ['doc.IV.read', 'doc.IV.create', 'doc.IV.issue'], BL = ['doc.BL.read', 'doc.BL.create', 'doc.BL.issue']; // operator: create + issue; the accountant adds cancel / correct
export const PERMISSIONS_BY_ROLE: Record<Role, string[]> = {
  operator: [...TI, ...IV, ...BL, ...PO, ...READ, 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.SO.create', 'doc.SO.issue', 'doc.DO.create', 'doc.DO.issue', 'party.read', 'party.manage', 'item.read'],
  accountant: [...TI, ...IV, ...BL, ...PO, 'doc.PO.cancel', 'doc.PO.correct', 'doc.IV.cancel', 'doc.IV.correct', 'doc.BL.cancel', 'doc.BL.correct', ...READ, 'doc.TI.cancel', 'doc.TI.correct', 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.RC.cancel',
    'doc.RC.correct', 'doc.CN.create', 'doc.CN.issue', 'doc.CN.cancel', 'doc.CN.correct', 'doc.DN.create', 'doc.DN.issue', 'doc.DN.cancel', 'doc.DN.correct', 'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.QT.cancel', 'doc.QT.correct', 'doc.SO.create', 'doc.SO.issue', 'doc.SO.cancel', 'doc.SO.correct', 'doc.DO.create', 'doc.DO.issue', 'doc.DO.cancel', 'doc.DO.correct',
    'party.read', 'party.manage', 'item.read', 'item.manage', 'ledger.read', 'audit.read', 'report.read'],
  admin: ['settings.manage', 'users.manage', 'party.read', 'item.read', 'item.manage', 'audit.read', 'report.read'],
};
