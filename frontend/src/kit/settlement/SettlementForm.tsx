'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/app-shell/useMe';
import type { DocType, SettlementDifferenceRole, SettlementKind, SettlementLeg, SettlementRecord } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints, type SettleInput } from '@/lib/api/endpoints';
import { formatDateBE, formatMoney } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { cleanDecimal, moneyText } from '../doc-editor/useLineGridKeys';

const selectCls = 'h-(--ctl-h) rounded-lg border border-input bg-card px-3 text-body';
const KINDS: SettlementKind[] = ['apply_deposit', 'apply_prepayment', 'netting', 'write_off'];
const ROLES: SettlementDifferenceRole[] = ['RoundingDifference', 'SmallWriteOff', 'BankFee'];
/** Comparing two money strings (never adding them): the smaller one, as the server wrote it. */
const smaller = (a: string, b: string) => (Math.round(Number(a) * 100) <= Math.round(Number(b) * 100) ? a : b);

/** The legs of a settlement as "number · amount" lines (the amounts are the ones frozen at posting). */
export const Legs = ({ legs }: { legs: SettlementLeg[] }) => (
  <ul className="grid gap-0.5">{legs.map((l) => <li key={l.docId} className="tabular-nums">{l.number ?? l.docId} · {formatMoney(l.amount)}</li>)}</ul>
);

interface Row { id: string; number: string; date: string; max: string }
type Picked = Record<string, string>; // doc id -> amount typed

/** FN3: a settlement (D-13) from one screen. Pick what to apply (a customer deposit, a vendor prepayment, a vendor bill to net, or just a small difference to write off), the party, the documents
 *  and the amounts; the server checks every rule (same party, within what each document has left, balanced, within the tolerance) and posts the journal. `initial` pre-selects a deposit. */
export function SettlementForm({ initial, onClose, onPosted }: { initial?: { docId: string; type: 'RC' | 'PV'; partyId: string }; onClose: () => void; onPosted: (s: SettlementRecord) => void }) {
  const t = useTranslations('settlement');
  const tf = useTranslations('settlement.form');
  const qc = useQueryClient();
  const { me } = useMe();
  const id = useId();
  const company = me?.activeCompanyId ?? '';
  const key = useRef(crypto.randomUUID());
  const [kind, setKind] = useState<SettlementKind>(initial ? (initial.type === 'RC' ? 'apply_deposit' : 'apply_prepayment') : 'apply_deposit');
  const [partyId, setPartyId] = useState(initial?.partyId ?? '');
  const [side, setSide] = useState<'customer' | 'vendor'>('customer'); // write-off only
  const [date, setDate] = useState(me?.businessDate ?? '');
  const [sources, setSources] = useState<Picked>(initial ? { [initial.docId]: '' } : {});
  const [targets, setTargets] = useState<Picked>({});
  const [role, setRole] = useState<SettlementDifferenceRole | ''>(kind === 'write_off' ? 'SmallWriteOff' : '');
  const [diff, setDiff] = useState('');
  const [reason, setReason] = useState('');

  const deposits = useQuery({ queryKey: qk.deposits(company), queryFn: () => endpoints.getDeposits(), enabled: !!me });
  const vat = !!me?.vatRegistered;
  const arType: DocType = vat ? 'TI' : 'IV';
  const pair = (deposits.data?.pairs ?? []).find((p) => p.customerId === partyId || p.vendorId === partyId);
  const targetParty = kind === 'netting' ? pair?.customerId ?? '' : partyId;
  const targetTypes: DocType[] = kind === 'apply_prepayment' || (kind === 'write_off' && side === 'vendor') ? ['PB'] : [arType];
  const targetItems = useQuery({ queryKey: qk.openItems(company, targetParty, targetTypes.join(',')), queryFn: () => endpoints.openItems({ partyId: targetParty, types: targetTypes }), enabled: !!me && !!targetParty });
  const apItems = useQuery({ queryKey: qk.openItems(company, pair?.vendorId ?? '', 'PB'), queryFn: () => endpoints.openItems({ partyId: pair!.vendorId, types: ['PB'] }), enabled: !!me && kind === 'netting' && !!pair });
  const parties = useQuery({ queryKey: [company, 'settlement-parties', side], queryFn: () => endpoints.searchParties({ kind: side, limit: 100 }), enabled: !!me && kind === 'write_off' });

  const depositRows: Row[] = (deposits.data?.items ?? []).filter((r) => r.partyId === partyId && r.type === (kind === 'apply_deposit' ? 'RC' : 'PV')).map((r) => ({ id: r.docId, number: r.number, date: r.documentDate, max: r.remaining }));
  const sourceRows: Row[] = kind === 'netting' ? (apItems.data?.items ?? []).map((i) => ({ id: i.id, number: i.number, date: i.documentDate, max: i.outstanding })) : kind === 'write_off' ? [] : depositRows;
  const targetRows: Row[] = (targetItems.data?.items ?? []).filter((i) => i.outstanding !== '0.00' && !i.outstanding.startsWith('-')).map((i) => ({ id: i.id, number: i.number, date: i.documentDate, max: i.outstanding }));
  const depositParties = [...new Map((deposits.data?.items ?? []).filter((r) => r.type === (kind === 'apply_deposit' ? 'RC' : 'PV')).map((r) => [r.partyId, r.partyName])).entries()];

  useEffect(() => { // a deposit chosen on the deposits screen arrives ticked, with the amount the server holds for it
    const r = initial && sources[initial.docId] === '' ? depositRows.find((x) => x.id === initial.docId) : undefined;
    if (r) setSources({ [r.id]: r.max });
  }, [initial, sources, depositRows]);
  const reset = (k: SettlementKind) => { setKind(k); setPartyId(''); setSources({}); setTargets({}); setDiff(''); setRole(k === 'write_off' ? 'SmallWriteOff' : ''); };
  const pickParty = (p: string) => { setPartyId(p); setSources({}); setTargets({}); };
  // ticking a row copies the server's amount; with exactly one row on the other side it is capped to what that row can give (a comparison, not a sum)
  const tick = (which: 'source' | 'target', row: Row, on: boolean) => {
    const [mine, setMine, other, setOther, otherRows] = which === 'source' ? [sources, setSources, targets, setTargets, targetRows] as const : [targets, setTargets, sources, setSources, sourceRows] as const;
    if (!on) { const { [row.id]: _gone, ...rest } = mine; void _gone; setMine(rest); return; }
    const o = Object.keys(other);
    const first = Object.keys(mine).length === 0 && o.length === 1; // one row each side: both take the smaller of the two, so the pair balances
    const amount = first ? smaller(row.max, other[o[0]] || otherRows.find((r) => r.id === o[0])?.max || row.max) : row.max;
    setMine({ ...mine, [row.id]: amount });
    if (first) setOther({ ...other, [o[0]]: amount });
  };

  const input: SettleInput = {
    kind, date, partyId, ...(kind === 'write_off' ? {} : { sources: Object.entries(sources).map(([docId, amount]) => ({ docId, amount })) }),
    targets: Object.entries(targets).map(([docId, amount]) => ({ docId, amount })),
    ...(role && diff ? { difference: { role, amount: diff } } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}),
  };
  const run = useMutation({
    mutationFn: () => endpoints.postSettlement(input, key.current),
    onSuccess: async (s) => { await qc.invalidateQueries({ queryKey: [company] }); onPosted(s); },
  });
  const ready = !!partyId && !!date && Object.keys(targets).length > 0 && (kind === 'write_off' || Object.keys(sources).length > 0) && Object.values({ ...sources, ...targets }).every((a) => a && Number(a) > 0);

  const table = (which: 'source' | 'target', rows: Row[], picked: Picked, set: (p: Picked) => void, label: string) => (
    <section aria-label={label} className="grid gap-1.5">
      <h3 className="text-small font-medium text-muted-foreground">{label}</h3>
      {rows.length === 0 ? <p className="text-muted-foreground">{tf('noRows')}</p> : (
        <div className="overflow-x-auto"><table className="w-full text-body">
          <thead className="text-small text-muted-foreground"><tr><th className="w-8" /><th className="px-2 py-1 text-left font-medium">{tf('number')}</th><th className="px-2 py-1 text-left font-medium">{tf('date')}</th>
            <th className="px-2 py-1 text-right font-medium">{tf(which === 'source' ? 'remaining' : 'outstanding')}</th><th className="px-2 py-1 text-right font-medium">{tf('amount')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="py-1.5 pr-1"><Checkbox aria-label={tf('pick', { number: r.number })} checked={r.id in picked} onCheckedChange={(on) => tick(which, r, on === true)} /></td>
                <td className="px-2 py-1.5 tabular-nums">{r.number}</td><td className="px-2 py-1.5 tabular-nums">{formatDateBE(r.date)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(r.max)}</td>
                <td className="px-2 py-1 text-right">{r.id in picked ? <Input type="text" inputMode="decimal" autoComplete="off" className="min-w-28 text-right tabular-nums" aria-label={tf('amountOf', { number: r.number })} value={picked[r.id]}
                  onChange={(e) => set({ ...picked, [r.id]: cleanDecimal(e.target.value, 2) })} onBlur={() => { if (picked[r.id] && moneyText(picked[r.id]) !== picked[r.id]) set({ ...picked, [r.id]: moneyText(picked[r.id]) }); }} onFocus={(e) => e.target.select()} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{t('formTitle')}</DialogTitle></DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-kind`}>{tf('kind')}</Label>
            <select id={`${id}-kind`} className={selectCls} value={kind} disabled={!!initial} onChange={(e) => reset(e.target.value as SettlementKind)}>
              {KINDS.map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-date`}>{tf('date')}</Label>
            <Input id={`${id}-date`} type="date" value={date} max={me?.businessDate} onChange={(e) => setDate(e.target.value)} />
          </div>
          {kind === 'write_off' ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-side`}>{tf('side')}</Label>
              <select id={`${id}-side`} className={selectCls} value={side} onChange={(e) => { setSide(e.target.value as 'customer' | 'vendor'); setPartyId(''); setTargets({}); }}>
                <option value="customer">{tf('sideCustomer')}</option><option value="vendor">{tf('sideVendor')}</option>
              </select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-party`}>{kind === 'netting' ? tf('pair') : tf('party')}</Label>
            <select id={`${id}-party`} className={selectCls} value={kind === 'netting' ? pair?.customerId ?? '' : partyId} onChange={(e) => pickParty(e.target.value)}>
              <option value="">{tf('choose')}</option>
              {kind === 'netting' ? (deposits.data?.pairs ?? []).map((p) => <option key={p.customerId} value={p.customerId}>{p.customerName} ⇄ {p.vendorName}</option>)
                : kind === 'write_off' ? (parties.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)
                  : depositParties.map(([pid, name]) => <option key={pid} value={pid}>{name}</option>)}
            </select>
          </div>
        </div>
        {partyId ? (
          <>
            {kind === 'write_off' ? null : table('source', sourceRows, sources, setSources, t(`sources.${kind}`))}
            {table('target', targetRows, targets, setTargets, t(`targets.${kind === 'write_off' ? (side === 'vendor' ? 'apply_prepayment' : 'apply_deposit') : kind}`))}
          </>
        ) : <p className="text-muted-foreground">{tf('pickParty')}</p>}
        {kind === 'netting' ? <p className="text-small text-muted-foreground">{tf('nettingHint')}</p> : (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-role`}>{tf('differenceRole')}</Label>
              <select id={`${id}-role`} className={selectCls} value={role} onChange={(e) => setRole(e.target.value as SettlementDifferenceRole | '')}>
                {kind === 'write_off' ? null : <option value="">{tf('noDifference')}</option>}
                {ROLES.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-diff`}>{tf('differenceAmount')}</Label>
              <Input id={`${id}-diff`} type="text" inputMode="decimal" autoComplete="off" className="text-right tabular-nums" disabled={!role} value={diff}
                onChange={(e) => setDiff(cleanDecimal(e.target.value, 2))} onBlur={() => { if (diff && moneyText(diff) !== diff) setDiff(moneyText(diff)); }} />
              <p className="text-small text-muted-foreground">{deposits.data?.tolerance ? tf('tolerance', { rounding: formatMoney(deposits.data.tolerance.rounding), writeOff: formatMoney(deposits.data.tolerance.smallWriteOff) }) : ''}</p>
            </div>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-reason`}>{tf('reason')}</Label>
          <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <p className="text-small text-muted-foreground">{t('vatNote')}</p>
        {run.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{run.error instanceof ApiError ? run.error.problem.title : tf('failed')}</AlertTitle>
            {run.error instanceof ApiError && run.error.problem.detail ? <AlertDescription className="text-foreground!">{run.error.problem.detail}</AlertDescription> : null}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tf('cancel')}</Button>
          <Button disabled={!ready || run.isPending} onClick={() => run.mutate()}>{run.isPending ? tf('submitting') : tf('submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
