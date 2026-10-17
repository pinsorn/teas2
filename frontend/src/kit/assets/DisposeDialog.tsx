'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { Doc } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { todayIso } from '@/lib/format';
import { MoneyField, PartySelect, selectCls } from '../opening/fields';
import { FormRow, Problem, fieldError } from '../schedules/ScheduleDialogs';

/** "จำหน่าย": a sale (a tax invoice - an invoice for a non-VAT company - to the buyer, issued by the same command) or a write-off. The server freezes cost, accumulated, NBV and gain / loss at this moment and refuses the rest in place. */
export function DisposeDialog({ asset, onClose }: { asset: Doc; onClose: () => void }) {
  const t = useTranslations('assets.dispose');
  const id = useId();
  const qc = useQueryClient();
  const { me } = useMe();
  const [kind, setKind] = useState<'sale' | 'write_off'>('sale');
  const [date, setDate] = useState(me?.businessDate ?? todayIso());
  const [proceeds, setProceeds] = useState('');
  const [buyerId, setBuyerId] = useState('');
  const go = useMutation({
    mutationFn: () => endpoints.disposeAsset(asset.id, { version: asset.version, date, kind, ...(kind === 'sale' ? { proceeds, buyerId } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId] }); onClose(); },
  });
  const sale = kind === 'sale';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('title', { asset: `${asset.number ?? ''} ${asset.asset?.name ?? ''}`.trim() })}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
          <FormRow label={t('kind')} htmlFor={`${id}-kind`}>
            <select id={`${id}-kind`} className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="sale">{t('sale')}</option><option value="write_off">{t('writeOff')}</option>
            </select>
          </FormRow>
          <FormRow label={t('date')} htmlFor={`${id}-date`} error={fieldError(go.error, 'date')}><Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormRow>
          {sale ? (
            <>
              <FormRow label={t('buyer')} htmlFor={`${id}-buyer`}><PartySelect kind="customer" label={t('buyer')} value={buyerId} onChange={setBuyerId} /></FormRow>
              <FormRow label={t('proceeds')} htmlFor={`${id}-proceeds`} error={fieldError(go.error, 'proceeds')}><MoneyField label={t('proceeds')} value={proceeds} onChange={setProceeds} /></FormRow>
              <p className="text-small text-muted-foreground">{t(me?.vatRegistered ? 'saleBodyVat' : 'saleBody')}</p>
            </>
          ) : <p className="text-small text-muted-foreground">{t('writeOffBody')}</p>}
          <Problem error={go.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t('back')}</Button>
            <Button type="submit" disabled={go.isPending || !date || (sale && (!buyerId || !proceeds))}>{go.isPending ? t('saving') : t('submit')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
