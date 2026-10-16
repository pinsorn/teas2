'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { DocDescriptor } from '@/domain/descriptors';
import type { Doc } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { Guarded } from './Guarded';

/** Send back needs a reason (§7.6): the author sees it on the timeline as "ส่งกลับแก้ไข: <reason>". The server's refusal is shown in place. */
function SendBackDialog({ docLabel, busy, error, onConfirm, onCancel }: { docLabel: string; busy?: boolean; error?: unknown; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const t = useTranslations('docView.approval');
  const tp = useTranslations('problem');
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('sendBackTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('sendBackBody', { doc: docLabel })}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-reason`}>{t('reason')}</Label>
          <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error ? <Alert variant="destructive"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          <Button type="button" disabled={busy || !reason.trim()} onClick={() => onConfirm(reason.trim())}>{t('sendBackConfirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The approval buttons of a document view (§7.6), by state. Everything here is a request: the server decides and its refusal is shown as is.
 *  draft (the policy wants approval): a person who cannot approve submits; one who holds approve + issue approves and issues in one action.
 *  pending: approve, approve-and-issue (both rights), send back. approved: send back (issuing is the edit/issue button of the bar).
 * Rendered inside the action bar's group; the error and notes take a full row.
 */
export function ApprovalActions({ descriptor: d, doc, permissions, companyId }: { descriptor: DocDescriptor; doc: Doc; permissions: string[]; companyId: string }) {
  const t = useTranslations('docView.actions');
  const ts = useTranslations('state');
  const ta = useTranslations('docView.approval');
  const tp = useTranslations('problem');
  const qc = useQueryClient();
  const [backOpen, setBackOpen] = useState(false);
  const can = (p: string) => permissions.includes(p);
  const canApprove = can(`doc.${d.type}.approve`), canIssue = can(d.permissions.issue);
  const refresh = () => qc.invalidateQueries({ queryKey: [companyId] });
  const after = {
    onSuccess: async () => { await refresh(); setBackOpen(false); },
    onError: (e: unknown) => { if (e instanceof ApiError && e.code === 'doc.version_conflict') void refresh(); }, // stale version: reload so a retry sends the current one
  };
  const submit = useMutation({ ...after, mutationFn: () => endpoints.submitDoc(d.type, doc.id, doc.version) });
  const approve = useMutation({ ...after, mutationFn: () => endpoints.approveDoc(d.type, doc.id, doc.version) });
  const approveIssue = useMutation({ ...after, mutationFn: () => endpoints.approveAndIssueDoc(d.type, doc.id, doc.version) });
  const sendBack = useMutation({ ...after, mutationFn: (reason: string) => endpoints.sendBackDoc(d.type, doc.id, doc.version, reason) });
  const busy = submit.isPending || approve.isPending || approveIssue.isPending || sendBack.isPending;
  const error = submit.error ?? approve.error ?? approveIssue.error;
  const both = canApprove && canIssue;
  const label = `${doc.type} ${doc.number ?? ''}`.trim();

  const submitBtn = (
    <Guarded why={can(d.permissions.create) ? undefined : ts('needPermission', { permission: d.permissions.create })}>
      {(p) => <Button {...p} disabled={p.disabled || busy} onClick={() => { submit.reset(); submit.mutate(); }}>{t('submit')}</Button>}
    </Guarded>
  );
  const approveIssueBtn = (
    <Button disabled={busy} onClick={() => { approveIssue.reset(); approveIssue.mutate(); }}>{t('approveAndIssue')}</Button>
  );

  return (
    <>
      {doc.status === 'draft' ? (both ? approveIssueBtn : submitBtn) : null}
      {doc.status === 'pending' ? (
        <>
          <Guarded why={canApprove ? undefined : ts('needPermission', { permission: `doc.${d.type}.approve` })}>
            {(p) => <Button {...p} disabled={p.disabled || busy} onClick={() => { approve.reset(); approve.mutate(); }}>{t('approve')}</Button>}
          </Guarded>
          {both ? <Button variant="outline" disabled={busy} onClick={() => { approveIssue.reset(); approveIssue.mutate(); }}>{t('approveAndIssue')}</Button> : null}
        </>
      ) : null}
      {(doc.status === 'pending' || doc.status === 'approved') ? (
        <Guarded why={canApprove ? undefined : ts('needPermission', { permission: `doc.${d.type}.approve` })}>
          {(p) => <Button {...p} variant="outline" disabled={p.disabled || busy} onClick={() => { sendBack.reset(); setBackOpen(true); }}>{t('sendBack')}</Button>}
        </Guarded>
      ) : null}
      <p className="basis-full text-small text-muted-foreground" data-testid="approval-note">
        {doc.status === 'pending' ? ta('pendingNote') : doc.status === 'approved' ? ta('approvedNote') : doc.status === 'draft' ? ta('requiredNote') : ''}
        {doc.approval ? ` · ${ta('trail', { by: doc.approval.submittedBy.name })}` : ''}{doc.approval?.approvedBy ? ` · ${ta('trailApproved', { by: doc.approval.approvedBy.name })}` : ''}
      </p>
      {error ? <Alert variant="destructive" role="alert" className="basis-full"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
      {backOpen ? <SendBackDialog docLabel={label} busy={sendBack.isPending} error={sendBack.error} onCancel={() => setBackOpen(false)} onConfirm={(r) => sendBack.mutate(r)} /> : null}
    </>
  );
}
