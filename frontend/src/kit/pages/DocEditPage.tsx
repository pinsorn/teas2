'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { DESCRIPTORS } from '@/descriptors';
import type { DocDescriptor } from '@/domain/descriptors';
import type { DocType } from '@/domain/types';
import { routesOf } from '@/domain/descriptors';
import { LIVE } from '@/domain/doc-types';
import type { Doc } from '@/domain/types';
import { DocEditor } from '@/kit/doc-editor/DocEditor';
import { ObWizard } from '@/kit/opening/ObWizard';
import { useCorrectionFlow } from '@/kit/doc-view/useCorrectionFlow';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { isNotFound, NotFoundState } from '@/kit/states/NotFoundState';
import { LoadingState } from '@/kit/states/LoadingState';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { TypeGate } from './TypeGate';

const DRAFTABLE = ['draft', 'approved'];

/** Issued documents change through the correction plan; the editor only hands the proposal over. */
function Revise({ doc, d, onLanding }: { doc: Doc; d: DocDescriptor; onLanding: () => void }) {
  const flow = useCorrectionFlow(d, doc, onLanding);
  return (
    <>
      {d.type === 'OB' ? <ObWizard mode="revise" initial={doc} onRevisionRequested={(p) => void flow.request(p)} />
        : <DocEditor descriptor={d} mode="revise" initial={doc} onIssued={() => undefined} onRevisionRequested={(p) => void flow.request(p)} />}
      {flow.ui}
    </>
  );
}

function Edit({ id, d }: { id: string; d: DocDescriptor }) {
  const routes = routesOf(d);
  const router = useRouter();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({
    queryKey: qk.doc(me?.activeCompanyId ?? '', d.type, id),
    queryFn: () => endpoints.getDoc(d.type, id),
    enabled: !!me,
  });
  const doc = q.data;
  const landing = useRef(false); // a correction plan just ran: its flow navigates to the result, this page must not also redirect to the (now replaced) document
  const editable = !!doc && (DRAFTABLE.includes(doc.status) || LIVE.includes(doc.status)) && d.type !== 'FA' && d.type !== 'DP'; // AC5: an asset / a depreciation run has no editor - the view says how to change it
  // Cancelled / replaced / pending documents cannot be edited: send the reader to the view, which says why.
  useEffect(() => { if (doc && !editable && !landing.current) router.replace(routesOf(d).view(id)); }, [doc, editable, id, router, d]);

  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && isNotFound(q.error)) return <NotFoundState listHref={routes.list} />;
  if (q.isError) return isForbidden(q.error) ? <ForbiddenState permission={d.permissions.read} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!doc || !editable) return <LoadingState />;
  if (DRAFTABLE.includes(doc.status)) {
    return d.type === 'OB' ? <ObWizard key={doc.id} mode="edit-draft" initial={doc} onIssued={(x) => router.replace(routes.view(x.id))} /> // AC3: opening balances are a wizard, not the document editor
      : <DocEditor key={doc.id} descriptor={d} mode="edit-draft" initial={doc} onIssued={(x) => router.replace(routes.view(x.id))} />;
  }
  return <Revise key={doc.id} doc={doc} d={d} onLanding={() => { landing.current = true; }} />;
}

export function DocEditPage({ type }: { type: DocType }) {
  const d = DESCRIPTORS[type]!;
  const { id } = useParams<{ id: string }>();
  return <TypeGate type={type}><Edit id={id} d={d} /></TypeGate>;
}
