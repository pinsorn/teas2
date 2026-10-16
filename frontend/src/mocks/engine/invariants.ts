import { ADJUSTS, CREDIT_NOTES, DOC_TYPES, GROUPS, LIVE, SETTLES, carriesBalance } from '@/domain/doc-types';
import type { DocType, WhtLine, WhtMode } from '@/domain/types';
import type { Doc, JournalEntryPreview } from '@/domain/types';
import type { MockState } from '../store';
import { approvalRequired } from './approval';
import { jvInvariants } from './journal';
import { scheduleInvariants } from './schedules';
import { obInvariants } from './opening';
import { appliedOf, docCash, toleranceOf } from './locks';
import { payoutOf, resolvedBankId } from './settlement';
import { consumed, q4 } from './chain';
import { divRoundHalfAway, fromSatang, toSatang } from './money';
import { resolveRole } from './posting';
import { claimPeriodOf, exForfeited, forfeitedOf, isRecoverable } from './purchase-vat';
import { computeDoc, vatBasisOf } from './vat';
import { wtsOfPv } from './wht-certificates';

type Stored = MockState['docs'][number];

/** Expected outstanding and status of a live document, from the active links alone (SP0 §7.11); independent of `recomputeSettlement`. */
function expectedBalance(st: MockState, d: Stored) {
  let out = toSatang(d.totals.total), paid = 0, settled = false;
  for (const l of st.links) {
    if (!l.active || l.to !== d.id) continue;
    const amt = toSatang(l.amount ?? '0.00');
    if (l.kind === 'settles') { out -= amt; paid += amt; settled = true; }
    else if (l.kind === 'adjusts') {
      const t = st.docs.find((x) => x.id === l.from)?.type;
      if (t === 'CN' || t === 'PCN') out -= amt; else if (t === 'DN' || t === 'PDN') out += amt;
    }
  }
  return { out, status: settled && out <= 0 ? 'settled' : paid > 0 ? 'partly_settled' : 'issued' };
}

/** Satang sum of one side of a journal entry's lines for a role (the role is read from the rule text "<level>: <role> → <code>"). */
const roleSum = (e: { lines: { debit: string; credit: string; rule: string }[] }, role: string, side: 'debit' | 'credit') =>
  e.lines.filter((l) => new RegExp(`: ${role} → `).test(l.rule)).reduce((n, l) => n + toSatang(l[side]), 0);

/** One WHT line against an independent recomputation from its base, the rate and the mode (D-14; RD ป.96/2543 ex. 6 for "once"), plus the identity
 *  income = payee cash + tax on the line's own figures. [SP-R] rates. */
export function whtLineProblems(l: WhtLine, base: number, bp: bigint, mode: WhtMode): string[] {
  const B = BigInt(base);
  const income = mode === 'deduct' ? B : mode === 'grossup_always' ? divRoundHalfAway(B * 10000n, 10000n - bp) : divRoundHalfAway(B * (10000n + bp), 10000n);
  const tax = divRoundHalfAway(income * bp, 10000n);
  const net = mode === 'deduct' ? B - tax : mode === 'grossup_always' ? B : income - tax;
  const out: string[] = [];
  const chk = (what: string, got: string, want: bigint) => { if (toSatang(got) !== Number(want)) out.push(`WHT ${l.code} (${mode}): ${what} ${got} but base ${fromSatang(base)} x rate gives ${fromSatang(Number(want))}`); };
  chk('base', l.base, B); chk('income', l.income, income); chk('tax', l.tax, tax); chk('payee cash', l.net, net);
  if (toSatang(l.income) !== toSatang(l.net) + toSatang(l.tax)) out.push(`WHT ${l.code}: income ${l.income} is not payee cash ${l.net} + tax ${l.tax}`);
  return out;
}

/** WHT of a PV recomputed from its lines and the bills it pays (the bases: its own typed lines + the bases STORED on it when it was issued, C1) and the fixture rate table with its own bigint formulas (not `computeWht`),
 *  and the engine's lines checked against it. */
function expectedWht(st: MockState, d: Stored): { tax: number; expense: number; cashDelta: number; lines: { code: string; tax: bigint }[]; bad?: string } {
  const nets = computeDoc(d.lines, !!d.header.priceIncludesVat, vatBasisOf(st, d.companyId, 'PV')).lines;
  const base = new Map<string, bigint>();
  d.lines.forEach((l, i) => { if (l.whtTypeCode) base.set(l.whtTypeCode, (base.get(l.whtTypeCode) ?? 0n) + BigInt(toSatang(nets[i].net))); });
  for (const b of d.whtFrozen?.bases ?? []) base.set(b.whtTypeCode, (base.get(b.whtTypeCode) ?? 0n) + BigInt(toSatang(b.base)));
  const mode = d.header.whtMode ?? 'deduct';
  let tax = 0n, expense = 0n, cashDelta = 0n;
  const want: [string, bigint, bigint][] = [], perType: { code: string; tax: bigint }[] = [];
  for (const [code, b] of base) {
    if (b <= 0n) continue; // the engine skips a non-positive base before it looks the type up, so does this check
    const t = st.whtTypes.filter((x) => x.companyId === d.companyId && x.code === code && x.effectiveFrom <= d.header.documentDate).sort((x, y) => y.effectiveFrom.localeCompare(x.effectiveFrom))[0];
    if (!t) return { tax: 0, expense: 0, cashDelta: 0, lines: [], bad: `unknown WHT type ${code}` };
    const r = BigInt(t.rateBp);
    const income = mode === 'deduct' ? b : mode === 'grossup_always' ? divRoundHalfAway(b * 10000n, 10000n - r) : divRoundHalfAway(b * (10000n + r), 10000n);
    const lt = divRoundHalfAway(income * r, 10000n);
    const paid = mode === 'deduct' ? b - lt : mode === 'grossup_always' ? b : income - lt; // what the payee receives
    perType.push({ code, tax: lt });
    tax += lt; cashDelta += paid - b; expense += mode === 'deduct' ? 0n : mode === 'grossup_always' ? lt : income - b;
    want.push([code, b, r]);
  }
  if (!d.whtFrozen) return { tax: 0, expense: 0, cashDelta: 0, lines: [], bad: 'a live voucher without its stored withholding figures' };
  const engine: WhtLine[] = d.whtFrozen.lines;
  const problems = want.flatMap(([code, b, r]) => {
    const l = engine.find((x) => x.code === code);
    return l ? whtLineProblems(l, Number(b), r, mode) : [`WHT ${code}: the engine produced no line`];
  });
  if (problems.length) return { tax: 0, expense: 0, cashDelta: 0, lines: [], bad: problems.join('; ') };
  return { tax: Number(tax), expense: Number(expense), cashDelta: Number(cashDelta), lines: perType };
}

/** Every violation in the state, as readable strings; [] = all hold (money invariants 1-7, numbering, derived locks). */
export function checkInvariants(st: MockState): string[] {
  const out: string[] = [];
  const doc = (id: string): Stored | undefined => st.docs.find((d) => d.id === id);
  const sat = (m: string, where: string): number => {
    try { return toSatang(m); } catch { out.push(`${where}: bad money "${m}"`); return 0; }
  };
  const gl = new Map<string, number>(); // `${companyId}|${code}` -> debit - credit
  const credit = new Map<string, number>(); // the same, credit - debit (WHT payable accounts)
  const obGl = new Map<string, number>(), obCredit = new Map<string, number>(); // AC3: what opening-balance batches posted (a balance with no document behind it: the VAT / WHT ties below judge the documents only) [SP-R]
  const arByParty = new Map<string, number>(); // `${companyId}|${party}` -> debit - credit on 1130
  const apByParty = new Map<string, number>(); // the same on 2110 (payables)
  const empByParty = new Map<string, number>(); // the same on 2180 (owed to employees)
  const byParty = new Map<string, number>(); // `${companyId}|${account}|${party}` -> debit - credit (FN3: the deposit / prepayment accounts per party)
  const inputVat = new Map<string, number>(); // `${companyId}|${claim period}` -> debit - credit on 1170 posted by PB / PCN / PDN (reversals and corrections included)

  // 1. every journal entry balances, is non-negative and posts to postable accounts of its own company. R0: the reconciliation's own journals (fee / inline / transfer / opening) feed every GL map below like a document's
  const jsrc: { id: string; companyId: string; d?: Stored; entries: JournalEntryPreview[] }[] = [];
  for (const j of st.journals) {
    const d = doc(j.docId);
    if (!d) { out.push(`journal of unknown document ${j.docId}`); continue; }
    jsrc.push({ id: d.id, companyId: d.companyId, d, entries: j.preview.entries });
  }
  for (const j of st.bankJournals) jsrc.push({ id: `bank journal ${j.id}`, companyId: j.companyId, entries: j.entries });
  for (const s of st.settlements) jsrc.push({ id: `settlement ${s.id}`, companyId: s.companyId, entries: s.journal }); // FN3: a settlement's own journal feeds every GL map below like a document's
  for (const { id, companyId, d, entries } of jsrc) {
    for (const e of entries) {
      const where = `${id} ${e.kind} entry ${e.date}`;
      let dr = 0, cr = 0;
      for (const l of e.lines) {
        const a = sat(l.debit, where), b = sat(l.credit, where);
        if (a < 0 || b < 0) out.push(`${where}: negative amount on ${l.accountCode}`);
        dr += a; cr += b;
        const acc = st.accounts.find((x) => x.companyId === companyId && x.code === l.accountCode);
        if (!acc) out.push(`${where}: unknown account ${l.accountCode} for ${companyId}`);
        else if (!acc.postable) out.push(`${where}: account ${l.accountCode} is not postable`);
        const k = `${companyId}|${l.accountCode}`;
        gl.set(k, (gl.get(k) ?? 0) + a - b);
        credit.set(k, (credit.get(k) ?? 0) + b - a);
        if (d?.type === 'OB') { obGl.set(k, (obGl.get(k) ?? 0) + a - b); obCredit.set(k, (obCredit.get(k) ?? 0) + b - a); }
        { const pk = `${companyId}|${l.accountCode}|${l.partyName ?? ''}`; byParty.set(pk, (byParty.get(pk) ?? 0) + a - b); }
        if (l.accountCode === '1130') { const pk = `${companyId}|${l.partyName ?? ''}`; arByParty.set(pk, (arByParty.get(pk) ?? 0) + a - b); }
        if (l.accountCode === '2110') { const pk = `${companyId}|${l.partyName ?? ''}`; apByParty.set(pk, (apByParty.get(pk) ?? 0) + b - a); }
        if (l.accountCode === '2180') { const pk = `${companyId}|${l.partyName ?? ''}`; empByParty.set(pk, (empByParty.get(pk) ?? 0) + b - a); }
        if (l.accountCode === '1170' && (!d || d.type === 'PB' || d.type === 'EX' || ADJUSTS[d.type] === 'PB')) { const pk = `${companyId}|${d ? claimPeriodOf(d.type, d.header) : 'bank journal'}`; inputVat.set(pk, (inputVat.get(pk) ?? 0) + a - b); }
      }
      if (dr !== cr) out.push(`${where}: unbalanced (Dr ${fromSatang(dr)} / Cr ${fromSatang(cr)})`);
    }
  }

  // 2 + 3. outstanding follows the links; status follows settlements (a TI credited to zero without a settlement stays issued)
  const sub = new Map<string, number>(); // `${companyId}|${type}` -> Σ outstanding of live documents
  for (const d of st.docs) {
    if (!LIVE.includes(d.status) || !carriesBalance(d)) continue;
    const exp = expectedBalance(st, d);
    if (d.outstanding !== fromSatang(exp.out)) out.push(`${d.id}: outstanding ${d.outstanding ?? 'missing'} but the links say ${fromSatang(exp.out)}`);
    if (d.status !== exp.status) out.push(`${d.id}: status ${d.status} but the settlements and outstanding say ${exp.status}`);
    const sk = `${d.companyId}|${d.type === 'OB' ? `OB:${d.header.obSide}` : d.type}`; // an opening item is a subledger row of its side
    sub.set(sk, (sub.get(sk) ?? 0) + sat(d.outstanding ?? '0.00', d.id));
  }

  // 4. subledger = GL, per company
  const SUBLEDGERS: [string, number, string[]][] = [['1130', 1, ['TI', 'IV', 'OB:AR']], ['2110', -1, ['PB', 'OB:AP']], ['2180', -1, ['EX', 'OB:EMP']]];
  for (const c of st.companies) {
    for (const [code, sign, types] of SUBLEDGERS) {
      const glBal = sign * (gl.get(`${c.id}|${code}`) ?? 0);
      const subBal = types.reduce((n, t) => n + (sub.get(`${c.id}|${t}`) ?? 0), 0);
      if (glBal !== subBal) out.push(`${c.id}: GL ${code} ${fromSatang(glBal)} but outstanding of live ${types.join('/')} is ${fromSatang(subBal)}`);
    }
  }

  // 4b. each customer's AR (1130 lines labelled with their name) = Σ that customer's live TI / IV outstanding
  const subByParty = new Map<string, number>();
  for (const d of st.docs) {
    if (!LIVE.includes(d.status) || (d.type !== 'TI' && d.type !== 'IV' && !(d.type === 'OB' && d.header.obSide === 'AR'))) continue;
    const k = `${d.companyId}|${d.party?.name ?? ''}`;
    subByParty.set(k, (subByParty.get(k) ?? 0) + sat(d.outstanding ?? '0.00', d.id));
  }
  for (const k of new Set([...arByParty.keys(), ...subByParty.keys()])) {
    if ((arByParty.get(k) ?? 0) !== (subByParty.get(k) ?? 0)) {
      const [company, name] = k.split('|');
      out.push(`${company}: AR 1130 of ${name}: GL ${fromSatang(arByParty.get(k) ?? 0)} but outstanding of their live TI/IV is ${fromSatang(subByParty.get(k) ?? 0)}`);
    }
  }

  // 4c. each vendor's AP (2110 lines labelled with their name) = Σ that vendor's live PB outstanding
  const apSub = new Map<string, number>();
  for (const d of st.docs) {
    if (!LIVE.includes(d.status) || !(d.type === 'PB' || (d.type === 'OB' && d.header.obSide === 'AP'))) continue;
    const k = `${d.companyId}|${d.party?.name ?? ''}`;
    apSub.set(k, (apSub.get(k) ?? 0) + sat(d.outstanding ?? '0.00', d.id));
  }
  for (const k of new Set([...apByParty.keys(), ...apSub.keys()])) {
    if ((apByParty.get(k) ?? 0) !== (apSub.get(k) ?? 0)) {
      const [company, name] = k.split('|');
      out.push(`${company}: AP 2110 of ${name}: GL ${fromSatang(apByParty.get(k) ?? 0)} but outstanding of their live PB is ${fromSatang(apSub.get(k) ?? 0)}`);
    }
  }

  // 4e. each employee's 2180 (lines labelled with their name) = Σ that employee's live EX outstanding (a voucher that pays a claim clears it under the same name)
  const empSub = new Map<string, number>();
  for (const d of st.docs) {
    if (!LIVE.includes(d.status) || !(d.type === 'EX' || (d.type === 'OB' && d.header.obSide === 'EMP'))) continue;
    const k = `${d.companyId}|${d.party?.name ?? ''}`;
    empSub.set(k, (empSub.get(k) ?? 0) + sat(d.outstanding ?? '0.00', d.id));
  }
  for (const k of new Set([...empByParty.keys(), ...empSub.keys()])) {
    if ((empByParty.get(k) ?? 0) !== (empSub.get(k) ?? 0)) {
      const [company, name] = k.split('|');
      out.push(`${company}: employee payable 2180 of ${name}: GL ${fromSatang(empByParty.get(k) ?? 0)} but outstanding of their live EX is ${fromSatang(empSub.get(k) ?? 0)}`);
    }
  }

  // 4d. input VAT (ม.82/3, ม.82/5, I6): per claim period, the 1170 posted by PB / PCN / PDN / EX = the claimable VAT of the live ones filed in it (a PCN gives back, a PDN adds; an EX claims a line only with the vendor's tax invoice behind it); a company outside VAT claims nothing
  const claimable = new Map<string, number>();
  for (const d of st.docs) {
    if (!LIVE.includes(d.status) || (d.type !== 'PB' && d.type !== 'EX' && ADJUSTS[d.type] !== 'PB')) continue;
    if (d.type !== 'EX' && !!d.header.inputVatForfeited !== forfeitedOf(st, d.companyId, d.type, d.header)) out.push(`${d.id}: inputVatForfeited ${!!d.header.inputVatForfeited} but the claim window says ${!d.header.inputVatForfeited} (ม.82/3)`);
    const rows = computeDoc(d.lines, !!d.header.priceIncludesVat, true).lines;
    const vat = d.lines.reduce((n, l, i) => n + (isRecoverable(st, d.companyId, l, d.type === 'EX' ? exForfeited(d.header, l) : d.header.inputVatForfeited) ? sat(rows[i].vat, d.id) : 0), 0);
    const k = `${d.companyId}|${claimPeriodOf(d.type, d.header)}`;
    claimable.set(k, (claimable.get(k) ?? 0) + (CREDIT_NOTES.includes(d.type) ? -vat : vat));
  }
  // C1: a live note line carries the category of the live bill line it adjusts (the VAT it gives back / adds is claimable exactly when the bill's was)
  for (const d of st.docs) {
    if (!LIVE.includes(d.status) || d.type === 'PB' || ADJUSTS[d.type] !== 'PB') continue;
    const pb = doc(d.header.refDocId ?? '');
    if (!pb || !LIVE.includes(pb.status)) continue;
    for (const l of d.lines) {
      const src = pb.lines.find((x) => x.id === l.sourceLineId);
      if (src && (l.expenseCategory ?? '') !== (src.expenseCategory ?? '')) out.push(`${d.id}: line ${l.id} category ${l.expenseCategory ?? 'none'} but the bill line ${src.id} of ${pb.id} has ${src.expenseCategory ?? 'none'}`);
    }
  }
  for (const k of new Set([...inputVat.keys(), ...claimable.keys()])) {
    if ((inputVat.get(k) ?? 0) !== (claimable.get(k) ?? 0)) {
      const [company, period] = k.split('|');
      out.push(`${company}: claim period ${period}: input VAT 1170 posted ${fromSatang(inputVat.get(k) ?? 0)} but the bills / notes filed in it claim ${fromSatang(claimable.get(k) ?? 0)}`);
    }
  }
  for (const c of st.companies) if (!c.vatRegistered && (gl.get(`${c.id}|1170`) ?? 0) !== 0) out.push(`${c.id}: not VAT-registered but GL 1170 moved by ${fromSatang(gl.get(`${c.id}|1170`) ?? 0)}`);

  // 5. converted quantity per source line never exceeds the source quantity
  const sources = new Set(st.links.filter((l) => l.kind === 'converted_from' && l.active).map((l) => l.to));
  for (const id of sources) {
    const src = doc(id);
    if (!src) continue;
    for (const line of src.lines) {
      try { if (consumed(st, src, line) > q4(line.qty)) out.push(`${id} line ${line.id}: conversion exceeds the source quantity`); }
      catch (e) { out.push(`${id} line ${line.id}: conversion check failed (${e instanceof Error ? e.message : String(e)})`); }
    }
  }

  // 6. links join documents of one company; every posted ledger document has its journal (cancelled / replaced: original + reversal)
  for (const l of st.links) {
    const a = doc(l.from) ?? (l.kind === 'settles' ? st.settlements.find((s) => s.id === l.from) : undefined), b = doc(l.to); // FN3: a settlement record is the `from` of its settles links
    if (!a || !b) out.push(`link ${l.from} → ${l.to} points at a missing document`);
    else if (a.companyId !== b.companyId || (l.companyId !== undefined && l.companyId !== a.companyId)) out.push(`link ${l.from} → ${l.to} joins different companies`);
  }
  for (const d of st.docs) {
    if (d.status === 'draft' || d.status === 'pending' || d.status === 'approved' || !DOC_TYPES[d.type].ledger || d.totals.total === '0.00' || d.header.obBatchId) continue; // an opening item posts nothing itself (its batch does)
    const entries = st.journals.find((j) => j.docId === d.id)?.preview.entries;
    if (!entries?.length) { out.push(`${d.id}: ${d.status} ${d.type} has no journal`); continue; }
    if ((d.status === 'cancelled' || d.status === 'replaced') && entries[entries.length - 1].kind !== 'reversal') out.push(`${d.id}: ${d.status} but its journal ends without a reversal`);
  }

  // 7. an entry dated in a closed period was posted (postedAt, set once when written) before that period closed
  for (const j of st.journals) {
    const d = doc(j.docId);
    if (!d) continue;
    for (const e of j.preview.entries) {
      if (!e.postedAt) out.push(`${d.id} ${e.kind} entry ${e.date}: no postedAt (every written entry carries when it was posted)`);
      const p = st.periods.find((x) => x.companyId === d.companyId && x.month === e.date.slice(0, 7));
      if (p?.status !== 'closed' || d.type === 'OB') continue; // an opening balance defines the opening: it may post into a closed month (D-10 exemption)
      if (!e.postedAt || !p.closedAt || !(Date.parse(e.postedAt) <= Date.parse(p.closedAt))) {
        out.push(`${d.id} ${e.kind} entry ${e.date}: dated in closed period ${p.month} but was posted after it closed (or has no posted-at)`);
      }
    }
  }

  // 8. receipts and vouchers (D-12, D-14): allocations <-> links, totals, journal and the WHT formula tie out in satang
  for (const d of st.docs) {
    if (!SETTLES[d.type] || !LIVE.includes(d.status)) continue;
    const allocs = d.allocations ?? [];
    const alloc = allocs.reduce((n, a) => n + sat(a.amount, d.id), 0), allocWht = allocs.reduce((n, a) => n + sat(a.wht ?? '0.00', d.id), 0);
    const links = st.links.filter((l) => l.active && l.kind === 'settles' && l.from === d.id);
    const key = (id: string, amount: number, wht: number) => `${id}|${amount}|${wht}`;
    const want = allocs.map((a) => key(a.targetId, sat(a.amount, d.id), sat(a.wht ?? '0.00', d.id))).sort().join(',');
    const have = links.map((l) => key(l.to, sat(l.amount ?? '0.00', d.id), sat(l.wht ?? '0.00', d.id))).sort().join(',');
    if (want !== have) out.push(`${d.id}: allocations [${want}] but the active settles links are [${have}]`);
    for (const a of allocs) if (sat(a.amount, d.id) <= 0) out.push(`${d.id}: allocation to ${a.targetId} is not positive`);
    const lineTotal = sat(d.totals.net, d.id) + sat(d.totals.vat, d.id);
    const total = sat(d.totals.total, d.id), cash = sat(d.totals.cash ?? 'x', d.id), wht = sat(d.totals.wht ?? 'x', d.id);
    const entries = st.journals.find((j) => j.docId === d.id)?.preview.entries.filter((e) => e.kind !== 'reversal');
    const live = entries?.[entries.length - 1];
    const j = (role: string, side: 'debit' | 'credit') => (live ? roleSum(live, role, side) : 0);
    if (d.type === 'RC') {
      const dep = sat(d.header.depositAmount ?? '0.00', d.id);
      if (total !== alloc + dep + lineTotal) out.push(`${d.id}: RC total ${fromSatang(total)} is not Σ allocations + deposit + cash-bill lines (${fromSatang(alloc + dep + lineTotal)})`);
      if (wht !== allocWht) out.push(`${d.id}: RC wht ${fromSatang(wht)} is not Σ allocation wht ${fromSatang(allocWht)}`);
      if (cash + wht !== alloc + dep + lineTotal) out.push(`${d.id}: RC cash ${fromSatang(cash)} + WHT ${fromSatang(wht)} is not Σ allocations + deposit + cash-bill (${fromSatang(alloc + dep + lineTotal)})`);
      if (live) {
        if (j('Cash', 'debit') !== cash) out.push(`${d.id}: journal cash ${fromSatang(j('Cash', 'debit'))} but the receipt received ${fromSatang(cash)}`);
        if (j('WhtReceivable', 'debit') !== wht) out.push(`${d.id}: journal WHT receivable ${fromSatang(j('WhtReceivable', 'debit'))} but the receipt withheld ${fromSatang(wht)}`);
        if (j('AR', 'credit') !== alloc) out.push(`${d.id}: journal AR ${fromSatang(j('AR', 'credit'))} but the allocations clear ${fromSatang(alloc)}`);
        if (j('CustomerDeposit', 'credit') !== dep) out.push(`${d.id}: journal deposit ${fromSatang(j('CustomerDeposit', 'credit'))} but the deposit is ${fromSatang(dep)}`);
      }
    } else {
      const mode = d.header.whtMode ?? 'deduct';
      const w = expectedWht(st, d);
      if (w.bad) out.push(`${d.id}: ${w.bad}`);
      else if (wht !== w.tax) out.push(`${d.id}: PV wht ${fromSatang(wht)} but round-half-away(base x rate) per WHT type gives ${fromSatang(w.tax)}`);
      const pdep = sat(d.header.depositAmount ?? '0.00', d.id); // FN3: paid in advance, kept as a vendor prepayment
      if (pdep < 0) out.push(`${d.id}: PV prepayment ${fromSatang(pdep)} is negative`);
      if (total !== alloc + lineTotal + pdep) out.push(`${d.id}: PV total ${fromSatang(total)} is not Σ allocations + line totals + prepayment (${fromSatang(alloc + lineTotal + pdep)})`);
      if (!w.bad && cash !== total + w.cashDelta) out.push(`${d.id}: PV cash ${fromSatang(cash)} is wrong for mode ${mode} (total ${fromSatang(total)}, expected ${fromSatang(total + w.cashDelta)})`);
      if (live) {
        const expense = j('WhtExpense', 'debit');
        if (!w.bad && expense !== w.expense) out.push(`${d.id}: WHT expense ${fromSatang(expense)} is wrong for mode ${mode} (expected ${fromSatang(w.expense)})`);
        if (j('Cash', 'credit') !== cash) out.push(`${d.id}: journal cash ${fromSatang(j('Cash', 'credit'))} but the voucher paid ${fromSatang(cash)}`);
        if (j('WhtPayable', 'credit') !== wht) out.push(`${d.id}: journal WHT payable ${fromSatang(j('WhtPayable', 'credit'))} but the voucher withheld ${fromSatang(wht)}`);
        if (j('AP', 'debit') + j('EmployeePayable', 'debit') !== alloc) out.push(`${d.id}: journal payables ${fromSatang(j('AP', 'debit') + j('EmployeePayable', 'debit'))} but the allocations clear ${fromSatang(alloc)}`);
        // the balance identity: Σ allocations + line totals + the WHT we bear = cash + Σ tax
        if (j('VendorPrepayment', 'debit') !== pdep) out.push(`${d.id}: journal prepayment ${fromSatang(j('VendorPrepayment', 'debit'))} but the prepayment is ${fromSatang(pdep)}`);
        if (alloc + lineTotal + pdep + expense !== cash + wht) out.push(`${d.id}: PV Σ alloc + lines + prepayment + expense (${fromSatang(alloc + lineTotal + pdep + expense)}) is not cash + WHT (${fromSatang(cash + wht)})`);
      }
    }
  }
  // (No "settled <= total" check: a credit note or a cancelled debit note after payment legitimately leaves a negative outstanding = customer credit, Ham ruling; over-allocation is refused at issue.)

  // 8b. the customer-withheld tax: GL(the WhtReceivable account of the posting profile, 1180 in the fixtures) of a company = the WHT of its live receipts (a posting to 1180 from anywhere else, or a reversal left behind, shows here)
  for (const c of st.companies) {
    let acct = '';
    try { acct = resolveRole(st, 'WhtReceivable', { companyId: c.id, docType: 'RC' }).code; } catch (e) { out.push(`${c.id}: WhtReceivable does not resolve (${(e as Error).message})`); continue; }
    const want = st.docs.filter((d) => d.companyId === c.id && d.type === 'RC' && LIVE.includes(d.status)).reduce((n, d) => n + sat(d.totals.wht ?? '0.00', d.id), 0);
    const glDocs = (gl.get(`${c.id}|${acct}`) ?? 0) - (obGl.get(`${c.id}|${acct}`) ?? 0);
    if (glDocs !== want) out.push(`${c.id}: GL ${acct} ${fromSatang(glDocs)} but the live receipts withheld ${fromSatang(want)}`);
  }

  // 9. a billing statement (BL): total = the sum of its amounts, its active groups links are its list, every target is a groupable document of the same company and customer, and it posts nothing
  for (const d of st.docs) {
    if (!GROUPS[d.type] || !LIVE.includes(d.status)) continue;
    const allocs = d.allocations ?? [];
    const total = allocs.reduce((n, a) => n + sat(a.amount, d.id), 0);
    if (sat(d.totals.total, d.id) !== total) out.push(`${d.id}: BL total ${d.totals.total} is not Σ allocation amounts ${fromSatang(total)}`);
    const want = allocs.map((a) => `${a.targetId}|${sat(a.amount, d.id)}`).sort().join(',');
    const have = st.links.filter((l) => l.active && l.kind === 'groups' && l.from === d.id).map((l) => `${l.to}|${sat(l.amount ?? '0.00', d.id)}`).sort().join(',');
    if (want !== have) out.push(`${d.id}: allocations [${want}] but the active groups links are [${have}]`);
    for (const a of allocs) {
      const t = doc(a.targetId);
      if (!t) continue; // a link to a missing document is reported by check 6
      if (t.companyId !== d.companyId || t.header.partyId !== d.header.partyId) out.push(`${d.id}: BL groups ${a.targetId} of another party or company`);
      if (!GROUPS[d.type]!.includes(t.type)) out.push(`${d.id}: BL groups ${a.targetId}, a ${t.type}, which cannot be grouped`);
    }
    if (st.journals.some((j) => j.docId === d.id)) out.push(`${d.id}: BL has a journal (a billing statement posts nothing)`);
  }

  // 10. credit / debit notes (CN / DN of a TI, PCN / PDN of a PB): each live note adjusts one live original of its company and party through exactly one active link of its own total; its total is its lines' net + VAT;
  //     per invoice line the live credits never exceed the line's net (G3) and a fully credited line gives back exactly its VAT (rule B), to the satang
  const credited = new Map<string, { net: number; vat: number; debit: boolean }>(); // `${ti}|${line}`
  for (const d of st.docs) {
    if (!ADJUSTS[d.type] || !LIVE.includes(d.status)) continue;
    const ti = d.header.refDocId ? doc(d.header.refDocId) : undefined;
    if (!ti || ti.type !== ADJUSTS[d.type] || ti.companyId !== d.companyId || !LIVE.includes(ti.status)) { out.push(`${d.id}: ${d.type} has no live ${ADJUSTS[d.type]} of its company to adjust (refDocId ${d.header.refDocId ?? 'missing'})`); continue; }
    if (d.header.partyId !== ti.header.partyId) out.push(`${d.id}: ${d.type} party ${d.header.partyId} is not the party of ${ti.id}`);
    const links = st.links.filter((l) => l.active && l.kind === 'adjusts' && l.from === d.id);
    if (links.length !== 1 || links[0].to !== ti.id || sat(links[0].amount ?? '0.00', d.id) !== sat(d.totals.total, d.id)) {
      out.push(`${d.id}: ${d.type} needs exactly one active adjusts link to ${ti.id} of its total ${d.totals.total} (has [${links.map((l) => `${l.to} ${l.amount}`).join(', ')}])`);
    }
    const rows = computeDoc(d.lines, !!d.header.priceIncludesVat, true);
    if (sat(rows.totals.total, d.id) !== sat(d.totals.total, d.id) || sat(d.totals.net, d.id) + sat(d.totals.vat, d.id) !== sat(d.totals.total, d.id)) {
      out.push(`${d.id}: ${d.type} total ${d.totals.total} is not its lines' net + VAT (${rows.totals.total})`);
    }
    d.lines.forEach((l, i) => {
      if (!l.sourceLineId) return;
      const k = `${ti.id}|${l.sourceLineId}`, c = credited.get(k) ?? { net: 0, vat: 0, debit: false };
      const net = sat(rows.lines[i].net, d.id), vat = sat(rows.lines[i].vat, d.id);
      if (CREDIT_NOTES.includes(d.type)) credited.set(k, { ...c, net: c.net + net, vat: c.vat + vat });
      else if (net < 0) credited.set(k, { ...c, net: c.net - net, vat: c.vat - vat }); // a negative referenced debit line is a credit as well
      else credited.set(k, { ...c, debit: true });
    });
  }
  for (const [k, c] of credited) {
    const [tiId, lineId] = k.split('|'), ti = doc(tiId)!, line = ti.lines.find((l) => l.id === lineId);
    if (!line) { out.push(`${tiId}: a note references line ${lineId}, which the invoice does not have`); continue; }
    const own = computeDoc([line], !!ti.header.priceIncludesVat, true).lines[0];
    if (c.net > sat(own.net, tiId)) out.push(`${tiId} line ${lineId}: credit notes take net ${fromSatang(c.net)}, which exceeds the line's net ${own.net} (cap)`);
    else if (c.net === sat(own.net, tiId) && !c.debit && c.vat !== sat(own.vat, tiId)) out.push(`${tiId} line ${lineId}: fully credited but the credit notes' VAT is ${fromSatang(c.vat)} and the line's VAT is ${own.vat} (rule B)`);
  }

  // 11. withholding certificates (50 tawi, D-14 / I7): a live PV has exactly one live WT per WHT type it withholds on (its active `issues` links), whose tax sums to the PV's wht and whose figures are the
  //     recomputed ones; a WT is live only through a live PV (the one that issues it); and per return the credit on its WHT-payable account = the tax of the live WTs of that return
  const wtTax = new Map<string, number>(); // company|account -> Σ tax of live WTs
  for (const d of st.docs) {
    if (d.type !== 'PV') continue;
    const live = LIVE.includes(d.status);
    const issued = wtsOfPv(st, d.id);
    if (!live) { for (const { wt } of issued) if (LIVE.includes(wt.status)) out.push(`${wt.id}: live WT of ${d.id}, which is ${d.status}`); continue; }
    const exp = expectedWht(st, d);
    if (exp.bad) continue; // check 8 reports it
    const liveWts = issued.filter(({ wt }) => LIVE.includes(wt.status));
    for (const x of issued) if (!LIVE.includes(x.wt.status)) out.push(`${x.wt.id}: an active issues link of ${d.id} points at a ${x.wt.status} WT`);
    for (const e of exp.lines) {
      const mine = liveWts.filter(({ wt }) => wt.header.whtTypeCode === e.code);
      if (mine.length !== 1) { out.push(`${d.id}: ${mine.length} active WT for WHT type ${e.code} (exactly one is issued per type)`); continue; }
      if (sat(mine[0].wt.header.whtTax ?? 'x', mine[0].wt.id) !== Number(e.tax) || sat(mine[0].wt.totals.wht ?? 'x', mine[0].wt.id) !== Number(e.tax)) {
        out.push(`${mine[0].wt.id}: tax ${mine[0].wt.header.whtTax} but ${d.id} withholds ${fromSatang(Number(e.tax))} on ${e.code}`);
      }
      if (mine[0].wt.header.partyId !== d.header.partyId || mine[0].wt.header.documentDate !== d.header.documentDate) out.push(`${mine[0].wt.id}: payee or date differs from ${d.id}`);
    }
    for (const { wt } of liveWts) if (!exp.lines.some((e) => e.code === wt.header.whtTypeCode)) out.push(`${wt.id}: live WT of type ${wt.header.whtTypeCode} that ${d.id} does not withhold on`);
    const sum = liveWts.reduce((n, { wt }) => n + sat(wt.header.whtTax ?? '0.00', wt.id), 0);
    if (sum !== sat(d.totals.wht ?? '0.00', d.id)) out.push(`${d.id}: Σ active WT tax ${fromSatang(sum)} but the voucher withholds ${d.totals.wht}`);
    for (const { wt } of liveWts) {
      let acct = '';
      try { acct = resolveRole(st, 'WhtPayable', { companyId: d.companyId, docType: 'PV', whtForm: wt.header.whtForm }).code; } catch (e) { out.push(`${wt.id}: WhtPayable does not resolve (${(e as Error).message})`); continue; }
      const k = `${d.companyId}|${acct}`;
      wtTax.set(k, (wtTax.get(k) ?? 0) + sat(wt.header.whtTax ?? '0.00', wt.id));
    }
  }
  // 11b. (I1) a bill at outstanding 0.00 that a live voucher paid up carries exactly ONE paid-up record (the holder's `billBase` = the bill's base per WHT type when it was paid up, never today's bill: a later note
  //      must not turn this red). Per WHT type: Σ stored bases of the bill's live vouchers = max(B_paidUp, Σ bases of the OTHER vouchers). Normally the holder's base is the remainder, so Σ = B_paidUp; when an
  //      earlier over-withholding already exceeds B_paidUp (a credit landed between payments) the holder's base is clamped to 0 and Σ = Σ others (WHT is not refunded). A bill brought to 0 by notes alone
  //      has no holder and is skipped (C1). Records are cleared by the command that reopens the bill, so none can be stale.
  for (const bill of st.docs) {
    if (bill.type !== 'PB' || !LIVE.includes(bill.status)) continue;
    const bal = expectedBalance(st, bill);
    if (bal.status !== 'settled' || bal.out !== 0) continue;
    const pvs = st.docs.filter((d) => d.type === 'PV' && LIVE.includes(d.status)).map((d) => ({ id: d.id, bases: (d.whtFrozen?.bases ?? []).filter((x) => x.targetId === bill.id) })).filter((x) => x.bases.length);
    const holders = pvs.filter((x) => x.bases.some((y) => y.full));
    if (holders.length > 1) { out.push(`${bill.id}: two paid-up records (${holders.map((h) => h.id).join(', ')}), exactly one voucher paid it up last`); continue; }
    if (!holders.length) continue;
    for (const h of holders[0].bases.filter((y) => y.full && y.billBase !== undefined)) {
      const sum = (xs: typeof h[]) => xs.filter((y) => y.whtTypeCode === h.whtTypeCode).reduce((n, y) => n + toSatang(y.base), 0);
      const got = sum(pvs.flatMap((x) => x.bases)), others = sum(pvs.filter((x) => x.id !== holders[0].id).flatMap((x) => x.bases));
      const want = Math.max(toSatang(h.billBase!), others);
      if (got !== want) out.push(`${bill.id}: paid up but its vouchers withheld on ${fromSatang(got)} of ${h.whtTypeCode}; the bill's base when it was paid up was ${h.billBase} and the other vouchers took ${fromSatang(others)}, so ${fromSatang(want)} is expected`);
    }
  }
  for (const wt of st.docs) {
    if (wt.type !== 'WT' || !LIVE.includes(wt.status)) continue;
    const from = st.links.filter((l) => l.active && l.kind === 'issues' && l.to === wt.id);
    if (from.length !== 1 || !LIVE.includes(doc(from[0].from)?.status ?? 'cancelled')) out.push(`${wt.id}: a live WT needs exactly one active issues link from a live PV (has ${from.length})`);
  }
  for (const c of st.companies) {
    const accounts = new Set<string>();
    for (const form of ['PND1', 'PND2', 'PND3', 'PND53', 'PND54'] as const) { try { accounts.add(resolveRole(st, 'WhtPayable', { companyId: c.id, docType: 'PV', whtForm: form }).code); } catch { /* not in this chart */ } }
    for (const a of accounts) if ((credit.get(`${c.id}|${a}`) ?? 0) - (obCredit.get(`${c.id}|${a}`) ?? 0) !== (wtTax.get(`${c.id}|${a}`) ?? 0)) {
      out.push(`${c.id}: GL ${a} (WHT payable) credit movement ${fromSatang((credit.get(`${c.id}|${a}`) ?? 0) - (obCredit.get(`${c.id}|${a}`) ?? 0))} but the live WTs of that return carry ${fromSatang(wtTax.get(`${c.id}|${a}`) ?? 0)}`);
    }
  }

  // 12. approval (§7.6): a pending / approved document is not issued - no number, no journal, no link - and carries who sent it (and who approved it); an issued one never carries an approval nobody gave
  for (const d of st.docs) {
    if (d.status === 'pending' || d.status === 'approved') {
      if (d.number) out.push(`${d.id}: ${d.status} but has the number ${d.number} (the number is allocated once, at issue)`);
      if (st.journals.some((j) => j.docId === d.id)) out.push(`${d.id}: ${d.status} but has a journal`);
      if (st.links.some((l) => l.active && l.from === d.id)) out.push(`${d.id}: ${d.status} but has an active link`);
      if (!d.approval?.submittedBy) out.push(`${d.id}: ${d.status} without an approval record (who sent it)`);
      if (d.status === 'approved' && !d.approval?.approvedBy) out.push(`${d.id}: approved without an approval record (who approved it)`);
    } else if (d.approval && !d.approval.approvedBy) out.push(`${d.id}: ${d.status} with an approval record that nobody approved`);
    // C1: a live document the policy wants approved at its CURRENT total carries an approval that covers it (a revise above the approved amount is approved in the same command)
    const payout = payoutOf(st, d.companyId, d); // what the company pays out: the settled total plus the WHT it bears (P4 m1)
    if (LIVE.includes(d.status) && approvalRequired(st, d.companyId, d.type, payout) && (!d.approval?.approvedBy || toSatang(d.approval.amount ?? '0.00') < toSatang(payout))) {
      out.push(`${d.id}: ${d.type} payout ${payout} needs approval but the approval ${d.approval?.approvedBy ? `covers only ${d.approval.amount ?? '0.00'}` : 'is missing'}`);
    }
  }

  // 13. bank reconciliation (FN2): a matched line = its stored document shares + its difference; a document is never matched for more than its cash and still IS what was matched; every reconciliation journal balances and posts to the line's account
  const shares = new Map<string, number>(); // docId -> Σ stored shares over all lines
  for (const l of st.bankLines) {
    const where = `bank line ${l.id}`, amount = sat(l.amount, where), ms = l.matches ?? [];
    if (l.status !== 'matched' && (ms.length || l.diff)) out.push(`${where}: ${l.status} but carries a match`);
    if (l.status === 'posted' && !l.journalId) out.push(`${where}: posted without its journal`);
    if (l.status === 'posted' && !st.bankJournals.some((j) => j.id === l.journalId && j.lineId === l.id && j.kind === 'inline')) out.push(`${where}: posted but its inline journal is missing`);
    if (l.transfer && l.status !== 'matched') out.push(`${where}: ${l.status} but carries a transfer match`);
    if (l.status !== 'matched') continue;
    if (l.transfer) {
      const tj = st.bankJournals.find((x) => x.id === l.transfer!.journalId && x.companyId === l.companyId && x.kind === 'transfer');
      if (!tj) out.push(`${where}: matched to a transfer journal that does not exist`);
      else {
        if (ms.length || l.diff) out.push(`${where}: matched to a transfer and to documents`);
        if (tj.accountId !== l.accountId && tj.otherAccountId !== l.accountId) out.push(`${where}: its transfer journal ${tj.id} is not between this account and another`);
        if (l.transfer.side !== (amount < 0 ? 'out' : 'in')) out.push(`${where}: transfer side ${l.transfer.side} but the amount is ${l.amount}`);
        const g = tj.entries[0].lines.reduce((n, x) => n + sat(x.debit, where), 0);
        if (g !== Math.abs(amount)) out.push(`${where}: transfer journal ${tj.id} moves ${fromSatang(g)} but the line is ${l.amount}`);
        if (st.bankLines.some((x) => x.id !== l.id && x.status === 'matched' && x.transfer?.journalId === tj.id && x.transfer.side === l.transfer!.side)) out.push(`${where}: two lines matched on the same side of transfer ${tj.id}`);
      }
      continue;
    }
    if (!ms.length) out.push(`${where}: matched without a document`);
    const s1 = amount < 0 ? -1 : 1, diff = sat(l.diff?.amount ?? '0.00', where), sum = ms.reduce((n, m) => n + sat(m.amount, where), 0);
    if (s1 * sum + diff !== amount) out.push(`${where}: matched ${fromSatang(sum)} + difference ${fromSatang(diff)} is not the line amount ${l.amount}`);
    if (l.diff) {
      const j = st.bankJournals.find((x) => x.id === l.diff!.journalId && x.lineId === l.id && x.kind === 'fee');
      if (!j) out.push(`${where}: difference without its journal`);
      else {
        const b = st.bankAccounts.find((x) => x.id === l.accountId);
        const net = j.entries.reduce((n, e) => n + e.lines.filter((g) => g.accountCode === b?.accountCode).reduce((x, g) => x + sat(g.debit, where) - sat(g.credit, where), 0), 0);
        const open = j.entries[j.entries.length - 1]?.kind !== 'reversal';
        if (open && net !== diff) out.push(`${where}: difference journal moves the bank by ${fromSatang(net)} but the difference is ${fromSatang(diff)}`);
      }
    }
    for (const m of ms) {
      const d = doc(m.docId);
      shares.set(m.docId, (shares.get(m.docId) ?? 0) + sat(m.amount, where));
      if (sat(m.amount, where) <= 0) out.push(`${where}: share of ${m.docId} is not positive`);
      if (!d || d.companyId !== l.companyId) { out.push(`${where}: matched document ${m.docId} is missing or of another company`); continue; }
      if (!LIVE.includes(d.status)) out.push(`${where}: matched document ${d.id} is ${d.status}`);
      if (docCash(d) !== sat(m.docCash, where)) out.push(`${where}: ${d.id} cash is now ${fromSatang(docCash(d))} but it was matched at ${m.docCash}`);
      if (resolvedBankId(st, d.companyId, d.type, d.header) !== m.accountId || m.accountId !== l.accountId) out.push(`${where}: ${d.id} is on account ${resolvedBankId(st, d.companyId, d.type, d.header)} but was matched on ${m.accountId} / line ${l.accountId}`);
      if (d.header.documentDate !== m.docDate) out.push(`${where}: ${d.id} is dated ${d.header.documentDate} but was matched at ${m.docDate}`);
    }
  }
  for (const [id, n] of shares) { const d = doc(id); if (d && n > docCash(d)) out.push(`${id}: matched for ${fromSatang(n)} but its cash is ${fromSatang(docCash(d))}`); }
  for (const j of st.bankJournals) {
    const where = `bank journal ${j.id}`, b = st.bankAccounts.find((x) => x.id === j.accountId && x.companyId === j.companyId);
    if (!b) { out.push(`${where}: unknown bank account ${j.accountId}`); continue; }
    if (j.lineId && !st.bankLines.some((l) => l.id === j.lineId && l.accountId === j.accountId && l.companyId === j.companyId)) out.push(`${where}: line ${j.lineId} is not on its account`);
    for (const e of j.entries) {
      if (!e.lines.some((g) => g.accountCode === b.accountCode)) out.push(`${where} ${e.kind} entry ${e.date}: does not post to the account's GL ${b.accountCode}`);
      if (!e.postedAt) out.push(`${where} ${e.kind} entry ${e.date}: no postedAt`);
      const p = st.periods.find((x) => x.companyId === j.companyId && x.month === e.date.slice(0, 7));
      if (p?.status === 'closed' && !(e.postedAt && p.closedAt && Date.parse(e.postedAt) <= Date.parse(p.closedAt))) out.push(`${where} ${e.kind} entry ${e.date}: dated in closed period ${p.month} but posted after it closed`);
    }
  }

  // 14. settlement records (FN3, D-13): the frozen legs balance for their kind, the journal posts exactly the legs, the settles links are the legs of the POSTED records (a reversed one leaves none active),
  //     a deposit / prepayment is never applied beyond what it kept, and per company and per party GL(2140) / GL(1140) = Σ the unapplied customer deposits / vendor prepayments
  const PAYABLE: DocType[] = ['PB'];
  for (const s of st.settlements) {
    const where = `settlement ${s.id}`, sm = (xs: { amount: string }[]) => xs.reduce((n, l) => n + sat(l.amount, where), 0);
    const ss = sm(s.sources), ts = sm(s.targets), diff = sat(s.difference?.amount ?? '0.00', where);
    for (const l of [...s.sources, ...s.targets]) {
      const d = doc(l.docId);
      if (sat(l.amount, where) <= 0) out.push(`${where}: leg ${l.docId} is not positive`);
      if (!d || d.companyId !== s.companyId) out.push(`${where}: leg ${l.docId} is missing or of another company`);
      else if (s.status === 'posted' && !LIVE.includes(d.status)) out.push(`${where}: posted but its leg ${d.id} is ${d.status}`);
    }
    if (s.kind === 'netting') { if (ss !== ts) out.push(`${where}: netting clears AR ${fromSatang(ts)} but AP ${fromSatang(ss)}`); if (s.difference) out.push(`${where}: a netting carries no difference`); }
    else if (ts !== ss + diff) out.push(`${where}: targets ${fromSatang(ts)} are not sources ${fromSatang(ss)} + difference ${fromSatang(diff)}`);
    if (s.kind === 'write_off' && (s.sources.length || diff <= 0 || diff !== ts)) out.push(`${where}: a write-off has no sources and writes off exactly its targets`);
    const active = st.links.filter((l) => l.active && l.kind === 'settles' && l.from === s.id);
    if (s.status === 'posted') {
      const want = [...s.sources, ...s.targets].map((l) => `${l.docId}|${sat(l.amount, where)}`).sort().join(','), have = active.map((l) => `${l.to}|${sat(l.amount ?? '0.00', where)}`).sort().join(',');
      if (want !== have) out.push(`${where}: legs [${want}] but the active settles links are [${have}]`);
    } else if (active.length) out.push(`${where}: reversed but ${active.length} settles link(s) are still active`);
    const original = s.journal[0], last = s.journal[s.journal.length - 1];
    if (!original || original.kind !== 'original') { out.push(`${where}: no original journal entry`); continue; }
    if (s.status === 'posted' ? s.journal.length !== 1 : s.journal.length !== 2 || last.kind !== 'reversal') out.push(`${where}: ${s.status} but its journal has ${s.journal.length} entries ending in ${last.kind}`);
    if (original.date !== s.date) out.push(`${where}: dated ${s.date} but its journal entry is dated ${original.date}`);
    for (const e of s.journal) {
      if (!e.postedAt) out.push(`${where} ${e.kind} entry ${e.date}: no postedAt`);
      const p = st.periods.find((x) => x.companyId === s.companyId && x.month === e.date.slice(0, 7));
      if (p?.status === 'closed' && !(e.postedAt && p.closedAt && Date.parse(e.postedAt) <= Date.parse(p.closedAt))) out.push(`${where} ${e.kind} entry ${e.date}: dated in closed period ${p.month} but posted after it closed`);
    }
    if (s.journal.length === 2 && last.kind === 'reversal' && JSON.stringify(last.lines.map((l) => [l.accountCode, l.credit, l.debit, l.partyName ?? ''])) !== JSON.stringify(original.lines.map((l) => [l.accountCode, l.debit, l.credit, l.partyName ?? '']))) {
      out.push(`${where}: its reversal is not the exact mirror of the original entry`);
    }
    const j = (role: string, side: 'debit' | 'credit') => roleSum(original, role, side), diffRole = s.difference?.role ?? '';
    const payable = s.targets.length > 0 && s.targets.every((t) => PAYABLE.includes(t.type as DocType));
    const jwant: [string, 'debit' | 'credit', number][] = s.kind === 'apply_deposit' ? [['CustomerDeposit', 'debit', ss], ['AR', 'credit', ts], ...(diff ? [[diffRole, 'debit', diff] as [string, 'debit', number]] : [])]
      : s.kind === 'apply_prepayment' ? [['AP', 'debit', ts], ['VendorPrepayment', 'credit', ss], ...(diff ? [[diffRole, 'credit', diff] as [string, 'credit', number]] : [])]
        : s.kind === 'netting' ? [['AP', 'debit', ss], ['AR', 'credit', ts]]
          : payable ? [['AP', 'debit', ts], [diffRole, 'credit', diff]] : [['AR', 'credit', ts], [diffRole, 'debit', diff]];
    for (const [role, side, n] of jwant) if (j(role, side) !== n) out.push(`${where}: journal ${role} ${side} ${fromSatang(j(role, side))} but its legs say ${fromSatang(n)}`);
  }
  // per target and difference role, Σ the live differences stays within the company's tolerance (ruling 1)
  const taken = new Map<string, { co: string; role: string; n: number }>();
  for (const s of st.settlements) {
    if (s.status !== 'posted' || !s.difference) continue;
    for (const t of s.targets) { const k = `${t.docId}|${s.difference.role}`, p = taken.get(k); taken.set(k, { co: s.companyId, role: s.difference.role, n: (p?.n ?? 0) + sat(s.difference.amount, `settlement ${s.id}`) }); }
  }
  for (const [k, v] of taken) if (v.n > toleranceOf(st, v.co, v.role)) out.push(`${k.split('|')[0]}: live ${v.role} differences ${fromSatang(v.n)} exceed the tolerance ${fromSatang(toleranceOf(st, v.co, v.role))}`);
  for (const l of st.links) {
    const s = l.kind === 'settles' ? st.settlements.find((x) => x.id === l.from) : undefined;
    if (s && l.active && s.status !== 'posted') out.push(`link ${l.from} → ${l.to} is active but ${l.from} is ${s.status}`);
    if (s && s.companyId !== l.companyId) out.push(`link ${l.from} → ${l.to} joins different companies`);
  }
  for (const c of st.companies) {
    for (const [role, type, sign] of [['CustomerDeposit', 'RC', -1], ['VendorPrepayment', 'PV', 1]] as const) {
      let code = '';
      try { code = resolveRole(st, role, { companyId: c.id, docType: 'JV' }).code; } catch (e) { out.push(`${c.id}: ${role} does not resolve (${(e as Error).message})`); continue; }
      const kept = new Map<string, number>(); // party name -> Σ unapplied
      for (const d of st.docs) {
        if (d.companyId !== c.id || d.type !== type || !LIVE.includes(d.status)) continue;
        const dep = sat(d.header.depositAmount ?? '0.00', d.id), rest = dep - appliedOf(st, d.id);
        if (rest < 0) out.push(`${d.id}: ${fromSatang(appliedOf(st, d.id))} applied from a ${role === 'CustomerDeposit' ? 'deposit' : 'prepayment'} of ${fromSatang(dep)}`);
        kept.set(d.party?.name ?? '', (kept.get(d.party?.name ?? '') ?? 0) + rest);
      }
      for (const d of st.docs) { // AC3: an opening deposit / prepayment is kept in full (nothing applies it yet)
        if (d.companyId !== c.id || d.type !== 'OB' || d.header.obSide !== (role === 'CustomerDeposit' ? 'DEP' : 'PRE') || !LIVE.includes(d.status)) continue;
        kept.set(d.party?.name ?? '', (kept.get(d.party?.name ?? '') ?? 0) + sat(d.outstanding ?? '0.00', d.id));
      }
      const total = [...kept.values()].reduce((n, x) => n + x, 0);
      if (sign * (gl.get(`${c.id}|${code}`) ?? 0) !== total) out.push(`${c.id}: GL ${code} (${role}) ${fromSatang(sign * (gl.get(`${c.id}|${code}`) ?? 0))} but the unapplied ${role === 'CustomerDeposit' ? 'customer deposits' : 'vendor prepayments'} are ${fromSatang(total)}`);
      const names = new Set([...kept.keys(), ...[...byParty.keys()].filter((k) => k.startsWith(`${c.id}|${code}|`)).map((k) => k.slice(`${c.id}|${code}|`.length))]);
      for (const name of names) {
        const g = sign * (byParty.get(`${c.id}|${code}|${name}`) ?? 0);
        if (g !== (kept.get(name) ?? 0)) out.push(`${c.id}: GL ${code} of ${name || '(no party)'} ${fromSatang(g)} but their unapplied ${role === 'CustomerDeposit' ? 'deposits' : 'prepayments'} are ${fromSatang(kept.get(name) ?? 0)}`);
      }
    }
  }

  out.push(...obInvariants(st)); // 16. opening balances (AC3): the journal is what its steps say, the ties hold, the frozen items are the steps' items, go-live follows the batch
  out.push(...scheduleInvariants(st)); // 17. schedules (AC4): plan = total, each run JV = its plan row, the prepaid account moved by the live runs
  out.push(...jvInvariants(st)); // 15. journal vouchers (AC1): no controlled account, the journal is the lines, reversals mirror, accruals net to zero

  // numbering: gap-free per company x type x month, and the series counter agrees
  const groups = new Map<string, number[]>();
  for (const d of st.docs) {
    if (!d.number || d.header.obBatchId) continue; // an opening item's number is the old document's, printed '(ยกมา)'
    const m = /^([A-Z]+)-(\d{4})(\d{2})-(\d{4})$/.exec(d.number);
    if (!m || m[1] !== d.type) { out.push(`${d.id}: numbering: "${d.number}" is not a ${d.type} number`); continue; }
    const k = `${d.companyId}|${d.type}|${m[2]}-${m[3]}`;
    groups.set(k, [...(groups.get(k) ?? []), Number(m[4])]);
  }
  for (const [k, seqs] of groups) {
    const sorted = [...seqs].sort((x, y) => x - y);
    if (sorted.some((n, i) => n !== i + 1)) out.push(`${k}: numbering is not gap-free (${sorted.join(', ')})`);
    if ((st.series[k] ?? 0) !== sorted.length) out.push(`${k}: numbering counter ${st.series[k] ?? 0} but ${sorted.length} numbers issued`);
  }

  // locks: the period lock is derived at read time, never stored (one function: derivedLocks)
  for (const d of st.docs as Doc[]) if (d.locks.some((l) => l.kind === 'period')) out.push(`${d.id}: stored period lock (derived at read time only)`);
  for (const d of st.docs as Doc[]) if (d.locks.some((l) => l.kind === 'reconciliation')) out.push(`${d.id}: stored reconciliation lock (derived from the bank-line matches at read time only)`);
  return out;
}
