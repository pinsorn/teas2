'use client';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { Actor, DocStatus } from '@/domain/types';

/** A document an AI agent created says so, and whose assistant it is (SP0 agent-actor rule). The report link shows only when the agent filed a check report; the report screen belongs to the approval inbox (HC1). */
export function AgentBanner({ actor, status, reportId }: { actor: Actor; status: DocStatus; reportId?: string }) {
  const t = useTranslations('docView.agent');
  if (actor.kind !== 'agent') return null;
  const key = status === 'draft' ? 'draftBy' : 'createdBy';
  return (
    <Alert role="status" data-testid="agent-banner">
      <AlertTitle>{actor.ownerName ? t(key, { name: actor.name, owner: actor.ownerName }) : t(`${key}NoOwner`, { name: actor.name })}</AlertTitle>
      {reportId ? <AlertDescription><a className="text-primary underline" href={`/?agentReport=${encodeURIComponent(reportId)}`}>{t('report')}</a></AlertDescription> : null}
    </Alert>
  );
}
