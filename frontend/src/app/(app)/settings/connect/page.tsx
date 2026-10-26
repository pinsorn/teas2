'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense, useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { PERMISSIONS } from '@/domain/permissions';
import { ApiError } from '@/lib/api/client';
import { formatDateBE, formatMoney } from '@/lib/format';
import { SecretOnceDialog } from '@/kit/connect/SecretOnceDialog';
import { EmptyState } from '@/kit/states/EmptyState';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';
import { type ApiKeyCreated, type ApiKeyRow, type KeyKind, type OAuthAppRow, type PolicyMode, type PolicyRow, connectApi } from '@/records/connect';

const TABS = ['keys', 'apps', 'policy'] as const;
type Tab = (typeof TABS)[number];
const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none aria-invalid:border-2 aria-invalid:border-destructive';
const titleOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.problem.title + (e.problem.detail ? ` ${e.problem.detail}` : '') : fallback);
const dateOf = (iso?: string) => (iso ? formatDateBE(iso.slice(0, 10)) : '–');

/** HC2: TEAS Connect (SP0 §8): API keys, connected apps, the agent policy. `connect.manage` (the administrator) for all three; an agent can change none of it. */
export default function ConnectPage() {
  return <Suspense fallback={<LoadingState />}><Inner key={useCompanyEpoch()} /></Suspense>;
}

function Inner() {
  const t = useTranslations('connect.page');
  const router = useRouter(), pathname = usePathname(), search = useSearchParams();
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const raw = search.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'keys';
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (!me) return <LoadingState />;
  const id = me.activeCompanyId;
  const manage = me.permissions.includes('connect.manage'); // a member sees their own keys; the apps and the policy are the manager's (a direct link to them answers 403)
  return (
    <div className="grid gap-4">
      <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <Tabs value={tab} onValueChange={(v) => { const u = new URLSearchParams(search.toString()); u.set('tab', v); router.replace(`${pathname}?${u}`); }}>
        <TabsList aria-label={t('tabs.label')} className="h-auto flex-wrap group-data-horizontal/tabs:h-auto">
          {TABS.filter((k) => k === 'keys' || manage).map((k) => <TabsTrigger key={k} value={k} className="h-8 flex-auto">{t(`tabs.${k}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="keys"><KeysTab companyId={id} manage={manage} /></TabsContent>
        <TabsContent value="apps"><AppsTab companyId={id} /></TabsContent>
        <TabsContent value="policy"><PolicyTab companyId={id} /></TabsContent>
      </Tabs>
    </div>
  );
}

/** The state of one tab's query, by cause (an error is never "no data"); undefined = render the data. */
function gate<T>(q: { data?: T; isError: boolean; error: unknown; refetch: () => unknown }): ReactNode | undefined {
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="connect.manage" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <LoadingState />;
  return undefined;
}

function Section({ title, lead, action, children }: { title: string; lead?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-section font-semibold">{title}</h2>{lead ? <p className="text-body text-muted-foreground">{lead}</p> : null}</div>{action}</div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ API keys
function KeysTab({ companyId, manage }: { companyId: string; manage: boolean }) {
  const t = useTranslations('connect.keys');
  const qc = useQueryClient();
  const key = [companyId, 'connect', 'keys'];
  const q = useQuery({ queryKey: key, queryFn: connectApi.keys });
  const [form, setForm] = useState(false);
  const [confirm, setConfirm] = useState<{ row: ApiKeyRow; action: 'rotate' | 'revoke' }>();
  const [secret, setSecret] = useState<{ name: string; secret: string }>();
  const [notice, setNotice] = useState<string>();
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const run = useMutation({
    mutationFn: ({ row, action }: { row: ApiKeyRow; action: 'rotate' | 'revoke' }): Promise<ApiKeyCreated | ApiKeyRow> => action === 'rotate' ? connectApi.rotateKey(row.id, row.version) : connectApi.revokeKey(row.id, row.version),
    onSuccess: (r) => { if ('secret' in r) setSecret({ name: r.key.name, secret: r.secret }); return refresh(); },
    onError: (e) => { setNotice(titleOf(e, t('failed'))); void refresh(); },
  });
  const g = gate(q);
  if (g) return g;
  const rows = q.data!.items;
  return (
    <Section title={t('title')} lead={manage ? t('lead') : t('leadOwn')} action={<Button onClick={() => { setNotice(undefined); setForm(true); }}>{t('create')}</Button>}>
      {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      {rows.length === 0 ? <EmptyState title={t('empty')} /> : (
        <div className="overflow-x-auto">
          <Table aria-label={t('title')}>
            <TableHeader><TableRow>{(['name', 'kind', 'prefix', 'owner', 'lastUsed', 'scopes', 'status', 'actions'] as const).map((c) => <TableHead key={c}>{t(`col.${c}`)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={r.status === 'active' ? undefined : 'text-muted-foreground'}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{t(`kind.${r.kind}`)}</TableCell>
                  <TableCell className="font-mono text-small">{r.prefix}…</TableCell>
                  <TableCell>{r.ownerName}</TableCell>
                  <TableCell>{r.lastUsedAt ? dateOf(r.lastUsedAt) : t('never')}</TableCell>
                  <TableCell className="tabular-nums" title={r.scopes.join(', ')}>{r.scopeCount}</TableCell>
                  <TableCell><Badge variant={r.status === 'active' ? 'secondary' : 'outline'}>{t(`status.${r.status}`)}</Badge>{r.expiresAt && r.status === 'active' ? <span className="ms-2 text-small text-muted-foreground">{t('expires', { date: formatDateBE(r.expiresAt) })}</span> : null}</TableCell>
                  <TableCell>
                    {r.status === 'revoked' ? null : (
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="outline" aria-label={t('rotateOf', { name: r.name })} onClick={() => setConfirm({ row: r, action: 'rotate' })}>{t('rotate')}</Button>
                        <Button size="sm" variant="outline" aria-label={t('revokeOf', { name: r.name })} onClick={() => setConfirm({ row: r, action: 'revoke' })}>{t('revoke')}</Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {form ? <KeyForm choices={q.data!.scopeChoices ?? []} onClose={() => setForm(false)} onCreated={(name, s) => { setForm(false); setSecret({ name, secret: s }); void refresh(); }} /> : null}
      {confirm ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setConfirm(undefined); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(`confirm.${confirm.action}.title`, { name: confirm.row.name })}</AlertDialogTitle>
              <AlertDialogDescription>{t(`confirm.${confirm.action}.body`)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('confirm.cancel')}</AlertDialogCancel>
              <AlertDialogAction variant={confirm.action === 'revoke' ? 'destructive' : 'default'} onClick={() => { setNotice(undefined); run.mutate(confirm); setConfirm(undefined); }}>{t(`confirm.${confirm.action}.ok`)}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {secret ? <SecretOnceDialog name={secret.name} secret={secret.secret} onClose={() => setSecret(undefined)} /> : null}
    </Section>
  );
}

function KeyForm({ choices, onClose, onCreated }: { choices: string[]; onClose: () => void; onCreated: (name: string, secret: string) => void }) {
  const t = useTranslations('connect.keys.form');
  const locale = useLocale() as 'th' | 'en';
  const [name, setName] = useState(''), [kind, setKind] = useState<KeyKind>('mcp'), [expiresAt, setExpiresAt] = useState(''), [scopes, setScopes] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string[]>>({}), [message, setMessage] = useState<string>();
  const save = useMutation({
    mutationFn: () => connectApi.createKey({ name: name.trim(), kind, scopes, ...(expiresAt ? { expiresAt } : {}) }),
    onSuccess: (r) => onCreated(r.key.name, r.secret),
    onError: (e) => { setErrors(e instanceof ApiError ? e.problem.fieldErrors ?? {} : {}); setMessage(titleOf(e, t('failed'))); },
  });
  const err = (k: string) => errors[k]?.[0];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('title')}</DialogTitle><DialogDescription>{t('lead')}</DialogDescription></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setErrors({}); setMessage(undefined); save.mutate(); }}>
          <div className="grid gap-1.5">
            <Label htmlFor="key-name">{t('name')}</Label>
            <Input id="key-name" value={name} autoComplete="off" aria-invalid={err('name') ? true : undefined} onChange={(e) => setName(e.target.value)} />
            {err('name') ? <p role="alert" className="text-small text-destructive">{err('name')}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-kind">{t('kind')}</Label>
            <select id="key-kind" className={select} value={kind} onChange={(e) => setKind(e.target.value as KeyKind)}><option value="mcp">{t('kinds.mcp')}</option><option value="rest">{t('kinds.rest')}</option></select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-exp">{t('expires')}</Label>
            <Input id="key-exp" type="date" value={expiresAt} aria-invalid={err('expiresAt') ? true : undefined} onChange={(e) => setExpiresAt(e.target.value)} />
            {err('expiresAt') ? <p role="alert" className="text-small text-destructive">{err('expiresAt')}</p> : null}
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="text-body font-medium">{t('scopes')}</legend>
            <p className="text-small text-muted-foreground">{t('scopesHint')}</p>
            <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border p-2">
              {choices.map((c) => (
                <div key={c} className="flex items-center gap-2">
                  <Checkbox id={`sc-${c}`} checked={scopes.includes(c)} onCheckedChange={(on) => setScopes(on === true ? [...scopes, c] : scopes.filter((x) => x !== c))} />
                  <Label htmlFor={`sc-${c}`} className="font-normal">{PERMISSIONS[c]?.[locale] ?? c}</Label>
                </div>
              ))}
            </div>
            {err('scopes') ? <p role="alert" className="text-small text-destructive">{err('scopes')}</p> : null}
          </fieldset>
          {message && !Object.keys(errors).length ? <Alert variant="destructive" role="alert"><AlertTitle>{message}</AlertTitle></Alert> : null}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button><Button type="submit" disabled={save.isPending}>{t('submit')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ connected apps
function AppsTab({ companyId }: { companyId: string }) {
  const t = useTranslations('connect.apps');
  const qc = useQueryClient();
  const key = [companyId, 'connect', 'apps'];
  const q = useQuery({ queryKey: key, queryFn: connectApi.apps });
  const [confirm, setConfirm] = useState<OAuthAppRow>();
  const [notice, setNotice] = useState<string>();
  const revoke = useMutation({
    mutationFn: (a: OAuthAppRow) => connectApi.revokeApp(a.id, a.version),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => { setNotice(titleOf(e, t('failed'))); void qc.invalidateQueries({ queryKey: key }); },
  });
  const g = gate(q);
  if (g) return g;
  const rows = q.data!.items;
  return (
    <Section title={t('title')} lead={t('lead')}>
      {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      {rows.length === 0 ? <EmptyState title={t('empty')} /> : (
        <div className="overflow-x-auto">
          <Table aria-label={t('title')}>
            <TableHeader><TableRow>{(['name', 'owner', 'scopes', 'connectedAt', 'actions'] as const).map((c) => <TableHead key={c}>{t(`col.${c}`)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.name}</TableCell><TableCell>{r.ownerName}</TableCell>
                  <TableCell className="tabular-nums" title={r.scopes.join(', ')}>{r.scopes.length}</TableCell>
                  <TableCell>{dateOf(r.connectedAt)}</TableCell>
                  <TableCell><Button size="sm" variant="outline" aria-label={t('revokeOf', { name: r.name })} onClick={() => setConfirm(r)}>{t('revoke')}</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {confirm ? (
        <AlertDialog open onOpenChange={(o) => { if (!o) setConfirm(undefined); }}>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>{t('confirm.title', { name: confirm.name })}</AlertDialogTitle><AlertDialogDescription>{t('confirm.body')}</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('confirm.cancel')}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => { setNotice(undefined); revoke.mutate(confirm); setConfirm(undefined); }}>{t('confirm.ok')}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------------ agent policy
function PolicyTab({ companyId }: { companyId: string }) {
  const t = useTranslations('connect.policy');
  const q = useQuery({ queryKey: [companyId, 'connect', 'policy'], queryFn: connectApi.policy });
  const g = gate(q);
  if (g) return g;
  return (
    <div className="grid gap-4">
      <Section title={t('title')} lead={t('lead')}>
        <div className="overflow-x-auto">
          <Table aria-label={t('title')}>
            <TableHeader><TableRow>{(['type', 'mode', 'cap', 'actions'] as const).map((c) => <TableHead key={c}>{t(`col.${c}`)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{q.data!.items.map((r) => <PolicyRowEditor key={r.docType} row={r} companyId={companyId} />)}</TableBody>
          </Table>
        </div>
        <p className="text-small text-muted-foreground">{t('frozen')}</p>
      </Section>
      <Section title={t('limits.title')} lead={t('limits.lead')}>
        <ul className="ml-5 list-disc" data-testid="hard-limits">{q.data!.hardLimits.map((c) => <li key={c}>{t(`limits.${c}`)}</li>)}</ul>
      </Section>
    </div>
  );
}

function PolicyRowEditor({ row, companyId }: { row: PolicyRow; companyId: string }) {
  const t = useTranslations('connect.policy');
  const td = useTranslations('docTypes');
  const qc = useQueryClient();
  const [mode, setMode] = useState<PolicyMode>(row.mode), [cap, setCap] = useState(row.cap);
  const [seen, setSeen] = useState(row.version);
  if (seen !== row.version) { setSeen(row.version); setMode(row.mode); setCap(row.cap); } // the row was refetched (after a 409 or a save): show the server's values, not the stale edit
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const name = td(`${row.docType}.title`);
  const save = useMutation({
    mutationFn: () => connectApi.savePolicy(row.docType, { mode, cap: cap.trim(), version: row.version }),
    onSuccess: () => { setMsg({ ok: true, text: t('saved') }); return qc.invalidateQueries({ queryKey: [companyId, 'connect', 'policy'] }); },
    onError: (e) => { setMsg({ ok: false, text: e instanceof ApiError ? (e.problem.fieldErrors ? Object.values(e.problem.fieldErrors)[0]?.[0] : undefined) ?? titleOf(e, t('failed')) : t('failed') }); void qc.invalidateQueries({ queryKey: [companyId, 'connect', 'policy'] }); },
  });
  return (
    <TableRow>
      <TableCell>{name} <span className="text-small text-muted-foreground">({row.docType})</span>{row.tClass ? <Badge variant="outline" className="ms-2">{t('tClass')}</Badge> : null}</TableCell>
      <TableCell>
        <select aria-label={t('modeOf', { name })} className={`${select} w-56`} value={mode} onChange={(e) => setMode(e.target.value as PolicyMode)}>
          <option value="off">{t('mode.off')}</option><option value="human">{t('mode.human')}</option><option value="auto" disabled={row.tClass}>{t('mode.auto')}</option>
        </select>
        {row.tClass ? <p className="mt-1 text-small text-muted-foreground">{t('tClassHint')}</p> : null}
      </TableCell>
      <TableCell><Input aria-label={t('capOf', { name })} inputMode="decimal" className="w-36 tabular-nums" value={cap} autoComplete="off" onChange={(e) => setCap(e.target.value)} />{mode !== 'auto' ? <p className="mt-1 text-small text-muted-foreground">{t('capHint', { cap: formatMoney(row.cap) })}</p> : null}</TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" aria-label={t('saveOf', { name })} disabled={save.isPending} onClick={() => { setMsg(undefined); save.mutate(); }}>{t('save')}</Button>
          {msg ? <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-small text-muted-foreground' : 'text-small text-destructive'}>{msg.text}</span> : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
