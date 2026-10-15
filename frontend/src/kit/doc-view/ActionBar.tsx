'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import { LIVE, MARKS } from '@/domain/doc-types';
import type { Doc, DocType, MarkKey } from '@/domain/types';

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
const MARK_BUTTONS: MarkKey[] = ['accepted', 'rejected'];

export function ActionBar({ descriptor: d, doc, permissions, onCancel, onConvert, onMark }: {
  descriptor: ConvertibleDescriptor; doc: Doc; permissions: string[]; onCancel: () => void; onConvert?: () => void; onMark?: (mark: MarkKey) => void;
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
  const targets = (d.convertsTo ?? []).filter((x) => can(`doc.${x}.create`));
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
        {targets.length && live ? (
          <Guarded why={d.type === 'QT' && doc.marks?.rejected ? t('whyRejected') : undefined}>
            {(p) => <Button {...p} variant="outline" onClick={onConvert}>{t('convert')}</Button>}
          </Guarded>
        ) : null}
        {live ? marks.map((m) => (
          <Guarded key={m} why={missing(d.permissions.issue)}>
            {(p) => <Button {...p} variant="outline" onClick={() => onMark?.(m)}>{t(m === 'accepted' ? 'markAccepted' : 'markRejected')}</Button>}
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
