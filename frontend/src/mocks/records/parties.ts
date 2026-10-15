import type { RecordRow } from '@/domain/records';
import type { PartySummary } from '@/domain/types';
import { isValidTin } from '@/domain/tin';
import { MockError } from '../engine/log';
import type { MockState } from '../store';
import type { RecordKindImpl } from './registry';

type Party = MockState['parties'][number];
type Values = Record<string, unknown>;

/** The `party-groups` fixture (labels are messages). */
const PARTY_GROUPS = ['general', 'major', 'government', 'foreign'];
const ENTITY_KINDS = ['individual', 'juristic', 'foreign'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
const used = (st: MockState, p: Party) => st.docs.some((d) => d.companyId === p.companyId && d.header.partyId === p.id);
const mine = (st: MockState, companyId: string, kind: PartySummary['kind']) => st.parties.filter((p) => p.companyId === companyId && p.kind === kind);

/** The flat record a form edits; the party keeps phone / email / bank details nested. */
function toRow(st: MockState, p: Party): RecordRow {
  return {
    id: p.id, version: p.version ?? 1, active: p.active !== false, inUse: used(st, p),
    entityKind: p.entityKind, code: p.code, name: p.name, nameEn: p.nameEn, taxId: p.taxId, branchCode: p.branchCode,
    vatRegistered: p.vatRegistered, address: p.address, phone: p.contact?.phone, email: p.contact?.email,
    paymentTermDays: p.paymentTermDays, partyGroup: p.partyGroup, defaultWhtTypeCode: p.defaultWhtTypeCode, notes: p.notes,
    ...(p.kind === 'vendor' ? {
      vatDRegistered: p.vatDRegistered ?? false, bankName: p.bankAccount?.bankName, bankAccountNo: p.bankAccount?.accountNo,
      bankAccountName: p.bankAccount?.accountName, usualItemIds: p.usualItemIds ?? [],
    } : {}),
  };
}

export function partyImpl(kind: PartySummary['kind']): RecordKindImpl {
  const find = (st: MockState, companyId: string, id: string) => {
    const p = mine(st, companyId, kind).find((x) => x.id === id);
    if (!p) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    return p;
  };

  /** Values -> party fields. An absent field is cleared (PUT replaces what the form edits); fields the form does not edit are kept. */
  const apply = (prev: Party | undefined, base: Pick<Party, 'id' | 'companyId'>, v: Values): Party => {
    const taxId = str(v.taxId);
    const phone = str(v.phone), email = str(v.email);
    const bank = { bankName: str(v.bankName), accountNo: str(v.bankAccountNo), accountName: str(v.bankAccountName) };
    const hasBank = kind === 'vendor' && Object.values(bank).some(Boolean);
    const next: Party = {
      ...prev, ...base, kind, entityKind: v.entityKind as Party['entityKind'], code: str(v.code)!, name: str(v.name)!,
      nameEn: str(v.nameEn), taxId, branchCode: taxId ? str(v.branchCode) : undefined, vatRegistered: v.vatRegistered === true,
      address: str(v.address), contact: phone || email ? { phone, email } : undefined,
      paymentTermDays: blank(v.paymentTermDays) ? 0 : Number(v.paymentTermDays), partyGroup: str(v.partyGroup),
      defaultWhtTypeCode: str(v.defaultWhtTypeCode), notes: str(v.notes), version: prev ? (prev.version ?? 1) + 1 : 1,
      ...(kind === 'vendor' ? {
        vatDRegistered: v.entityKind === 'foreign' && v.vatDRegistered === true, bankAccount: hasBank ? bank : undefined,
        usualItemIds: Array.isArray(v.usualItemIds) ? v.usualItemIds.filter((x): x is string => typeof x === 'string') : [],
      } : {}),
    };
    return JSON.parse(JSON.stringify(next)) as Party; // drop the undefined keys, like the stored JSON would
  };

  return {
    perms: { read: 'party.read', manage: 'party.manage' },
    rows: (st, companyId) => mine(st, companyId, kind).map((p) => toRow(st, p)),

    validate(v, st, companyId, id) {
      const e: Record<string, string[]> = {};
      const add = (k: string, m: string) => { (e[k] ??= []).push(m); };
      const entityKind = String(v.entityKind ?? '');
      if (!ENTITY_KINDS.includes(entityKind)) add('entityKind', 'ต้องระบุประเภทคู่ค้า');
      const code = str(v.code);
      const prev = id ? mine(st, companyId, kind).find((p) => p.id === id) : undefined;
      if (!code) add('code', 'ต้องระบุรหัส');
      else if (mine(st, companyId, kind).some((p) => p.code === code && p.id !== id)) add('code', 'รหัสนี้ใช้แล้ว');
      else if (prev && code !== prev.code && used(st, prev)) add('code', 'รหัสแก้ไม่ได้หลังจากใช้ในเอกสารแล้ว');
      if (!str(v.name)) add('name', 'ต้องระบุชื่อ');
      const taxId = str(v.taxId), vat = v.vatRegistered === true;
      if (taxId && !isValidTin(taxId)) add('taxId', 'เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)');
      else if (!taxId && (vat || entityKind === 'juristic')) add('taxId', 'ต้องระบุเลขประจำตัวผู้เสียภาษี');
      if (taxId && !/^\d{5}$/.test(str(v.branchCode) ?? '')) add('branchCode', 'ต้องระบุสาขา 5 หลัก');
      if (vat && !str(v.address)) add('address', kind === 'customer' ? 'ผู้ซื้อที่จดทะเบียน VAT ต้องมีที่อยู่ตามทะเบียน' : 'ผู้ขายที่จดทะเบียน VAT ต้องมีที่อยู่ตามทะเบียน');
      if (!blank(v.paymentTermDays) && !(Number.isInteger(v.paymentTermDays) && (v.paymentTermDays as number) >= 0)) add('paymentTermDays', 'ต้องเป็นจำนวนเต็มไม่น้อยกว่า 0');
      const group = str(v.partyGroup);
      if (group && !PARTY_GROUPS.includes(group)) add('partyGroup', 'กลุ่มไม่ถูกต้อง');
      const wht = str(v.defaultWhtTypeCode);
      if (wht && !st.whtTypes.some((t) => t.companyId === companyId && t.code === wht)) add('defaultWhtTypeCode', 'ไม่พบประเภทภาษีหัก ณ ที่จ่ายนี้');
      if (kind === 'vendor' && Array.isArray(v.usualItemIds) && v.usualItemIds.some((i) => !st.items.some((x) => x.companyId === companyId && x.id === i))) {
        add('usualItemIds', 'มีสินค้าที่ไม่พบในบริษัทนี้');
      }
      return e;
    },

    create(st, companyId, v) {
      const company = st.companies.find((c) => c.id === companyId)!;
      const stem = `${company.vatRegistered ? 'p' : 'n'}${kind === 'customer' ? 'c' : 'v'}`;
      const n = Math.max(0, ...st.parties.filter((p) => p.id.startsWith(`${stem}-`)).map((p) => Number(p.id.slice(stem.length + 1)) || 0)) + 1;
      const p = apply(undefined, { id: `${stem}-${String(n).padStart(2, '0')}`, companyId }, v);
      st.parties.push(p);
      return toRow(st, p);
    },

    update(st, companyId, id, v) {
      const prev = find(st, companyId, id);
      const next = apply(prev, { id, companyId }, v);
      Object.assign(prev, next);
      for (const k of Object.keys(prev) as (keyof Party)[]) if (!(k in next)) delete prev[k]; // a cleared field is gone, not stale
      return toRow(st, prev);
    },

    setActive(st, companyId, id, active) {
      const p = find(st, companyId, id);
      p.active = active;
      p.version = (p.version ?? 1) + 1;
      return toRow(st, p);
    },
  };
}
