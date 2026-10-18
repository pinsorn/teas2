import { DOC_TYPES } from '@/domain/doc-types';
import { isValidTin } from '@/domain/tin';
import type { Actor, Company, CompanySettings, DocType } from '@/domain/types';
import type { MockState } from '../store';
import { MockError, logAudit } from './log';
import { branchLabel } from './paper';

/** A 422 that names the fields (the handlers turn it into problem+json with `fieldErrors`; the forms put each message under its field). */
export class FieldErrors extends MockError {
  constructor(public fieldErrors: Record<string, string[]>) { super(422, 'record.invalid', 'ข้อมูลไม่ถูกต้อง ตรวจสอบช่องที่มีเครื่องหมาย'); }
}
/** §8.5: an agent never changes settings, permissions or users. Every settings write starts here. */
export function refuseAgent(actor: Actor): void {
  if (actor.kind === 'agent') throw new MockError(403, 'agent.forbidden_setting', 'ตัวแทน (agent) เปลี่ยนการตั้งค่าไม่ได้ ต้องให้ผู้ใช้ทำเอง');
}

export type CompanySection = 'identity' | 'contact' | 'payroll' | 'fiscal' | 'images' | 'notes';
export const SECTIONS: CompanySection[] = ['identity', 'contact', 'payroll', 'fiscal', 'images', 'notes'];
/** The document types a default note can be set for: the ones with a notes field on the paper (not certificates, journals, assets, depreciation, payroll, opening balances). */
export const NOTE_TYPES = (Object.keys(DOC_TYPES) as DocType[]).filter((t) => !['WT', 'JV', 'FA', 'DP', 'PR', 'OB'].includes(t));
export const MAX_IMAGE_BYTES = 1_048_576;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const find = (st: MockState, companyId: string): Company => {
  const c = st.companies.find((x) => x.id === companyId);
  if (!c) throw new MockError(404, 'company.not_found', 'ไม่พบบริษัท');
  return c;
};
/** A period is closed anywhere in the company: the fiscal year can no longer move (the exit is to reopen the periods). */
export const fiscalYearLocked = (st: MockState, companyId: string): boolean => st.periods.some((p) => p.companyId === companyId && p.status === 'closed');
export const companySettings = (st: MockState, companyId: string): CompanySettings => ({ ...find(st, companyId), fiscalYearLocked: fiscalYearLocked(st, companyId) });

/** The data URL header decides the type (never a file name) and the decoded size is counted here: the input's own check is only a courtesy. */
export function imageError(v: unknown): string | undefined {
  if (typeof v !== 'string') return 'รูปภาพไม่ถูกต้อง';
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(v); // svg is never accepted
  if (!m) return 'รองรับเฉพาะไฟล์ PNG, JPEG หรือ WebP';
  const bytes = Math.floor((m[2].length * 3) / 4) - (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  return bytes > MAX_IMAGE_BYTES ? 'ไฟล์ใหญ่เกิน 1 MB' : undefined;
}

type Errors = Record<string, string[]>;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(section: CompanySection, v: Record<string, unknown>): Errors {
  const e: Errors = {};
  const add = (k: string, m: string) => { (e[k] ??= []).push(m); };
  if (section === 'identity') {
    if (!str(v.legalNameTh)) add('legalNameTh', 'ต้องระบุชื่อนิติบุคคล');
    if (!isValidTin(str(v.taxId))) add('taxId', 'เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (ตรวจสอบหลักสุดท้าย)');
    if (!/^\d{5}$/.test(str(v.branchCode))) add('branchCode', 'ต้องระบุสาขา 5 หลัก');
    if (!str(v.address)) add('address', 'ต้องระบุที่อยู่ตามทะเบียน');
    if (str(v.paidUpCapital) && !/^\d+(\.\d{1,2})?$/.test(str(v.paidUpCapital))) add('paidUpCapital', 'จำนวนเงินไม่ถูกต้อง');
  } else if (section === 'contact') {
    if (str(v.email) && !EMAIL.test(str(v.email))) add('email', 'อีเมลไม่ถูกต้อง');
    if (str(v.website) && !/^https?:\/\/\S+$/.test(str(v.website))) add('website', 'เว็บไซต์ต้องขึ้นต้นด้วย http:// หรือ https://');
  } else if (section === 'payroll') {
    if (str(v.ssoEmployerAccountNo) && !/^\d{10}$/.test(str(v.ssoEmployerAccountNo))) add('ssoEmployerAccountNo', 'เลขที่บัญชีนายจ้างประกันสังคมต้องเป็นตัวเลข 10 หลัก');
  } else if (section === 'images') {
    for (const k of ['logoDataUrl', 'stampDataUrl'] as const) { // ST1b m1 / m6: a string data URL (png / jpeg / webp, never svg) or nothing: '' and null clear, anything else is refused
      if (k in v && v[k] !== '' && v[k] !== null) { const m = imageError(v[k]); if (m) add(k, m); }
    }
  } else if (section === 'notes') {
    const notes = v.defaultNotes;
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) add('defaultNotes', 'ข้อมูลไม่ถูกต้อง');
    else for (const [t, text] of Object.entries(notes)) {
      if (!NOTE_TYPES.includes(t as DocType)) add('defaultNotes', `ไม่รู้จักประเภทเอกสาร ${t}`);
      else if (typeof text !== 'string' || text.length > 1000) add(`defaultNotes.${t}`, 'หมายเหตุยาวเกิน 1,000 ตัวอักษร');
    }
  }
  return e;
}

/** I3: an issued document keeps the seller it was issued under. Papers read the company live, so before the legal identity (or the phone it prints) changes, every issued document that has no snapshot yet takes the old one. */
function freezeSeller(st: MockState, co: Company): void {
  const seller = { name: co.legalNameTh, nameEn: co.legalNameEn, address: co.address, phone: co.phone, taxId: co.taxId, branchLabel: branchLabel(co.branchCode) };
  for (const d of st.docs) if (d.companyId === co.id && (d.issuedAt || d.number) && !d.sellerSnapshot) d.sellerSnapshot = { ...seller };
}

const SECTION_FIELDS: Record<CompanySection, (keyof Company)[]> = {
  identity: ['legalNameTh', 'legalNameEn', 'taxId', 'branchCode', 'registrationNo', 'address', 'paidUpCapital'],
  contact: ['tradeName', 'phone', 'email', 'website'],
  payroll: ['ssoEmployerAccountNo'],
  fiscal: ['fiscalYearStartMonth'],
  images: ['logoDataUrl', 'stampDataUrl'],
  notes: ['defaultNotes'],
};
/** What the audit trail keeps of a field: a picture is only "set / not set" (the data URL stays out of the trail). */
const audited = (co: Company, fields: (keyof Company)[]) => Object.fromEntries(fields.map((k) => [k, k === 'logoDataUrl' || k === 'stampDataUrl' ? (co[k] ? 'set' : 'none') : co[k]]));

/** One Save of one section of the company page. Agents are refused; a refusal writes nothing (no change, no audit row). */
export function updateCompany(st: MockState, actor: Actor, companyId: string, section: CompanySection, v: Record<string, unknown>): CompanySettings {
  refuseAgent(actor);
  const co = find(st, companyId);
  if (!SECTIONS.includes(section)) throw new MockError(404, 'company.section_unknown', 'ไม่รู้จักส่วนของข้อมูลบริษัท');
  const fields = SECTION_FIELDS[section];
  if ('version' in v && v.version !== (co.version ?? 1)) throw new MockError(409, 'record.version_conflict', 'ข้อมูลบริษัทถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลล่าสุดก่อนบันทึก');
  const before = audited(co, fields);
  if (section === 'identity') {
    if (v.vatRegistered !== undefined && v.vatRegistered !== co.vatRegistered) throw new MockError(422, 'company.vat_readonly', 'เปลี่ยนสถานะ VAT ที่นี่ไม่ได้ การเปลี่ยนสถานะ VAT ทำผ่านการตั้งค่าภาษี');
    const errors = validate(section, v);
    if (Object.keys(errors).length) throw new FieldErrors(errors);
    if (v.confirm !== true) throw new MockError(422, 'company.confirm_required', 'ต้องยืนยันก่อนแก้ไขข้อมูลตามทะเบียน เอกสารที่ออกแล้วยังคงแสดงข้อมูลเดิม');
  } else if (section === 'fiscal') {
    const m = v.fiscalYearStartMonth;
    if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 12) throw new FieldErrors({ fiscalYearStartMonth: ['เดือนเริ่มต้นปีบัญชีต้องเป็น 1–12'] });
    if (m === co.fiscalYearStartMonth) return companySettings(st, companyId); // nothing to change
    if (fiscalYearLocked(st, companyId)) throw new MockError(409, 'company.fiscal_year_locked', 'แก้ไขเดือนเริ่มต้นปีบัญชีไม่ได้ เพราะมีงวดที่ปิดแล้ว ทางออก: ติดต่อผู้ดูแลระบบเพื่อเปิดงวดก่อน');
    // [SP-R] the whole engine (period close, CIT, P&L, ภ.ง.ด.1ก) assumes the calendar year: a value it would silently ignore is never stored. Ham decides at GST.
    if (m !== 1) throw new MockError(422, 'company.fiscal_year_unsupported', 'ระบบรองรับเฉพาะปีบัญชีตามปีปฏิทินในขณะนี้');
  } else {
    const errors = validate(section, v);
    if (Object.keys(errors).length) throw new FieldErrors(errors);
  }

  if (section === 'identity' || section === 'contact') freezeSeller(st, co);
  const put = (k: keyof Company, x: unknown) => { if (x === '' || x === undefined || x === null) delete co[k]; else (co as unknown as Record<string, unknown>)[k] = x; };
  if (section === 'identity') {
    for (const k of ['legalNameTh', 'taxId', 'branchCode', 'address'] as const) co[k] = str(v[k]);
    for (const k of ['legalNameEn', 'registrationNo', 'paidUpCapital'] as const) put(k, str(v[k]));
  } else if (section === 'contact') {
    for (const k of ['tradeName', 'phone', 'email', 'website'] as const) put(k, str(v[k]));
  } else if (section === 'payroll') {
    put('ssoEmployerAccountNo', str(v.ssoEmployerAccountNo));
  } else if (section === 'fiscal') {
    co.fiscalYearStartMonth = v.fiscalYearStartMonth as number;
  } else if (section === 'images') { // an absent key keeps the picture; an empty one removes it
    if ('logoDataUrl' in v) put('logoDataUrl', v.logoDataUrl);
    if ('stampDataUrl' in v) put('stampDataUrl', v.stampDataUrl);
  } else {
    const notes = { ...(co.defaultNotes ?? {}) };
    for (const [t, text] of Object.entries(v.defaultNotes as Record<string, string>)) { if (text.trim()) notes[t as DocType] = text; else delete notes[t as DocType]; }
    co.defaultNotes = notes;
  }
  co.version = (co.version ?? 1) + 1;
  logAudit(st, actor, companyId, `company.update.${section}`, companyId, before, audited(co, fields));
  return companySettings(st, companyId);
}
