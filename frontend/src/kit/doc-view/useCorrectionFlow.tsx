'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertTitle } from '@/components/ui/alert';
import type { DocDescriptor } from '@/domain/descriptors';
import type { CorrectionPlan, Doc } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints, type DocInput } from '@/lib/api/endpoints';
import { CorrectionPlanDialog } from '../dialogs/CorrectionPlanDialog';
import { docHref } from './ChainPanel';

/**
 * Glue for revise mode: the editor's `onRevisionRequested(proposed)` calls `request`, which fetches the plan and opens the dialog.
 * Confirming runs the whole plan (all or nothing on the server) and lands on the newest affected document of the same type.
 * `ui` must be rendered by the host screen.
 */
export function useCorrectionFlow(d: DocDescriptor, doc: Doc) {
  const t = useTranslations('docView.plan');
  const tp = useTranslations('problem');
  const { me } = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const [plan, setPlan] = useState<CorrectionPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [sent, setSent] = useState(false);
  const [proposed, setProposed] = useState<DocInput>();

  const request = async (next: DocInput) => {
    setError(undefined); setSent(false); setProposed(next);
    try { setPlan(await endpoints.getCorrectionPlan(d.type, doc.id, next)); } catch (e) { setError(e); }
  };
  const confirm = async () => {
    if (!plan) return;
    setBusy(true); setError(undefined);
    try {
      const { affected } = await endpoints.executeCorrection(plan.planId, plan.planHash);
      if (me) await qc.invalidateQueries({ queryKey: [me.activeCompanyId] });
      const next = [...affected].reverse().find((a) => a.type === d.type) ?? affected[affected.length - 1];
      setPlan(undefined);
      // each affected document opens on its own type's route (a CN-only plan lands on the CN, never a TI route)
      router.push((next && docHref(next.type, next.docId)) ?? docHref(d.type, doc.id) ?? d.basePath);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  // Sending to an approver is a mock inbox entry in SP1: it only acknowledges, nothing is written.
  const send = () => { setPlan(undefined); setSent(true); };

  // A stale / vanished plan cannot be confirmed: offer a fresh one from the kept proposal.
  const stale = error instanceof ApiError && ['correction.plan_stale', 'correction.plan_not_found'].includes(error.code) && !!proposed;
  const ui = (
    <>
      {plan ? <CorrectionPlanDialog plan={plan} busy={busy} error={error} onRegenerate={stale ? () => void request(proposed!) : undefined} onConfirm={() => void confirm()} onSendToApprover={send} onCancel={() => { setPlan(undefined); setError(undefined); }} /> : null}
      {!plan && error ? <Alert variant="destructive"><AlertTitle>{error instanceof ApiError ? error.code === 'correction.unrepresentable' ? tp('correctionUnrepresentable') : error.problem.title : tp('default')}</AlertTitle></Alert> : null}
      {sent ? <Alert role="status"><AlertTitle>{t('sent')}</AlertTitle></Alert> : null}
    </>
  );
  return { request, ui };
}
