import type { RecordRow } from '@/domain/records';
import { BANKS } from '@/records/bank-accounts';
import { MockError } from '../engine/log';
import type { BankAccount } from '../fixtures/bank-accounts';
import type { CompanyAccount } from '../fixtures/coa';
import type { MockState } from '../store';
import type { RecordKindImpl } from './registry';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const digits = (s: string) => s.replace(/\D/g, '');
const mine = (st: MockState, companyId: string) => st.bankAccounts.filter((b) => b.companyId === companyId);
const sub = (kind: unknown) => (kind === 'cash' ? 'cash' : 'bank');

/** SP0 §5.13: a bank / cash account's GL account is a postable current-asset account of the matching sub-class (cash box: เงินสด, bank: เงินฝากธนาคาร). */
export const bankGlAccounts = (st: MockState, companyId: string): CompanyAccount[] =>
  st.accounts.filter((a) => a.companyId === companyId && a.postable && a.class === 'asset' && a.parent === '1100' && (a.subClass === 'cash' || a.subClass === 'bank'));

/** Read-only-after-use (M1): any journal line of the company already posts to the account. History carries the code itself, so a later edit could never move it - this only refuses the edit. */
export function glUsed(st: MockState, companyId: string, accountCode: string): boolean {
  return glPoster(st, companyId, accountCode) !== undefined || bankJournalPoster(st, companyId, accountCode) !== undefined;
}
/** The first document of the company whose journal posts to the account. */
function glPoster(st: MockState, companyId: string, accountCode: string): string | undefined {
  const own = new Map(st.docs.filter((d) => d.companyId === companyId).map((d) => [d.id, d.number ?? d.id]));
  return st.journals.find((j) => own.has(j.docId) && j.preview.entries.some((e) => e.lines.some((l) => l.accountCode === accountCode)))?.docId;
}
/** The bank journal (fee / inline / opening) that posts to the account, if any: the same freeze as a document's journal. */
function bankJournalPoster(st: MockState, companyId: string, accountCode: string): string | undefined {
  return st.bankJournals.find((j) => j.companyId === companyId && j.entries.some((e) => e.lines.some((l) => l.accountCode === accountCode)))?.id;
}

/** M1: who else claims a GL account that no bank account is bound to - a posting rule that is not a bank's own Cash rule (the keyless Cash default included), or journal lines already posted to it for something else.
 *  Binding a bank to it would show those postings as the bank's own balance. Returns the reason, naming the user. */
export function glClaim(st: MockState, companyId: string, accountCode: string): string | undefined {
  const banks = new Set(mine(st, companyId).map((b) => b.id));
  const rule = st.postingRules.find((r) => r.companyId === companyId && r.accountCode === accountCode && !(r.role === 'Cash' && r.key && banks.has(r.key)));
  if (rule) return `บัญชีแยกประเภทนี้ถูกใช้โดยกฎการลงบัญชี “${rule.role}”${rule.key ? ` (${rule.key})` : ' (ค่าเริ่มต้น)'} แล้ว`;
  const docId = glPoster(st, companyId, accountCode);
  if (docId) return `มีรายการบัญชีลงที่บัญชีแยกประเภทนี้แล้ว (เอกสาร ${st.docs.find((d) => d.id === docId)?.number ?? docId}) ผูกกับบัญชีธนาคารไม่ได้`;
  if (bankJournalPoster(st, companyId, accountCode)) return 'มีรายการบัญชีจากการกระทบยอดธนาคารลงที่บัญชีแยกประเภทนี้แล้ว ผูกกับบัญชีธนาคารไม่ได้';
  return undefined;
}

/** A new document may not pick an inactive account; an old one keeps showing its own (the caller passes the document's stored account as `kept`). */
export function refuseInactiveBank(st: MockState, companyId: string, bankAccountId: string | undefined, kept?: string): void {
  if (!bankAccountId || bankAccountId === kept) return;
  const b = st.bankAccounts.find((x) => x.id === bankAccountId && x.companyId === companyId);
  if (b && b.active === false) throw new MockError(422, 'pay.inactive_bank_account', `บัญชี ${b.nameTh} ปิดใช้งานแล้ว เลือกใช้กับเอกสารใหม่ไม่ได้ เปิดใช้งานอีกครั้งได้ที่หน้าบัญชีธนาคารและเงินสด`);
}

function toRow(st: MockState, b: BankAccount): RecordRow {
  return {
    id: b.id, version: b.version ?? 1, active: b.active !== false, inUse: glUsed(st, b.companyId, b.accountCode),
    code: b.accountCode, name: b.nameTh, kind: b.kind, accountName: b.nameTh, accountCode: b.accountCode, default: b.default === true,
    ...(b.bankName ? { bankName: b.bankName } : {}), ...(b.accountNo ? { accountNo: b.accountNo } : {}),
  };
}

export const bankAccountImpl: RecordKindImpl = {
  perms: { read: 'bank.read', manage: 'bank.manage' },
  rows: (st, companyId) => mine(st, companyId).map((b) => toRow(st, b)),

  validate(v, st, companyId, id) {
    const e: Record<string, string[]> = {};
    const add = (k: string, m: string) => { (e[k] ??= []).push(m); };
    const prev = id ? mine(st, companyId).find((b) => b.id === id) : undefined;
    const kind = String(v.kind ?? '');
    if (kind !== 'bank' && kind !== 'cash') add('kind', 'ต้องเลือกประเภทบัญชี');
    if (!str(v.accountName)) add('accountName', 'ต้องระบุชื่อบัญชี');
    if (kind === 'bank') {
      if (!str(v.bankName) || !BANKS.includes(String(v.bankName))) add('bankName', 'ต้องเลือกธนาคาร');
      const no = str(v.accountNo);
      if (!no) add('accountNo', 'ต้องระบุเลขที่บัญชี');
      else if (!/^[\d-]+$/.test(no) || digits(no).length < 10 || digits(no).length > 15) add('accountNo', 'เลขที่บัญชีต้องเป็นตัวเลข 10–15 หลัก (ใส่ขีดได้)');
      else if (mine(st, companyId).some((b) => b.id !== id && b.accountNo && digits(b.accountNo) === digits(no))) add('accountNo', 'เลขที่บัญชีนี้ใช้แล้ว');
      else if (prev?.accountNo && digits(no) !== digits(prev.accountNo) && st.bankImports.some((i) => i.companyId === companyId && i.accountId === prev.id)) add('accountNo', 'แก้เลขที่บัญชีไม่ได้หลังจากนำเข้ารายการเดินบัญชีแล้ว (รายการเดิมตรวจกับเลขที่เดิม)');
    }
    const code = str(v.accountCode);
    const gl = code ? st.accounts.find((a) => a.companyId === companyId && a.code === code) : undefined;
    if (!code) add('accountCode', 'ต้องเลือกบัญชีแยกประเภท');
    else if (!gl || !bankGlAccounts(st, companyId).some((a) => a.code === code)) add('accountCode', 'ต้องเป็นบัญชีสินทรัพย์หมุนเวียนที่ลงรายการได้ (เงินสด/เงินฝากธนาคาร)');
    else if (gl.subClass !== sub(kind) && (kind === 'bank' || kind === 'cash')) add('accountCode', kind === 'cash' ? 'บัญชีเงินสดต้องใช้บัญชีหมวดเงินสด' : 'บัญชีธนาคารต้องใช้บัญชีหมวดเงินฝากธนาคาร');
    else if (mine(st, companyId).some((b) => b.id !== id && b.accountCode === code)) add('accountCode', 'บัญชีแยกประเภทนี้ผูกกับบัญชีอื่นแล้ว (หนึ่งบัญชีธนาคารต่อหนึ่งบัญชีแยกประเภท)');
    else if (code !== prev?.accountCode && glClaim(st, companyId, code)) add('accountCode', glClaim(st, companyId, code)!);
    else if (prev && code !== prev.accountCode && glUsed(st, companyId, prev.accountCode)) add('accountCode', 'แก้ไม่ได้หลังจากมีรายการบัญชีแล้ว');
    return e;
  },

  create(st, companyId, v) {
    const stem = st.companies.find((c) => c.id === companyId)!.vatRegistered ? 'ba' : 'nba';
    let n = mine(st, companyId).length + 1;
    while (st.bankAccounts.some((b) => b.id === `${stem}-${n}`)) n++;
    const b = build({ id: `${stem}-${n}`, companyId }, undefined, v);
    st.bankAccounts.push(b);
    st.postingRules.push({ companyId, level: 'default', key: b.id, role: 'Cash', accountCode: b.accountCode }); // the Cash role posts to this account for this bank
    return toRow(st, b);
  },

  update(st, companyId, id, v) {
    const prev = mine(st, companyId).find((b) => b.id === id);
    if (!prev) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    const next = build({ id, companyId }, prev, v);
    for (const k of Object.keys(prev) as (keyof BankAccount)[]) delete prev[k]; // a cleared field is gone, not stale
    Object.assign(prev, next);
    const rule = st.postingRules.find((r) => r.companyId === companyId && r.level === 'default' && r.role === 'Cash' && r.key === id);
    if (rule) rule.accountCode = prev.accountCode; else st.postingRules.push({ companyId, level: 'default', key: id, role: 'Cash', accountCode: prev.accountCode });
    return toRow(st, prev);
  },

  setActive(st, companyId, id, active) {
    const b = mine(st, companyId).find((x) => x.id === id);
    if (!b) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    b.active = active;
    b.version = (b.version ?? 1) + 1;
    return toRow(st, b);
  },

  canDeactivate: (st, companyId, id) => (mine(st, companyId).find((b) => b.id === id)?.default ? 'เป็นบัญชีตั้งต้นของเอกสารรับ/จ่ายเงินของบริษัท ปิดใช้งานไม่ได้' : undefined),
};

/** Values -> the stored account. Only the keys the form edits are read, so a body can never set `id`, `companyId`, `default`, `active` or `version`. */
function build(base: Pick<BankAccount, 'id' | 'companyId'>, prev: BankAccount | undefined, v: Record<string, unknown>): BankAccount {
  const bank = v.kind === 'bank';
  return {
    ...base, kind: bank ? 'bank' : 'cash', nameTh: str(v.accountName)!, accountCode: str(v.accountCode)!,
    ...(bank ? { bankName: str(v.bankName)!, accountNo: str(v.accountNo)! } : {}),
    ...(prev?.default ? { default: true } : {}), ...(prev?.active === false ? { active: false } : {}),
    version: prev ? (prev.version ?? 1) + 1 : 1,
  };
}
