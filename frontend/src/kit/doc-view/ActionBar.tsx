'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import type { Doc, DocType } from '@/domain/types';

/** A descriptor may list the conversions it allows; none of the SP1 descriptors do yet, so the menu stays hidden. */
export type ConvertibleDescriptor = DocDescriptor & { convertsTo?: DocType[] };

const LIVE = ['issued', 'partly_settled', 'settled'];

/** A disabled action keeps its place and says why (aria-describedby + tooltip), never just goes grey. */
function Guarded({ why, children }: { why?: string; children: (p: { disabled: boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  if (!why) return <>{children({ disabled: false })}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex">{children({ disabled: true, 'aria-describedby': id })}<span id={id} className="sr-only">{why}</span></span></TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  );
}

export function ActionBar({ descriptor: d, doc, permissions, onCancel, onConvert }: {
  descriptor: ConvertibleDescriptor; doc: Doc; permissions: string[]; onCancel: () => void; onConvert?: (target: DocType) => void;
}) {
  const t = useTranslations('docView.actions');
  const ts = useTranslations('state');
  const routes = routesOf(d);
  const can = (p: string) => permissions.includes(p);
  const missing = (p: string) => (can(p) ? undefined : ts('needPermission', { permission: p }));
  const locked = doc.locks.length > 0 ? t('locked') : undefined;
  const live = LIVE.includes(doc.status);
  const targets = (d.convertsTo ?? []).filter((x) => can(`doc.${x}.create`));

  return (
    <TooltipProvider>
      <div role="group" aria-label={t('label')} className="flex flex-wrap items-center gap-2">
        {doc.status === 'draft' ? (
          <Guarded why={missing(d.permissions.issue)}>
            {(p) => <Button {...p} asChild={!p.disabled}>{p.disabled ? <span>{t('issueDraft')}</span> : <Link href={routes.edit(doc.id)}>{t('issueDraft')}</Link>}</Button>}
          </Guarded>
        ) : live ? (
          <Guarded why={missing(d.permissions.correct) ?? locked}>
            {(p) => <Button {...p} asChild={!p.disabled}>{p.disabled ? <span>{t('edit')}</span> : <Link href={routes.edit(doc.id)}>{t('edit')}</Link>}</Button>}
          </Guarded>
        ) : null}
        {doc.status !== 'draft' ? (
          <Button variant="outline" asChild><Link href={routes.print(doc.id)}>{t('print')}</Link></Button>
        ) : null}
        <Guarded why={missing(d.permissions.create)}>
          {(p) => <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t('copy')}</span> : <Link href={`${routes.create}?copyFrom=${doc.id}`}>{t('copy')}</Link>}</Button>}
        </Guarded>
        {targets.length && live ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline">{t('convert')}</Button></DropdownMenuTrigger>
            <DropdownMenuContent>{targets.map((x) => <DropdownMenuItem key={x} onSelect={() => onConvert?.(x)}>{x}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {live ? (
          <Guarded why={missing(d.permissions.cancel) ?? locked}>
            {(p) => <Button {...p} variant="outline" onClick={onCancel}>{t('cancel')}</Button>}
          </Guarded>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
