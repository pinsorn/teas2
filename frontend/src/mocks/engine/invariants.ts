import { DOC_TYPES, LIVE, SETTLES } from '@/domain/doc-types';
import type { Doc } from '@/domain/types';
import type { MockState } from '../store';
import { consumed, q4 } from './chain';
import { divRoundHalfAway, fromSatang, toSatang } from './money';
import { firstOpenDate, isClosed } from './periods';
import { computeDoc } from './vat';

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

/** WHT of a PV recomputed from its lines and the fixture rate table, deliberately not through `computeWht` (D-14, [SP-R] rates). */
function expectedWht(st: MockState, d: Stored): { tax: number; bad?: string } {
  const nets = computeDoc(d.lines, !!d.header.priceIncludesVat).lines;
  const base = new Map<string, bigint>();
  d.lines.forEach((l, i) => { if (l.whtTypeCode) base.set(l.whtTypeCode, (base.get(l.whtTypeCode) ?? 0n) + BigInt(toSatang(nets[i].net))); });
  const mode = d.header.whtMode ?? 'deduct';
  let tax = 0n;
  for (const [code, b] of base) {
    const t = st.whtTypes.filter((x) => x.companyId === d.companyId && x.code === code && x.effectiveFrom <= d.header.documentDate).sort((x, y) => y.effectiveFrom.localeCompare(x.effectiveFrom))[0];
    if (!t) return { tax: 0, bad: `unknown WHT type ${code}` };
    if (b <= 0n) continue;
    const r = BigInt(t.rateBp);
    const income = mode === 'deduct' ? b : mode === 'grossup_always' ? divRoundHalfAway(b * 10000n, 10000n - r) : divRoundHalfAway(b * (10000n + r), 10000n);
    tax += divRoundHalfAway(income * r, 10000n);
  }
  return { tax: Number(tax) };
}

/** Every violation in the state, as readable strings; [] = all hold (money invariants 1-7, numbering, derived locks). */
export function checkInvariants(st: MockState): string[] {
  const out: string[] = [];
  const doc = (id: string): Stored | undefined => st.docs.find((d) => d.id === id);
  const sat = (m: string, where: string): number => {
    try { return toSatang(m); } catch { out.push(`${where}: bad money "${m}"`); return 0; }
  };
  const gl = new Map<string, number>(); // `${companyId}|${code}` -> debit - credit

  // 1. every journal entry balances, is non-negative and posts to postable accounts of its own company
  for (const j of st.journals) {
    const d = doc(j.docId);
    if (!d) { out.push(`journal of unknown document ${j.docId}`); continue; }
    for (const e of j.preview.entries) {
      const where = `${d.id} ${e.kind} entry ${e.date}`;
      let dr = 0, cr = 0;
      for (const l of e.lines) {
        const a = sat(l.debit, where), b = sat(l.credit, where);
        if (a < 0 || b < 0) out.push(`${where}: negative amount on ${l.accountCode}`);
        dr += a; cr += b;
        const acc = st.accounts.find((x) => x.companyId === d.companyId && x.code === l.accountCode);
        if (!acc) out.push(`${where}: unknown account ${l.accountCode} for ${d.companyId}`);
        else if (!acc.postable) out.push(`${where}: account ${l.accountCode} is not postable`);
        const k = `${d.companyId}|${l.accountCode}`;
        gl.set(k, (gl.get(k) ?? 0) + a - b);
      }
      if (dr !== cr) out.push(`${where}: unbalanced (Dr ${fromSatang(dr)} / Cr ${fromSatang(cr)})`);
    }
  }

  // 2 + 3. outstanding follows the links; status follows settlements (a TI credited to zero without a settlement stays issued)
  const sub = new Map<string, number>(); // `${companyId}|${type}` -> Σ outstanding of live documents
  for (const d of st.docs) {
    if (!LIVE.includes(d.status) || !DOC_TYPES[d.type].outstanding) continue;
    const exp = expectedBalance(st, d);
    if (d.outstanding !== fromSatang(exp.out)) out.push(`${d.id}: outstanding ${d.outstanding ?? 'missing'} but the links say ${fromSatang(exp.out)}`);
    if (d.status !== exp.status) out.push(`${d.id}: status ${d.status} but the settlements and outstanding say ${exp.status}`);
    sub.set(`${d.companyId}|${d.type}`, (sub.get(`${d.companyId}|${d.type}`) ?? 0) + sat(d.outstanding ?? '0.00', d.id));
  }

  // 4. subledger = GL, per company
  const SUBLEDGERS: [string, number, string[]][] = [['1130', 1, ['TI', 'IV']], ['2110', -1, ['PB']], ['2180', -1, ['EX']]];
  for (const c of st.companies) {
    for (const [code, sign, types] of SUBLEDGERS) {
      const glBal = sign * (gl.get(`${c.id}|${code}`) ?? 0);
      const subBal = types.reduce((n, t) => n + (sub.get(`${c.id}|${t}`) ?? 0), 0);
      if (glBal !== subBal) out.push(`${c.id}: GL ${code} ${fromSatang(glBal)} but outstanding of live ${types.join('/')} is ${fromSatang(subBal)}`);
    }
  }

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
    const a = doc(l.from), b = doc(l.to);
    if (!a || !b) out.push(`link ${l.from} → ${l.to} points at a missing document`);
    else if (a.companyId !== b.companyId || (l.companyId !== undefined && l.companyId !== a.companyId)) out.push(`link ${l.from} → ${l.to} joins different companies`);
  }
  for (const d of st.docs) {
    if (d.status === 'draft' || !DOC_TYPES[d.type].ledger || d.totals.total === '0.00') continue;
    const entries = st.journals.find((j) => j.docId === d.id)?.preview.entries;
    if (!entries?.length) { out.push(`${d.id}: ${d.status} ${d.type} has no journal`); continue; }
    if ((d.status === 'cancelled' || d.status === 'replaced') && entries[entries.length - 1].kind !== 'reversal') out.push(`${d.id}: ${d.status} but its journal ends without a reversal`);
  }

  // 7. an entry dated in a closed period was posted before the close (issuedAt / cancel / revision <= closedAt), or is late and in the first open period
  for (const j of st.journals) {
    const d = doc(j.docId);
    if (!d) continue;
    for (const e of j.preview.entries) {
      const p = st.periods.find((x) => x.companyId === d.companyId && x.month === e.date.slice(0, 7));
      if (p?.status !== 'closed') continue;
      let ok: boolean;
      if (e.kind === 'original' && !e.late) ok = !!d.issuedAt && !!p.closedAt && Date.parse(d.issuedAt) <= Date.parse(p.closedAt); // an original in a closed month was issued before the close
      else if (e.late) ok = e.date >= firstOpenDate(st, d.companyId) && !isClosed(st, d.companyId, e.date);
      else {
        const at = e.kind === 'reversal' ? d.cancel?.at : st.revisions.filter((r) => r.docId === d.id).map((r) => r.at).sort().pop();
        ok = !!at && !!p.closedAt && Date.parse(at) <= Date.parse(p.closedAt);
      }
      if (!ok) out.push(`${d.id} ${e.kind} entry ${e.date}: dated in closed period ${p.month} but was posted after it closed and is not a late entry in the first open period`);
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
      if (total !== alloc + lineTotal) out.push(`${d.id}: PV total ${fromSatang(total)} is not Σ allocations + line totals (${fromSatang(alloc + lineTotal)})`);
      if (cash !== (mode === 'deduct' ? total - wht : total)) out.push(`${d.id}: PV cash ${fromSatang(cash)} is wrong for mode ${mode} (total ${fromSatang(total)}, wht ${fromSatang(wht)})`);
      if (live) {
        const expense = j('WhtExpense', 'debit');
        if (expense !== (mode === 'deduct' ? 0 : wht)) out.push(`${d.id}: WHT expense ${fromSatang(expense)} is wrong for mode ${mode} (wht ${fromSatang(wht)})`);
        if (j('Cash', 'credit') !== cash) out.push(`${d.id}: journal cash ${fromSatang(j('Cash', 'credit'))} but the voucher paid ${fromSatang(cash)}`);
        if (j('WhtPayable', 'credit') !== wht) out.push(`${d.id}: journal WHT payable ${fromSatang(j('WhtPayable', 'credit'))} but the voucher withheld ${fromSatang(wht)}`);
        if (j('AP', 'debit') + j('EmployeePayable', 'debit') !== alloc) out.push(`${d.id}: journal payables ${fromSatang(j('AP', 'debit') + j('EmployeePayable', 'debit'))} but the allocations clear ${fromSatang(alloc)}`);
        // the balance identity: Σ allocations + line totals + the WHT we bear = cash + Σ tax
        if (alloc + lineTotal + expense !== cash + wht) out.push(`${d.id}: PV Σ alloc + lines + expense (${fromSatang(alloc + lineTotal + expense)}) is not cash + WHT (${fromSatang(cash + wht)})`);
      }
    }
  }
  // a target is never settled for more than it was ever billed: Σ active settles <= total + Σ active DN / PDN (a later CN may leave a negative outstanding; that is shown, not an error)
  for (const d of st.docs) {
    if (!LIVE.includes(d.status) || !DOC_TYPES[d.type].outstanding) continue;
    const settled = st.links.filter((l) => l.active && l.to === d.id && l.kind === 'settles').reduce((n, l) => n + sat(l.amount ?? '0.00', d.id), 0);
    const debits = st.links.filter((l) => l.active && l.to === d.id && l.kind === 'adjusts' && ['DN', 'PDN'].includes(doc(l.from)?.type ?? '')).reduce((n, l) => n + sat(l.amount ?? '0.00', d.id), 0);
    if (settled > sat(d.totals.total, d.id) + debits) out.push(`${d.id}: settled ${fromSatang(settled)} exceeds the total ${d.totals.total} plus debit notes`);
  }

  // numbering: gap-free per company x type x month, and the series counter agrees
  const groups = new Map<string, number[]>();
  for (const d of st.docs) {
    if (!d.number) continue;
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
  return out;
}
