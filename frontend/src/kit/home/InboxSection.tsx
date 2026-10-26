'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { docViewHref } from '@/descriptors';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DocSummary, HomeApproval } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE, formatTHB } from '@/lib/format';
import { SendBackDialog } from '@/kit/doc-view/ApprovalActions';
import { HomeSectionShell, useHomeSection } from './HomeSection';

const SHOWN = 5;

/** A link to the document when its type has a route in this company; plain text otherwise (never a made-up URL). */
function DocNumber({ type, id, label }: { type: DocSummary['type']; id: string; label: string }) {
  const href = docViewHref(type, id);
  return href ? <Link href={href} className="font-medium underline-offset-4 hover:underline">{label}</Link> : <span className="font-medium">{label}</span>;
}

function ApprovalRow({ a }: { a: HomeApproval }) {
  const t = useTranslations('home.approvals');
  const ta = useTranslations('docView.actions');
  const tc = useTranslations('common');
  const tp = useTranslations('problem');
  const { me } = useMe();
  const qc = useQueryClient();
  const [backOpen, setBackOpen] = useState(false);
  const companyId = me?.activeCompanyId ?? '';
  const both = !!me?.permissions.includes(`doc.${a.type}.issue`);
  const label = `${a.type} ${a.number ?? tc('draftNoNumber')}`.trim();
  // the same commands as the document page; a stale version reloads the inbox so a retry sends the current one
  const refresh = () => qc.invalidateQueries({ queryKey: [companyId] });
  const after = { onSuccess: async () => { await refresh(); setBackOpen(false); }, onError: (e: unknown) => { if (e instanceof ApiError && e.code === 'doc.version_conflict') void refresh(); } };
  const approve = useMutation({ ...after, mutationFn: () => endpoints.approveDoc(a.type, a.id, a.version) });
  const approveIssue = useMutation({ ...after, mutationFn: () => endpoints.approveAndIssueDoc(a.type, a.id, a.version) });
  const sendBack = useMutation({ ...after, mutationFn: (reason: string) => endpoints.sendBackDoc(a.type, a.id, a.version, reason) });
  const busy = approve.isPending || approveIssue.isPending || sendBack.isPending;
  const error = approve.error ?? approveIssue.error;
  return (
    <li className="grid gap-2 py-2" data-testid={`inbox-${a.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DocNumber type={a.type} id={a.id} label={label} />
            {a.reason === 'agent' && <Badge variant="secondary">{t('agentWaiting')}</Badge>}
          </div>
          <p className="truncate text-small text-muted-foreground">{a.partyName}</p>
          <p className="text-small text-muted-foreground">
            {t('requester', { name: a.requester })} · {a.ageDays > 0 ? t('age', { count: a.ageDays }) : t('today')}
            {a.agentReportId ? <> · <Link href={`/agent-reports/${a.agentReportId}`} className="underline-offset-4 hover:underline">{t('agentReport')}</Link></> : null}
          </p>
        </div>
        <div className="shrink-0 text-right tabular-nums">{formatTHB(a.total)}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {both && <Button size="sm" disabled={busy} aria-label={`${ta('approveAndIssue')} ${label}`} onClick={() => { approveIssue.reset(); approveIssue.mutate(); }}>{ta('approveAndIssue')}</Button>}
        <Button size="sm" variant={both ? 'outline' : 'default'} disabled={busy} aria-label={`${ta('approve')} ${label}`} onClick={() => { approve.reset(); approve.mutate(); }}>{ta('approve')}</Button>
        <Button size="sm" variant="outline" disabled={busy} aria-label={`${ta('sendBack')} ${label}`} onClick={() => { sendBack.reset(); setBackOpen(true); }}>{ta('sendBack')}</Button>
      </div>
      {error ? <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert> : null}
      {backOpen ? <SendBackDialog docLabel={label} busy={sendBack.isPending} error={sendBack.error} onCancel={() => setBackOpen(false)} onConfirm={(r) => sendBack.mutate(r)} /> : null}
    </li>
  );
}

/** งานรออนุมัติ: the approval engine's own list (frozen policy, the user's right, self-approval), oldest first. */
export function ApprovalsSection() {
  const t = useTranslations('home');
  const q = useHomeSection('approvals');
  return (
    <HomeSectionShell id="h-approvals" title={t('approvals.title')} q={q} isEmpty={(d) => !d.length} empty={t('approvals.empty')}>
      {(d) => (
        <>
          <ul className="divide-y">{d.slice(0, SHOWN).map((a) => <ApprovalRow key={a.id} a={a} />)}</ul>
          {d.length > SHOWN && <p className="pt-2 text-small text-muted-foreground">{t('more', { count: d.length - SHOWN })}</p>}
        </>
      )}
    </HomeSectionShell>
  );
}

function DocRows({ docs, mode }: { docs: DocSummary[]; mode: 'document' | 'overdue' }) {
  const t = useTranslations();
  return (
    <>
      <ul className="divide-y">
        {docs.slice(0, SHOWN).map((d) => (
          <li key={d.id} className="flex items-baseline justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <DocNumber type={d.type} id={d.id} label={d.number ?? t('common.draftNoNumber')} />
                {d.createdByAgent && <Badge variant="secondary">{t('common.agent')}</Badge>}
              </div>
              <p className="truncate text-small text-muted-foreground">{d.partyName}</p>
            </div>
            <div className="shrink-0 text-right text-small tabular-nums">
              <div>{formatTHB(mode === 'overdue' ? (d.outstanding ?? d.total) : d.total)}</div>
              <div className="text-muted-foreground">{mode === 'overdue' && d.dueDate ? t('common.dueOn', { date: formatDateBE(d.dueDate) }) : formatDateBE(d.documentDate)}</div>
            </div>
          </li>
        ))}
      </ul>
      {docs.length > SHOWN && <p className="pt-2 text-small text-muted-foreground">{t('home.more', { count: docs.length - SHOWN })}</p>}
    </>
  );
}

export function DraftsSection() {
  const t = useTranslations('home');
  const q = useHomeSection('drafts');
  return <HomeSectionShell id="h-drafts" title={t('drafts.title')} q={q} isEmpty={(d) => !d.length} empty={t('drafts.empty')}>{(d) => <DocRows docs={d} mode="document" />}</HomeSectionShell>;
}

export function OverdueSection() {
  const t = useTranslations('home');
  const q = useHomeSection('overdue');
  return <HomeSectionShell id="h-overdue" title={t('overdue.title')} q={q} isEmpty={(d) => !d.length} empty={t('overdue.empty')}>{(d) => <DocRows docs={d} mode="overdue" />}</HomeSectionShell>;
}
