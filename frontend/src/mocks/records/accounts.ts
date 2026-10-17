import type { RecordRow } from '@/domain/records';
import { ACCOUNT_CLASSES, DBD_LINES, GROUP_OF, PND50_BOXES, SUB_CLASS_GROUP, type AccountClass, type AccountGroup } from '@/records/accounts';
import { formatMoney } from '@/lib/format';
import { companyEntries } from '../engine/ledger';
import { MockError } from '../engine/log';
import { fromSatang, toSatang } from '../engine/money';
import { controlExit } from '../engine/reconcile';
import type { CompanyAccount } from '../fixtures/coa';
import type { MockState } from '../store';
import type { RecordKindImpl } from './registry';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const mine = (st: MockState, companyId: string) => st.accounts.filter((a) => a.companyId === companyId);
const find = (st: MockState, companyId: string, code: string | undefined) => (code ? st.accounts.find((a) => a.companyId === companyId && a.code === code) : undefined);
const GROUP_TH: Record<AccountGroup, string> = { asset: 'สินทรัพย์', liability: 'หนี้สิน', equity: 'ส่วนของเจ้าของ', revenue: 'รายได้', expense: 'ค่าใช้จ่าย' };
const RULE_TH = { required: 'บังคับ', optional: 'ไม่บังคับ', forbidden: 'ห้ามใช้' };
const children = (st: MockState, companyId: string, code: string) => mine(st, companyId).filter((a) => a.parent === code);

/** Every account code any journal line of the company posts to, whatever wrote it (documents, JV, bank journals, settlements, opening): "used" = has a first journal line (ruling 1). */
const usedCodes = (st: MockState, companyId: string): Set<string> => {
  const used = new Set<string>();
  for (const e of companyEntries(st, companyId)) for (const l of e.lines) used.add(l.accountCode);
  return used;
};
/** Debit minus credit of the company's journal lines on the account, in satang. */
function balanceOf(st: MockState, companyId: string, code: string): number {
  let n = 0;
  for (const e of companyEntries(st, companyId)) for (const l of e.lines) if (l.accountCode === code) n += toSatang(l.debit) - toSatang(l.credit);
  return n;
}

/** What points at an account by its code (a code cannot change, and the account cannot be switched off, while one does). The bank account comes first: its own Cash rule is the same binding. */
function claimedBy(st: MockState, companyId: string, code: string): { code: 'account.bank_bound' | 'account.mapped' | 'account.scheduled'; text: string } | undefined {
  const sch = st.schedules.find((s) => s.companyId === companyId && s.kind === 'amortisation' && !s.stopped && (s.expenseAccount === code || s.prepaidAccount === code)); // AC4: a schedule froze this account
  if (sch) return { code: 'account.scheduled', text: `ตารางตัดจ่าย “${sch.name}” ใช้บัญชีนี้อยู่ หยุดตารางนั้นก่อน (หน้าตารางตัดจ่าย → หยุด)` };
  const bank = st.bankAccounts.find((b) => b.companyId === companyId && b.accountCode === code);
  if (bank) return { code: 'account.bank_bound', text: `ผูกกับบัญชีธนาคาร/เงินสด “${bank.nameTh}” แก้ที่ การเงิน → บัญชีธนาคารและเงินสด (ผูกบัญชีแยกประเภทอื่นให้บัญชีนั้นก่อน)` };
  const banks = new Set(st.bankAccounts.filter((b) => b.companyId === companyId).map((b) => b.id));
  const rules = st.postingRules.filter((r) => r.companyId === companyId && r.accountCode === code && !(r.role === 'Cash' && r.key && banks.has(r.key)));
  const name = (r: (typeof rules)[number]) => `“${r.role}”${r.key ? ` (${r.key})` : ' (ค่าเริ่มต้น)'}`;
  if (rules.length) return { code: 'account.mapped', text: `ถูกกำหนดในกฎการลงบัญชี ${name(rules[0])}${rules.length > 1 ? ` และอีก ${rules.length - 1} กฎ` : ''} แก้ที่ ตั้งค่า → การลงบัญชี (ชี้กฎไปบัญชีอื่นก่อน)` };
  const role = find(st, companyId, code)?.controlRole;
  if (role) return { code: 'account.mapped', text: `เป็นบัญชีควบคุมของบทบาท “${role}” แก้ที่ ตั้งค่า → การลงบัญชี` };
  return undefined;
}

/** The dimension rules as the list shows them (edited in ST2). */
const rulesText = (a: CompanyAccount): string | undefined => (a.dimensionRules && Object.keys(a.dimensionRules).length ? Object.entries(a.dimensionRules).map(([d, r]) => `${d}: ${RULE_TH[r]}`).join(', ') : undefined);

function toRow(a: CompanyAccount, used: Set<string>): RecordRow {
  return {
    id: a.code, version: a.version ?? 1, active: a.active !== false, inUse: used.has(a.code), code: a.code, name: a.nameTh, nameTh: a.nameTh,
    ...(a.nameEn ? { nameEn: a.nameEn } : {}), ...(a.parent ? { parent: a.parent } : {}), postable: a.postable, class: a.class, subClass: a.subClass,
    ...(a.dbdLine ? { dbdLine: a.dbdLine } : {}), ...(a.pnd50Box ? { pnd50Box: a.pnd50Box } : {}), ...(rulesText(a) ? { dimensionRules: rulesText(a) } : {}),
  };
}

/** The parent chain: is `code` the account `of` itself or somewhere below it? */
function isUnder(st: MockState, companyId: string, code: string | undefined, of: string): boolean {
  for (let c = code, n = 0; c && n < 50; n++) { if (c === of) return true; c = find(st, companyId, c)?.parent; }
  return false;
}

const FROZEN_TH: Record<string, string> = { code: 'รหัส', class: 'หมวดบัญชี', subClass: 'ประเภทย่อย', postable: 'การลงรายการ', parent: 'บัญชีหมวดที่อยู่ภายใต้ (ย้ายข้ามหมวดบัญชี)' };

export const accountImpl: RecordKindImpl = {
  perms: { read: 'ledger.read', manage: 'ledger.coa.manage' },
  rows: (st, companyId) => { const used = usedCodes(st, companyId); return mine(st, companyId).map((a) => toRow(a, used)); },

  validate(v, st, companyId, id) {
    const prev = find(st, companyId, id);
    const e: Record<string, string[]> = {};
    const add = (k: string, m: string) => { (e[k] ??= []).push(m); };
    const code = str(v.code), parent = str(v.parent), cls = str(v.class) as AccountClass | undefined, sub = str(v.subClass);
    const postable = typeof v.postable === 'boolean' ? v.postable : (prev?.postable ?? true);
    const classOk = !!cls && (ACCOUNT_CLASSES as readonly string[]).includes(cls), parentRow = find(st, companyId, parent);

    // ruling 1: once an account has a journal line its code, class, sub-class, posting flag and the class of its parent are read-only
    if (prev && usedCodes(st, companyId).has(prev.code)) {
      const oldParent = find(st, companyId, prev.parent);
      const changed = ([['code', code !== prev.code], ['class', cls !== prev.class], ['subClass', sub !== prev.subClass], ['postable', postable !== prev.postable],
        ['parent', (parent ?? undefined) !== prev.parent && parentRow?.class !== oldParent?.class]] as const).filter(([, c]) => c).map(([k]) => FROZEN_TH[k]);
      if (changed.length) throw new MockError(422, 'account.in_use', `แก้${changed.join(' / ')}ของบัญชี ${prev.code} ไม่ได้ เพราะมีรายการบัญชีแล้ว (แก้ชื่อและการจับคู่งบการเงินได้ ถ้าต้องการเปลี่ยนให้เปิดบัญชีใหม่แล้วโอนยอดด้วยสมุดรายวัน)`);
    }

    // a controlled account (one a document / screen owns) is never reclassified out of control, used or not
    if (prev && (cls !== prev.class || sub !== prev.subClass) && (controlExit(st, companyId, prev.code) || controlExit(st, companyId, prev.code, 'jv'))) {
      throw new MockError(422, 'account.controlled', `แก้หมวดบัญชี/ประเภทย่อยของบัญชี ${prev.code} ไม่ได้ เพราะเป็นบัญชีควบคุมที่เอกสารหรือหน้าจอเฉพาะเป็นเจ้าของ (${controlExit(st, companyId, prev.code, 'jv') ?? controlExit(st, companyId, prev.code)})`);
    }
    if (!code || !/^\d{4,6}$/.test(code)) add('code', 'รหัสบัญชีต้องเป็นตัวเลข 4–6 หลัก');
    else if (mine(st, companyId).some((a) => a.code === code && a.code !== id)) add('code', 'รหัสบัญชีนี้ใช้แล้ว');
    else if (prev && code !== prev.code) {
      const claim = claimedBy(st, companyId, prev.code);
      if (claim) add('code', `เปลี่ยนรหัสไม่ได้ ${claim.text}`);
    }
    if (!str(v.nameTh)) add('nameTh', 'ต้องระบุชื่อบัญชี');
    if (!classOk) add('class', 'ต้องเลือกหมวดบัญชี');
    if (!sub || !(sub in SUB_CLASS_GROUP)) add('subClass', 'ต้องเลือกประเภทย่อย');
    else if (classOk && SUB_CLASS_GROUP[sub] !== 'any' && SUB_CLASS_GROUP[sub] !== GROUP_OF[cls]) add('subClass', 'ประเภทย่อยนี้ไม่ใช่ของหมวดบัญชีที่เลือก');
    if (str(v.dbdLine) && !(DBD_LINES as readonly string[]).includes(str(v.dbdLine)!)) add('dbdLine', 'ไม่พบบรรทัดงบการเงิน (DBD) นี้');
    if (str(v.pnd50Box) && !(PND50_BOXES as readonly string[]).includes(str(v.pnd50Box)!)) add('pnd50Box', 'ไม่พบช่อง ภ.ง.ด.50 นี้');

    if (parent) {
      if (!parentRow) add('parent', 'ไม่พบบัญชีหมวดนี้');
      else if (parentRow.postable) add('parent', 'ต้องเลือกบัญชีหมวด (ไม่ใช่บัญชีที่ลงรายการได้)');
      else if (prev && isUnder(st, companyId, parent, prev.code)) add('parent', 'ย้ายบัญชีหมวดไปไว้ใต้ตัวเองหรือบัญชีย่อยของตัวเองไม่ได้');
      else if (classOk && GROUP_OF[parentRow.class] !== GROUP_OF[cls]) add('parent', `ย้ายไปไว้ใต้บัญชีหมวดของหมวดอื่นไม่ได้ (หมวด${GROUP_TH[GROUP_OF[parentRow.class]]} ≠ หมวด${GROUP_TH[GROUP_OF[cls]]})`);
    } else if (postable) add('parent', 'บัญชีที่ลงรายการได้ต้องอยู่ใต้บัญชีหมวด');
    if (prev && children(st, companyId, prev.code).length) { // a header with sub-accounts stays a header of its group
      if (postable) add('postable', 'บัญชีหมวดที่มีบัญชีย่อยเปลี่ยนเป็นบัญชีที่ลงรายการได้ไม่ได้');
      if (classOk && GROUP_OF[cls] !== GROUP_OF[prev.class]) add('class', 'เปลี่ยนหมวดของบัญชีหมวดที่มีบัญชีย่อยไม่ได้');
    }
    return e;
  },

  create(st, companyId, v) {
    const a: CompanyAccount = { ...build(v), companyId, version: 1 };
    st.accounts.push(a);
    return toRow(a, usedCodes(st, companyId));
  },

  update(st, companyId, id, v) {
    const prev = find(st, companyId, id);
    if (!prev) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    const next = build(v);
    if (next.code !== prev.code) for (const c of children(st, companyId, prev.code)) c.parent = next.code; // sub-accounts follow their header's new code
    const { controlRole, dimensionRules, active } = prev;
    for (const k of Object.keys(prev) as (keyof CompanyAccount)[]) delete prev[k]; // a cleared field is gone, not stale
    Object.assign(prev, next, { companyId, version: (prev.version ?? 1) + 1 }, controlRole ? { controlRole } : {}, dimensionRules ? { dimensionRules } : {}, active === false ? { active } : {});
    return toRow(prev, usedCodes(st, companyId));
  },

  setActive(st, companyId, id, active) {
    const a = find(st, companyId, id);
    if (!a) throw new MockError(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
    a.active = active;
    a.version = (a.version ?? 1) + 1;
    return toRow(a, usedCodes(st, companyId));
  },

  /** Ruling 2: each refusal names the way out. Thrown (not returned) so the problem carries its own `account.*` code. */
  canDeactivate(st, companyId, id) {
    const a = find(st, companyId, id);
    if (!a) return undefined;
    const no = (code: string, why: string) => new MockError(409, code, `ปิดใช้งานบัญชี ${a.code} ${a.nameTh} ไม่ได้: ${why}`);
    const claim = claimedBy(st, companyId, a.code);
    if (claim) throw no(claim.code, claim.text);
    const live = children(st, companyId, a.code).filter((c) => c.active !== false);
    if (live.length) throw no('account.has_children', `ยังมีบัญชีย่อยที่ใช้งานอยู่ ${live.length} บัญชี (เช่น ${live[0].code}) ย้ายหรือปิดบัญชีย่อยก่อน`);
    const bal = balanceOf(st, companyId, a.code);
    if (bal !== 0) {
      const owner = controlExit(st, companyId, a.code, 'jv'); // a controlled account is emptied by its own document / screen; any other by a journal voucher
      throw no('account.has_balance', `ยังมียอดคงเหลือ ${formatMoney(fromSatang(Math.abs(bal)))} บาท (${bal > 0 ? 'เดบิต' : 'เครดิต'}) ${owner ? `ล้างยอดที่ต้นทาง: ${owner}` : 'โอนยอดออกด้วยสมุดรายวัน'}`);
    }
    return undefined;
  },
};

/** Values -> the stored account. Only the keys the form edits are read, so a body can never set `companyId`, `controlRole`, `active` or `version`. */
function build(v: Record<string, unknown>): CompanyAccount {
  const cls = str(v.class) as AccountClass, parent = str(v.parent);
  return {
    code: str(v.code)!, nameTh: str(v.nameTh)!, class: cls, subClass: str(v.subClass)!, postable: typeof v.postable === 'boolean' ? v.postable : true,
    ...(str(v.nameEn) ? { nameEn: str(v.nameEn) } : {}), ...(parent ? { parent } : {}), ...(str(v.dbdLine) ? { dbdLine: str(v.dbdLine) } : {}), ...(str(v.pnd50Box) ? { pnd50Box: str(v.pnd50Box) } : {}),
    companyId: '',
  };
}
