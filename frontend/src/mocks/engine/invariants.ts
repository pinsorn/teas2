import { DOC_TYPES } from '@/domain/doc-types';
import type { Doc } from '@/domain/types';
import type { MockState } from '../store';
import { consumed, q4 } from './chain';
import { LIVE } from './commands';
import { POST } from './ledger';
import { fromSatang, toSatang } from './money';
import { firstOpenDate, isClosed } from './periods';

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
    if (d.status === 'draft' || !DOC_TYPES[d.type].ledger || !POST[d.type] || d.totals.total === '0.00') continue;
    const entries = st.journals.find((j) => j.docId === d.id)?.preview.entries;
    if (!entries?.length) { out.push(`${d.id}: ${d.status} ${d.type} has no journal`); continue; }
    if ((d.status === 'cancelled' || d.status === 'replaced') && entries[entries.length - 1].kind !== 'reversal') out.push(`${d.id}: ${d.status} but its journal ends without a reversal`);
  }

  // 7. an entry dated in a closed period was posted before the close (a reversal / correction from before closedAt), is an original, or is late and in the first open period
  for (const j of st.journals) {
    const d = doc(j.docId);
    if (!d) continue;
    for (const e of j.preview.entries) {
      const p = st.periods.find((x) => x.companyId === d.companyId && x.month === e.date.slice(0, 7));
      if (p?.status !== 'closed' || e.kind === 'original' && !e.late) continue;
      let ok: boolean;
      if (e.late) ok = e.date >= firstOpenDate(st, d.companyId) && !isClosed(st, d.companyId, e.date);
      else {
        const at = e.kind === 'reversal' ? d.cancel?.at : st.revisions.filter((r) => r.docId === d.id).map((r) => r.at).sort().pop();
        ok = !!at && !!p.closedAt && Date.parse(at) <= Date.parse(p.closedAt);
      }
      if (!ok) out.push(`${d.id} ${e.kind} entry ${e.date}: dated in closed period ${p.month} but was posted after it closed and is not a late entry in the first open period`);
    }
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
