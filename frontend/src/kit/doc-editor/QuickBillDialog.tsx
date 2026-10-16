'use client';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Doc, TaxCode } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { EXPENSE_CATEGORY_CODES } from '@/records/items';
import { cleanDecimal, moneyText } from './useLineGridKeys';

export interface QuickBillSeed { description?: string; amount?: string; taxCode?: TaxCode; category?: string; whtTypeCode?: string }

const selectCls = 'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-body';

/** D-16: a payment voucher cannot carry input VAT, so the vendor's tax invoice is recorded as a purchase bill (PB) through the SAME API as the bill screen - every purchase rule (vendor VAT status at issue,
 *  ม.82/5, the claim window from the vendor's document date, the category) is the server's - and the voucher then pays it: the caller appends an allocation of the bill's total. */
export function QuickBillDialog({ open, onClose, partyId, partyName, seed, onCreated }: {
  open: boolean; onClose: () => void; partyId: string; partyName: string; seed?: QuickBillSeed; onCreated: (bill: Doc) => void;
}) {
  const t = useTranslations('docEditor.quickBill');
  const tc = useTranslations('records.options.expenseCategory');
  const tx = useTranslations('docEditor.lines.taxCode');
  const tp = useTranslations('problem');
  const { me } = useMe();
  const id = useId();
  const today = me?.businessDate ?? '';
  const key = useRef(crypto.randomUUID());
  const [number, setNumber] = useState('');
  const [vendorDate, setVendorDate] = useState(today);
  const [description, setDescription] = useState(seed?.description ?? '');
  const [amount, setAmount] = useState(seed?.amount ?? '');
  const [taxCode, setTaxCode] = useState<TaxCode>(seed?.taxCode && seed.taxCode !== 'Z0' ? seed.taxCode : 'S7');
  const [category, setCategory] = useState(seed?.category ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const ok = !busy && Number(amount) > 0 && !!description.trim();

  const save = async () => {
    setBusy(true); setError(undefined);
    let draft: Doc | undefined;
    try {
      draft = await endpoints.createDoc('PB', {
        header: { partyId, documentDate: today, ...(number.trim() ? { vendorDocNumber: number.trim() } : {}), ...(vendorDate ? { vendorDocDate: vendorDate } : {}) },
        lines: [{ id: 'qb-1', description: description.trim(), qty: '1', unit: 'รายการ', unitPrice: moneyText(amount), taxCode, ...(category ? { expenseCategory: category } : {}), ...(seed?.whtTypeCode ? { whtTypeCode: seed.whtTypeCode } : {}) }],
      }, key.current);
      const bill = await endpoints.issueDoc('PB', draft.id, draft.version);
      onCreated(bill);
    } catch (e) {
      if (draft) void endpoints.deleteDoc('PB', draft.id, draft.version).catch(() => undefined); // never leave a half-made bill behind: the refusal is shown, the next try starts clean
      key.current = crypto.randomUUID();
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('body')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3">
          <p className="text-body"><span className="text-muted-foreground">{t('vendor')} </span><span className="font-medium" data-field="quick-vendor">{partyName}</span></p>
          <div className="grid gap-1.5"><Label htmlFor={`${id}-no`}>{t('vendorDocNumber')}</Label>
            <Input id={`${id}-no`} autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor={`${id}-date`}>{t('vendorDocDate')}</Label>
            <Input id={`${id}-date`} type="date" max={today || undefined} value={vendorDate} onChange={(e) => setVendorDate(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor={`${id}-desc`}>{t('description')}</Label>
            <Input id={`${id}-desc`} autoComplete="off" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label htmlFor={`${id}-amt`}>{t('amount')}</Label>
              <Input id={`${id}-amt`} type="text" inputMode="decimal" autoComplete="off" className="text-right tabular-nums" value={amount}
                onChange={(e) => setAmount(cleanDecimal(e.target.value, 2))} onBlur={() => { if (amount && moneyText(amount) !== amount) setAmount(moneyText(amount)); }} onFocus={(e) => e.target.select()} /></div>
            <div className="grid gap-1.5"><Label htmlFor={`${id}-tax`}>{t('taxCode')}</Label>
              <select id={`${id}-tax`} className={selectCls} value={taxCode} onChange={(e) => setTaxCode(e.target.value as TaxCode)}>
                {(['S7', 'EX'] as const).map((c) => <option key={c} value={c}>{tx(c)}</option>)}
              </select></div>
          </div>
          <div className="grid gap-1.5"><Label htmlFor={`${id}-cat`}>{t('category')}</Label>
            <select id={`${id}-cat`} className={selectCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{t('categoryNone')}</option>
              {EXPENSE_CATEGORY_CODES.map((c) => <option key={c} value={c}>{tc(c)}</option>)}
            </select></div>
        </div>
        {error ? <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('back')}</AlertDialogCancel>
          <Button type="button" disabled={!ok} onClick={() => void save()}>{busy ? t('saving') : t('save')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
