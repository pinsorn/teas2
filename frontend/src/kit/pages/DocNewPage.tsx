'use client';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { useMe } from '@/app-shell/useMe';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { DESCRIPTORS } from '@/descriptors';
import type { DocDescriptor } from '@/domain/descriptors';
import type { Allocation, Doc, DocType, Me } from '@/domain/types';
import { routesOf } from '@/domain/descriptors';
import { isTypeAvailable, LIVE } from '@/domain/doc-types';
import { DocEditor } from '@/kit/doc-editor/DocEditor';
import { settleable } from '@/kit/doc-editor/SettlementPanel';
import { ErrorState } from '@/kit/states/ErrorState';
import { LoadingState } from '@/kit/states/LoadingState';
import { endpoints } from '@/lib/api/endpoints';
import { qk } from '@/lib/query/keys';
import { TypeGate } from './TypeGate';

/** "Copy as new": the source's party and lines, a fresh date, no number, no due date, never the source's links. */
const asNewDraft = (src: Doc, businessDate: string): Doc => ({
  ...src, id: '', number: undefined, status: 'draft', revision: 0, version: 0, locks: [], issuedAt: undefined,
  cancel: undefined, replacedById: undefined, replacesId: undefined,
  header: { ...src.header, documentDate: businessDate, dueDate: undefined },
  lines: src.lines.map((l) => ({ ...l, id: crypto.randomUUID(), sourceLineId: undefined })),
});

type Skipped = { number: string; why: 'settled' | 'cancelled' | 'missing' };
interface Prefill { doc: Doc; skipped: Skipped[] }

/** A receipt opened from a document ("รับชำระ"): the customer and the allocations come from the SERVER's open items (`/docs/open-items`), at each target's outstanding NOW.
 *  `settle` = one TI / IV; `fromBl` = every document the billing statement groups (its stored amounts are informational and may be stale). A target with nothing left to receive is skipped and listed with the reason. */
async function receiptPrefill(d: DocDescriptor, me: Me, settle: string | null, fromBl: string | null): Promise<Prefill> {
  const types = (d.settles ?? []).filter((t) => isTypeAvailable(t, me.vatRegistered));
  let partyId: string | undefined, party: Doc['party'];
  let wanted: { id: string; type: DocType; number: string }[];
  if (fromBl) {
    const bl = await endpoints.getDoc('BL', fromBl);
    partyId = bl.header.partyId; party = bl.party;
    wanted = (bl.allocations ?? []).map((a) => ({ id: a.targetId, type: a.targetType, number: a.targetNumber ?? a.targetId }));
  } else {
    const src = await endpoints.getDoc(types[0], settle!); // a company has one invoice type: TI (VAT) or IV (non-VAT)
    partyId = src.header.partyId; party = src.party;
    wanted = [{ id: src.id, type: src.type, number: src.number ?? src.id }];
  }
  const open = partyId ? (await endpoints.openItems({ partyId, types })).items : [];
  const allocations: Allocation[] = [], skipped: Skipped[] = [];
  for (const w of wanted) {
    const hit = open.find((i) => i.id === w.id);
    if (hit && settleable(hit.outstanding)) { allocations.push({ targetId: hit.id, targetType: hit.type, targetNumber: hit.number, amount: hit.outstanding }); continue; }
    const t = await endpoints.getDoc(w.type, w.id).catch(() => undefined);
    skipped.push({ number: w.number, why: !t ? 'missing' : LIVE.includes(t.status) ? 'settled' : 'cancelled' });
  }
  const doc: Doc = {
    id: '', type: d.type, status: 'draft', correctionClass: d.correctionClass, revision: 0, version: 0, header: { documentDate: me.businessDate, ...(partyId ? { partyId } : {}) },
    ...(party ? { party } : {}), lines: [], totals: { gross: '0.00', discount: '0.00', net: '0.00', vat: '0.00', total: '0.00', amountInWords: '' }, locks: [],
    createdBy: { kind: 'user', id: me.userId, name: me.displayName }, ...(allocations.length ? { allocations } : {}),
  };
  return { doc, skipped };
}

function SkippedNotice({ skipped }: { skipped: Skipped[] }) {
  const t = useTranslations('docEditor.settlement');
  if (!skipped.length) return null;
  return (
    <Alert role="status" aria-label={t('prefillSkipped')} className="mb-4">
      <AlertTitle>{t('prefillSkipped')}</AlertTitle>
      <AlertDescription><ul>{skipped.map((s) => <li key={s.number}>{t(({ settled: 'skipSettled', cancelled: 'skipCancelled', missing: 'skipMissing' } as const)[s.why], { number: s.number })}</li>)}</ul></AlertDescription>
    </Alert>
  );
}

function NewDocument({ d }: { d: DocDescriptor }) {
  const router = useRouter();
  // read once: the first autosave rewrites the address bar to /edit/<id> (no copyFrom), which must not reset the editor
  const sp = useSearchParams();
  const [copyFrom, setCopyFrom] = useState(() => sp.get('copyFrom'));
  const live = sp.get('copyFrom');
  if (live && live !== copyFrom) setCopyFrom(live); // a new ?copyFrom= (another document) starts a new copy
  // a receipt opened from a document ("รับชำระ" on a TI / IV / BL), read once for the same reason
  const [settle] = useState(() => (d.settles ? sp.get('settle') : null));
  const [fromBl] = useState(() => (d.settles ? sp.get('fromBl') : null));
  const { me } = useMe();
  const src = useQuery({
    queryKey: qk.doc(me?.activeCompanyId ?? '', d.type, copyFrom ?? ''),
    queryFn: () => endpoints.getDoc(d.type, copyFrom!),
    enabled: !!copyFrom && !!me,
  });
  const wantPrefill = !!(settle || fromBl);
  const pre = useQuery({
    queryKey: [me?.activeCompanyId ?? '', 'docs', d.type, 'prefill', settle ?? '', fromBl ?? ''],
    queryFn: () => receiptPrefill(d, me!, settle, fromBl),
    enabled: wantPrefill && !!me, staleTime: Infinity, gcTime: 0, retry: false,
  });
  if (copyFrom && src.isError) return <ErrorState error={src.error} onRetry={() => void src.refetch()} />;
  if (copyFrom && !src.data) return <LoadingState />;
  if (wantPrefill && pre.isError) return <ErrorState error={pre.error} onRetry={() => void pre.refetch()} />;
  if (wantPrefill && !pre.data) return <LoadingState />;
  const initial = pre.data?.doc ?? (src.data && me ? asNewDraft(src.data, me.businessDate) : undefined);
  return (
    <>
      {pre.data ? <SkippedNotice skipped={pre.data.skipped} /> : null}
      <DocEditor key={copyFrom ?? settle ?? fromBl ?? 'blank'} descriptor={d} mode="create" initial={initial}
        onIssued={(doc) => router.replace(routesOf(d).view(doc.id))} />
    </>
  );
}

export function DocNewPage({ type }: { type: DocType }) {
  const d = DESCRIPTORS[type]!;
  return <TypeGate type={type}><Suspense fallback={<LoadingState />}><NewDocument d={d} /></Suspense></TypeGate>;
}
