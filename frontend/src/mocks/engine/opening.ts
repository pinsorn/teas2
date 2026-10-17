import { LIVE } from '@/domain/doc-types';
import type { Actor, DocHeader, DocLine, DocOpening, IsoDate, JournalLinePreview, MissingItem, ObCheck, ObSide } from '@/domain/types';
import type { MockState } from '../store';
import { goLiveOf } from './commands';
import { MockError } from './log';
import { fromSatang, toSatang } from './money';
import { firstOpenDate } from './periods';
import { lastDayOf } from './schedules';

/** The first day of the earliest month of the company's period calendar that is not closed (periods before it are closed): the books of an open month already hold documents, so an opening cannot be dated inside or after it. No calendar = the first open month from today. */
export const firstOpenMonthStart = (st: MockState, companyId: string): IsoDate => {
  const open = st.periods.filter((p) => p.companyId === companyId && p.status !== 'closed').map((p) => p.month).sort()[0];
  return open ? `${open}-01` : firstOpenDate(st, companyId);
};
import { type AccountingRole, resolveRole } from './posting';
import { bahtText } from './bahtText';

// AC3: the opening-balance batch (OB). Its journal is NOT its trial-balance lines verbatim: a controlled account (receivable, payable, employee payable, deposits, prepayments, bank / cash) posts what its STEP says
// (one line per party for the sub-ledgers, one per bank account), the trial-balance line only has to TIE to it (`ob.subledger_mismatch`, both figures). Whatever is left over is posted to 3900.
// VAT / WHT balances (1170, 2151, 2131-2135 ...) are plain trial-balance lines: no sub-ledger yet [SP-R].

type Stored = MockState['docs'][number];
type Part = { header: DocHeader; lines: DocLine[]; opening?: DocOpening };
const fail = (status: number, code: string, title: string) => new MockError(status, code, title);
const money = (x: number) => fromSatang(x);
const satOf = (m: string | undefined): number => { try { return toSatang(m ?? '0.00'); } catch { return NaN; } };
const isUsed = (l: DocLine) => !!l.accountCode || satOf(l.debit) !== 0 || satOf(l.credit) !== 0;
export const EMPTY_OPENING: DocOpening = { openItems: [], assets: [], payrollYtd: [], bank: [] };
export const PLUG_TH = 'ผลต่างยกไปส่วนเกินทุนยอดยกมา';
const RULE = 'ยอดยกมา';

const SIDES: Record<ObSide, { role: AccountingRole; dr: boolean; kind: 'customer' | 'vendor' | 'employee'; label: string }> = {
  AR: { role: 'AR', dr: true, kind: 'customer', label: 'ลูกหนี้' }, AP: { role: 'AP', dr: false, kind: 'vendor', label: 'เจ้าหนี้' },
  EMP: { role: 'EmployeePayable', dr: false, kind: 'employee', label: 'เจ้าหนี้พนักงาน' },
  DEP: { role: 'CustomerDeposit', dr: false, kind: 'customer', label: 'เงินรับล่วงหน้าจากลูกค้า' }, PRE: { role: 'VendorPrepayment', dr: true, kind: 'vendor', label: 'เงินจ่ายล่วงหน้าผู้ขาย' },
};
export const nextDay = (d: IsoDate): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const prevDay = (d: IsoDate): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const isOb = (d: { type: string; header: DocHeader }) => d.type === 'OB' && !d.header.obBatchId;
/** The live opening-balance batch(es) of a company (not its frozen items). */
export const liveBatches = (st: MockState, companyId: string): Stored[] => st.docs.filter((d) => d.companyId === companyId && isOb(d) && LIVE.includes(d.status));
/** The frozen open items / in-transit items a batch created. */
export const itemsOf = (st: MockState, batchId: string): Stored[] => st.docs.filter((d) => d.header.obBatchId === batchId);

const codeOf = (st: MockState, companyId: string, role: AccountingRole, assetClass?: string): string => {
  try { return resolveRole(st, role, { companyId, docType: 'OB', ...(assetClass ? { assetClass } : {}) }).code; } catch (e) { throw e instanceof MockError ? fail(422, e.code, e.title) : e; }
};
const nameOf = (st: MockState, companyId: string, code: string) => st.accounts.find((a) => a.companyId === companyId && a.code === code)?.nameTh ?? code;
const bankOf = (st: MockState, companyId: string, id: string) => st.bankAccounts.find((b) => b.id === id && b.companyId === companyId);

// ---------------------------------------------------------------- the journal and its ties

/** Journal lines of the batch, the ties, and the 3900 plug. Pure: it judges nothing, it only states. */
export function buildOb(st: MockState, companyId: string, body: Part): { lines: JournalLinePreview[]; check: ObCheck } {
  const op = body.opening ?? EMPTY_OPENING, used = body.lines.filter((l) => isUsed(l) && !!l.accountCode);
  const tbNet = (code: string, party?: string) => used.filter((l) => l.accountCode === code && (party === undefined || (l.partyId ?? '') === party)).reduce((n, l) => n + (satOf(l.debit) || 0) - (satOf(l.credit) || 0), 0);
  const ties: ObCheck['ties'] = [];
  const tie = (key: string, label: string, code: string, tb: number, sub: number, normalDr: boolean) => {
    if (tb === 0 && sub === 0) return;
    const sg = normalDr ? 1 : -1;
    ties.push({ key, label, code, tb: money(tb * sg), sub: money(sub * sg), ok: tb === sub });
  };
  const lines: JournalLinePreview[] = [];
  const line = (code: string, net: number, rule: string, party?: string): void => {
    if (net === 0) return;
    lines.push({ accountCode: code, accountName: nameOf(st, companyId, code), debit: money(Math.max(net, 0)), credit: money(Math.max(-net, 0)), rule, ...(party ? { partyName: party } : {}) });
  };
  const replaced = new Set<string>(); // accounts whose trial-balance line is stated by a step instead
  const frozenName = new Map(op.openItems.filter((i) => i.partyName).map((i) => [i.partyId, i.partyName!])); // AS OF the issue / revise that wrote it: a rename later moves nothing
  const partyName = (id: string) => frozenName.get(id) ?? st.parties.find((p) => p.id === id && p.companyId === companyId)?.name ?? id;
  const acct = (role: AccountingRole, cls?: string) => op.codes?.[cls ? `${role}:${cls}` : role] ?? codeOf(st, companyId, role, cls); // likewise the account each role resolved to (labels - account names - stay live)

  // 2 + 4: the sub-ledgers, per party
  for (const [side, def] of Object.entries(SIDES) as [ObSide, (typeof SIDES)[ObSide]][]) {
    const items = op.openItems.filter((i) => i.side === side), code = acct(def.role), sg = def.dr ? 1 : -1;
    replaced.add(code);
    tie(side, `${def.label} (ขั้นตอนที่ 2)`, code, tbNet(code), items.reduce((n, i) => n + sg * (satOf(i.amount) || 0), 0), def.dr);
    if (used.some((l) => l.accountCode === code && l.partyId)) { // trial-balance lines named per party: each party's line ties to that party's items
      for (const p of new Set([...used.filter((l) => l.accountCode === code).map((l) => l.partyId ?? ''), ...items.map((i) => i.partyId)])) {
        tie(`${side}:${p}`, `${def.label} ${p ? partyName(p) : '(ไม่ระบุคู่ค้า)'}`, code, tbNet(code, p), items.filter((i) => i.partyId === p).reduce((n, i) => n + sg * (satOf(i.amount) || 0), 0), def.dr);
      }
    }
    for (const p of new Set(items.map((i) => i.partyId))) line(code, sg * items.filter((i) => i.partyId === p).reduce((n, i) => n + (satOf(i.amount) || 0), 0), `${RULE}: ${def.role} → ${code}`, partyName(p));
  }
  // 1: bank / cash accounts: statement balance + deposits in transit - outstanding payments
  // an account the batch opened is tied by the code it froze (a draft: its live code); the others by their live code - a later re-binding of an opened account moves no tie
  const opened = new Set(op.bank.map((b) => b.accountId));
  const bankCodes = new Set([...st.bankAccounts.filter((b) => b.companyId === companyId && !opened.has(b.id)).map((b) => b.accountCode), ...op.bank.map((b) => op.codes?.[`BANK:${b.accountId}`] ?? bankOf(st, companyId, b.accountId)?.accountCode).filter((c): c is string => !!c)]);
  const bankSub = new Map<string, number>();
  for (const b of op.bank) {
    const ba = bankOf(st, companyId, b.accountId);
    if (!ba) continue;
    const bcode = op.codes?.[`BANK:${b.accountId}`] ?? ba.accountCode;
    const net = (satOf(b.statement) || 0) + b.inTransit.reduce((n, t) => n + (t.kind === 'deposit' ? 1 : -1) * (satOf(t.amount) || 0), 0);
    bankSub.set(bcode, (bankSub.get(bcode) ?? 0) + net);
    line(bcode, net, `${RULE}: ${ba.nameTh} (ยอด statement + รายการระหว่างทาง)`);
  }
  for (const code of bankCodes) { replaced.add(code); tie(`BANK:${code}`, 'เงินสด/ธนาคาร (ขั้นตอนที่ 1 ยอด statement + รายการระหว่างทาง)', code, tbNet(code), bankSub.get(code) ?? 0, true); }
  // 3: fixed assets and their accumulated depreciation, by the account their class posts to
  const assetSub = new Map<string, number>();
  for (const a of op.assets) {
    const cost = acct('FixedAsset', a.assetClass), acc = acct('AccumulatedDepreciation', a.assetClass);
    assetSub.set(cost, (assetSub.get(cost) ?? 0) + (satOf(a.cost) || 0)); assetSub.set(acc, (assetSub.get(acc) ?? 0) - (satOf(a.accumulated) || 0));
  }
  for (const a of st.accounts) if (a.companyId === companyId && (a.subClass === 'fixed-asset' || a.subClass === 'accumulated-depreciation')) {
    replaced.add(a.code);
    tie(`ASSET:${a.code}`, `${a.subClass === 'fixed-asset' ? 'สินทรัพย์ถาวร' : 'ค่าเสื่อมราคาสะสม'} (ขั้นตอนที่ 3)`, a.code, tbNet(a.code), assetSub.get(a.code) ?? 0, a.subClass === 'fixed-asset');
    line(a.code, assetSub.get(a.code) ?? 0, `${RULE}: ${a.nameTh}`);
  }
  // every other trial-balance line is posted as typed
  for (const l of used) if (!replaced.has(l.accountCode!)) {
    lines.push({ accountCode: l.accountCode!, accountName: nameOf(st, companyId, l.accountCode!), debit: money(satOf(l.debit) || 0), credit: money(satOf(l.credit) || 0),
      rule: l.description.trim() ? `${RULE}: ${l.description.trim()}` : RULE });
  }
  const dr = lines.reduce((n, l) => n + toSatang(l.debit), 0), cr = lines.reduce((n, l) => n + toSatang(l.credit), 0), diff = dr - cr;
  if (diff !== 0) {
    const eq = acct('OpeningBalanceEquity');
    lines.push({ accountCode: eq, accountName: nameOf(st, companyId, eq), debit: money(Math.max(-diff, 0)), credit: money(Math.max(diff, 0)), rule: PLUG_TH });
  }
  return { lines, check: { debit: money(Math.max(dr, cr)), credit: money(Math.max(dr, cr)), plug: money(Math.abs(diff)), plugSide: diff === 0 ? null : diff > 0 ? 'Cr' : 'Dr', ties } };
}
/** The journal lines of an OB batch (the ledger reads this). A frozen item posts nothing itself. */
export const obEntryLines = (st: MockState, companyId: string, doc: { header: DocHeader; lines: DocLine[]; opening?: DocOpening }): JournalLinePreview[] =>
  doc.header.obBatchId ? [] : buildOb(st, companyId, doc).lines;
/** Total of a batch = its debit side after the plug. */
export const obTotals = (st: MockState, companyId: string, body: Part) => {
  const total = buildOb(st, companyId, body).check.debit;
  return { gross: total, discount: '0.00', net: total, vat: '0.00', total, amountInWords: bahtText(total) };
};
export const obCalc = (lines: DocLine[]) => ({ lines: lines.map((l) => { const a = fromSatang(Math.max(satOf(l.debit) || 0, satOf(l.credit) || 0)); return { id: l.id, net: a, vat: '0.00', total: a }; }) });

// ---------------------------------------------------------------- what is missing, what is refused

export function obMissing(st: MockState, companyId: string, body: Part): MissingItem[] {
  const out: MissingItem[] = [];
  body.lines.filter(isUsed).forEach((l, i) => {
    const n = i + 1, dr = satOf(l.debit), cr = satOf(l.credit);
    if (!l.accountCode) out.push({ field: 'lines', message: `รายการที่ ${n}: ต้องเลือกบัญชี` });
    if (Number.isNaN(dr) || Number.isNaN(cr) || dr < 0 || cr < 0) out.push({ field: 'lines', message: `รายการที่ ${n}: จำนวนเงินไม่ถูกต้อง` });
    else if ((dr > 0) === (cr > 0)) out.push({ field: 'lines', message: `รายการที่ ${n}: ต้องระบุเดบิตหรือเครดิตอย่างใดอย่างหนึ่ง` });
  });
  let journal: JournalLinePreview[] = [];
  try { journal = buildOb(st, companyId, body).lines; } catch { /* an unresolved posting rule is reported by obProblem */ }
  const op = body.opening ?? EMPTY_OPENING;
  if (!journal.length && !body.lines.some((l) => isUsed(l)) && !op.openItems.length && !op.assets.length && !op.bank.length) out.push({ field: 'lines', message: 'ต้องมียอดยกมาอย่างน้อย 1 รายการ' });
  return out;
}

/** Everything that refuses an OB before anything is written (compute shows it, issue / revise throw it). `selfId`: the batch being revised, whose own go-live and live-batch status do not count against it. */
export function obProblem(st: MockState, companyId: string, body: Part, selfId?: string): MockError | undefined {
  const date = body.header.documentDate, op = body.opening ?? EMPTY_OPENING;
  if (!date) return undefined;
  const firstOpen = firstOpenMonthStart(st, companyId), limit = prevDay(firstOpen);
  if (date > limit) return fail(422, 'ob.cutoff', `วันตัดยอดต้องไม่เกิน ${limit} (วันก่อนเริ่มงวดบัญชีแรกที่ยังเปิดอยู่ ${firstOpen} งวดที่เปิดแล้วมีเอกสารอยู่)`);
  if (op.assets.length && date !== lastDayOf(date.slice(0, 7))) return fail(422, 'ob.asset_cutoff', `วันตัดยอดที่มีสินทรัพย์ต้องเป็นวันสิ้นเดือน (${lastDayOf(date.slice(0, 7))}) เพราะค่าเสื่อมราคาเริ่มคิดจากเดือนถัดไป ทางออก: ใช้วันสิ้นเดือน`);
  const other = liveBatches(st, companyId).find((d) => d.id !== selfId);
  if (other) return fail(409, 'ob.already_exists', `บริษัทนี้มียอดยกมา ${other.number ?? other.id} อยู่แล้ว มีได้ฉบับเดียว ให้แก้ไข (revise) ฉบับเดิมหรือยกเลิกก่อน`);
  for (const l of body.lines.filter((x) => isUsed(x) && !!x.accountCode)) {
    const a = st.accounts.find((x) => x.companyId === companyId && x.code === l.accountCode);
    if (!a || !a.postable || (a as { active?: boolean }).active === false) return fail(422, 'ledger.account_invalid', `บัญชี ${l.accountCode} ใช้ลงรายการไม่ได้ (ไม่มีในผังบัญชีของบริษัท เป็นบัญชีหมวด หรือปิดใช้งานแล้ว)`);
    if (a.code === codeOf(st, companyId, 'OpeningBalanceEquity')) return fail(422, 'ob.plug_account', `บัญชี ${a.code} ${a.nameTh} ระบบคำนวณให้เอง (${PLUG_TH}) ไม่ต้องกรอก`);
    if (l.partyId && !st.parties.some((p) => p.id === l.partyId && p.companyId === companyId)) return fail(422, 'ledger.party_invalid', `ไม่พบคู่ค้าของรายการบัญชี ${a.code}`);
  }
  for (const [i, it] of op.openItems.entries()) {
    const n = `ยอดค้างรายการที่ ${i + 1}`, p = st.parties.find((x) => x.id === it.partyId && x.companyId === companyId);
    if (!SIDES[it.side]) return fail(422, 'ob.item_invalid', `${n}: ประเภทไม่ถูกต้อง`);
    if (!p || p.kind !== SIDES[it.side].kind) return fail(422, 'ob.item_party', `${n}: ต้องเลือก${SIDES[it.side].kind === 'customer' ? 'ลูกค้า' : SIDES[it.side].kind === 'vendor' ? 'ผู้ขาย' : 'พนักงาน'}ของบริษัทนี้`);
    if (!(satOf(it.amount) > 0)) return fail(422, 'ob.item_invalid', `${n}: จำนวนเงินต้องมากกว่า 0`);
    if (!it.docNumber?.trim()) return fail(422, 'ob.item_invalid', `${n}: ต้องระบุเลขที่เอกสาร`);
    if (!it.docDate || it.docDate > date) return fail(422, 'ob.item_invalid', `${n}: วันที่เอกสารต้องไม่หลังวันตัดยอด ${date}`);
    if (it.dueDate && it.dueDate < it.docDate) return fail(422, 'ob.item_invalid', `${n}: วันครบกำหนดต้องไม่ก่อนวันที่เอกสาร`);
  }
  for (const [i, a] of op.assets.entries()) {
    if (!a.name?.trim() || !(satOf(a.cost) >= 0) || !(satOf(a.accumulated) >= 0) || satOf(a.accumulated) > satOf(a.cost)) return fail(422, 'ob.asset_invalid', `สินทรัพย์รายการที่ ${i + 1}: ต้องมีชื่อ และค่าเสื่อมราคาสะสมต้องไม่เกินราคาทุน`);
  }
  for (const [i, y] of op.payrollYtd.entries()) {
    if (!st.parties.some((p) => p.id === y.employeeId && p.companyId === companyId && p.kind === 'employee') || [y.income, y.pit, y.sso].some((m) => !(satOf(m) >= 0))) return fail(422, 'ob.payroll_invalid', `ข้อมูลเงินเดือนสะสมรายการที่ ${i + 1} ไม่ถูกต้อง`);
  }
  const seen = new Set<string>();
  for (const b of op.bank) {
    const acct = bankOf(st, companyId, b.accountId);
    if (!acct) return fail(422, 'ob.bank_invalid', 'ไม่พบบัญชีธนาคาร/เงินสดของบริษัทนี้');
    if (seen.has(b.accountId)) return fail(422, 'ob.bank_invalid', `เลือกบัญชี ${acct.nameTh} ซ้ำ`);
    seen.add(b.accountId);
    if (Number.isNaN(satOf(b.statement))) return fail(422, 'ob.bank_invalid', `${acct.nameTh}: ยอดตาม statement ไม่ถูกต้อง`);
    const live = goLiveOf(st, companyId, b.accountId);
    if (live && !(acct.goLiveBy && acct.goLiveBy === selfId)) return fail(422, 'ob.bank_live', `${acct.nameTh} เริ่มกระทบยอดกับ statement แล้ว (ตั้งแต่ ${live}${acct.goLiveBy ? ` ตามยอดยกมา ${st.docs.find((d) => d.id === acct.goLiveBy)?.number ?? acct.goLiveBy}` : ' มี statement นำเข้าแล้ว'}) เปิดยอดยกมาซ้ำไม่ได้ ทางออก: แก้ไขใบยอดยกมาเดิม`);
    for (const t of b.inTransit) {
      if (!(satOf(t.amount) > 0) || !t.description?.trim()) return fail(422, 'ob.bank_invalid', `${acct.nameTh}: รายการระหว่างทางต้องมีคำอธิบายและจำนวนเงินมากกว่า 0`);
      if (!t.date || t.date > date) return fail(422, 'ob.bank_invalid', `${acct.nameTh}: วันที่ของรายการระหว่างทางต้องไม่หลังวันตัดยอด ${date}`);
    }
  }
  const bad = buildOb(st, companyId, body).check.ties.find((t) => !t.ok);
  if (bad) return fail(422, 'ob.subledger_mismatch', `${bad.label} บัญชี ${bad.code}: ยอดในงบทดลอง ${bad.tb} ไม่เท่ากับยอดที่กรอกในขั้นตอนอื่น ${bad.sub} (ต่าง ${money(Math.abs(toSatang(bad.tb) - toSatang(bad.sub)))}) แก้ให้เท่ากันก่อนบันทึก`);
  return undefined;
}

// ---------------------------------------------------------------- freeze at issue / revise

/** The opening without its server-owned fields (ids, frozen names, frozen codes): what a caller means, to compare a request with the stored batch. */
export const plainOpening = (op: DocOpening | undefined): unknown => op && ({ openItems: op.openItems.map(({ id: _i, partyName: _n, ...r }) => (void _i, void _n, r)), assets: op.assets.map(({ id: _a, ...r }) => (void _a, r)), payrollYtd: op.payrollYtd,
  bank: op.bank.map((b) => ({ ...b, inTransit: b.inTransit.map(({ id: _i, ...r }) => (void _i, r)) })) });
/** F1 / F3: stamps what the journal derives from editable data onto the opening AS OF this write - each item's party name, the account of every role / asset class / bank account - and gives every item a server-owned id.
 *  An id the caller echoes is kept only if `prev` (the batch as stored) holds it; anything else gets a fresh id that no item of the batch ever had. A caller's names and codes are replaced. */
export function freezeOpening(st: MockState, companyId: string, batchId: string, op: DocOpening, prev?: DocOpening): DocOpening {
  const own = new Set([...(prev?.openItems ?? []).map((i) => i.id), ...(prev?.assets ?? []).map((a) => a.id), ...(prev?.bank ?? []).flatMap((b) => b.inTransit.map((t) => t.id))].filter((x): x is string => !!x));
  const taken = new Set([...st.docs.filter((d) => d.header.obBatchId === batchId).map((d) => d.id), ...st.docs.flatMap((d) => (d.type === 'FA' && d.asset?.source.kind === 'ob' && d.asset.source.docId === batchId ? [d.asset.source.rowId] : []))]); // dropped items keep their (cancelled) rows, an asset row its asset: their ids are never reused
  const fresh = (prefix: string): string => { let k = 1; while (taken.has(`${prefix}${k}`)) k++; taken.add(`${prefix}${k}`); return `${prefix}${k}`; };
  const pick = (id: string | undefined, prefix: string): string => { if (id && own.has(id) && !seen.has(id)) { seen.add(id); return id; } return fresh(prefix); };
  const seen = new Set<string>();
  for (const id of own) taken.add(id);
  const codes: Record<string, string> = {};
  for (const def of Object.values(SIDES)) codes[def.role] = codeOf(st, companyId, def.role);
  codes.OpeningBalanceEquity = codeOf(st, companyId, 'OpeningBalanceEquity');
  for (const a of op.assets) for (const r of ['FixedAsset', 'AccumulatedDepreciation'] as const) codes[`${r}:${a.assetClass}`] = codeOf(st, companyId, r, a.assetClass);
  for (const b of op.bank) { const ba = bankOf(st, companyId, b.accountId); if (ba) codes[`BANK:${b.accountId}`] = ba.accountCode; }
  const name = (id: string) => st.parties.find((p) => p.id === id && p.companyId === companyId)?.name ?? id;
  return { ...op, codes,
    openItems: op.openItems.map((i) => ({ ...i, id: pick(i.id, `${batchId}-i`), partyName: name(i.partyId) })),
    assets: op.assets.map((a) => ({ ...a, id: pick(a.id, `${batchId}-a`) })), // AC5: an asset row keeps its id through a revise; the asset registered from it points at it
    bank: op.bank.map((b) => ({ ...b, inTransit: b.inTransit.map((t) => ({ ...t, id: pick(t.id, `${batchId}-t${b.accountId}-`) })) })) };
}

// ---------------------------------------------------------------- issue / revise / cancel side effects

/** (Re)creates the frozen items of a live batch and sets the go-live of its bank accounts. The caller has judged the body. Previous items of the batch are replaced (revise: nothing settled or matched, the lock saw to it). */
export function syncObItems(st: MockState, ob: Stored, actor: Actor): void {
  const before = itemsOf(st, ob.id).map((d) => d.id);
  releaseGoLive(st, ob.id);
  const op = ob.opening ?? EMPTY_OPENING, co = ob.companyId, base = { companyId: co, type: 'OB' as const, status: 'issued' as const, correctionClass: 'L' as const, revision: 0, version: 1, lines: [], locks: [], createdBy: actor, ...(ob.issuedAt ? { issuedAt: ob.issuedAt } : {}) };
  const totals = (m: string, cash?: boolean) => ({ gross: m, discount: '0.00', net: m, vat: '0.00', total: m, ...(cash ? { cash: m } : {}), amountInWords: bahtText(m) });
  const fresh: Stored[] = [];
  op.openItems.forEach((it, i) => {
    const p = st.parties.find((x) => x.id === it.partyId && x.companyId === co)!, { companyId: _c, ...party } = p; void _c;
    if (it.partyName) party.name = it.partyName; // the name frozen with the journal, whatever the master data says now
    const amount = fromSatang(toSatang(it.amount));
    fresh.push({ ...base, id: it.id ?? `${ob.id}-i${i + 1}`, number: `${it.docNumber.trim()} (ยกมา)`, party, totals: totals(amount), outstanding: amount,
      header: { partyId: it.partyId, documentDate: it.docDate, ...(it.dueDate ? { dueDate: it.dueDate } : {}), reference: it.docNumber.trim(), obBatchId: ob.id, obSide: it.side } });
  });
  for (const b of op.bank) {
    const acct = bankOf(st, co, b.accountId)!;
    b.inTransit.forEach((t, i) => {
      const amount = fromSatang(toSatang(t.amount));
      fresh.push({ ...base, id: t.id ?? `${ob.id}-t${b.accountId}-${i + 1}`, number: `${t.description.trim()} (ยกมา)`, totals: totals(amount, true),
        header: { documentDate: t.date, reference: t.description.trim(), bankAccountId: b.accountId, obBatchId: ob.id, obKind: t.kind === 'deposit' ? 'DIT' : 'OP' } });
    });
    acct.goLive = nextDay(ob.header.documentDate); acct.goLiveBy = ob.id;
  }
  const ids = new Set(fresh.map((d) => d.id));
  for (const d of fresh) { const at = st.docs.findIndex((x) => x.id === d.id); if (at >= 0) st.docs[at] = d; else st.docs.push(d); } // same id = same row: a link that once pointed at it stays valid
  cancelItems(st, before.filter((id) => !ids.has(id)));
}
function cancelItems(st: MockState, ids: string[]): void {
  st.docs = st.docs.map((d) => { if (!ids.includes(d.id)) return d; const { outstanding: _o, ...r } = d; void _o; return { ...r, status: 'cancelled' as const }; });
}
/** The bank accounts this batch opened are free again. */
export function releaseGoLive(st: MockState, batchId: string): void {
  for (const b of st.bankAccounts) if (b.goLiveBy === batchId) { delete b.goLive; delete b.goLiveBy; }
}
/** Cancel of a batch: its frozen items go with it (nothing was settled or matched, the lock saw to it) and its bank accounts leave the go-live. */
export function cancelObItems(st: MockState, batchId: string): void {
  st.docs = st.docs.map((d) => { if (d.header.obBatchId !== batchId) return d; const { outstanding: _o, ...r } = d; void _o; return { ...r, status: 'cancelled' as const }; });
  releaseGoLive(st, batchId);
}

// ---------------------------------------------------------------- invariants

/** AC3 invariants: one live batch per company; its journal is what its steps say (per-party lines, Dr = Cr after the plug); the ties hold; its frozen items are exactly its steps' items at their issued amounts; its bank accounts
 *  are in go-live at cut-off + 1 and no other account claims a batch that is not live. */
export function obInvariants(st: MockState): string[] {
  const out: string[] = [];
  const sig = (ls: { accountCode: string; debit: string; credit: string; partyName?: string }[]) => ls.map((l) => `${l.accountCode}|${satOf(l.debit)}|${satOf(l.credit)}|${l.partyName ?? ''}`).sort().join(',');
  for (const c of st.companies) if (liveBatches(st, c.id).length > 1) out.push(`${c.id}: more than one live opening-balance batch`);
  for (const d of st.docs) {
    if (d.type !== 'OB') continue;
    if (d.header.obBatchId) { // a frozen item
      const batch = st.docs.find((x) => x.id === d.header.obBatchId);
      if (!batch || !isOb(batch)) { out.push(`${d.id}: opening item of a missing batch ${d.header.obBatchId}`); continue; }
      if (LIVE.includes(d.status) && !LIVE.includes(batch.status)) out.push(`${d.id}: opening item is ${d.status} but its batch ${batch.id} is ${batch.status}`); // a revise may drop an item (cancelled, its row stays for the links that pointed at it)
      continue;
    }
    if (d.status === 'draft' || d.status === 'pending' || d.status === 'approved' || !LIVE.includes(d.status)) { if (itemsOf(st, d.id).some((x) => LIVE.includes(x.status))) out.push(`${d.id}: ${d.status} batch with live items`); continue; }
    const co = d.companyId, built = buildOb(st, co, d);
    const es = st.journals.find((j) => j.docId === d.id)?.preview.entries ?? [], cur = [...es].reverse().find((e) => e.kind !== 'reversal');
    if (!cur || sig(cur.lines) !== sig(built.lines)) out.push(`${d.id}: OB journal is not what its steps say`);
    if (cur && cur.date !== d.header.documentDate) out.push(`${d.id}: OB journal dated ${cur.date}, not its cut-off ${d.header.documentDate}`);
    for (const t of built.check.ties) if (!t.ok) out.push(`${d.id}: OB ${t.label} ${t.code}: trial balance ${t.tb} but the step says ${t.sub}`);
    if (toSatang(d.totals.total) !== toSatang(built.check.debit)) out.push(`${d.id}: OB total ${d.totals.total} is not its journal debit ${built.check.debit}`);
    const op = d.opening ?? EMPTY_OPENING, items = itemsOf(st, d.id).filter((x) => LIVE.includes(x.status));
    const want = [...op.openItems.map((i, n) => `${i.id ?? `${d.id}-i${n + 1}`}|${i.side}|${i.partyId}|${satOf(i.amount)}|${i.partyName ?? ''}`), ...op.bank.flatMap((b) => b.inTransit.map((t, n) => `${t.id ?? `${d.id}-t${b.accountId}-${n + 1}`}|${t.kind === 'deposit' ? 'DIT' : 'OP'}|${b.accountId}|${satOf(t.amount)}|`))].sort().join(',');
    const have = items.map((x) => `${x.id}|${x.header.obSide ?? x.header.obKind}|${x.header.partyId ?? x.header.bankAccountId}|${satOf(x.totals.total)}|${x.header.partyId ? x.party?.name ?? '' : ''}`).sort().join(',');
    if (want !== have) out.push(`${d.id}: OB items [${have}] but its steps list [${want}]`);
    for (const b of op.bank) { const a = bankOf(st, co, b.accountId); if (a?.goLive !== nextDay(d.header.documentDate) || a.goLiveBy !== d.id) out.push(`${d.id}: bank account ${b.accountId} is not in go-live at cut-off + 1 by this batch`); }
  }
  for (const b of st.bankAccounts) if (b.goLiveBy && !liveBatches(st, b.companyId).some((x) => x.id === b.goLiveBy)) out.push(`${b.id}: go-live by ${b.goLiveBy}, which is not a live opening-balance batch`);
  return out;
}

