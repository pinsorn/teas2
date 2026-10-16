'use client';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { inputVatExpired } from '@/domain/claim-window';
import type { DocLine, VendorInvoice } from '@/domain/types';
import { isBlankLine } from './LineGrid';

const BLANK: VendorInvoice = { vendorName: '', vendorTin: '', number: '', date: '' };

/**
 * EX: the vendor tax invoice behind each line that carries VAT (ม.82/3, ม.86/4). All four details or none - the server judges (a half-filled one is refused, an empty one means the VAT is cost).
 * The editor only warns when the invoice date is already past its claim window; the server decides what is claimed.
 */
export function VendorInvoiceFields({ lines, documentDate, onChange }: { lines: DocLine[]; documentDate: string; onChange: (lines: DocLine[]) => void }) {
  const t = useTranslations('docEditor.vendorInvoice');
  const id = useId();
  const taxed = lines.map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => l.taxCode === 'S7' && !isBlankLine(l));
  if (!taxed.length) return null;
  const set = (lineId: string, k: keyof VendorInvoice, v: string) =>
    onChange(lines.map((l) => (l.id === lineId ? { ...l, vendorInvoice: { ...(l.vendorInvoice ?? BLANK), [k]: v } } : l)));
  return (
    <section aria-labelledby={`${id}-t`} className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <h2 id={`${id}-t`} className="text-section font-semibold">{t('title')}</h2>
      <p className="text-small text-muted-foreground">{t('hint')}</p>
      {taxed.map(({ l, n }) => {
        const v = l.vendorInvoice ?? BLANK;
        const field = (k: keyof VendorInvoice, extra: Record<string, unknown> = {}) => (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-${l.id}-${k}`}>{t(k)}<span className="sr-only"> {n}</span></Label>
            <Input id={`${id}-${l.id}-${k}`} autoComplete="off" value={v[k]} onChange={(e) => set(l.id, k, e.target.value)} {...extra} />
          </div>
        );
        return (
          <fieldset key={l.id} className="m-0 grid gap-2 border-0 p-0">
            <legend className="mb-1 text-body font-medium">{t('line', { n, description: l.description })}</legend>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {field('vendorName')}
              {field('vendorTin', { inputMode: 'numeric', maxLength: 13 })}
              {field('number')}
              {field('date', { type: 'date', max: documentDate || undefined })}
            </div>
            {v.date && documentDate && inputVatExpired(documentDate, v.date) ? <Badge variant="outline" data-testid="line-invoice-expired" className="w-fit">{t('expired')}</Badge> : null}
          </fieldset>
        );
      })}
    </section>
  );
}
