'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { ApiError } from '@/lib/api/client';
import { type ApprovalRuleRow, type ApprovalsView, approvalApi } from '@/records/tax-numbering-approvals';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const titleOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.problem.title + (e.problem.detail ? ` ${e.problem.detail}` : '') : fallback);

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return <div className="grid gap-1.5"><Label htmlFor={id}>{label}</Label>{children}</div>;
}

/** ST3: which document types need approval (one threshold per type, O-5), whether a person may approve their own document (company-wide), and the settlement tolerance (FN3). The policy that applied to a document is frozen on it when it is submitted / issued: a change here reaches the next documents only. */
export default function ApprovalSettingsPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('settings.approvals');
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const id = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: [id, 'settings', 'approvals'], queryFn: approvalApi.get, enabled: !!id });
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="settings.manage" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!me || !q.data) return <LoadingState />;
  return (
    <div className="grid gap-4">
      <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <Rules view={q.data} />
      <SelfApproval view={q.data} />
      <Tolerance view={q.data} />
    </div>
  );
}

const useRefresh = () => {
  const qc = useQueryClient();
  const { me } = useMe();
  return () => qc.invalidateQueries({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'approvals'] });
};

function Rules({ view }: { view: ApprovalsView }) {
  const t = useTranslations('settings.approvals.rules');
  return (
    <section aria-labelledby="ap-rules" className="grid gap-3 rounded-lg border bg-card p-4">
      <div><h2 id="ap-rules" className="text-section font-semibold">{t('title')}</h2><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{(['type', 'enabled', 'min', 'actions'] as const).map((c) => <TableHead key={c}>{t(`col.${c}`)}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{view.items.map((r) => <RuleRow key={r.docType} rule={r} />)}</TableBody>
        </Table>
      </div>
    </section>
  );
}

function RuleRow({ rule }: { rule: ApprovalRuleRow }) {
  const t = useTranslations('settings.approvals.rules');
  const td = useTranslations('docTypes');
  const refresh = useRefresh();
  const [enabled, setEnabled] = useState(rule.enabled);
  const [min, setMin] = useState(rule.minAmount ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const name = td(`${rule.docType}.title`);
  const save = useMutation({
    mutationFn: () => approvalApi.saveRule(rule.docType, { enabled, ...(min.trim() ? { minAmount: min.trim() } : {}), version: rule.version }),
    onSuccess: () => { setMsg({ ok: true, text: t('saved') }); return refresh(); },
    onError: (e) => { setMsg({ ok: false, text: titleOf(e, t('failed')) }); void refresh(); },
  });
  return (
    <TableRow>
      <TableCell>{name} <span className="text-small text-muted-foreground">({rule.docType})</span></TableCell>
      <TableCell><Checkbox aria-label={t('enabledOf', { name })} checked={enabled} onCheckedChange={(c) => setEnabled(c === true)} /></TableCell>
      <TableCell>
        <Input aria-label={t('minOf', { name })} inputMode="decimal" className="w-40 tabular-nums" value={min} placeholder={t('minPlaceholder')} autoComplete="off" onChange={(e) => setMin(e.target.value)} aria-invalid={msg ? !msg.ok : undefined} />
        <p className="mt-1 text-small text-muted-foreground">{t('minHint')}</p>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" aria-label={t('saveOf', { name })} disabled={save.isPending} onClick={() => { setMsg(undefined); save.mutate(); }}>{t('save')}</Button>
          {msg ? <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-small text-muted-foreground' : 'text-small text-destructive'}>{msg.text}</span> : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function SelfApproval({ view }: { view: ApprovalsView }) {
  const t = useTranslations('settings.approvals.self');
  const refresh = useRefresh();
  const [on, setOn] = useState(view.selfApproval);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const save = useMutation({
    mutationFn: () => approvalApi.saveSelf({ selfApproval: on, version: view.selfApprovalVersion }),
    onSuccess: () => { setMsg({ ok: true, text: t('saved') }); return refresh(); },
    onError: (e) => { setMsg({ ok: false, text: titleOf(e, t('failed')) }); void refresh(); },
  });
  return (
    <section aria-labelledby="ap-self" className="grid gap-3 rounded-lg border bg-card p-4">
      <div><h2 id="ap-self" className="text-section font-semibold">{t('title')}</h2><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <div className="flex items-center gap-2"><Checkbox id="ap-self-on" checked={on} onCheckedChange={(c) => setOn(c === true)} /><Label htmlFor="ap-self-on">{t('label')}</Label></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={save.isPending || on === view.selfApproval} onClick={() => { setMsg(undefined); save.mutate(); }}>{t('save')}</Button>
        {msg ? <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-small text-muted-foreground' : 'text-small text-destructive'}>{msg.text}</span> : null}
      </div>
    </section>
  );
}

function Tolerance({ view }: { view: ApprovalsView }) {
  const t = useTranslations('settings.approvals.tolerance');
  const refresh = useRefresh();
  const [v, setV] = useState({ rounding: view.tolerance.rounding, smallWriteOff: view.tolerance.smallWriteOff });
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const save = useMutation({
    mutationFn: () => approvalApi.saveTolerance({ rounding: v.rounding.trim(), smallWriteOff: v.smallWriteOff.trim(), version: view.tolerance.version }),
    onSuccess: () => { setMsg({ ok: true, text: t('saved') }); return refresh(); },
    onError: (e) => { setMsg({ ok: false, text: titleOf(e, t('failed')) }); void refresh(); },
  });
  return (
    <section aria-labelledby="ap-tol" className="grid gap-3 rounded-lg border bg-card p-4">
      <div><h2 id="ap-tol" className="text-section font-semibold">{t('title')}</h2><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <form noValidate className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); setMsg(undefined); save.mutate(); }}>
        <Field id="tol-rounding" label={t('rounding')}><Input id="tol-rounding" inputMode="decimal" className="tabular-nums" value={v.rounding} autoComplete="off" onChange={(e) => setV({ ...v, rounding: e.target.value })} /></Field>
        <Field id="tol-write" label={t('smallWriteOff')}><Input id="tol-write" inputMode="decimal" className="tabular-nums" value={v.smallWriteOff} autoComplete="off" onChange={(e) => setV({ ...v, smallWriteOff: e.target.value })} /></Field>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="outline" disabled={save.isPending}>{t('save')}</Button>
          {msg ? <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-small text-muted-foreground' : 'text-small text-destructive'}>{msg.text}</span> : null}
        </div>
      </form>
      <p className="text-small text-muted-foreground">{t('frozen')}</p>
    </section>
  );
}
