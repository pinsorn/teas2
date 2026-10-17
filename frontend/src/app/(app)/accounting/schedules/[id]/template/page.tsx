'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { DESCRIPTORS } from '@/descriptors';
import type { RecordRow } from '@/domain/records';
import type { Doc, PartySummary, ScheduleRecord } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { DocEditor } from '@/kit/doc-editor/DocEditor';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { NotFoundState } from '@/kit/states/NotFoundState';

type View = RecordRow & Pick<ScheduleRecord, 'kind' | 'name' | 'nextRun' | 'template' | 'version'> & { templatePartyRef?: PartySummary };

/** AC7b: the template of a recurring schedule, edited in the normal document editor (template mode). Saving re-freezes it; the schedule's page is where it lands. */
export default function ScheduleTemplatePage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('schedules');
  const router = useRouter();
  const qc = useQueryClient();
  const { me, isPending: mePending, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({ queryKey: qk.record(me?.activeCompanyId ?? '', 'schedule', id), queryFn: () => endpoints.getRecord('schedule', id), enabled: !!me });
  if (meError) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (mePending || q.isPending) return <LoadingState />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.code === 'record.not_found') return <NotFoundState listHref="/accounting/schedules" title={t('notFoundTitle')} body={t('notFoundBody')} />;
    return isForbidden(q.error) ? <ForbiddenState permission="ledger.read" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const s = q.data as View, d = s.template ? DESCRIPTORS[s.template.type] : undefined;
  if (s.kind !== 'recurring' || !s.template || !d) return <NotFoundState listHref="/accounting/schedules" title={t('notFoundTitle')} body={t('notFoundBody')} />;
  const back = `/accounting/schedules/${s.id}`;
  // the editor always has a date; a template has none - the next run stands in for it and is never sent back as part of the template
  const initial = { id: '', type: d.type, status: 'draft', correctionClass: 'L', revision: 0, version: s.version, header: { ...s.template.header, documentDate: s.nextRun }, lines: s.template.lines, party: s.templatePartyRef,
    totals: {}, locks: [], createdBy: { kind: 'user', id: '', name: '' } } as unknown as Doc;
  return (
    <DocEditor descriptor={d} mode="template" initial={initial} onIssued={() => undefined}
      onSaveTemplate={async ({ header, lines }) => {
        await endpoints.updateRecord('schedule', s.id, { name: s.name, template: { header, lines } }, s.version);
        await qc.invalidateQueries({ queryKey: [me!.activeCompanyId] });
        router.push(back);
      }} />
  );
}
