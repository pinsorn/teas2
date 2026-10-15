'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import { CLOSEABLE, convertTargets, LIVE, MARKS, SETTLES } from '@/domain/doc-types';
import type { Doc, DocType, MarkKey } from '@/domain/types';
import { settleable } from '../doc-editor/SettlementPanel';

/** A descriptor may list the conversions it allows; the "convert to…" button (and its dialog) exists only for those. */
export type ConvertibleDescriptor = DocDescriptor & { convertsTo?: DocType[] };


/** A disabled action keeps its place and says why (aria-describedby + tooltip), never just goes grey. */
export function Guarded({ why, children }: { why?: string; children: (p: { disabled: boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  if (!why) return <>{children({ disabled: false })}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex">{children({ disabled: true, 'aria-describedby': id })}<span id={id} className="sr-only">{why}</span></span></TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  );
}

/** Marks that have a button today (delivered / sent land with their own screens). */
const MARK_BUTTONS: MarkKey[] = ['accepted', 'rejected', 'delivered'];
const MARK_LABEL = { accepted: 'markAccepted', rejected: 'markRejected', delivered: 'markDelivered', sent: 'markSent' } as const;

export function ActionBar({ descriptor: d, doc, permissions, vatRegistered, onCancel, onConvert, onMark, onCloseRemainder, nothingRemaining }: {
  descriptor: ConvertibleDescriptor; doc: Doc; permissions: string[]; /** The active company's VAT status (conversion targets depend on it). */ vatRegistered: boolean; onCancel: () => void; onConvert?: () => void; onMark?: (mark: MarkKey) => void; onCloseRemainder?: () => void; /** Every line is already converted in full: there is nothing to close. */ nothingRemaining?: boolean;
}) {
  const t = useTranslations('docView.actions');
  const ts = useTranslations('state');
  const routes = routesOf(d);
  const can = (p: string) => permissions.includes(p);
  const missing = (p: string) => (can(p) ? undefined : ts('needPermission', { permission: p }));
  // Edit only needs the right to author this type: the correction plan lists the permissions its steps need and offers the approver path. Cancel stays blocked by filing / settlement / reconciliation locks; a period lock does not block it (SP0 7.5), and edit is never lock-blocked (7.3: the plan decides).
  const blocker = doc.locks.find((l) => l.kind !== 'period');
  const locked = blocker ? t('locked', { reason: blocker.reason }) : undefined;
  const live = LIVE.includes(doc.status);
  const targets = convertTargets(d.convertsTo, vatRegistered, permissions);
  // A receipt is made from open items, never by conversion: a TI / IV with something owed opens it on ?settle=, a billing statement on ?fromBl= (the editor reads the server's outstanding)
  const receiveHref = d.groups && live ? `/sales/receipts/new?fromBl=${doc.id}`
    : SETTLES.RC?.includes(d.type) && live && doc.outstanding !== undefined && settleable(doc.outstanding) ? `/sales/receipts/new?settle=${doc.id}` : undefined;
  const marks = (MARKS[d.type] ?? []).filter((m) => MARK_BUTTONS.includes(m) && !doc.marks?.[m]);

  return (
    <TooltipProvider>
      <div role="group" aria-label={t('label')} className="flex flex-wrap items-center gap-2">
        {doc.status === 'draft' ? (
          <Guarded why={missing(d.permissions.issue)}>
            {(p) => <Button {...p} asChild={!p.disabled}>{p.disabled ? <span>{t('issueDraft')}</span> : <Link href={routes.edit(doc.id)}>{t('issueDraft')}</Link>}</Button>}
          </Guarded>
        ) : doc.status === 'pending' ? (
          <Guarded why={t('whyPending')}>{(p) => <Button {...p}><span>{t('issueDraft')}</span></Button>}</Guarded>
        ) : doc.status === 'approved' ? (
          <Guarded why={missing(d.permissions.issue)}>
            {(p) => <Button {...p} asChild={!p.disabled}>{p.disabled ? <span>{t('issueDraft')}</span> : <Link href={routes.edit(doc.id)}>{t('issueDraft')}</Link>}</Button>}
          </Guarded>
        ) : (
          <Guarded why={live ? missing(d.permissions.create) : doc.status === 'replaced' ? t('whyReplaced') : t('whyCancelled')}>
            {(p) => <Button {...p} asChild={!p.disabled}>{p.disabled ? <span>{t('edit')}</span> : <Link href={routes.edit(doc.id)}>{t('edit')}</Link>}</Button>}
          </Guarded>
        )}
        {doc.status !== 'draft' ? (
          <Guarded why={missing(d.permissions.read)}>
            {(p) => <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t('print')}</span> : <Link href={routes.print(doc.id)}>{t('print')}</Link>}</Button>}
          </Guarded>
        ) : null}
        <Guarded why={missing(d.permissions.create)}>
          {(p) => <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t('copy')}</span> : <Link href={`${routes.create}?copyFrom=${doc.id}`}>{t('copy')}</Link>}</Button>}
        </Guarded>
        {d.convertsTo?.length && live ? (
          <Guarded why={d.type === 'QT' && doc.marks?.rejected ? t('whyRejected') : doc.marks?.closed ? t('whyClosed') : targets.length ? undefined : t('whyNoTarget')}>
            {(p) => <Button {...p} variant="outline" onClick={onConvert}>{t('convert')}</Button>}
          </Guarded>
        ) : null}
        {receiveHref ? (
          <Guarded why={missing('doc.RC.create')}>
            {(p) => <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t('receive')}</span> : <Link href={receiveHref}>{t('receive')}</Link>}</Button>}
          </Guarded>
        ) : null}
        {d.type === 'TI' && live ? (['CN', 'DN'] as const).map((n) => ( // a note is made from the invoice it adjusts (the lines come from the server on ?adjust=)
          <Guarded key={n} why={missing(`doc.${n}.create`) ?? (doc.header.priceIncludesVat ? t('whyInclusiveNote') : undefined)}>
            {(p) => <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t(n === 'CN' ? 'issueCn' : 'issueDn')}</span> : <Link href={`${n === 'CN' ? '/sales/credit-notes' : '/sales/debit-notes'}/new?adjust=${doc.id}`}>{t(n === 'CN' ? 'issueCn' : 'issueDn')}</Link>}</Button>}
          </Guarded>
        )) : null}
        {live && CLOSEABLE.includes(d.type) && !doc.marks?.closed ? (
          <Guarded why={missing(d.permissions.issue) ?? (nothingRemaining ? t('whyNothingRemaining') : undefined)}>
            {(p) => <Button {...p} variant="outline" onClick={onCloseRemainder}>{t('closeRemainder')}</Button>}
          </Guarded>
        ) : null}
        {live ? marks.map((m) => (
          <Guarded key={m} why={missing(d.permissions.issue)}>
            {(p) => <Button {...p} variant="outline" onClick={() => onMark?.(m)}>{t(MARK_LABEL[m])}</Button>}
          </Guarded>
        )) : null}
        {live ? (
          <Guarded why={missing(d.permissions.cancel) ?? locked}>
            {(p) => <Button {...p} variant="outline" onClick={onCancel}>{t('cancel')}</Button>}
          </Guarded>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
