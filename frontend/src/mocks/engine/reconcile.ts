import { LIVE } from '@/domain/doc-types';
import type { AccountingRole } from './posting';
import type { Actor, BankJournal, BankLine, BankMatch, IsoDate, JournalEntryPreview, Money } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import type { BankAccount } from '../fixtures/bank-accounts';
import type { MockState } from '../store';
import { correctionReversal, dateGuards } from './commands';
import { companyEntries } from './ledger';
import { docCash } from './locks';
import { MockError, logActivity, logAudit, stamp, today } from './log';
import { fromSatang, toSatang } from './money';
import { resolveRole } from './posting';
import { resolvedBankId } from './settlement';

type Stored = MockState['docs'][number];
type StoredLine = MockState['bankLines'][number];
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const abs = (n: number) => Math.abs(n);

/** SP0 G4: the VAT and withholding control accounts are written by documents only. */
const TAX_ROLES: AccountingRole[] = ['OutputVat', 'InputVat', 'InputVatUnclaimed', 'Pnd36VatPayable', 'WhtReceivable', 'WhtPayable', 'WhtExpense'];
/** SP0 5.2.5: a receivable / payable line is under a party. */
const PARTY_ROLES: { role: AccountingRole; kind: 'customer' | 'vendor' | 'employee' }[] = [{ role: 'AR', kind: 'customer' }, { role: 'AP', kind: 'vendor' }, { role: 'EmployeePayable', kind: 'employee' }];

/** The roles an account of the company plays: its chart `controlRole` and every posting rule that points at it. */
export function rolesOf(st: MockState, companyId: string, code: string): AccountingRole[] {
  const a = st.accounts.find((x) => x.companyId === companyId && x.code === code);
  return [...new Set([...(a?.controlRole ? [a.controlRole] : []), ...st.postingRules.filter((r) => r.companyId === companyId && r.accountCode === code).map((r) => r.role)])];
}
export const isTaxControl = (st: MockState, companyId: string, code: string) => rolesOf(st, companyId, code).some((r) => TAX_ROLES.includes(r));
export const partyKindOf = (st: MockState, companyId: string, code: string) => PARTY_ROLES.find((p) => rolesOf(st, companyId, code).includes(p.role))?.kind;

const bankOf = (st: MockState, companyId: string, accountId: string): BankAccount => {
  const b = st.bankAccounts.find((x) => x.id === accountId && x.companyId === companyId);
  if (!b) throw fail(404, 'record.not_found', 'ไม่พบข้อมูลนี้');
  return b;
};
function lineOf(st: MockState, companyId: string, lineId: string): StoredLine {
  const l = st.bankLines.find((x) => x.id === lineId && x.companyId === companyId);
  if (!l) throw fail(404, 'record.not_found', 'ไม่พบรายการเดินบัญชีนี้');
  return l;
}
/** A line as the API returns it: no company, `locked` derived from the account's reconciled-to date. */
export function publicLine(st: MockState, l: StoredLine): BankLine {
  const { companyId, ...rest } = l;
  const to = st.bankAccounts.find((b) => b.id === l.accountId && b.companyId === companyId)?.reconciledTo;
  return { ...rest, ...(to && l.date <= to ? { locked: true } : {}) };
}
const isLocked = (st: MockState, l: StoredLine) => publicLine(st, l).locked === true;

/** What of a document's cash is already matched on bank lines (satang, positive). */
export const matchedPortion = (st: MockState, docId: string): number =>
  st.bankLines.reduce((n, l) => n + (l.matches ?? []).filter((m) => m.docId === docId).reduce((x, m) => x + toSatang(m.amount), 0), 0);
const remainingOf = (st: MockState, d: Stored) => docCash(d) - matchedPortion(st, d.id);
const label = (l: { date: IsoDate; amount: Money }) => `${formatDateBE(l.date)} ${formatMoney(l.amount.replace('-', ''))}`;

// ---------------------------------------------------------------- suggestions and search

export interface BankCandidate { docId: string; type: 'RC' | 'PV'; number: string; documentDate: IsoDate; partyName: string; cash: Money; remaining: Money; exact: boolean }
const DAYS = 7;
const daysBetween = (a: string, b: string) => abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** Live receipts (money in) / payment vouchers (money out) of the line's own account with something left to match (ruling 1: the same account only).
 *  No `q`: the suggestions - not matched yet, exact cash, within 7 days (A.8). With `q`: the search - any date, any amount, number or party containing it. Ranked: exact, nearest date, number. */
export function suggest(st: MockState, companyId: string, lineId: string, q?: string): BankCandidate[] {
  const l = lineOf(st, companyId, lineId);
  const want = toSatang(l.amount) > 0 ? 'RC' : 'PV', needle = (q ?? '').trim().toLowerCase();
  return st.docs
    .filter((d) => d.companyId === companyId && d.type === want && LIVE.includes(d.status) && resolvedBankId(st, companyId, d.type, d.header) === l.accountId && remainingOf(st, d) > 0)
    .map((d) => ({ d, exact: matchedPortion(st, d.id) === 0 && docCash(d) === abs(toSatang(l.amount)), days: daysBetween(d.header.documentDate, l.date) }))
    .filter((x) => (needle ? `${x.d.number ?? ''} ${x.d.party?.name ?? ''}`.toLowerCase().includes(needle) : x.exact && x.days <= DAYS))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.days - b.days || (a.d.number ?? '').localeCompare(b.d.number ?? ''))
    .map(({ d, exact }): BankCandidate => ({ docId: d.id, type: want, number: d.number ?? d.id, documentDate: d.header.documentDate, partyName: d.party?.name ?? '', cash: fromSatang(docCash(d)), remaining: fromSatang(remainingOf(st, d)), exact }));
}

// ---------------------------------------------------------------- journals

const nameOf = (st: MockState, companyId: string, code: string) => st.accounts.find((a) => a.companyId === companyId && a.code === code)?.nameTh ?? code;
type Leg = { code: string; debit: number; credit: number; party?: string; dims?: Record<string, string> };
/** One balanced entry (Dr = Cr by construction of the callers, checked here) dated `date`, written now. */
function entry(st: MockState, companyId: string, date: IsoDate, rule: string, legs: Leg[]): JournalEntryPreview {
  const dr = legs.reduce((n, g) => n + g.debit, 0), cr = legs.reduce((n, g) => n + g.credit, 0);
  if (dr !== cr || dr <= 0) throw fail(500, 'engine.invariant', 'รายการบัญชีไม่สมดุล');
  return {
    date, kind: 'original', postedAt: stamp(),
    lines: legs.map((g) => ({ accountCode: g.code, accountName: nameOf(st, companyId, g.code), debit: fromSatang(g.debit), credit: fromSatang(g.credit), rule, ...(g.party ? { partyName: g.party } : {}), ...(g.dims ? { dimensions: g.dims } : {}) })),
  };
}
function addJournal(st: MockState, j: Omit<BankJournal, 'id'>): BankJournal {
  const nj: BankJournal = { id: `bj-${String(st.bankJournals.length + 1).padStart(3, '0')}`, ...j };
  st.bankJournals.push(nj);
  return nj;
}
/** Seed only: the opening balance the statement starts from, so the account's GL carries it (Dr bank / Cr opening-balance equity, reversed for an overdrawn start). */
export function postOpening(st: MockState, companyId: string, accountId: string, date: IsoDate, amount: Money): void {
  const b = bankOf(st, companyId, accountId), sat = toSatang(amount);
  if (sat === 0) return;
  const eq = resolveRole(st, 'OpeningBalanceEquity', { companyId, docType: 'JV' }).code;
  addJournal(st, { companyId, accountId, kind: 'opening', label: 'ยอดยกมาบัญชีธนาคาร', entries: [entry(st, companyId, date, 'ยอดยกมาบัญชีธนาคาร',
    [{ code: b.accountCode, debit: Math.max(sat, 0), credit: Math.max(-sat, 0) }, { code: eq, debit: Math.max(-sat, 0), credit: Math.max(sat, 0) }])] });
}

// ---------------------------------------------------------------- commands

const statusError = (l: StoredLine, want: string) => fail(409, 'bank.line_state', `รายการนี้${l.status === 'matched' ? 'จับคู่แล้ว' : l.status === 'ignored' ? 'ถูกข้ามแล้ว' : l.status === 'posted' ? 'บันทึกบัญชีแล้ว (แก้ไขไม่ได้ ยกเลิกโดยกลับรายการบัญชี)' : 'ยังไม่ได้จับคู่'} ${want}`);
const reasonOf = (st: MockState, l: StoredLine, reason: string | undefined) => {
  const r = (reason ?? '').trim();
  if (isLocked(st, l) && !r) throw fail(422, 'bank.reason_required', 'รายการนี้อยู่ในช่วงที่ปิดการกระทบยอดแล้ว ต้องระบุเหตุผลในการแก้ไข');
  return r;
};

export interface MatchRequest { docIds: string[]; /** per-document share of its cash, for a document split over several lines; absent = the document's whole remainder */ amounts?: Record<string, Money>; diff?: { role: 'BankFee' | 'RoundingDifference'; amount: Money } }

/** One line <-> one or several documents (batch), or one share of a document split over several lines. Σ matched cash + diff = line amount (in the line's sign); a document is matched only on the line's own account and never beyond its cash.
 *  A diff posts its own journal at the line's date. Everything is judged before anything is written. */
export function match(st: MockState, companyId: string, lineId: string, req: MatchRequest, actor: Actor): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'unmatched') throw statusError(l, '- จับคู่ไม่ได้');
  const ids = [...new Set(req.docIds ?? [])];
  if (!ids.length) throw fail(422, 'bank.match_empty', 'เลือกเอกสารที่จะจับคู่อย่างน้อยหนึ่งรายการ');
  const amount = toSatang(l.amount), s = amount < 0 ? -1 : 1, want = s > 0 ? 'RC' : 'PV';
  const diff = req.diff && toSatang(req.diff.amount) !== 0 ? req.diff : undefined, diffSat = diff ? toSatang(diff.amount) : 0;
  if (diff) {
    if (diff.role !== 'BankFee' && diff.role !== 'RoundingDifference') throw fail(422, 'bank.match_diff', 'ผลต่างต้องเป็นค่าธรรมเนียมธนาคารหรือผลต่างจากการปัดเศษ');
    if (diff.role === 'BankFee' && diffSat > 0) throw fail(422, 'bank.match_diff', 'ค่าธรรมเนียมธนาคารต้องทำให้ยอดในบัญชีลดลง (ติดลบ)');
  }
  const bank = bankOf(st, companyId, l.accountId);
  const docs = ids.map((id) => {
    const d = st.docs.find((x) => x.id === id && x.companyId === companyId);
    if (!d) throw fail(422, 'bank.match_doc_not_found', 'ไม่พบเอกสารที่เลือก');
    const no = d.number ?? d.id;
    if (d.type !== want) throw fail(422, 'bank.match_direction', `${no} เป็น${d.type === 'RC' ? 'ใบเสร็จรับเงิน (เงินเข้า)' : 'ใบสำคัญจ่าย (เงินออก)'} จับคู่กับรายการ${s > 0 ? 'เงินเข้า' : 'เงินออก'}ไม่ได้`);
    if (!LIVE.includes(d.status)) throw fail(422, 'bank.match_doc_status', `${no} ไม่อยู่ในสถานะที่จับคู่ได้`);
    const acct = resolvedBankId(st, companyId, d.type, d.header);
    if (acct !== l.accountId) throw fail(422, 'bank.match_account', `${no} ใช้บัญชี ${st.bankAccounts.find((b) => b.id === acct)?.nameTh ?? 'อื่น'} ไม่ใช่บัญชี ${bank.nameTh} ของรายการนี้ จับคู่ได้เฉพาะเอกสารของบัญชีเดียวกัน`);
    return d;
  });
  const target = abs(amount) - s * diffSat; // what the documents must add up to
  const portions = docs.map((d) => {
    const left = remainingOf(st, d), given = req.amounts?.[d.id];
    const p = given !== undefined && given !== '' ? toSatang(given) : left; // a share (split over lines) is always said out loud: otherwise the whole remainder, so a wrong pick is a mismatch, not a quiet partial match
    if (p <= 0) throw fail(422, 'bank.match_amount', `ยอดที่จับคู่ของ ${d.number ?? d.id} ต้องมากกว่า 0`);
    if (p > left) throw fail(422, 'bank.match_over', `${d.number ?? d.id} จับคู่ได้อีกไม่เกิน ${formatMoney(fromSatang(left))} บาท (ยอดเงิน ${formatMoney(fromSatang(docCash(d)))} จับคู่ไปแล้ว ${formatMoney(fromSatang(matchedPortion(st, d.id)))})`);
    return p;
  });
  const sum = portions.reduce((n, p) => n + p, 0);
  if (sum !== target) {
    throw fail(422, 'bank.match_amount', `ยอดเอกสาร ${formatMoney(fromSatang(sum))} ${diffSat ? `${diffSat < 0 ? '−' : '+'} ผลต่าง ${formatMoney(fromSatang(abs(diffSat)))} ` : ''}ไม่เท่ากับยอดรายการเดินบัญชี ${formatMoney(fromSatang(abs(amount)))} บาท`);
  }
  if (diff) dateGuards(st, companyId, l.date); // the fee journal is dated at the line: a closed month refuses

  // all judged - write
  const matches: BankMatch[] = docs.map((d, i) => ({ docId: d.id, type: d.type as 'RC' | 'PV', number: d.number ?? d.id, amount: fromSatang(portions[i]), docCash: fromSatang(docCash(d)), accountId: l.accountId, docDate: d.header.documentDate }));
  let stored: StoredLine['diff'];
  if (diff) {
    const counter = resolveRole(st, diff.role, { companyId, docType: 'JV' }).code, tag = diff.role === 'BankFee' ? 'ค่าธรรมเนียมจากการกระทบยอด' : 'ผลต่างจากการปัดเศษจากการกระทบยอด';
    const out = diffSat < 0; // the bank balance falls: Cr bank / Dr the cost; a rise is the mirror
    const j = addJournal(st, { companyId, accountId: l.accountId, lineId, kind: 'fee', label: tag, entries: [entry(st, companyId, l.date, tag,
      [{ code: counter, debit: out ? abs(diffSat) : 0, credit: out ? 0 : abs(diffSat) }, { code: bank.accountCode, debit: out ? 0 : abs(diffSat), credit: out ? abs(diffSat) : 0 }])] });
    stored = { role: diff.role, amount: fromSatang(diffSat), journalId: j.id };
  }
  Object.assign(l, { status: 'matched', matches, matchedDocIds: matches.map((m) => m.docId), ...(stored ? { diff: stored } : {}) });
  for (const m of matches) logActivity(st, m.docId, actor, 'bank.match', `จับคู่กับรายการเดินบัญชี ${label(l)} (${formatMoney(m.amount)} บาท)`);
  logActivity(st, l.id, actor, 'bank.match', `จับคู่กับ ${matches.map((m) => m.number).join(', ')}`);
  logAudit(st, actor, companyId, 'bank.match', l.id, { status: 'unmatched' }, { status: 'matched', matches: matches.map((m) => [m.docId, m.amount]), diff: stored });
  return publicLine(st, l);
}

/** Back to unmatched. A fee / rounding journal is reversed once (SP0 5.9: on its own date while that month is open). A locked line needs a reason, audited on the line and on every document. */
export function unmatch(st: MockState, companyId: string, lineId: string, actor: Actor, reason?: string): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'matched') throw statusError(l, '- ยกเลิกการจับคู่ไม่ได้');
  const why = reasonOf(st, l, reason), locked = isLocked(st, l);
  const before = { status: l.status, matches: l.matches, diff: l.diff };
  if (l.diff) {
    const j = st.bankJournals.find((x) => x.id === l.diff!.journalId);
    const last = j?.entries[j.entries.length - 1];
    if (j && last && last.kind !== 'reversal') j.entries = [...j.entries, correctionReversal(st, companyId, last)];
  }
  for (const m of l.matches ?? []) logActivity(st, m.docId, actor, 'bank.unmatch', `ยกเลิกการจับคู่กับรายการเดินบัญชี ${label(l)}${locked ? ` (ช่วงที่ปิดการกระทบยอดแล้ว) เหตุผล: ${why}` : why ? ` เหตุผล: ${why}` : ''}`);
  logActivity(st, l.id, actor, 'bank.unmatch', locked ? `ยกเลิกการจับคู่ในช่วงที่ปิดแล้ว เหตุผล: ${why}` : why || 'ยกเลิกการจับคู่');
  delete l.matches; delete l.matchedDocIds; delete l.diff;
  l.status = 'unmatched';
  logAudit(st, actor, companyId, 'bank.unmatch', l.id, before, { status: 'unmatched', ...(why ? { reason: why } : {}), locked });
  return publicLine(st, l);
}

export function ignore(st: MockState, companyId: string, lineId: string, actor: Actor, reason?: string): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'unmatched') throw statusError(l, '- ข้ามไม่ได้');
  const why = (reason ?? '').trim();
  l.status = 'ignored';
  if (why) l.note = why;
  logActivity(st, l.id, actor, 'bank.ignore', why || 'ข้ามรายการ');
  logAudit(st, actor, companyId, 'bank.ignore', l.id, { status: 'unmatched' }, { status: 'ignored', ...(why ? { reason: why } : {}) });
  return publicLine(st, l);
}
export function unignore(st: MockState, companyId: string, lineId: string, actor: Actor, reason?: string): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'ignored') throw statusError(l, '- เลิกข้ามไม่ได้');
  const why = reasonOf(st, l, reason), locked = isLocked(st, l);
  l.status = 'unmatched';
  delete l.note;
  logActivity(st, l.id, actor, 'bank.unignore', locked ? `เลิกข้ามในช่วงที่ปิดแล้ว เหตุผล: ${why}` : why || 'เลิกข้ามรายการ');
  logAudit(st, actor, companyId, 'bank.unignore', l.id, { status: 'ignored' }, { status: 'unmatched', ...(why ? { reason: why } : {}), locked });
  return publicLine(st, l);
}

export interface PostRequest { accountCode: string; description?: string; partyId?: string; dimensions?: Record<string, string> }
/** Inline journal for a line nothing matches (a fee, interest, a transfer): two lines, the bank's GL account against the chosen one, dated at the line. Immutable afterwards; the exit is to reverse the journal (AC1). */
export function post(st: MockState, companyId: string, lineId: string, req: PostRequest, actor: Actor): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'unmatched') throw statusError(l, '- บันทึกบัญชีไม่ได้');
  const bank = bankOf(st, companyId, l.accountId);
  const acc = st.accounts.find((a) => a.companyId === companyId && a.code === req.accountCode);
  if (!acc || !acc.postable) throw fail(422, 'ledger.account_invalid', 'เลือกบัญชีที่ลงรายการได้');
  if (acc.code === bank.accountCode) throw fail(422, 'bank.post_same_account', 'บัญชีที่เลือกต้องไม่ใช่บัญชีธนาคารของรายการนี้');
  if (isTaxControl(st, companyId, acc.code)) throw fail(422, 'ledger.control_account', `${acc.code} ${acc.nameTh} เป็นบัญชีควบคุมภาษี ลงรายการเองไม่ได้ ภาษีลงจากเอกสารเท่านั้น`);
  const kind = partyKindOf(st, companyId, acc.code);
  let party: string | undefined;
  if (kind) {
    const p = st.parties.find((x) => x.id === req.partyId && x.companyId === companyId);
    if (!req.partyId) throw fail(422, 'ledger.party_required', `${acc.code} ${acc.nameTh} ต้องระบุ${kind === 'customer' ? 'ลูกค้า' : kind === 'vendor' ? 'ผู้ขาย' : 'พนักงาน'}`);
    if (!p || p.kind !== kind) throw fail(422, 'ledger.party_invalid', `คู่ค้าที่เลือกไม่ใช่${kind === 'customer' ? 'ลูกค้า' : kind === 'vendor' ? 'ผู้ขาย' : 'พนักงาน'}ของบริษัทนี้`);
    party = p.name;
  }
  const dims = req.dimensions && Object.keys(req.dimensions).length ? req.dimensions : undefined;
  dateGuards(st, companyId, l.date);
  const amount = toSatang(l.amount), tag = (req.description ?? '').trim() || l.description;
  const incoming = amount > 0;
  const j = addJournal(st, { companyId, accountId: l.accountId, lineId, kind: 'inline', label: tag, entries: [entry(st, companyId, l.date, tag, [
    { code: bank.accountCode, debit: incoming ? abs(amount) : 0, credit: incoming ? 0 : abs(amount), ...(dims ? { dims } : {}) },
    { code: acc.code, debit: incoming ? 0 : abs(amount), credit: incoming ? abs(amount) : 0, ...(party ? { party } : {}), ...(dims ? { dims } : {}) },
  ])] });
  l.status = 'posted';
  l.journalId = j.id;
  logActivity(st, l.id, actor, 'bank.post', `บันทึกบัญชี ${acc.code} ${acc.nameTh}: ${tag}`);
  logAudit(st, actor, companyId, 'bank.post', l.id, { status: 'unmatched' }, { status: 'posted', journalId: j.id, accountCode: acc.code });
  return publicLine(st, l);
}

/** "ปิดการกระทบยอดถึงวันที่": every line on or before `date` must be resolved (matched, posted or ignored); then they read locked. The date only moves forward. */
export function lockTo(st: MockState, companyId: string, accountId: string, date: IsoDate, actor: Actor): BankAccount {
  const b = bankOf(st, companyId, accountId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(422, 'bank.lock_date', 'วันที่ไม่ถูกต้อง');
  if (date > today()) throw fail(422, 'bank.lock_date', `วันที่อยู่ในอนาคต (วันนี้ ${today()})`);
  if (b.reconciledTo && date < b.reconciledTo) throw fail(422, 'bank.lock_backwards', `ปิดการกระทบยอดถึง ${formatDateBE(b.reconciledTo)} แล้ว เลื่อนวันที่ถอยหลังไม่ได้`);
  const open = st.bankLines.filter((x) => x.companyId === companyId && x.accountId === accountId && x.date <= date && x.status === 'unmatched');
  if (open.length) throw fail(422, 'bank.lock_unmatched', `ยังมีรายการเดินบัญชีที่ยังไม่ได้จับคู่ ${open.length} รายการ (ล่าสุด ${formatDateBE(open.map((x) => x.date).sort().at(-1)!)}) จับคู่ บันทึกบัญชี หรือข้ามก่อนปิด`);
  const before = b.reconciledTo;
  b.reconciledTo = date;
  logAudit(st, actor, companyId, 'bank.lock', accountId, { reconciledTo: before }, { reconciledTo: date });
  return b;
}

/** Statement lines of the account, API shape (newest first). */
export const linesOf = (st: MockState, companyId: string, accountId: string): BankLine[] =>
  st.bankLines.filter((l) => l.companyId === companyId && l.accountId === accountId).map((l) => publicLine(st, l));

/** GL balance of one account at `to` over every entry (documents', fee, inline, opening) - satang. */
export function glBalance(st: MockState, companyId: string, code: string, to: IsoDate): number {
  let n = 0;
  for (const e of companyEntries(st, companyId)) if (e.date <= to) for (const g of e.lines) if (g.accountCode === code) n += toSatang(g.debit) - toSatang(g.credit);
  return n;
}
