'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMe } from '@/app-shell/useMe';
import type { DocType } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatMoney } from '@/lib/format';
import { categoryApi } from '@/records/expense-categories';
import { type PostingPreviewResult, postingApi } from '@/records/posting-rules';

const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none';
/** The documents that post by the roles (the server refuses any other). A sale picks a customer, a purchase a vendor. */
export const PREVIEW_TYPES: { type: DocType; side: 'sales' | 'purchase' }[] = [
  { type: 'TI', side: 'sales' }, { type: 'IV', side: 'sales' }, { type: 'RC', side: 'sales' }, { type: 'DN', side: 'sales' }, { type: 'CN', side: 'sales' },
  { type: 'PB', side: 'purchase' }, { type: 'PV', side: 'purchase' }, { type: 'PDN', side: 'purchase' }, { type: 'PCN', side: 'purchase' }, { type: 'EX', side: 'purchase' },
];

/** "ทดสอบการลงบัญชี": pick a document type and (optionally) an item, an expense category, a party; the server posts a sample line through the SAME resolver the issue uses and says which rule won for each role. Writes nothing. */
export function PostingPreview() {
  const t = useTranslations('settings.posting.preview');
  const tr = useTranslations('settings.posting.roleNames');
  const { me } = useMe();
  const co = me?.activeCompanyId ?? '';
  const [type, setType] = useState<DocType>('TI');
  const [itemId, setItemId] = useState('');
  const [category, setCategory] = useState('');
  const [partyId, setPartyId] = useState('');
  const side = PREVIEW_TYPES.find((p) => p.type === type)!.side;
  const items = useQuery({ queryKey: [co, 'preview', 'items'], queryFn: () => endpoints.listRecords('item', { limit: 200 }), enabled: !!me });
  const cats = useQuery({ queryKey: [co, 'expense-categories'], queryFn: categoryApi.list, enabled: !!me });
  const parties = useQuery({ queryKey: [co, 'preview', side === 'sales' ? 'customer' : 'vendor'], queryFn: () => endpoints.listRecords(side === 'sales' ? 'customer' : 'vendor', { limit: 200 }), enabled: !!me && type !== 'EX' });
  const run = useMutation({ mutationFn: () => postingApi.preview({ docType: type, ...(itemId ? { itemId } : {}), ...(category && side === 'purchase' ? { expenseCategory: category } : {}), ...(partyId && type !== 'EX' ? { partyId } : {}) }) });
  const res: PostingPreviewResult | undefined = run.data;
  const label = (r: Record<string, unknown>) => `${String(r.code ?? r.id)} ${String(r.name ?? '')}`.trim();
  return (
    <div className="grid gap-4">
      <p className="text-body text-muted-foreground">{t('lead')}</p>
      <form noValidate className="grid gap-3 rounded-lg border bg-card p-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <div className="grid gap-1.5">
          <Label htmlFor="pv-type">{t('docType')}</Label>
          <select id="pv-type" className={select} value={type} onChange={(e) => { setType(e.target.value as DocType); setPartyId(''); }}>
            {PREVIEW_TYPES.map((p) => <option key={p.type} value={p.type}>{p.type}</option>)}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pv-item">{t('item')}</Label>
          <select id="pv-item" className={select} value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">{t('none')}</option>
            {items.data?.items.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
          </select>
        </div>
        {side === 'purchase' ? (
          <div className="grid gap-1.5">
            <Label htmlFor="pv-cat">{t('category')}</Label>
            <select id="pv-cat" className={select} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('none')}</option>
              {cats.data?.items.map((c) => <option key={c.code} value={c.code}>{c.nameTh}</option>)}
            </select>
          </div>
        ) : null}
        {type !== 'EX' ? (
          <div className="grid gap-1.5">
            <Label htmlFor="pv-party">{t('party')}</Label>
            <select id="pv-party" className={select} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
              <option value="">{t('none')}</option>
              {parties.data?.items.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
            </select>
          </div>
        ) : null}
        <div className="flex items-end justify-end md:col-span-2"><Button type="submit" disabled={run.isPending}>{run.isPending ? t('running') : t('run')}</Button></div>
      </form>
      {run.isError ? <Alert variant="destructive" role="alert"><AlertTitle>{run.error instanceof ApiError ? run.error.problem.title : t('failed')}</AlertTitle></Alert> : null}
      {res ? (
        <div className="grid gap-4" data-testid="preview-result">
          {res.missing.length ? <Alert role="status"><AlertTitle>{t('missing')}</AlertTitle><ul className="list-disc ps-5 text-body">{res.missing.map((m) => <li key={m}>{m}</li>)}</ul></Alert> : null}
          <section aria-labelledby="pv-winners" className="grid gap-2">
            <h2 id="pv-winners" className="text-section font-semibold">{t('winners')}</h2>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <TableHeader><TableRow><TableHead>{t('role')}</TableHead><TableHead>{t('rule')}</TableHead><TableHead>{t('account')}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {res.winners.map((w) => (
                    <TableRow key={w.role} data-role={w.role}>
                      <TableCell>{tr(w.role)} <span className="text-small text-muted-foreground">({w.role})</span></TableCell>
                      <TableCell>{w.rule.replace(/: \w+ → \S+$/, '')}</TableCell>
                      <TableCell className="tabular-nums">{w.accountCode} {w.accountName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
          <section aria-labelledby="pv-journal" className="grid gap-2">
            <h2 id="pv-journal" className="text-section font-semibold">{t('journal')}</h2>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <TableHeader><TableRow><TableHead>{t('account')}</TableHead><TableHead className="text-right">{t('debit')}</TableHead><TableHead className="text-right">{t('credit')}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(res.journal.entries[0]?.lines ?? []).map((l, i) => (
                    <TableRow key={i}>
                      <TableCell className="tabular-nums">{l.accountCode} {l.accountName}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.debit === '0.00' ? '' : formatMoney(l.debit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.credit === '0.00' ? '' : formatMoney(l.credit)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
