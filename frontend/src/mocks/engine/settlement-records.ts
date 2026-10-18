import { DOC_TYPES, LIVE } from '@/domain/doc-types';
import type { Actor, DepositRow, DocType, IsoDate, JournalEntryPreview, Money, SettlementDifferenceRole, SettlementKind, SettlementLeg, SettlementRecord } from '@/domain/types';
import type { MockState } from '../store';
import { correctionReversal, dateGuards, recomputeSettlement } from './commands';
import { appliedOf, differenceUsed, toleranceOf } from './locks';
import { MockError, logActivity, logAudit, stamp } from './log';
import { fromSatang, toSatang } from './money';
import { type AccountingRole, resolveRole } from './posting';
import { balanceOf, billBases } from './settlement';

type Stored = MockState['docs'][number];
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);

export const KINDS: SettlementKind[] = ['apply_deposit', 'apply_prepayment', 'netting', 'write_off'];
export const DIFFERENCE_ROLES: SettlementDifferenceRole[] = ['RoundingDifference', 'SmallWriteOff', 'BankFee'];
/** What each kind takes as its sources / targets (types) and on which side of the books the targets sit. */
const SHAPE: Record<SettlementKind, { sources: DocType[]; targets: DocType[]; needSources: boolean }> = {
  apply_deposit: { sources: ['RC'], targets: ['TI', 'IV'], needSources: true },
  apply_prepayment: { sources: ['PV'], targets: ['PB'], needSources: true },
  netting: { sources: ['PB'], targets: ['TI', 'IV'], needSources: true },
  write_off: { sources: [], targets: ['TI', 'IV', 'PB'], needSources: false },
};
export const settlementLabel = (id: string) => id.toUpperCase();

export interface SettleRequest {
  kind: SettlementKind; date: IsoDate; partyId: string; sources?: { docId: string; amount: Money }[]; targets: { docId: string; amount: Money }[];
  difference?: { role: SettlementDifferenceRole; amount: Money }; reason?: string;
}

/** What a deposit (RC) / prepayment (PV) still holds: the amount kept on the document less what posted settlements took (satang). */
export const unappliedOf = (st: MockState, d: Stored): number => toSatang(d.header.depositAmount ?? '0.00') - appliedOf(st, d.id);

/** Customer deposits and vendor prepayments with something left to apply (live RC / PV of the company). */
export function depositsOf(st: MockState, companyId: string): DepositRow[] {
  return st.docs.filter((d) => d.companyId === companyId && (d.type === 'RC' || d.type === 'PV') && LIVE.includes(d.status) && toSatang(d.header.depositAmount ?? '0.00') > 0)
    .map((d): DepositRow => ({
      docId: d.id, type: d.type as 'RC' | 'PV', number: d.number ?? d.id, documentDate: d.header.documentDate, partyId: d.header.partyId ?? '', partyName: d.party?.name ?? '',
      amount: d.header.depositAmount!, applied: fromSatang(appliedOf(st, d.id)), remaining: fromSatang(unappliedOf(st, d)),
    })).filter((r) => toSatang(r.remaining) > 0)
    .sort((a, b) => a.documentDate.localeCompare(b.documentDate) || a.number.localeCompare(b.number));
}

export { toleranceOf };

const positive = (m: unknown, code: string, what: string): number => {
  let n: number;
  try { n = toSatang(String(m)); } catch { throw fail(422, code, `จำนวนเงินของ${what}ไม่ถูกต้อง`); }
  if (n <= 0) throw fail(422, code, `จำนวนเงินของ${what}ต้องมากกว่า 0`);
  return n;
};

/** Resolves the legs of one side: right company, type, live, party, no duplicate, amount within what the document can give (a source's unapplied remainder, a target's outstanding NOW). */
function legs(st: MockState, companyId: string, side: 'source' | 'target', list: { docId: string; amount: Money }[], accept: DocType[], partyId: string, date: IsoDate): { legs: SettlementLeg[]; docs: Stored[] } {
  const seen = new Set<string>(), out: SettlementLeg[] = [], docs: Stored[] = [];
  const word = side === 'source' ? 'ต้นทาง' : 'ปลายทาง';
  for (const r of list) {
    const d = st.docs.find((x) => x.id === r.docId && x.companyId === companyId);
    if (!d) throw fail(422, `settle.${side}_not_found`, `ไม่พบเอกสาร${word}`);
    const label = d.number ?? d.id;
    if (seen.has(d.id)) throw fail(422, 'settle.duplicate_target', `เลือก ${label} ซ้ำ รวมยอดเป็นรายการเดียว`);
    seen.add(d.id);
    if (!accept.includes(d.type)) throw fail(422, 'settle.wrong_type', `${label} ใช้เป็นเอกสาร${word}ของรายการนี้ไม่ได้`);
    if (!LIVE.includes(d.status)) throw fail(422, `settle.${side}_not_open`, `${label} ไม่อยู่ในสถานะที่ใช้ได้`);
    if (d.header.partyId !== partyId) throw fail(422, 'settle.party_mismatch', `${label} เป็นของคู่ค้าคนละราย`);
    if (date < d.header.documentDate) throw fail(422, 'settle.date_before_document', `วันที่รายการต้องไม่ก่อนวันที่ของ ${label}`);
    const amount = positive(r.amount, 'settle.invalid_amount', label);
    if (d.type === 'RC' || d.type === 'PV') {
      if (amount > unappliedOf(st, d)) throw fail(422, 'settle.over_application', `ใช้ ${label} เกินยอดเงินล่วงหน้าคงเหลือ (คงเหลือ ${fromSatang(Math.max(unappliedOf(st, d), 0))} บาท)`);
    } else if (amount > balanceOf(st, d).out) {
      throw fail(422, 'settle.over_allocation', `หัก ${label} เกินยอดค้างชำระ (ค้างชำระ ${fromSatang(Math.max(balanceOf(st, d).out, 0))} บาท)`);
    }
    out.push({ docId: d.id, amount: fromSatang(amount), type: d.type, number: d.number ?? d.id, partyId, partyName: d.party?.name ?? '' });
    docs.push(d);
  }
  return { legs: out, docs };
}

const sum = (xs: SettlementLeg[]) => xs.reduce((n, l) => n + toSatang(l.amount), 0);

type Row = { role: AccountingRole; dr: number; cr: number; party?: string; partyId?: string; item?: string };
/** The journal rows of a settlement (§5.11): the postings of the task, one row per leg under its own party name. */
function rowsOf(kind: SettlementKind, sources: SettlementLeg[], targets: SettlementLeg[], diff: { role: SettlementDifferenceRole; amount: number } | undefined, payableTargets: boolean): Row[] {
  const rows: Row[] = [];
  const d = diff?.amount ?? 0;
  if (kind === 'apply_deposit') {
    for (const s of sources) rows.push({ role: 'CustomerDeposit', dr: toSatang(s.amount), cr: 0, party: s.partyName, partyId: s.partyId, item: s.docId });
    if (diff) rows.push({ role: diff.role, dr: d, cr: 0 });
    for (const t of targets) rows.push({ role: 'AR', dr: 0, cr: toSatang(t.amount), party: t.partyName, partyId: t.partyId, item: t.docId });
  } else if (kind === 'apply_prepayment') {
    for (const t of targets) rows.push({ role: 'AP', dr: toSatang(t.amount), cr: 0, party: t.partyName, partyId: t.partyId, item: t.docId });
    for (const s of sources) rows.push({ role: 'VendorPrepayment', dr: 0, cr: toSatang(s.amount), party: s.partyName, partyId: s.partyId, item: s.docId });
    if (diff) rows.push({ role: diff.role, dr: 0, cr: d });
  } else if (kind === 'netting') {
    for (const s of sources) rows.push({ role: 'AP', dr: toSatang(s.amount), cr: 0, party: s.partyName, partyId: s.partyId, item: s.docId });
    for (const t of targets) rows.push({ role: 'AR', dr: 0, cr: toSatang(t.amount), party: t.partyName, partyId: t.partyId, item: t.docId });
  } else if (payableTargets) { // a payable written off: we owe less, the difference is ours
    for (const t of targets) rows.push({ role: 'AP', dr: toSatang(t.amount), cr: 0, party: t.partyName, partyId: t.partyId, item: t.docId });
    rows.push({ role: diff!.role, dr: 0, cr: d });
  } else { // a receivable written off: the difference is a cost
    rows.push({ role: diff!.role, dr: d, cr: 0 });
    for (const t of targets) rows.push({ role: 'AR', dr: 0, cr: toSatang(t.amount), party: t.partyName, partyId: t.partyId, item: t.docId });
  }
  return rows;
}

const RULE_TH: Record<SettlementKind, string> = { apply_deposit: 'ใช้เงินมัดจำ', apply_prepayment: 'ใช้เงินจ่ายล่วงหน้า', netting: 'หักกลบ', write_off: 'ตัดส่วนต่าง' };

function journalOf(st: MockState, companyId: string, id: string, kind: SettlementKind, date: IsoDate, rows: Row[]): JournalEntryPreview {
  const acc = new Map<string, { code: string; name: string; rule: string; net: number; party?: string; partyId?: string; item?: string }>();
  for (const r of rows) {
    const res = resolveRole(st, r.role, { companyId, docType: 'JV' });
    const key = `${res.code}|${r.party ?? ''}|${r.partyId ?? ''}|${r.item ?? ''}`, prev = acc.get(key);
    acc.set(key, prev ? { ...prev, net: prev.net + r.dr - r.cr } : { code: res.code, name: res.name, rule: `${res.rule} (${RULE_TH[kind]} ${settlementLabel(id)})`, net: r.dr - r.cr, party: r.party, partyId: r.partyId, item: r.item });
  }
  const lines = [...acc.values()].filter((x) => x.net !== 0).map((x) => ({
    accountCode: x.code, accountName: x.name, debit: fromSatang(Math.max(x.net, 0)), credit: fromSatang(Math.max(-x.net, 0)), rule: x.rule, ...(x.party ? { partyName: x.party } : {}), ...(x.partyId ? { partyId: x.partyId } : {}), ...(x.item ? { openItemId: x.item } : {}),
  }));
  const dr = lines.reduce((n, l) => n + toSatang(l.debit), 0), cr = lines.reduce((n, l) => n + toSatang(l.credit), 0);
  if (!lines.length || dr !== cr) throw fail(500, 'engine.invariant', 'รายการบัญชีของการหักกลบไม่สมดุล');
  return { date, kind: 'original', postedAt: stamp(), lines };
}

const newId = (st: MockState): string => {
  let n = st.settlements.length + 1;
  while (st.settlements.some((s) => s.id === `stl-${String(n).padStart(3, '0')}`)) n++;
  return `stl-${String(n).padStart(3, '0')}`;
};

/** Posts a settlement record (D-13): validates every rule, then writes the record with its frozen legs, its journal and its `settles` links in one go. Nothing is written when anything is refused. */
export function postSettlement(st: MockState, companyId: string, req: SettleRequest, actor: Actor): SettlementRecord {
  if (!req || typeof req !== 'object' || !KINDS.includes(req.kind)) throw fail(422, 'settle.invalid_kind', 'ประเภทรายการหักกลบไม่ถูกต้อง');
  const shape = SHAPE[req.kind];
  if (typeof req.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) throw fail(422, 'settle.invalid_date', 'ต้องระบุวันที่ของรายการ');
  dateGuards(st, companyId, req.date); // not in the future, not in a closed period (D-10)
  const party = st.parties.find((p) => p.id === req.partyId && p.companyId === companyId);
  if (!party) throw fail(422, 'settle.party_not_found', 'ไม่พบคู่ค้า');
  const sourceReq = req.sources ?? [], targetReq = req.targets ?? [];
  if (!targetReq.length || (shape.needSources && !sourceReq.length) || (!shape.needSources && sourceReq.length)) {
    throw fail(422, 'settle.incomplete', req.kind === 'write_off' ? 'ต้องเลือกเอกสารที่ต้องการตัดส่วนต่าง' : 'ต้องเลือกทั้งเอกสารต้นทางและเอกสารปลายทาง');
  }

  // who is on which side: a netting pairs a customer with the vendor it is linked to (either one may be named; both name each other), every other kind has one party
  let sourceParty = party.id, targetParty = party.id, counterPartyId: string | undefined, partyId = party.id;
  if (req.kind === 'netting') {
    // linked both ways: the party names the other AND the other names the party
    const other = st.parties.find((p) => p.companyId === companyId && p.id === party.linkedPartyId && p.linkedPartyId === party.id);
    const cust = party.kind === 'customer' ? party : other, vend = party.kind === 'vendor' ? party : other;
    if (!cust || !vend || cust.kind !== 'customer' || vend.kind !== 'vendor') {
      throw fail(422, 'settle.not_linked', 'หักกลบได้เฉพาะลูกค้าและผู้ขายที่เป็นคู่ค้ารายเดียวกัน (เชื่อมโยงกันในข้อมูลหลัก)');
    }
    partyId = cust.id; counterPartyId = vend.id; targetParty = cust.id; sourceParty = vend.id;
  } else if (req.kind === 'write_off') {
    const types = targetReq.map((r) => st.docs.find((d) => d.id === r.docId)?.type);
    if (types.some((t) => t === 'PB') && types.some((t) => t !== 'PB')) throw fail(422, 'settle.mixed_sides', 'ตัดส่วนต่างลูกหนี้และเจ้าหนี้พร้อมกันไม่ได้');
  }
  const accept = req.kind === 'write_off' ? (party.kind === 'vendor' ? ['PB'] : ['TI', 'IV']) as DocType[] : shape.targets;
  const src = legs(st, companyId, 'source', sourceReq, shape.sources, sourceParty, req.date);
  const tgt = legs(st, companyId, 'target', targetReq, accept, targetParty, req.date);

  // a bill with a WHT-typed line is paid by a voucher only: a settlement without cash would leave the remaining-balance WHT base (P3) wrong [SP-R]
  for (const d of [...src.docs, ...tgt.docs]) {
    if (d.type === 'PB' && billBases(st, d).size > 0) throw fail(422, 'settle.prepayment_wht', `${d.number ?? d.id} มีรายการที่ต้องหักภาษี ณ ที่จ่าย นำเงินจ่ายล่วงหน้า/หักกลบ/ตัดส่วนต่างไม่ได้ ให้จ่ายด้วยใบสำคัญจ่าย`);
  }

  let diff: { role: SettlementDifferenceRole; amount: number } | undefined;
  if (req.difference !== undefined) {
    if (req.kind === 'netting') throw fail(422, 'settle.netting_difference', 'การหักกลบต้องหักด้วยยอดเท่ากันทั้งสองฝั่ง ไม่มีส่วนต่าง');
    if (!DIFFERENCE_ROLES.includes(req.difference.role)) throw fail(422, 'settle.invalid_difference', 'ประเภทส่วนต่างไม่ถูกต้อง');
    diff = { role: req.difference.role, amount: positive(req.difference.amount, 'settle.invalid_amount', 'ส่วนต่าง') };
    // cumulative per target and role: what its live settlements already took plus this request must stay within the tolerance
    const limit = toleranceOf(st, companyId, diff.role);
    for (const t of tgt.docs) {
      const used = differenceUsed(st, t.id, diff.role);
      if (used + diff.amount > limit) throw fail(422, 'settle.beyond_tolerance', `${t.number ?? t.id}: เกินเกณฑ์ที่กำหนด (ใช้ไปแล้ว ${fromSatang(used)} / ขอ ${fromSatang(diff.amount)} / เกณฑ์ ${fromSatang(limit)} บาท) ต้องออกใบลดหนี้หรือรับชำระเพิ่ม`);
    }
  }
  if (req.kind === 'write_off' && !diff) throw fail(422, 'settle.incomplete', 'ต้องระบุส่วนต่างที่ตัด');
  const ts = sum(tgt.legs), ss = sum(src.legs);
  if (req.kind === 'netting' ? ss !== ts : ts !== ss + (diff?.amount ?? 0)) {
    throw fail(422, req.kind === 'netting' ? 'settle.netting_unbalanced' : 'settle.unbalanced', req.kind === 'netting' ? 'ยอดลูกหนี้และเจ้าหนี้ที่หักกลบต้องเท่ากัน' : 'ยอดที่หักกับเอกสารปลายทางไม่สมดุลกับเงินล่วงหน้าและส่วนต่าง');
  }

  const id = newId(st);
  const payable = tgt.docs.length > 0 && tgt.docs.every((d) => d.type === 'PB');
  const entry = journalOf(st, companyId, id, req.kind, req.date, rowsOf(req.kind, src.legs, tgt.legs, diff, payable));
  const rec: SettlementRecord = {
    id, companyId, kind: req.kind, date: req.date, partyId, ...(counterPartyId ? { counterPartyId } : {}), sources: src.legs, targets: tgt.legs,
    ...(diff ? { difference: { role: diff.role, amount: fromSatang(diff.amount) } } : {}), status: 'posted', journal: [entry],
    ...(typeof req.reason === 'string' && req.reason.trim() ? { reason: req.reason.trim() } : {}), createdBy: actor, postedAt: entry.postedAt!,
  };
  const tol = st.settlementTolerance.find((x) => x.companyId === companyId);
  st.settlements.push({ ...rec, tolerance: { rounding: tol?.rounding ?? '0.00', smallWriteOff: tol?.smallWriteOff ?? '0.00' } }); // FN3 M-4: the tolerance in force now stays with the settlement
  for (const l of [...src.legs, ...tgt.legs]) st.links.push({ companyId, from: id, to: l.docId, kind: 'settles', amount: l.amount, active: true });
  touch(st, [...src.legs, ...tgt.legs]);
  for (const l of [...src.legs, ...tgt.legs]) logActivity(st, l.docId, actor, 'settlement', `${settlementLabel(id)} · ${l.amount}`);
  logAudit(st, actor, companyId, 'settlement.post', id, undefined, { kind: rec.kind, date: rec.date, sources: rec.sources, targets: rec.targets, difference: rec.difference });
  return structuredClone(rec);
}

/** Refreshes the balance of every leg that carries an outstanding amount (a deposit / prepayment does not). */
function touch(st: MockState, list: SettlementLeg[]): void {
  for (const l of list) { const d = st.docs.find((x) => x.id === l.docId); if (d && DOC_TYPES[d.type].outstanding) recomputeSettlement(st, d.id); }
}

/** Reverses a posted settlement: one reversing journal (on the original date while its period is open, else late on the first open date, SP0 5.9), its links inactive, every leg's balance back. Twice is refused. */
export function reverseSettlement(st: MockState, companyId: string, id: string, actor: Actor, reason?: string): SettlementRecord {
  const s = st.settlements.find((x) => x.id === id && x.companyId === companyId);
  if (!s) throw fail(404, 'settlement.not_found', 'ไม่พบรายการหักกลบ');
  if (s.status === 'reversed') throw fail(409, 'settle.already_reversed', 'รายการหักกลบนี้ถูกย้อนแล้ว');
  const original = s.journal[s.journal.length - 1];
  s.journal.push(correctionReversal(st, companyId, original));
  s.status = 'reversed';
  s.reversal = { at: stamp(), by: actor, ...(reason?.trim() ? { reason: reason.trim() } : {}) };
  st.links = st.links.map((l) => (l.active && l.kind === 'settles' && l.from === id ? { ...l, active: false } : l));
  touch(st, [...s.sources, ...s.targets]);
  for (const l of [...s.sources, ...s.targets]) logActivity(st, l.docId, actor, 'settlement_reverse', `${settlementLabel(id)} · ${l.amount}`);
  logAudit(st, actor, companyId, 'settlement.reverse', id, { status: 'posted' }, { status: 'reversed', reason });
  return structuredClone(s);
}
