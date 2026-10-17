'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Doc, PayrollSlip } from '@/domain/types';
import { formatDateBE, formatMoney } from '@/lib/format';

/** One employee's payslip beside the run: the six figures, the year to date and the proration, all read from the STORED slip (the frontend never computes). Print opens the A5 slip of this employee alone. */
export function PayslipDrawer({ doc, slip, onClose }: { doc: Doc; slip: PayrollSlip; onClose: () => void }) {
  const t = useTranslations('payrollPay.drawer');
  const figures = [['gross', slip.gross], ['pit', slip.pit], ['sso', slip.sso], ['otherDeduction', slip.otherDeduction], ['ssoEmployer', slip.ssoEmployer], ['net', slip.net]] as const;
  const ytd = [['ytdIncome', slip.ytdIncome], ['ytdPit', slip.ytdPit], ['ytdSso', slip.ytdSso]] as const;
  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="overflow-y-auto data-[side=right]:sm:max-w-md" data-testid="payslip-drawer">
        <SheetHeader><SheetTitle>{t('title', { name: slip.name })}</SheetTitle><SheetDescription>{t('description', { period: formatDateBE(`${slip.month}-01`).replace(/^\d+ /, '') })}</SheetDescription></SheetHeader>
        <div className="grid gap-4 px-4 pb-4">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-body">
            {figures.map(([k, v]) => (
              <div key={k} className={`contents ${k === 'net' ? 'font-semibold' : ''}`}>
                <dt className={k === 'net' ? 'border-t border-foreground pt-2' : 'text-muted-foreground'}>{t(k)}</dt>
                <dd className={`text-right tabular-nums ${k === 'net' ? 'border-t border-foreground pt-2' : ''}`} data-testid={`slip-${k}`}>{formatMoney(v)}</dd>
              </div>
            ))}
          </dl>
          {slip.proratedDays !== undefined ? <p className="text-small text-muted-foreground">{t('prorated', { days: slip.proratedDays, total: slip.daysInMonth })}</p> : null}
          <section aria-label={t('ytdTitle')} className="rounded-lg bg-muted/40 p-3">
            <h3 className="mb-1 text-small font-semibold">{t('ytdTitle')}</h3>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
              {ytd.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{t(k)}</dt><dd className="text-right tabular-nums" data-testid={`slip-${k}`}>{formatMoney(v)}</dd></div>)}
            </dl>
          </section>
          <p className="text-small text-muted-foreground">{t('note')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('close')}</Button>
            <Button asChild><a href={`/print/PR/${encodeURIComponent(doc.id)}?employee=${encodeURIComponent(slip.employeeId)}`} target="_blank" rel="noopener">{t('print')}</a></Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
