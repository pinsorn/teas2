'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useCompanyEpoch } from '@/app-shell/useCompanyEpoch';
import { isForbidden, useMe } from '@/app-shell/useMe';
import { DOC_TYPES } from '@/domain/doc-types';
import type { CompanySettings, DocType } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { ImageUpload } from '@/kit/settings/ImageUpload';
import { SettingsSection } from '@/kit/settings/SettingsSection';
import { ErrorState } from '@/kit/states/ErrorState';
import { ForbiddenState } from '@/kit/states/ForbiddenState';
import { LoadingState } from '@/kit/states/LoadingState';

type Errors = Record<string, string[]>;
/** m3: a stale save (409) reloads the page's data and reopens every section from it. */
const Reload = createContext<() => void>(() => undefined);
const NO_NOTE: DocType[] = ['WT', 'JV', 'FA', 'DP', 'PR', 'OB']; // no notes field on their paper
const select = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none disabled:bg-muted';

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p id={`${id}-err`} role="alert" className="text-small text-destructive">{error}</p> : null}
    </div>
  );
}

/** ST1: the company profile, one audited Save per section. Papers do not print the pictures yet (the snapshot at issue is ST3). */
export default function CompanySettingsPage() {
  return <Inner key={useCompanyEpoch()} />;
}

function Inner() {
  const t = useTranslations('settings.company');
  const { me, isError: meFailed, error: meError, refetch: refetchMe } = useMe();
  const id = me?.activeCompanyId ?? '';
  const q = useQuery({ queryKey: [id, 'settings', 'company'], queryFn: () => endpoints.getCompanySettings(id), enabled: !!id });
  const qc = useQueryClient();
  const [round, setRound] = useState(0);
  const [stale, setStale] = useState(false);
  const reload = () => { void qc.refetchQueries({ queryKey: [id, 'settings', 'company'] }).then(() => { setStale(true); setRound((n) => n + 1); }); };
  if (meFailed && !me) return <ErrorState error={meError} onRetry={() => void refetchMe()} />;
  if (q.isError && !q.data) return isForbidden(q.error) ? <ForbiddenState permission="settings.manage" detail={q.error instanceof ApiError ? q.error.problem.detail : undefined} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!me || !q.data) return <LoadingState />;
  const co = q.data;
  return (
    <Reload.Provider value={reload}>
    <div className="grid gap-4" key={round}>
      <div><h1 className="text-title font-semibold">{t('title')}</h1><p className="text-body text-muted-foreground">{t('lead')}</p></div>
      {stale ? <Alert role="alert"><AlertTitle>{t('conflict')}</AlertTitle></Alert> : null}
      <Identity co={co} />
      <Contact co={co} />
      <Payroll co={co} />
      <Fiscal co={co} />
      <Images co={co} />
      <Notes co={co} vat={me.vatRegistered} />
    </div>
    </Reload.Provider>
  );
}

/** One section's Save: PUTs, puts the answer in the cache, keeps the server's field errors for the fields. */
function useSection(co: CompanySettings, section: string) {
  const qc = useQueryClient();
  const reload = useContext(Reload);
  const [errors, setErrors] = useState<Errors>({});
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => endpoints.saveCompanySection(co.id, section, { ...body, version: co.version ?? 1 }),
    onMutate: () => setErrors({}),
    onSuccess: (next) => qc.setQueryData([co.id, 'settings', 'company'], next),
    onError: (e) => { if (e instanceof ApiError && e.code === 'record.version_conflict') reload(); },
  });
  return { errors, setErrors, save };
}
const err = (e: Errors, k: string) => e[k]?.[0];
const text = (v: string | undefined) => v ?? '';

function Identity({ co }: { co: CompanySettings }) {
  const t = useTranslations('settings.company');
  const [editing, setEditing] = useState(false);
  const [ask, setAsk] = useState(false);
  const [v, setV] = useState({ legalNameTh: co.legalNameTh, legalNameEn: text(co.legalNameEn), taxId: co.taxId, branchCode: co.branchCode, registrationNo: text(co.registrationNo), address: co.address, paidUpCapital: text(co.paidUpCapital) });
  const { errors, setErrors, save } = useSection(co, 'identity');
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const F = (k: keyof typeof v, input: ReactNode) => <Field id={`i-${k}`} label={t(`fields.${k}`)} error={err(errors, k)}>{input}</Field>;
  const view = (k: keyof typeof v) => <p className="min-h-(--ctl-h) py-2 text-body">{v[k] || '–'}</p>;
  const inputFor = (k: keyof typeof v, extra: object = {}) => (editing
    ? <Input id={`i-${k}`} value={v[k]} onChange={set(k)} aria-invalid={!!err(errors, k)} aria-describedby={err(errors, k) ? `i-${k}-err` : undefined} {...extra} />
    : view(k));
  return (
    <SettingsSection title={t('identity.title')} description={t('identity.description')} hideSave={!editing}
      onSave={async () => { await save.mutateAsync({ ...v, confirm: true }); setEditing(false); }} onError={(e) => setErrors(e.problem.fieldErrors ?? {})}>
      <div className="grid gap-3 sm:grid-cols-2">
        {F('legalNameTh', inputFor('legalNameTh'))}
        {F('legalNameEn', inputFor('legalNameEn'))}
        {F('taxId', inputFor('taxId', { inputMode: 'numeric', maxLength: 13 }))}
        {F('branchCode', inputFor('branchCode', { inputMode: 'numeric', maxLength: 5 }))}
        {F('registrationNo', inputFor('registrationNo'))}
        {F('paidUpCapital', inputFor('paidUpCapital', { inputMode: 'decimal' }))}
        <div className="sm:col-span-2">{F('address', editing ? <Textarea id="i-address" value={v.address} onChange={set('address')} aria-invalid={!!err(errors, 'address')} /> : view('address'))}</div>
        <div className="grid gap-1 sm:col-span-2">
          <span className="text-body font-medium">{t('identity.vatStatus')}</span>
          <p className="text-body" data-testid="vat-status">{co.vatRegistered ? t('identity.vatYes') : t('identity.vatNo')}</p>
          <p className="text-small text-muted-foreground">{t('identity.vatNote')}</p>
        </div>
      </div>
      {editing ? null : <div><Button type="button" variant="outline" onClick={() => setAsk(true)}>{t('identity.edit')}</Button></div>}
      {editing ? <div><Button type="button" variant="ghost" onClick={() => { setEditing(false); setErrors({}); setV({ legalNameTh: co.legalNameTh, legalNameEn: text(co.legalNameEn), taxId: co.taxId, branchCode: co.branchCode, registrationNo: text(co.registrationNo), address: co.address, paidUpCapital: text(co.paidUpCapital) }); }}>{t('identity.cancelEdit')}</Button></div> : null}
      <AlertDialog open={ask} onOpenChange={setAsk}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t('identity.confirmTitle')}</AlertDialogTitle><AlertDialogDescription>{t('identity.confirmBody')}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('identity.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => setEditing(true)}>{t('identity.confirmAction')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function Contact({ co }: { co: CompanySettings }) {
  const t = useTranslations('settings.company');
  const [v, setV] = useState({ tradeName: text(co.tradeName), phone: text(co.phone), email: text(co.email), website: text(co.website) });
  const { errors, setErrors, save } = useSection(co, 'contact');
  return (
    <SettingsSection title={t('contact.title')} description={t('contact.description')} onSave={() => save.mutateAsync(v)} onError={(e) => setErrors(e.problem.fieldErrors ?? {})}>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['tradeName', 'phone', 'email', 'website'] as const).map((k) => (
          <Field key={k} id={`c-${k}`} label={t(`fields.${k}`)} error={err(errors, k)}>
            <Input id={`c-${k}`} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} aria-invalid={!!err(errors, k)} aria-describedby={err(errors, k) ? `c-${k}-err` : undefined} />
          </Field>
        ))}
      </div>
    </SettingsSection>
  );
}

function Payroll({ co }: { co: CompanySettings }) {
  const t = useTranslations('settings.company');
  const [acct, setAcct] = useState(text(co.ssoEmployerAccountNo));
  const { errors, setErrors, save } = useSection(co, 'payroll');
  return (
    <SettingsSection title={t('payroll.title')} description={t('payroll.description')} onSave={() => save.mutateAsync({ ssoEmployerAccountNo: acct })} onError={(e) => setErrors(e.problem.fieldErrors ?? {})}>
      <div className="max-w-sm">
        <Field id="p-sso" label={t('fields.ssoEmployerAccountNo')} error={err(errors, 'ssoEmployerAccountNo')}>
          <Input id="p-sso" inputMode="numeric" maxLength={10} value={acct} onChange={(e) => setAcct(e.target.value)} aria-invalid={!!err(errors, 'ssoEmployerAccountNo')} aria-describedby={err(errors, 'ssoEmployerAccountNo') ? 'p-sso-err' : undefined} />
        </Field>
      </div>
    </SettingsSection>
  );
}

function Fiscal({ co }: { co: CompanySettings }) {
  const t = useTranslations('settings.company');
  const [m, setM] = useState(String(co.fiscalYearStartMonth));
  const { errors, setErrors, save } = useSection(co, 'fiscal');
  const locked = co.fiscalYearLocked;
  return (
    <SettingsSection title={t('fiscal.title')} description={t('fiscal.description')} hideSave={locked} onSave={() => save.mutateAsync({ fiscalYearStartMonth: Number(m) })} onError={(e) => setErrors(e.problem.fieldErrors ?? {})}>
      {locked ? (
        <div className="grid gap-1" data-testid="fiscal-locked">
          <p className="text-body"><span className="font-medium">{t('fields.fiscalYearStartMonth')}:</span> {t(`months.${co.fiscalYearStartMonth}` as never)}</p>
          <p className="text-body text-muted-foreground">{t('fiscal.locked')} {t('fiscal.lockedExit')}</p>
          <p><Link href="/accounting/period-close" className="text-primary underline underline-offset-2">{t('fiscal.lockedLink')}</Link></p>
        </div>
      ) : (
        <div className="max-w-sm">
          <Field id="f-month" label={t('fields.fiscalYearStartMonth')} error={err(errors, 'fiscalYearStartMonth')}>
            <select id="f-month" className={select} value={m} onChange={(e) => setM(e.target.value)}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{t(`months.${i + 1}` as never)}</option>)}
            </select>
          </Field>
        </div>
      )}
    </SettingsSection>
  );
}

function Images({ co }: { co: CompanySettings }) {
  const t = useTranslations('settings.company');
  const [v, setV] = useState({ logoDataUrl: text(co.logoDataUrl), stampDataUrl: text(co.stampDataUrl) });
  const { errors, setErrors, save } = useSection(co, 'images');
  return (
    <SettingsSection title={t('images.title')} description={t('images.description')} onSave={() => save.mutateAsync(v)} onError={(e) => setErrors(e.problem.fieldErrors ?? {})}>
      <div className="grid gap-4 sm:grid-cols-2">
        <ImageUpload label={t('fields.logoDataUrl')} value={v.logoDataUrl} onChange={(d) => setV({ ...v, logoDataUrl: d })} error={err(errors, 'logoDataUrl')} />
        <ImageUpload label={t('fields.stampDataUrl')} value={v.stampDataUrl} onChange={(d) => setV({ ...v, stampDataUrl: d })} error={err(errors, 'stampDataUrl')} />
      </div>
    </SettingsSection>
  );
}

function Notes({ co, vat }: { co: CompanySettings; vat: boolean }) {
  const t = useTranslations('settings.company');
  const td = useTranslations('docTypes');
  const types = (Object.keys(DOC_TYPES) as DocType[]).filter((x) => !NO_NOTE.includes(x) && (DOC_TYPES[x].vat === 'both' || (DOC_TYPES[x].vat === 'vat-only') === vat));
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(types.map((x) => [x, co.defaultNotes?.[x] ?? ''])));
  const { errors, setErrors, save } = useSection(co, 'notes');
  return (
    <SettingsSection title={t('notes.title')} description={t('notes.description')} onSave={() => save.mutateAsync({ defaultNotes: v })} onError={(e) => setErrors(e.problem.fieldErrors ?? {})}>
      <div className="grid gap-3 sm:grid-cols-2">
        {types.map((x) => (
          <Field key={x} id={`n-${x}`} label={td(`${x}.title` as never)} error={err(errors, `defaultNotes.${x}`)}>
            <Textarea id={`n-${x}`} value={v[x]} onChange={(e) => setV({ ...v, [x]: e.target.value })} rows={2} />
          </Field>
        ))}
      </div>
    </SettingsSection>
  );
}
