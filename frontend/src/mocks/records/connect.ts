import { CLASS, isTypeAvailable } from '@/domain/doc-types';
import { PERMISSIONS } from '@/domain/permissions';
import type { Actor, DocType, IsoDate, Money } from '@/domain/types';
import { agentForbidden } from '@/contract/platform';
import type { ApiKeyBody, ApiKeyCreated, ApiKeyRow, ConsentInfo, ConsentResult, KeyKind, OAuthAppRow, PolicyMode, PolicyRow, PolicyView } from '@/records/connect';
import { FieldErrors, refuseAgent } from '../engine/company';
import { MockError, logAudit, stamp, today } from '../engine/log';
import { fromSatang, toSatang } from '../engine/money';
import { effectivePermissions, permissionsOf } from '../permissions';
import { getSettings } from '../settings';
import type { MockState } from '../store';

/** SP0 §8.1 / §8.4 / §8.5 (HC2). A key or an OAuth app is bound to one owner and one company; its rights at USE are its scopes ∩ the owner's CURRENT rights. */
export interface StoredKey { id: string; companyId: string; name: string; kind: KeyKind; prefix: string; /** hash of the secret: the secret itself is never stored */ hash: string; ownerId: string; ownerName: string;
  scopes: string[]; createdAt: string; expiresAt?: IsoDate; lastUsedAt?: string; revokedAt?: string; version: number; rotatedFrom?: string }
export interface StoredApp { id: string; companyId: string; clientId: string; name: string; ownerId: string; ownerName: string; scopes: string[]; connectedAt: string; revokedAt?: string; version: number }
export interface StoredPolicy { companyId: string; docType: DocType; mode: PolicyMode; cap: Money; version: number }

/** §8.5 + HC2a: no key, app or agent ever holds these (the rule lives in the frozen contract, contract/platform.ts). */
export { agentForbidden };
export const HARD_LIMITS = ['period', 'filing', 'settings', 'permissions', 'posting', 'numbering', 'policy', 'cancelT', 'company'];
export const POLICY_TYPES: DocType[] = ['QT', 'SO', 'DO', 'BL', 'IV', 'TI', 'RC', 'CN', 'DN', 'PO', 'PB', 'PCN', 'PDN', 'PV', 'EX'];
export const DEFAULT_CAP = '50000.00'; // D-22: only the starting value
/** Fixture OAuth clients (the mock has no registry). */
export const CLIENTS: Record<string, { name: string; scopes: string[] }> = {
  'cl-assistant': { name: 'ผู้ช่วยบัญชี (AI)', scopes: ['doc.TI.read', 'doc.TI.create', 'doc.PV.read', 'doc.PV.create', 'party.read', 'item.read', 'report.read', 'settings.manage'] },
};

/** Mock hash (cyrb53): a real server stores a salted slow hash. */
export function hashOf(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
const newSecret = (kind: KeyKind): string => `teas_${kind}_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
const PREFIX_LEN = 14;

/** The owner's rights in a company RIGHT NOW: ONE source for create and for use (m7). The signed-in user (u-1) is the toolbar role unless a custom role was given; anyone else is their staff row; a deactivated member holds nothing. */
export function ownerRights(st: MockState, companyId: string, ownerId: string): string[] {
  if (ownerId === 'u-1') return effectivePermissions(st, companyId, getSettings().role);
  const m = st.staff.find((x) => x.companyId === companyId && x.userId === ownerId);
  return m && m.active ? permissionsOf(st, companyId, m.roleId) : [];
}
const activeOwner = (st: MockState, companyId: string, ownerId: string): boolean => st.staff.some((x) => x.companyId === companyId && x.userId === ownerId && x.active);
/** Ruling 2: scopes ∩ the owner's current rights (and never a right an agent cannot hold). */
export const rightsOf = (st: MockState, companyId: string, ownerId: string, scopes: string[]): string[] => {
  const own = ownerRights(st, companyId, ownerId);
  return scopes.filter((s) => own.includes(s) && !agentForbidden(s));
};
export const scopeChoices = (ownerPerms: string[]): string[] => ownerPerms.filter((p) => !agentForbidden(p) && Object.hasOwn(PERMISSIONS, p)).sort();

const statusOf = (k: StoredKey): ApiKeyRow['status'] => (k.revokedAt ? 'revoked' : k.expiresAt && today() > k.expiresAt ? 'expired' : 'active');
/** What leaves the engine: never the hash, never the secret. */
const publicKey = (k: StoredKey): ApiKeyRow => ({ id: k.id, version: k.version, name: k.name, kind: k.kind, prefix: k.prefix, ownerName: k.ownerName, scopes: k.scopes, scopeCount: k.scopes.length,
  createdAt: k.createdAt, ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}), ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}), ...(k.revokedAt ? { revokedAt: k.revokedAt } : {}), status: statusOf(k) });
const keyOf = (st: MockState, companyId: string, id: string, who?: string): StoredKey => {
  const k = (st.apiKeys ?? []).find((x) => x.id === id && x.companyId === companyId && (!who || x.ownerId === who)); // another company's key is a 404
  if (!k) throw new MockError(404, 'record.not_found', 'ไม่พบคีย์ API นี้');
  return k;
};
const conflict = () => new MockError(409, 'record.version_conflict', 'ข้อมูลนี้ถูกแก้ไขโดยผู้อื่นแล้ว โหลดข้อมูลใหม่ก่อนบันทึก');

/** `who` = a member who may see only their own keys (absent = connect.manage: everyone's). */
export const listKeys = (st: MockState, companyId: string, who?: string): ApiKeyRow[] => (st.apiKeys ?? []).filter((k) => k.companyId === companyId && (!who || k.ownerId === who)).map(publicKey);

function insertKey(st: MockState, actor: Actor, companyId: string, owner: { id: string; name: string }, b: { name: string; kind: KeyKind; scopes: string[]; expiresAt?: IsoDate }, secret: string, command: string, rotatedFrom?: string): ApiKeyCreated {
  const keys = (st.apiKeys ??= []);
  const k: StoredKey = { id: `key-${Math.max(0, ...keys.map((x) => Number(x.id.slice(4)) || 0)) + 1}`, companyId, name: b.name, kind: b.kind, prefix: secret.slice(0, PREFIX_LEN), hash: hashOf(secret),
    ownerId: owner.id, ownerName: owner.name, scopes: b.scopes, createdAt: stamp(), ...(b.expiresAt ? { expiresAt: b.expiresAt } : {}), version: 1, ...(rotatedFrom ? { rotatedFrom } : {}) };
  keys.push(k);
  logAudit(st, actor, companyId, command, k.id, undefined, publicKey(k)); // the trail keeps the row as the list shows it
  return { key: publicKey(k), secret };
}

/** Ruling 1 + 2: the secret is made here, returned once, and stored as a hash + prefix. `ownerPerms` = the signed-in owner's rights on THIS company. */
export function createKey(st: MockState, actor: Actor, companyId: string, owner: { id: string; name: string }, v: Partial<ApiKeyBody>, secret?: string): ApiKeyCreated {
  refuseAgent(actor);
  if (!activeOwner(st, companyId, owner.id)) throw new MockError(403, 'connect.not_member', 'ต้องเป็นสมาชิกที่ใช้งานอยู่ของบริษัทนี้');
  const e: Record<string, string[]> = {};
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name || name.length > 60) e.name = ['ต้องระบุชื่อคีย์ (ไม่เกิน 60 ตัวอักษร)'];
  if (v.kind !== 'rest' && v.kind !== 'mcp') e.kind = ['ต้องเลือกชนิดคีย์'];
  const scopes = Array.isArray(v.scopes) ? v.scopes : [];
  if (!Array.isArray(v.scopes) || !scopes.length || scopes.some((s) => typeof s !== 'string' || !Object.hasOwn(PERMISSIONS, s))) e.scopes = ['ต้องเลือกสิทธิ์อย่างน้อยหนึ่งรายการจากรายการที่มี'];
  if (v.expiresAt !== undefined && v.expiresAt !== '' && (typeof v.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.expiresAt) || v.expiresAt <= today())) e.expiresAt = ['วันหมดอายุต้องเป็นวันหลังวันนี้'];
  if (Object.keys(e).length) throw new FieldErrors(e);
  const bad = (scopes as string[]).find((s) => agentForbidden(s));
  if (bad) throw new MockError(422, 'connect.scope_forbidden', `สิทธิ์ ${bad} ให้ agent ไม่ได้ (agent อนุมัติ ยกเลิก แก้ไขเอกสาร เปลี่ยนการตั้งค่า ปิดงวด หรือยื่นภาษีไม่ได้)`);
  const mine = ownerRights(st, companyId, owner.id);
  const over = (scopes as string[]).filter((s) => !mine.includes(s));
  if (over.length) throw new MockError(422, 'connect.scope_exceeds', `สิทธิ์ของคีย์ต้องไม่เกินสิทธิ์ของเจ้าของคีย์ในบริษัทนี้: ${over.join(', ')}`);
  return insertKey(st, actor, companyId, owner, { name, kind: v.kind as KeyKind, scopes: [...new Set(scopes as string[])], ...(v.expiresAt ? { expiresAt: v.expiresAt } : {}) }, secret ?? newSecret(v.kind as KeyKind), 'connect.key.create');
}

/** Rotate = a new key with the same name / kind / scopes / expiry / owner; the OLD key is revoked in the same command. */
export function rotateKey(st: MockState, actor: Actor, companyId: string, id: string, version: unknown, secret?: string): ApiKeyCreated {
  refuseAgent(actor);
  const old = keyOf(st, companyId, id, actor.id); // HC2b N2: a new key carries the OLD key's owner rights, so only that owner may ask for it; anyone else (the manager too) gets a 404
  if (version !== old.version) throw conflict();
  if (statusOf(old) === 'revoked') throw new MockError(409, 'connect.key_revoked', 'คีย์นี้ถูกเพิกถอนแล้ว สร้างคีย์ใหม่แทน');
  if (statusOf(old) === 'expired') throw new MockError(409, 'connect.key_expired', 'คีย์นี้หมดอายุแล้ว สร้างคีย์ใหม่แทน (หมุนเวียนคีย์ที่หมดอายุไม่ได้)');
  if (!activeOwner(st, companyId, old.ownerId)) throw new MockError(409, 'connect.owner_inactive', 'เจ้าของคีย์ไม่ได้ใช้งานในบริษัทนี้แล้ว หมุนเวียนคีย์ไม่ได้ เพิกถอนคีย์แทน');
  const made = insertKey(st, actor, companyId, { id: old.ownerId, name: old.ownerName }, { name: old.name, kind: old.kind, scopes: old.scopes, expiresAt: old.expiresAt }, secret ?? newSecret(old.kind), 'connect.key.rotate', old.id);
  const before = publicKey(old);
  old.revokedAt = stamp(); old.version += 1;
  logAudit(st, actor, companyId, 'connect.key.revoke', old.id, before, publicKey(old));
  return made;
}

export function revokeKey(st: MockState, actor: Actor, companyId: string, id: string, version: unknown, who?: string): ApiKeyRow {
  refuseAgent(actor);
  const k = keyOf(st, companyId, id, who);
  if (version !== k.version) throw conflict();
  if (k.revokedAt) return publicKey(k); // already there: no write, no audit
  const before = publicKey(k);
  k.revokedAt = stamp(); k.version += 1;
  logAudit(st, actor, companyId, 'connect.key.revoke', k.id, before, publicKey(k));
  return publicKey(k);
}

/** Mock auth of a presented secret: the prefix finds the key, the hash decides. Revoked / expired / other-company keys are refused; the answer carries the rights the key holds NOW. */
export function authenticateKey(st: MockState, secret: string, companyId: string): { key: ApiKeyRow; rights: string[] } {
  const k = (st.apiKeys ?? []).find((x) => x.prefix === secret.slice(0, PREFIX_LEN) && x.hash === hashOf(secret));
  if (!k) throw new MockError(401, 'connect.key_invalid', 'คีย์ API ไม่ถูกต้อง');
  if (k.revokedAt) throw new MockError(401, 'connect.key_revoked', 'คีย์ API นี้ถูกเพิกถอนแล้ว');
  if (statusOf(k) === 'expired') throw new MockError(401, 'connect.key_expired', 'คีย์ API นี้หมดอายุแล้ว');
  if (k.companyId !== companyId) throw new MockError(403, 'connect.wrong_company', 'คีย์นี้ใช้กับบริษัทอื่นไม่ได้');
  k.lastUsedAt = stamp();
  return { key: publicKey(k), rights: rightsOf(st, k.companyId, k.ownerId, k.scopes) };
}

// ---- connected OAuth apps and the consent screen ----
const publicApp = (a: StoredApp): OAuthAppRow => ({ id: a.id, version: a.version, name: a.name, ownerName: a.ownerName, scopes: a.scopes, connectedAt: a.connectedAt, ...(a.revokedAt ? { revokedAt: a.revokedAt } : {}) });
/** `who` = a member sees only the apps they consented to (absent = connect.manage: all). */
export const listApps = (st: MockState, companyId: string, who?: string): OAuthAppRow[] => (st.oauthApps ?? []).filter((a) => a.companyId === companyId && !a.revokedAt && (!who || a.ownerId === who)).map(publicApp);

export function revokeApp(st: MockState, actor: Actor, companyId: string, id: string, version: unknown, who?: string): OAuthAppRow {
  refuseAgent(actor);
  const a = (st.oauthApps ?? []).find((x) => x.id === id && x.companyId === companyId && (!who || x.ownerId === who));
  if (!a) throw new MockError(404, 'record.not_found', 'ไม่พบแอปที่เชื่อมต่อนี้');
  if (version !== a.version) throw conflict();
  if (a.revokedAt) return publicApp(a);
  const before = publicApp(a);
  a.revokedAt = stamp(); a.version += 1;
  logAudit(st, actor, companyId, 'connect.oauth.revoke', a.id, before, publicApp(a));
  return publicApp(a);
}

/** m3: a connected app holds its scopes ∩ the owner's CURRENT rights, like a key. */
export const appRights = (st: MockState, companyId: string, appId: string): string[] => {
  const a = (st.oauthApps ?? []).find((x) => x.id === appId && x.companyId === companyId && !x.revokedAt);
  return a ? rightsOf(st, companyId, a.ownerId, a.scopes) : [];
};

export function consentInfo(st: MockState, companyId: string, owner: { id: string; name: string }, clientId: string): ConsentInfo {
  const c = Object.hasOwn(CLIENTS, clientId) ? CLIENTS[clientId] : undefined;
  if (!c) throw new MockError(404, 'oauth.client_unknown', 'ไม่รู้จักแอปที่ขอเชื่อมต่อ');
  const ceiling = scopeChoices(ownerRights(st, companyId, owner.id));
  return { client: { id: clientId, name: c.name }, company: { id: companyId, name: st.companies.find((x) => x.id === companyId)?.legalNameTh ?? '' }, owner: { name: owner.name },
    requested: c.scopes, granted: c.scopes.filter((s) => ceiling.includes(s)), notGranted: c.scopes.filter((s) => !ceiling.includes(s)) };
}

/** Approve connects the app with the requested scopes the owner holds (never more); Deny connects nothing. Both are audited. */
export function decideConsent(st: MockState, actor: Actor, companyId: string, owner: { id: string; name: string }, clientId: string, decision: unknown, shownCompanyId?: unknown): ConsentResult {
  refuseAgent(actor);
  if (!activeOwner(st, companyId, owner.id)) throw new MockError(403, 'connect.not_member', 'ต้องเป็นสมาชิกที่ใช้งานอยู่ของบริษัทนี้');
  if (shownCompanyId !== companyId) throw new MockError(409, 'oauth.company_mismatch', 'บริษัทที่ใช้งานอยู่ไม่ตรงกับบริษัทที่แสดงในหน้านี้ ให้เปิดหน้าอนุญาตใหม่');
  const info = consentInfo(st, companyId, owner, clientId);
  if (decision !== 'approve' && decision !== 'deny') throw new MockError(422, 'record.invalid', 'ต้องเลือกอนุมัติหรือปฏิเสธ');
  if (decision === 'deny') { logAudit(st, actor, companyId, 'connect.oauth.deny', clientId); return { status: 'denied' }; }
  const apps = (st.oauthApps ??= []);
  let a = apps.find((x) => x.companyId === companyId && x.clientId === clientId && !x.revokedAt);
  if (a) { a.scopes = info.granted; a.ownerId = owner.id; a.ownerName = owner.name; a.connectedAt = stamp(); a.version += 1; } // connecting again replaces the grant
  else { a = { id: `app-${Math.max(0, ...apps.map((x) => Number(x.id.slice(4)) || 0)) + 1}`, companyId, clientId, name: info.client.name, ownerId: owner.id, ownerName: owner.name, scopes: info.granted, connectedAt: stamp(), version: 1 }; apps.push(a); }
  logAudit(st, actor, companyId, 'connect.oauth.approve', a.id, undefined, publicApp(a));
  return { status: 'approved', appId: a.id };
}

// ---- the agent policy (§8.4) ----
export const defaultPolicy = (type: DocType): { mode: PolicyMode; cap: Money; version: number } => ({ mode: CLASS[type] === 'T' ? 'human' : 'auto', cap: DEFAULT_CAP, version: 1 });
export const policyOf = (st: MockState, companyId: string, type: DocType): { mode: PolicyMode; cap: Money; version: number } => {
  if (!POLICY_TYPES.includes(type)) return { mode: 'off', cap: DEFAULT_CAP, version: 1 }; // HC2c: a type outside the policy table (JV, payroll, opening balance, assets, certificates ...) is never an agent's: Off, and not settable
  const s = (st.agentPolicies ?? []).find((p) => p.companyId === companyId && p.docType === type);
  return s ? { mode: s.mode, cap: s.cap, version: s.version } : defaultPolicy(type);
};
export function policyView(st: MockState, companyId: string): PolicyView {
  const vat = st.companies.find((c) => c.id === companyId)?.vatRegistered ?? false;
  return { items: POLICY_TYPES.filter((t) => isTypeAvailable(t, vat)).map((t) => ({ docType: t, ...policyOf(st, companyId, t), tClass: CLASS[t] === 'T' })), hardLimits: HARD_LIMITS };
}

/** Admin only (`connect.manage`, checked by the handler); an agent is refused first. A T-class type is never Auto; cancel / reissue are never Auto for any type. */
export function setPolicy(st: MockState, actor: Actor, companyId: string, type: string, v: Record<string, unknown>): PolicyRow {
  refuseAgent(actor);
  const t = POLICY_TYPES.find((x) => x === type);
  const vat = st.companies.find((c) => c.id === companyId)?.vatRegistered ?? false;
  if (!t || !isTypeAvailable(t, vat)) throw new MockError(404, 'record.not_found', 'ไม่พบประเภทเอกสารนี้');
  const cur = policyOf(st, companyId, t);
  if (v.version !== cur.version) throw conflict();
  const e: Record<string, string[]> = {};
  if (v.mode !== 'off' && v.mode !== 'human' && v.mode !== 'auto') e.mode = ['ต้องเลือกปิด / ให้คนอนุมัติ / อัตโนมัติถ้าไม่มีข้อสังเกต'];
  if (typeof v.cap !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(v.cap.trim()) || toSatang(v.cap.trim()) <= 0) e.cap = ['วงเงินต้องเป็นจำนวนเงินมากกว่า 0'];
  if (Object.keys(e).length) throw new FieldErrors(e);
  if (v.mode === 'auto' && CLASS[t] === 'T') throw new MockError(422, 'agent.policy_t_class', 'เอกสารกลุ่ม T (ใบกำกับภาษี ใบเสร็จรับเงิน ใบลดหนี้ ใบเพิ่มหนี้) ตั้งเป็นอัตโนมัติไม่ได้ ต้องให้คนอนุมัติ');
  const list = (st.agentPolicies ??= []);
  const row = list.find((p) => p.companyId === companyId && p.docType === t);
  const next = { mode: v.mode as PolicyMode, cap: fromSatang(toSatang((v.cap as string).trim())), version: cur.version + 1 };
  if (row) Object.assign(row, next); else list.push({ companyId, docType: t, ...next });
  logAudit(st, actor, companyId, 'agent.policy.update', t, { mode: cur.mode, cap: cur.cap }, { mode: next.mode, cap: next.cap });
  return { docType: t, ...next, tClass: CLASS[t] === 'T' };
}

/** The seed's keys and connected app: entered directly with fixed secrets (they appear nowhere in the state, only their hash). */
export function seedConnect(st: MockState, owner: { id: string; name: string }): void {
  const at = '2026-10-01T09:00:00.000Z';
  st.apiKeys = [
    { id: 'key-1', companyId: 'co-vat', name: 'ผู้ช่วยบัญชี (MCP)', kind: 'mcp', prefix: 'teas_mcp_seed0', hash: hashOf('teas_mcp_seed0-fixture'), ownerId: owner.id, ownerName: owner.name, scopes: ['report.read', 'party.read', 'item.read'], createdAt: at, lastUsedAt: '2026-10-13T08:30:00.000Z', version: 1 },
    { id: 'key-2', companyId: 'co-vat', name: 'ระบบรายงานภายนอก', kind: 'rest', prefix: 'teas_rest_seed', hash: hashOf('teas_rest_seed-fixture'), ownerId: owner.id, ownerName: owner.name, scopes: ['report.read'], createdAt: at, expiresAt: '2026-12-31', version: 1 },
  ];
  st.oauthApps = [{ id: 'app-1', companyId: 'co-vat', clientId: 'cl-desktop', name: 'Claude Desktop', ownerId: owner.id, ownerName: owner.name, scopes: ['report.read', 'party.read'], connectedAt: at, version: 1 }];
}
