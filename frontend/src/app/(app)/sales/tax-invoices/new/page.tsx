'use client';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { taxInvoice } from '@/descriptors/tax-invoice';
import { routesOf } from '@/domain/descriptors';
import type { Doc } from '@/domain/types';
import { DocEditor } from '@/kit/doc-editor/DocEditor';
import { ErrorState } from '@/kit/states/ErrorState';
import { LoadingState } from '@/kit/states/LoadingState';
import { endpoints } from '@/lib/api/endpoints';
import { todayIso } from '@/lib/format';
import { qk } from '@/lib/query/keys';
import { VatGate } from '../gate';

/** "Copy as new": the source's party and lines, a fresh date, no number, no due date, never the source's links. */
const asNewDraft = (src: Doc): Doc => ({
  ...src, id: '', number: undefined, status: 'draft', revision: 0, version: 0, locks: [], issuedAt: undefined,
  cancel: undefined, replacedById: undefined, replacesId: undefined,
  header: { ...src.header, documentDate: todayIso(), dueDate: undefined },
  lines: src.lines.map((l) => ({ ...l, id: crypto.randomUUID(), sourceLineId: undefined })),
});

function NewTaxInvoice() {
  const router = useRouter();
  // read once: the first autosave rewrites the address bar to /edit/<id> (no copyFrom), which must not reset the editor
  const sp = useSearchParams();
  const [copyFrom, setCopyFrom] = useState(() => sp.get('copyFrom'));
  const live = sp.get('copyFrom');
  if (live && live !== copyFrom) setCopyFrom(live); // a new ?copyFrom= (another document) starts a new copy
  const { me } = useMe();
  const src = useQuery({
    queryKey: qk.doc(me?.activeCompanyId ?? '', taxInvoice.type, copyFrom ?? ''),
    queryFn: () => endpoints.getDoc(taxInvoice.type, copyFrom!),
    enabled: !!copyFrom && !!me,
  });
  if (copyFrom && src.isError) return <ErrorState error={src.error} onRetry={() => void src.refetch()} />;
  if (copyFrom && !src.data) return <LoadingState />;
  return (
    <DocEditor key={copyFrom ?? 'blank'} descriptor={taxInvoice} mode="create" initial={src.data ? asNewDraft(src.data) : undefined}
      onIssued={(doc) => router.replace(routesOf(taxInvoice).view(doc.id))} />
  );
}

export default function NewTaxInvoicePage() {
  return <VatGate><Suspense fallback={<LoadingState />}><NewTaxInvoice /></Suspense></VatGate>;
}
