'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { DOC_TYPES } from '@/domain/doc-types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { type ExpenseCategoryItem, type ExpenseCategoriesView, categoryApi } from '@/records/expense-categories';
import { POSTING_LEVELS, type PostingLevel, type PostingRuleRow, type PostingRulesView, postingApi } from '@/records/posting-rules';
import { PostingPreview } from '@/kit/settings/PostingPreview';
import { EmptyState } from '@/kit/states/EmptyState';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none aria-invalid:border-2 aria-invalid:border-destructive';
type FieldErrors = Record<string, string[]>;
const fieldErrorsOf = (e: unknown): FieldErrors => (e instanceof ApiError ? e.problem.fieldErrors ?? {} : {});
const titleOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.problem.title + (e.problem.detail ? ` ${e.problem.detail}` : '') : fallback);
const GROUPS = ['general', 'major', 'government', 'foreign'];
const KEYED_DEFAULTS = ['PND1', 'PND2', 'PND3', 'PND53', 'PND54', 'loss'];
const LEDGER_TYPES = Object.keys(DOC_TYPES).filter((t) => DOC_TYPES[t as keyof typeof DOC_TYPES].ledger);

function Row({ label, error, children, id }: { label: string; error?: string; children: ReactNode; id: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
    </div>
  );
}

/** ST2: the posting rules (SP0 §5.5), the expense categories and the test of the resolution order. A change applies to the NEXT posting only: what is already posted never moves. */
export default function PostingPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('settings.posting');
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const id = me?.activeCompanyId ?? '';
  const rules = useQuery({ queryKey: [id, 'settings', 'posting', 'rules'], queryFn: postingApi.rules, enabled: !!id });
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (rules.isError && !rules.data) return isForbidden(rules.error) ? <ForbiddenState permission="ledger.posting.manage" detail={rules.error instanceof ApiError ? rules.error.problem.detail : undefined} /> : <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />;
  if (!me || !rules.data) return <LoadingState />;
  return (
    <div className="grid gap-4">
      <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      <Tabs defaultValue="rules">
        <TabsList aria-label={t('tabsLabel')} className="h-auto max-w-full flex-wrap justify-start">
          {(['rules', 'categories', 'preview'] as const).map((k) => <TabsTrigger key={k} value={k}>{t(`tabs.${k}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="rules"><RulesTab view={rules.data} /></TabsContent>
        <TabsContent value="categories"><CategoriesTab view={rules.data} /></TabsContent>
        <TabsContent value="preview"><PostingPreview /></TabsContent>
      </Tabs>
    </div>
  );
}

// ------------------------------------------------------------------ rules

function RulesTab({ view }: { view: PostingRulesView }) {
  const t = useTranslations('settings.posting');
  const qc = useQueryClient();
  const { me } = useMe();
  const key = [me?.activeCompanyId ?? '', 'settings', 'posting', 'rules'];
  const [level, setLevel] = useState<PostingLevel | ''>('');
  const [form, setForm] = useState<{ row?: PostingRuleRow } | undefined>();
  const [del, setDel] = useState<PostingRuleRow>();
  const [notice, setNotice] = useState<string>();
  const remove = useMutation({
    mutationFn: (r: PostingRuleRow) => postingApi.remove(r.id, r.version),
    onMutate: () => setNotice(undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => setNotice(titleOf(e, t('title'))),
  });
  const rows = view.items.filter((r) => !level || r.level === level);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="rule-level-filter">{t('filterLevel')}</Label>
          <select id="rule-level-filter" className={select} value={level} onChange={(e) => setLevel(e.target.value as PostingLevel | '')}>
            <option value="">{t('allLevels')}</option>
            {POSTING_LEVELS.map((l) => <option key={l} value={l}>{t(`levels.${l}`)}</option>)}
          </select>
        </div>
        <Button onClick={() => setForm({})}>{t('addRule')}</Button>
      </div>
      {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      {rows.length === 0 ? <EmptyState title={t('empty')} /> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow>{(['level', 'key', 'role', 'account', 'actions'] as const).map((c) => <TableHead key={c}>{t(`columns.${c}`)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{t(`levels.${r.level}`)}</TableCell>
                  <TableCell>{r.key ?? <span className="text-muted-foreground">–</span>}</TableCell>
                  <TableCell>{t(`roleNames.${r.role}`)} <span className="text-small text-muted-foreground">({r.role})</span></TableCell>
                  <TableCell className="tabular-nums">{r.accountCode} {r.accountName}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" aria-label={t('editRule', { role: t(`roleNames.${r.role}`), level: t(`levels.${r.level}`), key: r.key ?? '' })} onClick={() => setForm({ row: r })}>{t('edit')}</Button>
                      {r.required ? <Badge variant="outline" title={t('requiredHint')}>{t('required')}</Badge>
                        : <Button size="sm" variant="outline" aria-label={t('deleteRule', { role: t(`roleNames.${r.role}`), level: t(`levels.${r.level}`), key: r.key ?? '' })} onClick={() => setDel(r)}>{t('delete')}</Button>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {form ? <RuleForm view={view} row={form.row} onClose={() => setForm(undefined)} onDone={() => { setForm(undefined); void qc.invalidateQueries({ queryKey: key }); }} /> : null}
      <AlertDialog open={!!del} onOpenChange={(o) => { if (!o) setDel(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle><AlertDialogDescription>{del ? t('deleteBody', { role: t(`roleNames.${del.role}`), level: t(`levels.${del.level}`), key: del.key ?? '' }) : null}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const r = del!; setDel(undefined); remove.mutate(r); }}>{t('delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RuleForm({ view, row, onClose, onDone }: { view: PostingRulesView; row?: PostingRuleRow; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('settings.posting');
  const tc = useTranslations('settings.common');
  const tg = useTranslations('records.options.partyGroup');
  const { me } = useMe();
  const cats = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'expense-categories'], queryFn: categoryApi.list, enabled: !!me });
  const [v, setV] = useState({ level: row?.level ?? 'item' as PostingLevel, key: row?.key ?? '', role: row?.role ?? '', accountCode: row?.accountCode ?? '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failed, setFailed] = useState<string>();
  const role = view.roles.find((r) => r.role === v.role);
  const names = new Map(view.accounts.map((a) => [a.code, a.nameTh]));
  const save = useMutation({
    mutationFn: () => (row ? postingApi.update(row.id, { accountCode: v.accountCode, version: row.version }) : postingApi.create({ level: v.level, key: v.key || undefined, role: v.role, accountCode: v.accountCode })),
    onSuccess: onDone,
    onError: (e) => { setErrors(fieldErrorsOf(e)); setFailed(titleOf(e, tc('failed'))); },
  });
  const catKeys = [...new Set([...(cats.data?.items.map((c) => c.code) ?? []), ...(cats.data?.assetClasses ?? [])])];
  const keyField = (() => {
    const set = (key: string) => setV({ ...v, key });
    if (row) return <Input id="r-key" value={v.key} readOnly />;
    switch (v.level) {
      case 'category': return <select id="r-key" className={select} value={v.key} onChange={(e) => set(e.target.value)}><option value="">{t('pickKey')}</option>{catKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select>;
      case 'partyGroup': return <select id="r-key" className={select} value={v.key} onChange={(e) => set(e.target.value)}><option value="">{t('pickKey')}</option>{GROUPS.map((k) => <option key={k} value={k}>{tg(k)}</option>)}</select>;
      case 'docType': return <select id="r-key" className={select} value={v.key} onChange={(e) => set(e.target.value)}><option value="">{t('pickKey')}</option>{LEDGER_TYPES.map((k) => <option key={k} value={k}>{k}</option>)}</select>;
      case 'default': return <select id="r-key" className={select} value={v.key} onChange={(e) => set(e.target.value)}><option value="">{t('keyNone')}</option>{KEYED_DEFAULTS.map((k) => <option key={k} value={k}>{k}</option>)}</select>;
      default: return <Input id="r-key" value={v.key} onChange={(e) => set(e.target.value)} placeholder={t('itemKeyHint')} autoComplete="off" />;
    }
  })();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>{row ? t('editTitle') : t('addTitle')}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setErrors({}); setFailed(undefined); save.mutate(); }}>
          {failed ? <Alert variant="destructive" role="alert"><AlertTitle>{failed}</AlertTitle></Alert> : null}
          <Row id="r-level" label={t('fields.level')} error={errors.level?.[0]}>
            <select id="r-level" className={select} value={v.level} disabled={!!row} onChange={(e) => setV({ ...v, level: e.target.value as PostingLevel, key: '' })}>
              {POSTING_LEVELS.map((l) => <option key={l} value={l}>{t(`levels.${l}`)}</option>)}
            </select>
          </Row>
          <Row id="r-key" label={t('fields.key')} error={errors.key?.[0]}>{keyField}</Row>
          <Row id="r-role" label={t('fields.role')} error={errors.role?.[0]}>
            <select id="r-role" className={select} value={v.role} disabled={!!row} onChange={(e) => setV({ ...v, role: e.target.value, accountCode: '' })}>
              <option value="">{t('pickRole')}</option>
              {view.roles.map((r) => <option key={r.role} value={r.role}>{t(`roleNames.${r.role}`)} ({r.role})</option>)}
            </select>
          </Row>
          <Row id="r-account" label={t('fields.account')} error={errors.accountCode?.[0]}>
            <select id="r-account" className={select} value={v.accountCode} disabled={!role} onChange={(e) => setV({ ...v, accountCode: e.target.value })}>
              <option value="">{t('pickAccount')}</option>
              {v.accountCode && !role?.accountCodes.includes(v.accountCode) && <option value={v.accountCode}>{v.accountCode}</option>}
              {role?.accountCodes.map((c) => <option key={c} value={c}>{c} {names.get(c)}</option>)}
            </select>
            {role ? <p className="text-small text-muted-foreground">{t('accepts', { classes: role.accepts })}</p> : null}
          </Row>
          <p className="text-small text-muted-foreground">{t('nextOnly')}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{tc('cancel')}</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : tc('save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ expense categories

function CategoriesTab({ view }: { view: PostingRulesView }) {
  const t = useTranslations('settings.categories');
  const qc = useQueryClient();
  const { me } = useMe();
  const key = [me?.activeCompanyId ?? '', 'expense-categories'];
  const q = useQuery({ queryKey: key, queryFn: categoryApi.list, enabled: !!me });
  const [form, setForm] = useState<{ row?: ExpenseCategoryItem } | undefined>();
  const [del, setDel] = useState<ExpenseCategoryItem>();
  const [notice, setNotice] = useState<string>();
  const remove = useMutation({
    mutationFn: (c: ExpenseCategoryItem) => categoryApi.remove(c.code, c.version),
    onMutate: () => setNotice(undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => setNotice(titleOf(e, t('title'))),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <LoadingState rows={4} />;
  const rows = q.data.items;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-body text-muted-foreground">{t('lead')}</p>
        <Button onClick={() => setForm({})}>{t('add')}</Button>
      </div>
      {notice ? <Alert variant="destructive" role="alert"><AlertTitle>{notice}</AlertTitle></Alert> : null}
      {rows.length === 0 ? <EmptyState title={t('empty')} /> : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow>{(['code', 'name', 'account', 'vat', 'capex', 'status', 'actions'] as const).map((c) => <TableHead key={c}>{t(`columns.${c}`)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.code} className={c.active ? undefined : 'text-muted-foreground'}>
                  <TableCell>{c.code}</TableCell>
                  <TableCell>{c.nameTh}{c.parent ? <span className="text-small text-muted-foreground"> ({t('under', { parent: c.parent })})</span> : null}</TableCell>
                  <TableCell className="tabular-nums">{c.capex ? t('capexTo', { cls: c.assetClass ?? '' }) : c.accountCode}</TableCell>
                  <TableCell>{c.recoverableVat ? t('yes') : t('no')}</TableCell>
                  <TableCell>{c.capex ? t('yes') : t('no')}</TableCell>
                  <TableCell>{c.active ? t('active') : t('inactive')}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" aria-label={t('editOf', { name: c.nameTh })} onClick={() => setForm({ row: c })}>{t('edit')}</Button>
                      <Button size="sm" variant="outline" aria-label={t('deleteOf', { name: c.nameTh })} onClick={() => setDel(c)}>{t('delete')}</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {form ? <CategoryForm view={view} cats={q.data} row={form.row} onClose={() => setForm(undefined)} onDone={() => { setForm(undefined); void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: [me?.activeCompanyId ?? '', 'settings', 'posting', 'rules'] }); }} /> : null}
      <AlertDialog open={!!del} onOpenChange={(o) => { if (!o) setDel(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t('deleteTitle', { name: del?.nameTh ?? '' })}</AlertDialogTitle><AlertDialogDescription>{t('deleteBody')}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const c = del!; setDel(undefined); remove.mutate(c); }}>{t('delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CategoryForm({ view, cats, row, onClose, onDone }: { view: PostingRulesView; cats: ExpenseCategoriesView; row?: ExpenseCategoryItem; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('settings.categories');
  const tc = useTranslations('settings.common');
  const { me } = useMe();
  const wht = useQuery({ queryKey: [me?.activeCompanyId ?? '', 'wht-types'], queryFn: endpoints.whtTypes, enabled: !!me });
  const [v, setV] = useState({ code: row?.code ?? '', nameTh: row?.nameTh ?? '', accountCode: row?.accountCode ?? '', recoverableVat: row?.recoverableVat ?? true, capex: row?.capex ?? false, assetClass: row?.assetClass ?? '',
    defaultWhtType: row?.defaultWhtType ?? '', parent: row?.parent ?? '', active: row?.active ?? true });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failed, setFailed] = useState<string>();
  const expense = view.roles.find((r) => r.role === 'Expense');
  const names = new Map(view.accounts.map((a) => [a.code, a.nameTh]));
  const save = useMutation({
    mutationFn: () => {
      const body = { nameTh: v.nameTh, recoverableVat: v.recoverableVat, capex: v.capex, active: v.active, ...(v.capex ? { assetClass: v.assetClass } : { accountCode: v.accountCode }), defaultWhtType: v.defaultWhtType, parent: v.parent };
      return row ? categoryApi.update(row.code, { ...body, version: row.version }) : categoryApi.create({ ...body, code: v.code });
    },
    onSuccess: onDone,
    onError: (e) => { setErrors(fieldErrorsOf(e)); setFailed(titleOf(e, tc('failed'))); },
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>{row ? t('editTitle', { name: row.nameTh }) : t('addTitle')}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setErrors({}); setFailed(undefined); save.mutate(); }}>
          {failed ? <Alert variant="destructive" role="alert"><AlertTitle>{failed}</AlertTitle></Alert> : null}
          <Row id="c-code" label={t('fields.code')} error={errors.code?.[0]}><Input id="c-code" value={v.code} readOnly={!!row} onChange={(e) => setV({ ...v, code: e.target.value })} autoComplete="off" aria-invalid={!!errors.code} /></Row>
          <Row id="c-name" label={t('fields.name')} error={errors.nameTh?.[0]}><Input id="c-name" value={v.nameTh} onChange={(e) => setV({ ...v, nameTh: e.target.value })} aria-invalid={!!errors.nameTh} /></Row>
          <div className="flex items-center gap-2"><Checkbox id="c-capex" checked={v.capex} onCheckedChange={(c) => setV({ ...v, capex: c === true })} /><Label htmlFor="c-capex">{t('fields.capex')}</Label></div>
          {v.capex ? (
            <Row id="c-class" label={t('fields.assetClass')} error={errors.assetClass?.[0]}>
              <select id="c-class" className={select} value={v.assetClass} onChange={(e) => setV({ ...v, assetClass: e.target.value })} aria-invalid={!!errors.assetClass}>
                <option value="">{t('pickAssetClass')}</option>
                {cats.assetClasses.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Row>
          ) : (
            <Row id="c-account" label={t('fields.account')} error={errors.accountCode?.[0]}>
              <select id="c-account" className={select} value={v.accountCode} onChange={(e) => setV({ ...v, accountCode: e.target.value })} aria-invalid={!!errors.accountCode}>
                <option value="">{t('pickAccount')}</option>
                {v.accountCode && !expense?.accountCodes.includes(v.accountCode) && <option value={v.accountCode}>{v.accountCode}</option>}
                {expense?.accountCodes.map((c) => <option key={c} value={c}>{c} {names.get(c)}</option>)}
              </select>
              <p className="text-small text-muted-foreground">{t('accepts', { classes: expense?.accepts ?? '' })}</p>
            </Row>
          )}
          <div className="flex items-center gap-2"><Checkbox id="c-vat" checked={v.recoverableVat} onCheckedChange={(c) => setV({ ...v, recoverableVat: c === true })} /><Label htmlFor="c-vat">{t('fields.vat')}</Label></div>
          <Row id="c-wht" label={t('fields.wht')} error={errors.defaultWhtType?.[0]}>
            <select id="c-wht" className={select} value={v.defaultWhtType} onChange={(e) => setV({ ...v, defaultWhtType: e.target.value })}>
              <option value="">{t('none')}</option>
              {wht.data?.map((w) => <option key={w.code} value={w.code}>{w.nameTh} {w.rate}</option>)}
            </select>
          </Row>
          <Row id="c-parent" label={t('fields.parent')} error={errors.parent?.[0]}>
            <select id="c-parent" className={select} value={v.parent} onChange={(e) => setV({ ...v, parent: e.target.value })}>
              <option value="">{t('none')}</option>
              {cats.items.filter((c) => c.code !== row?.code).map((c) => <option key={c.code} value={c.code}>{c.nameTh}</option>)}
            </select>
          </Row>
          {row ? <div className="flex items-center gap-2"><Checkbox id="c-active" checked={v.active} onCheckedChange={(c) => setV({ ...v, active: c === true })} /><Label htmlFor="c-active">{t('fields.active')}</Label></div> : null}
          <p className="text-small text-muted-foreground">{t('nextOnly')}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{tc('cancel')}</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? tc('saving') : tc('save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
