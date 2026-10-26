'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Guarded } from './Guarded';
import { routesOf, type DocDescriptor } from '@/domain/descriptors';
import { docListHref } from '@/descriptors';
import { ADJUSTS, CLOSEABLE, convertTargets, DOC_TYPES, LIVE, MARKS, SETTLES } from '@/domain/doc-types';
import type { Doc, DocType, MarkKey } from '@/domain/types';
import { settleable } from '../doc-editor/SettlementPanel';
import { ApprovalActions } from './ApprovalActions';
import { ScheduleActions } from './ScheduleActions';
import { PayrollActions } from '../payroll/PayRunDialog';
import { ApiError } from '@/lib/api/client';
import { authApi } from '@/records/auth';

/** A descriptor may list the conversions it allows; the "convert to…" button (and its dialog) exists only for those. */
export type ConvertibleDescriptor = DocDescriptor & { convertsTo?: DocType[] };


export { Guarded };

/** Marks that have a button. */
const MARK_BUTTONS: MarkKey[] = ['accepted', 'rejected', 'delivered', 'sent'];
const MARK_LABEL = { accepted: 'markAccepted', rejected: 'markRejected', delivered: 'markDelivered', sent: 'markSent' } as const;
/** The notes made from a document (never by conversion): their buttons open the note's editor on `?adjust=<this document>`. */
const NOTE_LABEL = { CN: 'issueCn', DN: 'issueDn', PCN: 'issuePcn', PDN: 'issuePdn' } as const;

/** HC3 (ruling 5): the public link of an ISSUED printable document. "Copy" makes a NEW random link and copies it (the token is shown once, here); "Revoke" ends every link of the document. A cancelled document's links stop working by themselves. */
function PublicLinkActions({ doc, why }: { doc: Doc; why?: string }) {
  const t = useTranslations('docView.actions');
  const [busy, setBusy] = useState(false);
  const failed = (e: unknown) => toast.error(e instanceof ApiError ? e.problem.title : t('publicLinkFailed'));
  const copy = async () => {
    setBusy(true);
    try {
      const { token } = await authApi.createLink(doc.type, doc.id);
      const url = `${window.location.origin}/p/${token}`;
      try { await navigator.clipboard.writeText(url); toast.success(t('publicLinkCopied')); } catch { toast.message(t('publicLinkCopyFailed', { url })); }
    } catch (e) { failed(e); } finally { setBusy(false); }
  };
  const revoke = async () => {
    setBusy(true);
    try { const { revoked } = await authApi.revokeLinks(doc.type, doc.id); toast.success(revoked ? t('publicLinkRevoked', { count: revoked }) : t('publicLinkNone')); } catch (e) { failed(e); } finally { setBusy(false); }
  };
  return (
    <>
      <Guarded why={why}>{(p) => <Button {...p} variant="outline" disabled={p.disabled || busy} onClick={() => void copy()}>{t('publicLink')}</Button>}</Guarded>
      <Guarded why={why}>{(p) => <Button {...p} variant="outline" disabled={p.disabled || busy} onClick={() => void revoke()}>{t('publicLinkRevoke')}</Button>}</Guarded>
    </>
  );
}

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
  const locked = blocker ? t(blocker.kind === 'reconciliation' ? 'lockedReconciliation' : 'locked', { reason: blocker.reason }) : undefined;
  const live = LIVE.includes(doc.status);
  const system = d.type === 'WT'; // a withholding certificate is written by its voucher: the only thing a person does with it is print it
  const engineMade = system || d.type === 'FA' || d.type === 'DP'; // AC5: an asset / a depreciation run is made and changed by its own commands (the asset panel, the run page), never edited or copied as a document
  const targets = convertTargets(d.convertsTo, vatRegistered, permissions);
  // A receipt is made from open items, never by conversion: a TI / IV with something owed opens it on ?settle=, a billing statement on ?fromBl= (the editor reads the server's outstanding)
  const receiveHref = d.groups && live ? `/sales/receipts/new?fromBl=${doc.id}`
    : SETTLES.RC?.includes(d.type) && live && doc.outstanding !== undefined && settleable(doc.outstanding) ? `/sales/receipts/new?settle=${doc.id}` : undefined;
  const marks = (MARKS[d.type] ?? []).filter((m) => MARK_BUTTONS.includes(m) && !doc.marks?.[m]);

  return (
    <TooltipProvider>
      <div role="group" aria-label={t('label')} className="flex flex-wrap items-center gap-2">
        {engineMade ? null : doc.status === 'draft' ? (
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
          <Guarded why={live ? (doc.locks.some((l) => l.kind === 'reversal') ? t('whyFinal') : doc.header.disposal ? t('whyDisposalInvoice') : d.type === 'PR' && doc.status === 'settled' ? t('whyPayrollPaid') : missing(d.permissions.create)) : doc.status === 'replaced' ? t('whyReplaced') : t('whyCancelled')}>
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
        {live && DOC_TYPES[d.type].printable ? <PublicLinkActions doc={doc} why={missing(d.permissions.read)} /> : null}
        {engineMade ? null : <Guarded why={missing(d.permissions.create)}>
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
          <Guarded key={n} why={missing(`doc.${n}.create`) ?? (doc.header.disposal ? t('whyDisposalInvoice') : d.type === 'TI' && doc.header.priceIncludesVat ? t('whyInclusiveNote') : undefined)}>
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
        {d.type === 'PR' && live ? <PayrollActions doc={doc} permissions={permissions} needPermission={(permission) => ts('needPermission', { permission })} /> : null}
        {live && !engineMade ? <ScheduleActions doc={doc} permissions={permissions} /> : null}
        {live && !system ? (
          <Guarded why={missing(d.permissions.cancel) ?? locked}>
            {(p) => <Button {...p} variant="outline" onClick={onCancel}>{t('cancel')}</Button>}
          </Guarded>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
