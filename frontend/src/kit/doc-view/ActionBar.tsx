'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Guarded } from './Guarded';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import { docListHref } from '@/descriptors';
import { ADJUSTS, CLOSEABLE, convertTargets, DOC_TYPES, LIVE, MARKS, SETTLES } from '@/domain/doc-types';
import type { Doc, DocType, MarkKey } from '@/domain/types';
import { settleable } from '../doc-editor/SettlementPanel';
import { ApprovalActions } from './ApprovalActions';

/** A descriptor may list the conversions it allows; the "convert to…" button (and its dialog) exists only for those. */
export type ConvertibleDescriptor = DocDescriptor & { convertsTo?: DocType[] };


export { Guarded };

/** Marks that have a button. */
const MARK_BUTTONS: MarkKey[] = ['accepted', 'rejected', 'delivered', 'sent'];
const MARK_LABEL = { accepted: 'markAccepted', rejected: 'markRejected', delivered: 'markDelivered', sent: 'markSent' } as const;
/** The notes made from a document (never by conversion): their buttons open the note's editor on `?adjust=<this document>`. */
const NOTE_LABEL = { CN: 'issueCn', DN: 'issueDn', PCN: 'issuePcn', PDN: 'issuePdn' } as const;

export function ActionBar({ descriptor: d, doc, permissions, vatRegistered, companyId = '', onCancel, onConvert, onMark, onCloseRemainder, nothingRemaining, onReprint }: {
  descriptor: ConvertibleDescriptor; doc: Doc; permissions: string[]; /** The active company's VAT status (conversion targets depend on it). */ vatRegistered: boolean; /** The active company: the approval buttons refresh its queries. */ companyId?: string; onCancel: () => void; onConvert?: () => void; onMark?: (mark: MarkKey) => void; onCloseRemainder?: () => void; /** Every line is already converted in full: there is nothing to close. */ nothingRemaining?: boolean; /** The original was printed: the print action asks first (a reprint is a สำเนา). */ onReprint?: () => void;
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
  const system = d.type === 'WT'; // a withholding certificate is written by its voucher: the only thing a person does with it is print it
  const targets = convertTargets(d.convertsTo, vatRegistered, permissions);
  // A receipt is made from open items, never by conversion: a TI / IV with something owed opens it on ?settle=, a billing statement on ?fromBl= (the editor reads the server's outstanding)
  const receiveHref = d.groups && live ? `/sales/receipts/new?fromBl=${doc.id}`
    : SETTLES.RC?.includes(d.type) && live && doc.outstanding !== undefined && settleable(doc.outstanding) ? `/sales/receipts/new?settle=${doc.id}` : undefined;
  const marks = (MARKS[d.type] ?? []).filter((m) => MARK_BUTTONS.includes(m) && !doc.marks?.[m]);

  return (
    <TooltipProvider>
      <div role="group" aria-label={t('label')} className="flex flex-wrap items-center gap-2">
        {system ? null : doc.status === 'draft' ? (
          <Guarded why={missing(d.permissions.issue)}>
            {(p) => <Button {...p} variant={doc.approvalRequired ? 'outline' : 'default'} asChild={!p.disabled}>{p.disabled ? <span>{t(doc.approvalRequired ? 'edit' : 'issueDraft')}</span> : <Link href={routes.edit(doc.id)}>{t(doc.approvalRequired ? 'edit' : 'issueDraft')}</Link>}</Button>}
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
        {!system && (doc.status === 'pending' || doc.status === 'approved' || (doc.status === 'draft' && doc.approvalRequired)) ? <ApprovalActions descriptor={d} doc={doc} permissions={permissions} companyId={companyId} /> : null}
        {doc.status !== 'draft' && DOC_TYPES[d.type].printable && doc.status !== 'pending' && doc.status !== 'approved' ? ( // a vendor's document is recorded, not printed
          <Guarded why={missing(d.permissions.read)}>
            {(p) => (doc.printCount ?? 0) > 0 && !p.disabled
              ? <Button {...p} variant="outline" onClick={onReprint}>{t('print')}</Button>
              : <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t('print')}</span> : <Link href={routes.print(doc.id)}>{t('print')}</Link>}</Button>}
          </Guarded>
        ) : null}
        {system ? null : <Guarded why={missing(d.permissions.create)}>
          {(p) => <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t('copy')}</span> : <Link href={`${routes.create}?copyFrom=${doc.id}`}>{t('copy')}</Link>}</Button>}
        </Guarded>}
        {d.convertsTo?.length && live ? (
          <Guarded why={d.type === 'QT' && doc.marks?.rejected ? t('whyRejected') : doc.marks?.closed ? t('whyClosed') : d.type === 'EX' && doc.outstanding !== undefined && !settleable(doc.outstanding) ? t('whyPaid') : targets.length ? undefined : t('whyNoTarget')}>
            {(p) => <Button {...p} variant="outline" onClick={onConvert}>{t('convert')}</Button>}
          </Guarded>
        ) : null}
        {receiveHref ? (
          <Guarded why={missing('doc.RC.create')}>
            {(p) => <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t('receive')}</span> : <Link href={receiveHref}>{t('receive')}</Link>}</Button>}
          </Guarded>
        ) : null}
        {live ? (['CN', 'DN', 'PCN', 'PDN'] as const).filter((n) => ADJUSTS[n] === d.type && docListHref(n, vatRegistered)).map((n) => ( // a note is made from the document it adjusts (the lines come from the server on ?adjust=)
          <Guarded key={n} why={missing(`doc.${n}.create`) ?? (d.type === 'TI' && doc.header.priceIncludesVat ? t('whyInclusiveNote') : undefined)}>
            {(p) => <Button {...p} variant="outline" asChild={!p.disabled}>{p.disabled ? <span>{t(NOTE_LABEL[n])}</span> : <Link href={`${docListHref(n, vatRegistered)}/new?adjust=${doc.id}`}>{t(NOTE_LABEL[n])}</Link>}</Button>}
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
        {live && !system ? (
          <Guarded why={missing(d.permissions.cancel) ?? locked}>
            {(p) => <Button {...p} variant="outline" onClick={onCancel}>{t('cancel')}</Button>}
          </Guarded>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
