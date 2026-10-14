'use client';
import { useTranslations } from 'next-intl';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { ComputeResult, DocLine, PartySummary } from '@/domain/types';
import { formatMoney } from '@/lib/format';

function Paper({ party, lines, compute }: { party?: PartySummary; lines: DocLine[]; compute?: ComputeResult }) {
  const t = useTranslations('docEditor');
  return (
    <div className="grid gap-3 rounded-lg bg-card p-4 text-body ring-1 ring-foreground/10">
      <p className="font-semibold">{party?.name ?? '—'}</p>
      <ul className="grid gap-1">
        {lines.filter((l) => l.description.trim()).map((l) => (
          <li key={l.id} className="flex justify-between gap-3"><span>{l.description} × {l.qty}</span>
            <span className="tabular-nums">{compute ? formatMoney(compute.lines.find((x) => x.id === l.id)?.net ?? '0') : ''}</span></li>
        ))}
      </ul>
      {compute && (
        <div className="grid gap-1 border-t border-border pt-2">
          <p className="flex justify-between"><span>{t('totals.net')}</span><span className="tabular-nums">{formatMoney(compute.totals.net)}</span></p>
          <p className="flex justify-between"><span>{t('totals.vat')}</span><span className="tabular-nums">{formatMoney(compute.totals.vat)}</span></p>
          <p className="flex justify-between font-semibold"><span>{t('totals.totalLabel')}</span><span className="tabular-nums">{formatMoney(compute.totals.total)}</span></p>
          <p className="text-small text-muted-foreground">{compute.totals.amountInWords}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Side preview. At 1700 px and wider it is docked next to the form (a modal sheet would block editing); below that it
 * is a right-side sheet, closed by default. Task 13's PaperModel replaces the body; for now it shows the server's numbers.
 */
export function PreviewDrawer({ open, onOpenChange, docked, party, lines, compute }: {
  open: boolean; onOpenChange: (o: boolean) => void; docked: boolean; party?: PartySummary; lines: DocLine[]; compute?: ComputeResult;
}) {
  const t = useTranslations('docEditor');
  if (docked) return open ? <aside aria-label={t('previewTitle')} className="min-w-0"><Paper party={party} lines={lines} compute={compute} /></aside> : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto">
        <SheetHeader><SheetTitle>{t('previewTitle')}</SheetTitle><SheetDescription>{t('previewBody')}</SheetDescription></SheetHeader>
        <div className="px-4 pb-4"><Paper party={party} lines={lines} compute={compute} /></div>
      </SheetContent>
    </Sheet>
  );
}
