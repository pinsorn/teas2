'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { routesOf } from '@/domain/descriptors';
import type { Doc } from '@/domain/types';
import { DocEditor } from '@/kit/doc-editor/DocEditor';
import { useCorrectionFlow } from '@/kit/doc-view/useCorrectionFlow';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { VatGate } from '../../gate';

const routes = routesOf(taxInvoice);
const DRAFTABLE = ['draft', 'approved'];
const REVISABLE = ['issued', 'partly_settled', 'settled'];

/** Issued documents change through the correction plan; the editor only hands the proposal over. */
function Revise({ doc }: { doc: Doc }) {
  const flow = useCorrectionFlow(taxInvoice, doc);
  return (
    <>
      <DocEditor descriptor={taxInvoice} mode="revise" initial={doc} onIssued={() => undefined} onRevisionRequested={(p) => void flow.request(p)} />
      {flow.ui}
    </>
  );
}

function Edit({ id }: { id: string }) {
  const router = useRouter();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const q = useQuery({
    queryKey: qk.doc(me?.activeCompanyId ?? '', taxInvoice.type, id),
    queryFn: () => endpoints.getDoc(taxInvoice.type, id),
    enabled: !!me,
  });
  const doc = q.data;
  const editable = !!doc && (DRAFTABLE.includes(doc.status) || REVISABLE.includes(doc.status));
  // Cancelled / replaced / pending documents cannot be edited: send the reader to the view, which says why.
  useEffect(() => { if (doc && !editable) router.replace(routes.view(id)); }, [doc, editable, id, router]);

  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError) return isForbidden(q.error) ? <ForbiddenState permission={taxInvoice.permissions.read} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!doc || !editable) return <LoadingState />;
  if (DRAFTABLE.includes(doc.status)) {
    return <DocEditor key={doc.id} descriptor={taxInvoice} mode="edit-draft" initial={doc} onIssued={(d) => router.replace(routes.view(d.id))} />;
  }
  return <Revise key={doc.id} doc={doc} />;
}

export default function EditTaxInvoicePage() {
  const { id } = useParams<{ id: string }>();
  return <VatGate><Edit id={id} /></VatGate>;
}
