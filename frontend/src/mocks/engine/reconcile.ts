import { LIVE } from '@/domain/doc-types';
import type { AccountingRole } from './posting';
import type { Actor, BankJournal, BankLine, BankMatch, IsoDate, JournalEntryPreview, Money } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';
import type { BankAccount } from '../fixtures/bank-accounts';
import type { MockState } from '../store';
import { correctionReversal, dateGuards, goLiveOf } from './commands';
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

/** SP0 G4 + I1: an inline journal posts only to accounts no subledger or document owns. The roles a document writes (tax, receivable / payable, deposits, prepayments, payroll payables, cash / bank, equity) are refused. */
const TAX_ROLES: AccountingRole[] = ['OutputVat', 'InputVat', 'InputVatUnclaimed', 'Pnd36VatPayable', 'WhtReceivable', 'WhtPayable', 'WhtExpense'];

/** The roles an account of the company plays: its chart `controlRole` and every posting rule that points at it. */
export function rolesOf(st: MockState, companyId: string, code: string): AccountingRole[] {
  const a = st.accounts.find((x) => x.companyId === companyId && x.code === code);
  return [...new Set([...(a?.controlRole ? [a.controlRole] : []), ...st.postingRules.filter((r) => r.companyId === companyId && r.accountCode === code).map((r) => r.role)])];
}
/** Why an account is not for an inline journal and what to use instead; undefined = free to post. */
export function controlExit(st: MockState, companyId: string, code: string): string | undefined {
  const a = st.accounts.find((x) => x.companyId === companyId && x.code === code);
  const roles = rolesOf(st, companyId, code), has = (...r: AccountingRole[]) => roles.some((x) => r.includes(x)), sub = a?.subClass ?? '';
  if (a?.class === 'equity' || has('RetainedEarnings', 'OpeningBalanceEquity')) return 'บัญชีส่วนของเจ้าของ ปรับด้วยสมุดรายวันทั่วไป (JV) ไม่ใช่รายการเดินบัญชี';
  if (has('Cash') || sub === 'cash' || sub === 'bank') return 'บัญชีเงินสด/ธนาคาร ใช้ปุ่ม "โอนระหว่างบัญชี" ที่รายการเดินบัญชี';
  if (has('AR', 'CustomerDeposit') || sub === 'receivable') return 'บัญชีลูกหนี้/เงินรับล่วงหน้า ใช้ใบเสร็จรับเงิน (RC)';
  if (has('AP', 'EmployeePayable', 'VendorPrepayment') || sub === 'payable') return 'บัญชีเจ้าหนี้/เงินจ่ายล่วงหน้า ใช้ใบสำคัญจ่าย (PV)';
  if (has('Revenue', 'SalesReturn', 'SalesDiscount') || sub === 'sales' || sub === 'contra-sales') return 'บัญชีรายได้จากการขาย ลงจากใบกำกับภาษี/ใบลดหนี้เท่านั้น (ต้องมีภาษีขาย)';
  if (has('FixedAsset', 'AccumulatedDepreciation') || sub === 'fixed-asset' || sub === 'accumulated-depreciation') return 'บัญชีสินทรัพย์ถาวร/ค่าเสื่อมราคาสะสม ลงจากทะเบียนสินทรัพย์และใบสำคัญจ่ายเท่านั้น';
  if (has(...TAX_ROLES) || sub === 'tax-asset' || sub === 'tax-liability') return 'บัญชีควบคุมภาษี ภาษีลงจากเอกสารเท่านั้น';
  if (has('SalaryPayable', 'PitPayable', 'SsoPayable') || sub === 'payroll-liability') return 'บัญชีเจ้าหนี้เงินเดือน ลงจากเอกสารเงินเดือนเท่านั้น';
  return undefined;
}

const bankCodeOf = (st: MockState, companyId: string, accountId: string) => st.bankAccounts.find((x) => x.id === accountId && x.companyId === companyId)?.accountCode ?? '';
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
  const pending = l.status === 'unmatched' ? pendingTransfer(st, companyId, l.id)?.id : undefined;
  return { ...rest, ...(to && l.date <= to ? { locked: true } : {}), ...(pending ? { transferPending: pending } : {}) };
}
const isLocked = (st: MockState, l: StoredLine) => publicLine(st, l).locked === true;

/** What of a document's cash is already matched on bank lines (satang, positive). */
export const matchedPortion = (st: MockState, docId: string): number =>
  st.bankLines.reduce((n, l) => n + (l.matches ?? []).filter((m) => m.docId === docId).reduce((x, m) => x + toSatang(m.amount), 0), 0);
const remainingOf = (st: MockState, d: Stored) => docCash(d) - matchedPortion(st, d.id);
const label = (l: { date: IsoDate; amount: Money }) => `${formatDateBE(l.date)} ${formatMoney(l.amount.replace('-', ''))}`;

// ---------------------------------------------------------------- suggestions and search

export interface BankCandidate { docId: string; type: 'RC' | 'PV' | 'TR'; number: string; documentDate: IsoDate; partyName: string; cash: Money; remaining: Money; exact: boolean }
const DAYS = 7;
const daysBetween = (a: string, b: string) => abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
/** R1-2: a document is on this account's books after go-live when one of its journal entries on the bank GL is dated on or after it (its original, or the late-posted entry of a correction). Earlier ones are inside the opening balance. */
export const hasEntryFrom = (st: MockState, docId: string, code: string, live: IsoDate | undefined): boolean =>
  !live || (st.journals.find((j) => j.docId === docId)?.preview.entries ?? []).some((e) => e.date >= live && e.lines.some((g) => g.accountCode === code));

/** I2: a transfer journal that is still in force (not reversed). */
const inForce = (j: BankJournal) => j.kind === 'transfer' && j.entries[j.entries.length - 1]?.kind !== 'reversal';
const pendingTransfer = (st: MockState, companyId: string, lineId: string) => st.bankJournals.find((j) => j.companyId === companyId && j.lineId === lineId && inForce(j));
const transferLines = (st: MockState, journalId: string) => st.bankLines.filter((x) => x.transfer?.journalId === journalId && x.status === 'matched');
/** The money a transfer journal moves (satang, positive). */
const transferAmount = (j: BankJournal) => j.entries[0].lines.reduce((n, g) => n + toSatang(g.debit), 0);
const sideOf = (l: { amount: Money }): 'out' | 'in' => (toSatang(l.amount) < 0 ? 'out' : 'in');

/** Transfer journals this line (on the receiving / paying account of one made from the other side) may match: in force, not taken on this side, the opposite direction. */
function transferCandidates(st: MockState, companyId: string, l: StoredLine, needle: string): BankCandidate[] {
  return st.bankJournals.filter((j) => j.companyId === companyId && inForce(j) && j.otherAccountId === l.accountId && j.lineId)
    .filter((j) => { const o = st.bankLines.find((x) => x.id === j.lineId); return !!o && sideOf(o) !== sideOf(l) && !transferLines(st, j.id).some((x) => x.accountId === l.accountId); })
    .map((j) => ({ j, exact: transferAmount(j) === abs(toSatang(l.amount)), days: daysBetween(j.entries[0].date, l.date) }))
    .filter((x) => (needle ? x.j.label.toLowerCase().includes(needle) : x.exact && x.days <= DAYS))
    .map(({ j, exact }): BankCandidate => ({ docId: j.id, type: 'TR', number: 'โอนระหว่างบัญชี', documentDate: j.entries[0].date, partyName: j.label, cash: fromSatang(transferAmount(j)), remaining: fromSatang(transferAmount(j)), exact }));
}

/** Live receipts (money in) / payment vouchers (money out) of the line's own account with something left to match (ruling 1: the same account only), dated on or after the account's go-live, and transfer journals from
 *  another own account. No `q`: the suggestions - not matched yet, exact cash, within 7 days (A.8). With `q`: the search - any date, any amount, number or party containing it. Ranked: exact, nearest date, number. */
export function suggest(st: MockState, companyId: string, lineId: string, q?: string): BankCandidate[] {
  const l = lineOf(st, companyId, lineId);
  const want = toSatang(l.amount) > 0 ? 'RC' : 'PV', needle = (q ?? '').trim().toLowerCase(), live = goLiveOf(st, companyId, l.accountId);
  const docs = st.docs
    .filter((d) => d.companyId === companyId && d.type === want && LIVE.includes(d.status) && hasEntryFrom(st, d.id, bankCodeOf(st, companyId, l.accountId), live) && resolvedBankId(st, companyId, d.type, d.header) === l.accountId && remainingOf(st, d) > 0)
    .map((d) => ({ d, exact: matchedPortion(st, d.id) === 0 && docCash(d) === abs(toSatang(l.amount)), days: daysBetween(d.header.documentDate, l.date) }))
    .filter((x) => (needle ? `${x.d.number ?? ''} ${x.d.party?.name ?? ''}`.toLowerCase().includes(needle) : x.exact && x.days <= DAYS))
    .map(({ d, exact, days }) => ({ days, exact, n: d.number ?? '', c: { docId: d.id, type: want, number: d.number ?? d.id, documentDate: d.header.documentDate, partyName: d.party?.name ?? '', cash: fromSatang(docCash(d)), remaining: fromSatang(remainingOf(st, d)), exact } as BankCandidate }));
  const trs = transferCandidates(st, companyId, l, needle).map((c) => ({ days: daysBetween(c.documentDate, l.date), exact: c.exact, n: c.docId, c }));
  return [...docs, ...trs].sort((a, b) => Number(b.exact) - Number(a.exact) || a.days - b.days || a.n.localeCompare(b.n)).map((x) => x.c);
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
/** Seed only (I4): the go-live adjustment. GL(bank) on `date` (the day before the first statement line) is brought to the statement's opening: Dr / Cr bank against opening-balance equity
 *  for the difference - history before the statement is inside it. */
export function postOpening(st: MockState, companyId: string, accountId: string, date: IsoDate, opening: Money): void {
  const b = bankOf(st, companyId, accountId), sat = toSatang(opening) - glBalance(st, companyId, b.accountCode, date);
  if (sat === 0) return;
  const eq = resolveRole(st, 'OpeningBalanceEquity', { companyId, docType: 'JV' }).code, tag = 'ปรับยอดยกมาตาม statement';
  addJournal(st, { companyId, accountId, kind: 'opening', label: tag, entries: [entry(st, companyId, date, tag,
    [{ code: b.accountCode, debit: Math.max(sat, 0), credit: Math.max(-sat, 0) }, { code: eq, debit: Math.max(-sat, 0), credit: Math.max(sat, 0) }])] });
}

// ---------------------------------------------------------------- commands

const statusError = (l: StoredLine, want: string) => fail(409, 'bank.line_state', `รายการนี้${l.status === 'matched' ? 'จับคู่แล้ว' : l.status === 'ignored' ? 'ถูกข้ามแล้ว' : l.status === 'posted' ? 'บันทึกบัญชีแล้ว (แก้ไขไม่ได้ ยกเลิกโดยกลับรายการบัญชี)' : 'ยังไม่ได้จับคู่'} ${want}`);
const reasonOf = (st: MockState, l: StoredLine, reason: string | undefined) => {
  const r = (reason ?? '').trim();
  if (isLocked(st, l) && !r) throw fail(422, 'bank.reason_required', 'รายการนี้อยู่ในช่วงที่ปิดการกระทบยอดแล้ว ต้องระบุเหตุผลในการแก้ไข');
  return r;
};

/** M3: a rounding difference is satang, not a mismatch: up to 1.00. */
const ROUNDING_MAX = 100;
export interface MatchRequest { docIds: string[]; /** per-document share of its cash, for a document split over several lines; absent = the document's whole remainder */ amounts?: Record<string, Money>; diff?: { role: 'BankFee' | 'RoundingDifference'; amount: Money } }

/** One line <-> one or several documents (batch), or one share of a document split over several lines. Σ matched cash + diff = line amount (in the line's sign); a document is matched only on the line's own account and never beyond its cash.
 *  A diff posts its own journal at the line's date. Everything is judged before anything is written. */
export function match(st: MockState, companyId: string, lineId: string, req: MatchRequest, actor: Actor): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'unmatched') throw statusError(l, '- จับคู่ไม่ได้');
  const ids = [...new Set(req.docIds ?? [])];
  if (!ids.length) throw fail(422, 'bank.match_empty', 'เลือกเอกสารที่จะจับคู่อย่างน้อยหนึ่งรายการ');
  refuseIfTransferPending(st, companyId, l);
  if (ids.some((id) => st.bankJournals.some((j) => j.id === id))) return matchTransfer(st, companyId, l, ids, req, actor);
  const amount = toSatang(l.amount), s = amount < 0 ? -1 : 1, want = s > 0 ? 'RC' : 'PV';
  const diff = req.diff && toSatang(req.diff.amount) !== 0 ? req.diff : undefined, diffSat = diff ? toSatang(diff.amount) : 0;
  if (diff) {
    if (diff.role !== 'BankFee' && diff.role !== 'RoundingDifference') throw fail(422, 'bank.match_diff', 'ผลต่างต้องเป็นค่าธรรมเนียมธนาคารหรือผลต่างจากการปัดเศษ');
    if (diff.role === 'BankFee' && diffSat > 0) throw fail(422, 'bank.match_diff', 'ค่าธรรมเนียมธนาคารต้องทำให้ยอดในบัญชีลดลง (ติดลบ)');
    if (diff.role === 'RoundingDifference' && abs(diffSat) > ROUNDING_MAX) throw fail(422, 'bank.rounding_too_large', `ผลต่างจากการปัดเศษเกิน ${formatMoney(fromSatang(ROUNDING_MAX))} บาท ไม่ใช่การปัดเศษ บันทึกผลต่างเป็นรายการบัญชีแยกต่างหาก`);
  }
  const bank = bankOf(st, companyId, l.accountId);
  const docs = ids.map((id) => {
    const d = st.docs.find((x) => x.id === id && x.companyId === companyId);
    if (!d) throw fail(422, 'bank.match_doc_not_found', 'ไม่พบเอกสารที่เลือก');
    const no = d.number ?? d.id;
    if (d.type !== want) throw fail(422, 'bank.match_direction', `${no} เป็น${d.type === 'RC' ? 'ใบเสร็จรับเงิน (เงินเข้า)' : 'ใบสำคัญจ่าย (เงินออก)'} จับคู่กับรายการ${s > 0 ? 'เงินเข้า' : 'เงินออก'}ไม่ได้`);
    if (!LIVE.includes(d.status)) throw fail(422, 'bank.match_doc_status', `${no} ไม่อยู่ในสถานะที่จับคู่ได้`);
    const live = goLiveOf(st, companyId, l.accountId);
    if (!hasEntryFrom(st, d.id, bank.accountCode, live)) throw fail(422, 'bank.match_history', `${no} ลงวันที่ ${formatDateBE(d.header.documentDate)} ก่อนวันเริ่มใช้ระบบกับ statement (${formatDateBE(live!)}) อยู่ในยอดยกมาแล้ว จับคู่ไม่ได้`);
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

const refuseIfTransferPending = (st: MockState, companyId: string, l: StoredLine) => {
  if (pendingTransfer(st, companyId, l.id)) throw fail(409, 'bank.transfer_pending', 'รายการนี้มีรายการโอนระหว่างบัญชีค้างอยู่ (ยกเลิกการจับคู่ไว้) บันทึกซ้ำจะนับเงินสองครั้ง กด "โอนระหว่างบัญชี" เพื่อจับคู่ใหม่ หรือกลับรายการโอนก่อน');
};
const attachTransfer = (st: MockState, companyId: string, l: StoredLine, j: BankJournal, actor: Actor) => {
  Object.assign(l, { status: 'matched', transfer: { journalId: j.id, side: sideOf(l) } });
  logActivity(st, l.id, actor, 'bank.match', `จับคู่กับ ${j.label}`);
  logAudit(st, actor, companyId, 'bank.match', l.id, { status: 'unmatched' }, { status: 'matched', transfer: j.id });
  return publicLine(st, l);
};

/** The other side of a transfer: this line (on the receiving / paying account) takes the journal the first line made. Exact amount, opposite direction, one line per side. */
function matchTransfer(st: MockState, companyId: string, l: StoredLine, ids: string[], req: MatchRequest, actor: Actor): BankLine {
  const j = st.bankJournals.find((x) => x.id === ids[0] && x.companyId === companyId);
  if (ids.length !== 1 || !j || j.kind !== 'transfer' || (req.diff && toSatang(req.diff.amount) !== 0)) throw fail(422, 'bank.match_transfer', 'รายการโอนระหว่างบัญชีจับคู่ได้ครั้งละหนึ่งรายการ และไม่มีผลต่าง');
  const origin = st.bankLines.find((x) => x.id === j.lineId);
  if (!inForce(j) || j.otherAccountId !== l.accountId || !origin || sideOf(origin) === sideOf(l)) throw fail(422, 'bank.match_transfer', 'รายการโอนนี้ไม่ใช่ของบัญชีหรือทิศทางเงินของรายการนี้');
  if (transferLines(st, j.id).some((x) => x.accountId === l.accountId)) throw fail(409, 'bank.match_transfer', 'รายการโอนนี้จับคู่กับรายการเดินบัญชีของบัญชีนี้แล้ว');
  if (transferAmount(j) !== abs(toSatang(l.amount))) throw fail(422, 'bank.match_amount', `ยอดโอน ${formatMoney(fromSatang(transferAmount(j)))} ไม่เท่ากับยอดรายการเดินบัญชี ${formatMoney(fromSatang(abs(toSatang(l.amount))))} บาท`);
  return attachTransfer(st, companyId, l, j, actor);
}

/** I2: a statement line that is money moving between two own accounts. Posts ONE bank journal Dr receiving / Cr paying at the line's date and matches this line to it; the other account's line matches the same
 *  journal later (suggested at the same amount within 7 days). A journal kept after an unmatch is re-attached, never posted twice. */
export function transfer(st: MockState, companyId: string, lineId: string, toAccountId: string, actor: Actor): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'unmatched') throw statusError(l, '- โอนระหว่างบัญชีไม่ได้');
  const bank = bankOf(st, companyId, l.accountId);
  if (toAccountId === l.accountId) throw fail(422, 'bank.transfer_same_account', 'ต้องเลือกบัญชีอื่นที่ไม่ใช่บัญชีของรายการนี้');
  const other = bankOf(st, companyId, String(toAccountId));
  if (bank.active === false || other.active === false) throw fail(422, 'bank.transfer_inactive', 'บัญชีที่เลือกถูกปิดใช้งานแล้ว');
  const kept = pendingTransfer(st, companyId, l.id);
  if (kept) {
    if (kept.otherAccountId !== other.id) throw fail(409, 'bank.transfer_pending', 'รายการนี้มีรายการโอนไปบัญชีอื่นค้างอยู่ ต้องกลับรายการโอนนั้นก่อน');
    return attachTransfer(st, companyId, l, kept, actor);
  }
  // R1-1: the same money already booked from the other side (an open journal from `other`, equal amount, opposite direction, within 7 days): match it, never post a second one
  const covering = transferCandidates(st, companyId, l, '').filter((c) => c.exact && st.bankJournals.find((x) => x.id === c.docId)?.accountId === other.id);
  if (covering.length > 1) throw fail(409, 'bank.transfer_ambiguous', `มีรายการโอนจาก ${other.nameTh} ยอดเท่ากันมากกว่าหนึ่งรายการ (${covering.map((c) => c.docId).join(', ')}) เลือกที่ "ค้นหารายการที่ตรงกัน"`);
  if (covering.length === 1) return attachTransfer(st, companyId, l, st.bankJournals.find((x) => x.id === covering[0].docId)!, actor);
  dateGuards(st, companyId, l.date);
  const amount = toSatang(l.amount), out = amount < 0, rx = out ? other : bank, tx = out ? bank : other;
  const tag = `โอนระหว่างบัญชี ${tx.nameTh} → ${rx.nameTh}`;
  const j = addJournal(st, { companyId, accountId: bank.id, otherAccountId: other.id, lineId: l.id, kind: 'transfer', label: tag, entries: [entry(st, companyId, l.date, tag, [
    { code: bank.accountCode, debit: out ? 0 : abs(amount), credit: out ? abs(amount) : 0 }, { code: other.accountCode, debit: out ? abs(amount) : 0, credit: out ? 0 : abs(amount) },
  ])] });
  return attachTransfer(st, companyId, l, j, actor);
}

/** The way out of a transfer: reverse its journal, once, and only while neither line is matched to it (SP0 5.9: the reversal goes on the journal's date while that month is open). */
export function reverseTransfer(st: MockState, companyId: string, journalId: string, actor: Actor, reason?: string): BankJournal {
  const why = (reason ?? '').trim();
  if (!why) throw fail(422, 'bank.reason_required', 'ต้องระบุเหตุผลในการย้อนรายการโอน');
  const j = st.bankJournals.find((x) => x.id === journalId && x.companyId === companyId && x.kind === 'transfer');
  if (!j) throw fail(404, 'record.not_found', 'ไม่พบรายการโอนนี้');
  if (!inForce(j)) throw fail(409, 'bank.transfer_reversed', 'รายการโอนนี้กลับรายการไปแล้ว');
  if (transferLines(st, j.id).length) throw fail(422, 'bank.transfer_matched', 'รายการโอนนี้ยังจับคู่กับรายการเดินบัญชีอยู่ ยกเลิกการจับคู่ทั้งสองฝั่งก่อน');
  j.entries = [...j.entries, correctionReversal(st, companyId, j.entries[j.entries.length - 1])];
  logAudit(st, actor, companyId, 'bank.transfer_reverse', j.id, { reversed: false }, { reversed: true, reason: why });
  return j;
}

/** Back to unmatched. A fee / rounding journal is reversed once (SP0 5.9: on its own date while that month is open). A locked line needs a reason, audited on the line and on every document. */
export function unmatch(st: MockState, companyId: string, lineId: string, actor: Actor, reason?: string): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'matched') throw statusError(l, '- ยกเลิกการจับคู่ไม่ได้');
  const why = reasonOf(st, l, reason), locked = isLocked(st, l);
  const before = { status: l.status, matches: l.matches, diff: l.diff, transfer: l.transfer };
  if (l.transfer) { // the journal stays (the other side may still stand on it); the way to undo it is reverseTransfer
    if (l.transfer.side === 'out' && transferLines(st, l.transfer.journalId).some((x) => x.id !== l.id && x.transfer?.side === 'in')) {
      throw fail(422, 'bank.transfer_matched', 'ฝั่งรับของรายการโอนนี้ยังจับคู่อยู่ ยกเลิกการจับคู่ฝั่งรับก่อน แล้วจึงยกเลิกการจับคู่ฝั่งจ่าย');
    }
    logActivity(st, l.id, actor, 'bank.unmatch', locked ? `ยกเลิกการจับคู่ในช่วงที่ปิดแล้ว เหตุผล: ${why}` : why || 'ยกเลิกการจับคู่รายการโอน');
    delete l.transfer;
    l.status = 'unmatched';
    logAudit(st, actor, companyId, 'bank.unmatch', l.id, before, { status: 'unmatched', ...(why ? { reason: why } : {}), locked });
    return publicLine(st, l);
  }
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

export interface PostRequest { accountCode: string; description?: string; dimensions?: Record<string, string> }
/** Inline journal for a line nothing matches (a fee, interest, a transfer): two lines, the bank's GL account against the chosen one, dated at the line. Immutable afterwards; the exit is to reverse the journal (AC1). */
export function post(st: MockState, companyId: string, lineId: string, req: PostRequest, actor: Actor): BankLine {
  const l = lineOf(st, companyId, lineId);
  if (l.status !== 'unmatched') throw statusError(l, '- บันทึกบัญชีไม่ได้');
  refuseIfTransferPending(st, companyId, l);
  const bank = bankOf(st, companyId, l.accountId);
  const acc = st.accounts.find((a) => a.companyId === companyId && a.code === req.accountCode);
  if (!acc || !acc.postable) throw fail(422, 'ledger.account_invalid', 'เลือกบัญชีที่ลงรายการได้');
  if (acc.code === bank.accountCode) throw fail(422, 'bank.post_same_account', 'บัญชีที่เลือกต้องไม่ใช่บัญชีธนาคารของรายการนี้');
  const exit = controlExit(st, companyId, acc.code);
  if (exit) throw fail(422, 'ledger.control_account', `${acc.code} ${acc.nameTh} ลงรายการเองไม่ได้: ${exit}`);
  const dims = req.dimensions && Object.keys(req.dimensions).length ? req.dimensions : undefined;
  if (dims) { // M4: only dimensions the company's documents already carry (there is no dimension master yet)
    const known = new Set<string>();
    for (const d of st.docs) if (d.companyId === companyId) for (const m of [d.header.dimensions, ...d.lines.map((x) => x.dimensions)]) for (const [k, v] of Object.entries(m ?? {})) known.add(`${k}|${v}`);
    const bad = Object.entries(dims).find(([k, v]) => !known.has(`${k}|${v}`));
    if (bad) throw fail(422, 'ledger.dimension_invalid', `มิติ ${bad[0]} = ${bad[1]} ไม่มีในมิติของบริษัทนี้`);
  }
  dateGuards(st, companyId, l.date);
  const amount = toSatang(l.amount), tag = (req.description ?? '').trim() || l.description;
  const incoming = amount > 0;
  const j = addJournal(st, { companyId, accountId: l.accountId, lineId, kind: 'inline', label: tag, entries: [entry(st, companyId, l.date, tag, [
    { code: bank.accountCode, debit: incoming ? abs(amount) : 0, credit: incoming ? 0 : abs(amount), ...(dims ? { dims } : {}) },
    { code: acc.code, debit: incoming ? 0 : abs(amount), credit: incoming ? abs(amount) : 0, ...(dims ? { dims } : {}) },
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(Date.parse(`${date}T00:00:00Z`) || 0).toISOString().slice(0, 10) !== date) throw fail(422, 'bank.lock_date', 'วันที่ไม่ถูกต้อง');
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
