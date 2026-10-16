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
import { CREDIT_NOTES, isTypeAvailable, LIVE } from '@/domain/doc-types';
import { DocEditor } from '@/kit/doc-editor/DocEditor';
import { settleable } from '@/kit/doc-editor/SettlementPanel';
import { ErrorState } from '@/kit/states/ErrorState';
import { AdjustPicker } from './AdjustPicker';
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

const sat = (m: string) => Math.round(Number(m) * 100);
/** A note opened from its original ("ออกใบลดหนี้" on a TI, "บันทึกใบลดหนี้จากผู้ขาย" on a PB): the party, the reference and the lines come from the SERVER's document; every line keeps the id of the line it credits (the per-line cap reads it).
 *  A credit note starts at what is still creditable of each line (a line credited in full is left out; one credited in part becomes 1 x what is left); a debit note starts every line at quantity 0, so saving it unedited adds nothing.
 *  A bill priced WITH VAT is read through the server's nets (a note is always priced ex-VAT): its lines become 1 x the line's net (credit) or 0 x it (debit). */
async function adjustPrefill(d: DocDescriptor, me: Me, tiId: string): Promise<Doc> {
  const ti = await endpoints.getDoc(d.adjusts!, tiId);
  const credits = CREDIT_NOTES.includes(d.type), incl = !!ti.header.priceIncludesVat;
  let lines = ti.lines.map((l) => ({ ...l, id: crypto.randomUUID(), sourceLineId: l.id, vatOverride: undefined }));
  let notes: Doc[] = [];
  if (credits) {
    const chain = await endpoints.getChain(d.adjusts!, tiId);
    const ids = chain.edges.filter((e) => e.kind === 'adjusts' && e.active && e.to === tiId).map((e) => e.from); // live CNs, and DNs (a stored negative DN line is a credit too)
    notes = await Promise.all(ids.map((id) => endpoints.getDoc(chain.nodes.find((n) => n.id === id)!.type, id)));
  }
  if (notes.length || incl) { // the server's own nets (one compute): the original's lines, then every live note's lines
    const all = [...ti.lines.map((l, i) => ({ ...l, id: `t${i}` })), ...notes.flatMap((c, j) => c.lines.map((l, i) => ({ ...l, id: `c${j}-${i}`, vatOverride: undefined })))];
    const net = new Map((await endpoints.computeDocument(d.adjusts!, { header: ti.header, lines: all })).lines.map((r) => [r.id, sat(r.net)] as const));
    const credit = (c: Doc, j: number, l: Doc['lines'][number], k: number) => { // a credit note line credits its net; a debit note line only when negative
      const x = net.get(`c${j}-${k}`)!;
      return l.sourceLineId && (CREDIT_NOTES.includes(c.type) ? x : x < 0 ? -x : 0);
    };
    const left = ti.lines.map((l, i) => net.get(`t${i}`)! - notes.reduce((a, c, j) => a + c.lines.reduce((b, cl, k) => b + (cl.sourceLineId === l.id ? credit(c, j, cl, k) || 0 : 0), 0), 0));
    lines = lines.flatMap((l, i) => (!credits ? [{ ...l, qty: '0', ...(incl ? { unitPrice: (left[i] / 100).toFixed(2), discountPct: undefined } : {}) }]
      : left[i] <= 0 ? [] : left[i] === net.get(`t${i}`) && !incl ? [l] : [{ ...l, qty: '1', unitPrice: (left[i] / 100).toFixed(2), discountPct: undefined }]));
  } else if (!credits) lines = lines.map((l) => ({ ...l, qty: '0' }));
  return {
    id: '', type: d.type, status: 'draft', correctionClass: d.correctionClass, revision: 0, version: 0,
    header: { documentDate: me.businessDate, ...(ti.header.partyId ? { partyId: ti.header.partyId } : {}), refDocId: ti.id, ...(ti.number ? { reference: ti.number } : {}), priceIncludesVat: false },
    ...(ti.party ? { party: ti.party } : {}), totals: { gross: '0.00', discount: '0.00', net: '0.00', vat: '0.00', total: '0.00', amountInWords: '' }, locks: [],
    createdBy: { kind: 'user', id: me.userId, name: me.displayName }, lines,
  };
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
  const [adjust] = useState(() => (d.adjusts ? sp.get('adjust') : null)); // a CN / DN opened from its invoice
  const { me } = useMe();
  const adj = useQuery({
    queryKey: [me?.activeCompanyId ?? '', 'docs', d.type, 'adjust', adjust ?? ''],
    queryFn: () => adjustPrefill(d, me!, adjust!),
    enabled: !!adjust && !!me, staleTime: Infinity, gcTime: 0, retry: false,
  });
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
  if (d.adjusts && !adjust) return <AdjustPicker descriptor={d} />; // no invoice chosen yet: pick the invoice first
  if (adjust && adj.isError) return <ErrorState error={adj.error} onRetry={() => void adj.refetch()} />;
  if (adjust && !adj.data) return <LoadingState />;
  if (copyFrom && src.isError) return <ErrorState error={src.error} onRetry={() => void src.refetch()} />;
  if (copyFrom && !src.data) return <LoadingState />;
  if (wantPrefill && pre.isError) return <ErrorState error={pre.error} onRetry={() => void pre.refetch()} />;
  if (wantPrefill && !pre.data) return <LoadingState />;
  const initial = adj.data ?? pre.data?.doc ?? (src.data && me ? asNewDraft(src.data, me.businessDate) : undefined);
  return (
    <>
      {pre.data ? <SkippedNotice skipped={pre.data.skipped} /> : null}
      <DocEditor key={copyFrom ?? settle ?? fromBl ?? adjust ?? 'blank'} descriptor={d} mode="create" initial={initial}
        onIssued={(doc) => router.replace(routesOf(d).view(doc.id))} />
    </>
  );
}

export function DocNewPage({ type }: { type: DocType }) {
  const d = DESCRIPTORS[type]!;
  return <TypeGate type={type}><Suspense fallback={<LoadingState />}><NewDocument d={d} /></Suspense></TypeGate>;
}
