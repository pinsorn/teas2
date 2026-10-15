'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { convertTargets } from '@/domain/doc-types';
import type { Doc, DocType } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';

const selectCls = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none';
/** What a typed quantity means (text only, no float arithmetic): blank / zero drops the line, digits convert, anything else (negative, exponent, letters) is a field error. The server judges the rest. */
const qtyKind = (q: string): 'drop' | 'ok' | 'invalid' => {
  const v = q.trim();
  if (v === '') return 'drop';
  if (!/^\d*\.?\d*$/.test(v) || v === '.') return 'invalid';
  return /[1-9]/.test(v) ? 'ok' : 'drop';
};

/** Convert an issued document into a draft of another type, taking part of each line. The server owns the remaining quantity and refuses an over-conversion. */
export function ConvertDialog({ source, targets, onDone, onClose }: { source: Doc; targets: DocType[]; onDone: (created: Doc) => void; onClose: () => void }) {
  const t = useTranslations('docView.convertDialog');
  const td = useTranslations('docTypes');
  const qc = useQueryClient();
  const id = useId();
  const { me } = useMe();
  const companyId = me?.activeCompanyId ?? '';
  const allowed = me ? convertTargets(targets, me.vatRegistered, me.permissions) : [];
  const [picked, setPicked] = useState<DocType>();
  const target = picked && allowed.includes(picked) ? picked : allowed[0];
  const [typed, setTyped] = useState<Record<string, string>>({});
  const rem = useQuery({ queryKey: qk.remaining(companyId, source.type, source.id), queryFn: () => endpoints.getRemaining(source.type, source.id), enabled: !!me });
  const qtyOf = (lineId: string, remaining: string) => typed[lineId] ?? remaining;
  const kinds = (rem.data ?? []).map((l) => qtyKind(qtyOf(l.lineId, l.remaining)));
  const chosen = (rem.data ?? []).filter((_, i) => kinds[i] === 'ok');
  const invalid = kinds.includes('invalid');

  const create = useMutation({
    mutationFn: () => endpoints.convertDoc(source.type, source.id, target!, chosen.map((l) => ({ sourceLineId: l.lineId, qty: qtyOf(l.lineId, l.remaining).trim() }))),
    onSuccess: async (created) => { await qc.invalidateQueries({ queryKey: [companyId] }); onDone(created); },
  });
  const title = td(`${source.type}.title`);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title', { doc: `${title} ${source.number ?? ''}`.trim() })}</DialogTitle>
          <DialogDescription>{t('body')}</DialogDescription>
        </DialogHeader>
        {!target ? <Alert role="status"><AlertTitle>{t('noTarget')}</AlertTitle></Alert> : (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-target`}>{t('target')}</Label>
              <select id={`${id}-target`} className={selectCls} value={target} onChange={(e) => { setPicked(e.target.value as DocType); create.reset(); }}>
                {allowed.map((x) => <option key={x} value={x}>{td(`${x}.title`)}</option>)}
              </select>
            </div>
            {rem.isError ? <Alert variant="destructive"><AlertTitle>{t('loadFailed')}</AlertTitle></Alert> : (
              <Table>
                <TableHeader><TableRow>
                  <TableHead>{t('colItem')}</TableHead><TableHead>{t('colUnit')}</TableHead>
                  <TableHead className="text-end">{t('colOrdered')}</TableHead><TableHead className="text-end">{t('colConverted')}</TableHead>
                  <TableHead className="text-end">{t('colRemaining')}</TableHead><TableHead className="text-end">{t('colQty')}</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {(rem.data ?? []).map((l, n) => (
                    <TableRow key={l.lineId}>
                      <TableCell className="whitespace-normal">{l.description}</TableCell><TableCell>{l.unit}</TableCell>
                      <TableCell className="text-end tabular-nums">{l.ordered}</TableCell><TableCell className="text-end tabular-nums">{l.converted}</TableCell>
                      <TableCell className="text-end tabular-nums">{l.remaining}</TableCell>
                      <TableCell className="text-end">
                        <Input type="number" inputMode="decimal" min="0" step="any" className="w-28 text-end tabular-nums" aria-label={t('qty', { n: n + 1 })}
                          aria-invalid={kinds[n] === 'invalid'} aria-describedby={kinds[n] === 'invalid' ? `${id}-bad-${n}` : undefined}
                          value={qtyOf(l.lineId, l.remaining)} onChange={(e) => { setTyped((s) => ({ ...s, [l.lineId]: e.target.value })); create.reset(); }} />
                        {kinds[n] === 'invalid' ? <p id={`${id}-bad-${n}`} role="alert" className="mt-1 text-small text-destructive">{t('badQty')}</p> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
        {create.error ? <Alert variant="destructive"><AlertTitle>{create.error instanceof ApiError ? create.error.problem.title : create.error.message}</AlertTitle></Alert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('close')}</Button>
          <Button type="button" disabled={!target || invalid || !chosen.length || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? t('creating') : t('create', { target: target ? td(`${target}.title`) : '' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
