'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import type { DocType, RoleRow, UserRow } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { EmptyState } from '../states/EmptyState';
import { ErrorState } from '../states/ErrorState';
import { ForbiddenState } from '../states/ForbiddenState';
import { LoadingState } from '../states/LoadingState';
import { ImageUpload } from './ImageUpload';
import { PermissionMatrix } from './PermissionMatrix';

const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none aria-invalid:border-2 aria-invalid:border-destructive';
type FieldErrors = Record<string, string[]>;
const fieldErrorsOf = (e: unknown): FieldErrors => (e instanceof ApiError ? e.problem.fieldErrors ?? {} : {});
const titleOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.problem.title + (e.problem.detail ? ` ${e.problem.detail}` : '') : fallback);

function Row({ label, error, children, id }: { label: string; error?: string; children: ReactNode; id: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
    </div>
  );
}

/** The shared gate of both pages: the session first, then the list, by cause (an error is never "no data"). */
function useGate<T>(q: { data?: T; isError: boolean; error: unknown; refetch: () => unknown }, permission: string): ReactNode | undefined {
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission={permission} detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!me || !q.data) return <LoadingState />;
  return undefined;
}

// ------------------------------------------------------------------ users

export function UsersPage() { return <UsersInner key={useCompanyEpoch()} />; }

function UsersInner() {
  const t = useTranslations('settings.users');
  const qc = useQueryClient();
  const { me } = useMe();
  const key = [me?.activeCompanyId ?? '', 'settings', 'users'];
  const users = useQuery({ queryKey: key, queryFn: endpoints.listStaff, enabled: !!me });
  const roles = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'roles'], queryFn: endpoints.listRoles, enabled: !!me });
  const [form, setForm] = useState<{ row?: UserRow } | undefined>();
  const [link, setLink] = useState<{ label: string; name: string; url: string }>();
  const [confirm, setConfirm] = useState<UserRow>();
  const [notice, setNotice] = useState<string>();
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const run = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onMutate: () => setNotice(undefined),
    onSuccess: refresh,
    onError: (e) => setNotice(titleOf(e, t('title'))),
  });
  const gate = useGate(users, 'users.manage');
  if (gate) return gate;
  const rows = users.data!.items;
  const roleName = (r: UserRow) => r.roleName;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
        <Button onClick={() => setForm({})}>{t('invite')}</Button>
      </div>
      {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      {rows.length === 0 ? <EmptyState title={t('empty')} /> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow>{(['name', 'email', 'role', 'position', 'status', 'lastLogin', 'actions'] as const).map((c) => <TableHead key={c}>{t(`columns.${c}`)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={r.active ? undefined : 'text-muted-foreground'}>
                  <TableCell>{r.name}</TableCell><TableCell>{r.email}</TableCell><TableCell>{roleName(r)}</TableCell><TableCell>{r.position ?? '–'}</TableCell>
                  <TableCell>{r.active ? (r.invitePending ? <Badge variant="outline">{t('status.pending')}</Badge> : t('status.active')) : t('status.inactive')}</TableCell>
                  <TableCell>{r.lastLoginAt ? formatDateBE(r.lastLoginAt.slice(0, 10)) : <span className="text-muted-foreground">{t('never')}</span>}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" aria-label={t('actions.edit', { name: r.name })} onClick={() => setForm({ row: r })}>{t('edit')}</Button>
                      {r.active ? <Button size="sm" variant="outline" aria-label={t('actions.resetLink', { name: r.name })} onClick={() => run.mutate(async () => setLink({ label: t('link.resetLabel'), name: r.name, url: (await endpoints.staffResetLink(r.id)).link }))}>{t('actions.resetShort')}</Button> : null}
                      {r.active
                        ? <Button size="sm" variant="outline" aria-label={t('actions.deactivate', { name: r.name })} onClick={() => setConfirm(r)}>{t('deactivateAction')}</Button>
                        : <Button size="sm" variant="outline" aria-label={t('actions.activate', { name: r.name })} onClick={() => run.mutate(() => endpoints.setStaffActive(r.id, true, r.version))}>{t('actions.activateShort')}</Button>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {form ? <UserForm row={form.row} roles={roles.data?.items ?? []} onClose={() => setForm(undefined)} onDone={(url) => { setForm(undefined); void refresh(); if (url) setLink(url); }} /> : null}
      {link ? <LinkDialog {...link} onClose={() => setLink(undefined)} /> : null}
      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t('deactivateTitle', { name: confirm?.name ?? '' })}</AlertDialogTitle><AlertDialogDescription>{t('deactivateBody')}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancelShort')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const c = confirm!; setConfirm(undefined); run.mutate(() => endpoints.setStaffActive(c.id, false, c.version)); }}>{t('deactivateAction')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The one-time link: shown here and nowhere else (the server keeps a hash). */
function LinkDialog({ label, name, url, onClose }: { label: string; name: string; url: string; onClose: () => void }) {
  const t = useTranslations('settings.users.link');
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-xl">
        <DialogHeader><DialogTitle>{t('title', { name })}</DialogTitle></DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="one-time-link">{label}</Label>
          <Input id="one-time-link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <p className="text-small text-muted-foreground">{t('once')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? t('copied') : t('copy')}</Button>
            <Button onClick={onClose}>{t('done')}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UserForm({ row, roles, onClose, onDone }: { row?: UserRow; roles: RoleRow[]; onClose: () => void; onDone: (link?: { label: string; name: string; url: string }) => void }) {
  const t = useTranslations('settings.users');
  const tc = useTranslations('settings.common');
  const [v, setV] = useState({ name: row?.name ?? '', email: row?.email ?? '', roleId: row?.roleId ?? '', position: row?.position ?? '', signatureDataUrl: row?.signatureDataUrl ?? '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failed, setFailed] = useState<string>();
  const save = useMutation({
    mutationFn: async () => {
      if (row) { await endpoints.updateStaff(row.id, { name: v.name, roleId: v.roleId, position: v.position, signatureDataUrl: v.signatureDataUrl, version: row.version }); return undefined; }
      const made = await endpoints.inviteStaff({ name: v.name, email: v.email, roleId: v.roleId, position: v.position });
      return { label: t('link.inviteLabel'), name: made.name, url: made.link };
    },
    onSuccess: (link) => onDone(link),
    onError: (e) => { setErrors(fieldErrorsOf(e)); setFailed(titleOf(e, tc('failed'))); },
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>{row ? t('actions.edit', { name: row.name }) : t('inviteTitle')}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setErrors({}); setFailed(undefined); save.mutate(); }}>
          {failed ? <Alert variant="destructive" role="alert"><AlertTitle>{failed}</AlertTitle></Alert> : null}
          <Row id="u-name" label={t('fields.name')} error={errors.name?.[0]}><Input id="u-name" value={v.name} onChange={set('name')} aria-invalid={!!errors.name} /></Row>
          <Row id="u-email" label={t('fields.email')} error={errors.email?.[0]}><Input id="u-email" type="email" value={v.email} onChange={set('email')} readOnly={!!row} aria-invalid={!!errors.email} /></Row>
          <Row id="u-role" label={t('fields.role')} error={errors.roleId?.[0]}>
            <select id="u-role" className={select} value={v.roleId} onChange={set('roleId')} aria-invalid={!!errors.roleId}>
              <option value="">{t('selectRole')}</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Row>
          <Row id="u-position" label={t('fields.position')} error={errors.position?.[0]}><Input id="u-position" value={v.position} onChange={set('position')} /></Row>
          {row ? <ImageUpload label={t('fields.signature')} value={v.signatureDataUrl} onChange={(d) => setV({ ...v, signatureDataUrl: d })} error={errors.signatureDataUrl?.[0]} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{tc('cancel')}</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : row ? tc('save') : t('invite')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ roles

export function RolesPage() { return <RolesInner key={useCompanyEpoch()} />; }

/** Mirrors the server's rule (the server computes it too): types with approval on that the permissions both create and approve. */
const sodOf = (types: DocType[], perms: string[]): DocType[] => types.filter((x) => perms.includes(`doc.${x}.create`) && perms.includes(`doc.${x}.approve`));

function RolesInner() {
  const t = useTranslations('settings.roles');
  const tu = useTranslations('settings.users');
  const qc = useQueryClient();
  const { me } = useMe();
  const key = [me?.activeCompanyId ?? '', 'settings', 'roles'];
  const roles = useQuery({ queryKey: key, queryFn: endpoints.listRoles, enabled: !!me });
  const [editor, setEditor] = useState<{ row?: RoleRow; seed?: RoleRow }>();
  const [removing, setRemoving] = useState<RoleRow>();
  const [notice, setNotice] = useState<string>();
  const remove = useMutation({
    mutationFn: (id: string) => endpoints.deleteRole(id),
    onMutate: () => setNotice(undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => setNotice(titleOf(e, t('title'))),
  });
  const gate = useGate(roles, 'users.manage');
  if (gate) return gate;
  const rows = roles.data!.items;
  const types = rows[0]?.approvalTypes ?? [];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
        <Button onClick={() => setEditor({})}>{t('create')}</Button>
      </div>
      {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      {rows.length === 0 ? <EmptyState title={t('empty')} /> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow>{(['name', 'permissions', 'users', 'actions'] as const).map((c) => <TableHead key={c}>{t(`columns.${c}`)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="font-medium">{r.name} <Badge variant={r.system ? 'secondary' : 'outline'}>{r.system ? t('system') : t('custom')}</Badge></div>
                    {r.description ? <div className="text-small text-muted-foreground">{r.description}</div> : null}
                    {r.sodTypes.length ? <div className="text-small text-destructive">{t('sod', { types: r.sodTypes.join(', ') })}</div> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{r.permissions.length}</TableCell>
                  <TableCell>{r.inUse ? t('inUse') : <span className="text-muted-foreground">{t('unused')}</span>}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" aria-label={`${r.system ? t('view') : t('edit')} ${r.name}`} onClick={() => setEditor({ row: r })}>{r.system ? t('view') : t('edit')}</Button>
                      <Button size="sm" variant="outline" aria-label={`${t('copy')} ${r.name}`} onClick={() => setEditor({ seed: r })}>{t('copy')}</Button>
                      {r.system ? null : <Button size="sm" variant="outline" aria-label={`${t('delete')} ${r.name}`} onClick={() => setRemoving(r)}>{t('delete')}</Button>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editor ? <RoleEditor {...editor} types={types} onClose={() => setEditor(undefined)} onSaved={() => { setEditor(undefined); void qc.invalidateQueries({ queryKey: key }); }} /> : null}
      <AlertDialog open={!!removing} onOpenChange={(o) => { if (!o) setRemoving(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t('deleteTitle', { name: removing?.name ?? '' })}</AlertDialogTitle><AlertDialogDescription>{t('deleteBody')}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tu('cancelShort')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const r = removing!; setRemoving(undefined); remove.mutate(r.id); }}>{t('deleteAction')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RoleEditor({ row, seed, types, onClose, onSaved }: { row?: RoleRow; seed?: RoleRow; types: DocType[]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('settings.roles');
  const tc = useTranslations('settings.common');
  const readOnly = !!row?.system;
  const [v, setV] = useState({ name: row?.name ?? (seed ? t('copyName', { name: seed.name }) : ''), description: row?.description ?? seed?.description ?? '', permissions: row?.permissions ?? seed?.permissions ?? [] });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failed, setFailed] = useState<string>();
  const save = useMutation({
    mutationFn: () => (row ? endpoints.updateRole(row.id, { ...v, version: row.version }) : endpoints.createRole(v)),
    onSuccess: onSaved,
    onError: (e) => { setErrors(fieldErrorsOf(e)); setFailed(titleOf(e, tc('failed'))); },
  });
  const sod = sodOf(types, v.permissions);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{readOnly ? t('viewTitle', { name: row!.name }) : row ? t('editTitle') : t('createTitle')}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setErrors({}); setFailed(undefined); save.mutate(); }}>
          {failed ? <Alert variant="destructive" role="alert"><AlertTitle>{failed}</AlertTitle></Alert> : null}
          {readOnly ? <p className="text-body text-muted-foreground">{t('readOnlyNote')}</p> : null}
          <Row id="r-name" label={t('fields.name')} error={errors.name?.[0]}><Input id="r-name" value={v.name} readOnly={readOnly} onChange={(e) => setV({ ...v, name: e.target.value })} aria-invalid={!!errors.name} /></Row>
          <Row id="r-desc" label={t('fields.description')}><Textarea id="r-desc" value={v.description} readOnly={readOnly} onChange={(e) => setV({ ...v, description: e.target.value })} /></Row>
          {sod.length ? <Alert role="status" data-testid="sod-warning"><AlertTitle>{t('sod', { types: sod.join(', ') })}</AlertTitle></Alert> : null}
          {errors.permissions?.[0] ? <p role="alert" className="text-small text-destructive">{errors.permissions[0]}</p> : null}
          <PermissionMatrix label={t('matrixLabel')} value={v.permissions} readOnly={readOnly} onChange={(permissions) => setV({ ...v, permissions })} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{tc('cancel')}</Button>
            {readOnly ? null : <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : t('save')}</Button>}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
