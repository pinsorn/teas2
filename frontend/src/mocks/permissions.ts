import type { Role } from '@/domain/types';

const TI = ['doc.TI.read', 'doc.TI.create', 'doc.TI.issue'];
const PO = ['doc.PO.read', 'doc.PO.create', 'doc.PO.issue']; // operator: author + issue; the accountant adds cancel / correct
const PB = ['doc.PB.read', 'doc.PB.create', 'doc.PB.issue']; // operator: records and issues a bill; the accountant adds cancel / correct and the vendor notes
const PB_ALL = [...PB, 'doc.PB.cancel', 'doc.PB.correct', ...['PCN', 'PDN'].flatMap((t) => ['read', 'create', 'issue', 'cancel', 'correct'].map((v) => `doc.${t}.${v}`))];
const PV = ['doc.PV.read', 'doc.PV.create', 'doc.PV.issue', 'doc.WT.read']; // operator: pays vendors and hands over the 50 tawi it issues (WT is read-only for every role); the accountant adds cancel / correct
const PV_ALL = [...PV, 'doc.PV.cancel', 'doc.PV.correct', 'doc.PV.approve']; // the accountant approves a voucher the policy wants approved (above 50,000.00)
const EX = ['doc.EX.read', 'doc.EX.create', 'doc.EX.issue']; // operator: files and (once approved) issues an expense claim; the accountant approves it and adds cancel / correct
const EX_ALL = [...EX, 'doc.EX.cancel', 'doc.EX.correct', 'doc.EX.approve'];
const JV_ALL = ['read', 'create', 'issue', 'cancel', 'correct', 'approve'].map((v) => `doc.JV.${v}`); // JV is accountant-only (§3.1)
const OB_ALL = ['read', 'create', 'issue', 'cancel', 'correct'].map((v) => `doc.OB.${v}`); // opening balances (AC3) are the accountant's
const READ = ['doc.SO.read', 'doc.DO.read', 'doc.CN.read', 'doc.DN.read'];
const IV = ['doc.IV.read', 'doc.IV.create', 'doc.IV.issue'], BL = ['doc.BL.read', 'doc.BL.create', 'doc.BL.issue']; // operator: create + issue; the accountant adds cancel / correct
export const PERMISSIONS_BY_ROLE: Record<Role, string[]> = {
  operator: [...TI, ...IV, ...BL, ...PO, ...PB, ...PV, ...EX, 'doc.PCN.read', 'doc.PDN.read', ...READ, 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.SO.create', 'doc.SO.issue', 'doc.DO.create', 'doc.DO.issue', 'party.read', 'party.manage', 'item.read', 'bank.read'],
  accountant: [...TI, ...IV, ...BL, ...PO, ...PB_ALL, ...PV_ALL, ...EX_ALL, ...JV_ALL, ...OB_ALL, 'doc.PO.cancel', 'doc.PO.correct', 'doc.IV.cancel', 'doc.IV.correct', 'doc.BL.cancel', 'doc.BL.correct', ...READ, 'doc.TI.cancel', 'doc.TI.correct', 'doc.RC.read', 'doc.RC.create', 'doc.RC.issue', 'doc.RC.cancel',
    'doc.RC.correct', 'doc.CN.create', 'doc.CN.issue', 'doc.CN.cancel', 'doc.CN.correct', 'doc.DN.create', 'doc.DN.issue', 'doc.DN.cancel', 'doc.DN.correct', 'doc.QT.read', 'doc.QT.create', 'doc.QT.issue', 'doc.QT.cancel', 'doc.QT.correct', 'doc.SO.create', 'doc.SO.issue', 'doc.SO.cancel', 'doc.SO.correct', 'doc.DO.create', 'doc.DO.issue', 'doc.DO.cancel', 'doc.DO.correct',
    'party.read', 'party.manage', 'item.read', 'item.manage', 'ledger.read', 'ledger.coa.manage', 'audit.read', 'report.read', 'bank.read', 'bank.manage', 'bank.reconcile'],
  admin: ['settings.manage', 'users.manage', 'party.read', 'item.read', 'item.manage', 'audit.read', 'report.read', 'bank.read', 'bank.manage'],
};
