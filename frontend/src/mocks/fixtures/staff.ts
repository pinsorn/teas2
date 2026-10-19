import type { Role, StaffMember } from '@/domain/types';

/** ST1: the people of each company. u-1 (the toolbar user, "สมศรี") holds the role the memberships give her; each company has one separate administrator. Everyone is active, none has a pending invite. */
export const staffSeed = (role: Role): StaffMember[] => [
  { id: 'usr-vat-1', companyId: 'co-vat', userId: 'u-1', name: 'สมศรี บัญชีดี', email: 'somsri@maliwan.example', roleId: role, position: 'หัวหน้าฝ่ายบัญชี', active: true, version: 1, lastLoginAt: '2026-10-14T09:00:00+07:00', invitePending: false },
  { id: 'usr-vat-2', companyId: 'co-vat', name: 'วิชัย ผู้ดูแลระบบ', email: 'wichai@maliwan.example', roleId: 'admin', position: 'ผู้จัดการทั่วไป', active: true, version: 1, lastLoginAt: '2026-10-13T16:30:00+07:00', invitePending: false },
  { id: 'usr-vat-3', companyId: 'co-vat', name: 'นภา ใจดี', email: 'napa@maliwan.example', roleId: 'operator', position: 'เจ้าหน้าที่ธุรการ', active: true, version: 1, lastLoginAt: '2026-10-12T10:15:00+07:00', invitePending: false },
  { id: 'usr-nonvat-1', companyId: 'co-nonvat', userId: 'u-1', name: 'สมศรี บัญชีดี', email: 'somsri@baantonkhao.example', roleId: 'operator', position: 'พนักงานบัญชี', active: true, version: 1, lastLoginAt: '2026-10-11T08:45:00+07:00', invitePending: false },
  { id: 'usr-nonvat-2', companyId: 'co-nonvat', name: 'ธนากร เจ้าของกิจการ', email: 'thanakorn@baantonkhao.example', roleId: 'admin', position: 'เจ้าของกิจการ', active: true, version: 1, lastLoginAt: '2026-10-10T17:00:00+07:00', invitePending: false },
];
