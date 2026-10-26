'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/app-shell/useMe';
import { isValidTin } from '@/domain/tin';
import { ApiError } from '@/lib/api/client';
import { authApi, type OnboardBody } from '@/records/auth';
import { BANKS } from '@/records/bank-accounts';

const STEPS = ['identity', 'vat', 'fiscal', 'template', 'bank', 'cutoff'] as const;
type Step = (typeof STEPS)[number];
/** Which step owns a field the server complained about. */
const STEP_OF = (field: string): Step => field.startsWith('bank.') ? 'bank' : field === 'vatRegistered' ? 'vat' : field === 'fiscalYearStartMonth' ? 'fiscal' : field === 'template' ? 'template' : field === 'cutoff' ? 'cutoff' : 'identity';
const selectClass = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body';
/** The last day of the month before the business date: the cut-off the opening-balance wizard starts with too. */
const defaultCutoff = (businessDate?: string) => { if (!businessDate) return ''; const [y, m] = businessDate.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10); };

interface Form { legalNameTh: string; taxId: string; branchCode: string; address: string; vat: 'yes' | 'no' | ''; month: number; template: string; kind: 'bank' | 'cash'; accountName: string; bankName: string; accountNo: string; cutoff: string }

/** D-03 (first run): six steps - legal identity, VAT status, fiscal year start, chart template, first bank account, opening-balance cut-off. The server creates the company through its commands, switches to it, and the wizard lands on the opening-balance wizard. */
export default function OnboardingPage() {
  const t = useTranslations('auth.onboarding');
  const tb = useTranslations('records.options.bankName');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const { me } = useMe();
  const [i, setI] = useState(0);
  const [f, setF] = useState<Form>({ legalNameTh: '', taxId: '', branchCode: '00000', address: '', vat: '', month: 1, template: 'sme-th', kind: 'bank', accountName: '', bankName: 'kbank', accountNo: '', cutoff: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string>();
  const cutoff = f.cutoff || defaultCutoff(me?.businessDate);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const step = STEPS[i];

  const finish = useMutation({
    mutationFn: () => {
      const body: OnboardBody = { legalNameTh: f.legalNameTh.trim(), taxId: f.taxId.trim(), branchCode: f.branchCode.trim(), address: f.address.trim(), vatRegistered: f.vat === 'yes', fiscalYearStartMonth: f.month, template: f.template,
        bank: f.kind === 'cash' ? { kind: 'cash', accountName: f.accountName.trim() } : { kind: 'bank', accountName: f.accountName.trim(), bankName: f.bankName, accountNo: f.accountNo.trim() }, cutoff };
      return authApi.onboard(body);
    },
    onSuccess: (r) => { void qc.invalidateQueries(); router.replace(`/accounting/opening-balances/new?cutoff=${r.cutoff}`); },
    onError: (e) => {
      const p = e instanceof ApiError ? e.problem : undefined;
      const fe = p?.fieldErrors ?? {};
      const first = Object.keys(fe)[0];
      setErrors(Object.fromEntries(Object.entries(fe).map(([k, m]) => [k, m[0]])));
      setBanner(first ? undefined : p?.title);
      setI(STEPS.indexOf(first ? STEP_OF(first) : p?.code === 'company.fiscal_year_unsupported' ? 'fiscal' : step));
    },
  });

  /** Client-side checks for the step you are leaving; the server checks everything again. */
  const check = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (step === 'identity') {
      if (!f.legalNameTh.trim()) e.legalNameTh = t('errors.name');
      if (!isValidTin(f.taxId.trim())) e.taxId = t('errors.tin');
      if (!/^\d{5}$/.test(f.branchCode.trim())) e.branchCode = t('errors.branch');
      if (!f.address.trim()) e.address = t('errors.address');
    } else if (step === 'vat') { if (!f.vat) e.vatRegistered = t('errors.vat'); }
    else if (step === 'bank') {
      if (!f.accountName.trim()) e['bank.accountName'] = t('errors.accountName');
      if (f.kind === 'bank' && !/^[\d-]{10,18}$/.test(f.accountNo.trim())) e['bank.accountNo'] = t('errors.accountNo');
    } else if (step === 'cutoff') { if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) e.cutoff = t('errors.cutoff'); }
    return e;
  };
  const next = () => { const e = check(); setErrors(e); setBanner(undefined); if (!Object.keys(e).length) { if (i === STEPS.length - 1) finish.mutate(); else setI(i + 1); } };

  const field = (id: string, label: string, input: ReactNode, error?: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {input}
      {error ? <p id={`${id}-err`} role="alert" className="text-small text-destructive">{error}</p> : null}
    </div>
  );
  const text = (k: 'legalNameTh' | 'taxId' | 'branchCode' | 'address' | 'accountName' | 'accountNo', err?: string, extra: object = {}) =>
    <Input id={`ob-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!err} aria-describedby={err ? `ob-${k}-err` : undefined} {...extra} />;
  const radio = (name: string, value: string, checked: boolean, onChange: () => void, label: string, hint?: string) => (
    <label key={value} className="flex items-start gap-2 rounded-lg border bg-card p-3">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-1 size-4" />
      <span><span className="block font-medium">{label}</span>{hint ? <span className="block text-small text-muted-foreground">{hint}</span> : null}</span>
    </label>
  );

  return (
    <main id="content" className="mx-auto grid min-h-dvh max-w-2xl content-start gap-5 p-4 md:p-8">
      <title>{t('title')}</title>
      <div>
        <h1 className="text-title font-semibold">{t('title')}</h1>
        <p className="text-body text-muted-foreground">{t('lead')}</p>
      </div>
      <ol className="flex flex-wrap gap-2 text-small" aria-label={t('stepsLabel')}>
        {STEPS.map((s, n) => <li key={s} aria-current={n === i ? 'step' : undefined} className={`rounded-full border px-3 py-1 ${n === i ? 'bg-primary text-primary-foreground' : n < i ? 'bg-muted' : 'text-muted-foreground'}`}>{n + 1}. {t(`steps.${s}`)}</li>)}
      </ol>
      <form className="grid gap-4 rounded-lg border bg-card p-4" onSubmit={(e) => { e.preventDefault(); next(); }} noValidate>
        <fieldset className="grid gap-4">
          <legend className="mb-2 text-section font-semibold">{t(`steps.${step}`)} <span className="text-small font-normal text-muted-foreground">({t('progress', { n: i + 1, total: STEPS.length })})</span></legend>
          {step === 'identity' ? (<>
            {field('ob-legalNameTh', t('fields.legalNameTh'), text('legalNameTh', errors.legalNameTh, { autoFocus: true }), errors.legalNameTh)}
            {field('ob-taxId', t('fields.taxId'), text('taxId', errors.taxId, { inputMode: 'numeric', maxLength: 13 }), errors.taxId)}
            {field('ob-branchCode', t('fields.branchCode'), text('branchCode', errors.branchCode, { inputMode: 'numeric', maxLength: 5 }), errors.branchCode)}
            {field('ob-address', t('fields.address'), text('address', errors.address), errors.address)}
          </>) : null}
          {step === 'vat' ? (<div className="grid gap-2">
            {radio('vat', 'yes', f.vat === 'yes', () => set('vat', 'yes'), t('vat.yes'), t('vat.yesHint'))}
            {radio('vat', 'no', f.vat === 'no', () => set('vat', 'no'), t('vat.no'), t('vat.noHint'))}
            {errors.vatRegistered ? <p role="alert" className="text-small text-destructive">{errors.vatRegistered}</p> : null}
          </div>) : null}
          {step === 'fiscal' ? (<>
            {field('ob-month', t('fields.fiscalMonth'), <select id="ob-month" className={selectClass} value={f.month} onChange={(e) => set('month', Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, m) => <option key={m} value={m + 1}>{new Date(2026, m, 1).toLocaleDateString(locale === 'en' ? 'en-GB' : 'th-TH', { month: 'long' })}</option>)}
            </select>)}
            <p className="text-small text-muted-foreground">{t('fiscalNote')}</p>
          </>) : null}
          {step === 'template' ? <div className="grid gap-2">{radio('template', 'sme-th', f.template === 'sme-th', () => set('template', 'sme-th'), t('template.smeTh'), t('template.smeThHint'))}</div> : null}
          {step === 'bank' ? (<>
            <div className="grid gap-2 sm:grid-cols-2">
              {radio('kind', 'bank', f.kind === 'bank', () => set('kind', 'bank'), t('bank.bank'))}
              {radio('kind', 'cash', f.kind === 'cash', () => set('kind', 'cash'), t('bank.cash'))}
            </div>
            {field('ob-accountName', t('fields.accountName'), text('accountName', errors['bank.accountName']), errors['bank.accountName'])}
            {f.kind === 'bank' ? (<>
              {field('ob-bankName', t('fields.bankName'), <select id="ob-bankName" className={selectClass} value={f.bankName} onChange={(e) => set('bankName', e.target.value)}>{BANKS.map((b) => <option key={b} value={b}>{tb(b)}</option>)}</select>, errors['bank.bankName'])}
              {field('ob-accountNo', t('fields.accountNo'), text('accountNo', errors['bank.accountNo'], { inputMode: 'numeric' }), errors['bank.accountNo'])}
            </>) : null}
          </>) : null}
          {step === 'cutoff' ? (<>
            {field('ob-cutoff', t('fields.cutoff'), <Input id="ob-cutoff" type="date" value={cutoff} onChange={(e) => set('cutoff', e.target.value)} aria-invalid={!!errors.cutoff} aria-describedby={errors.cutoff ? 'ob-cutoff-err' : undefined} />, errors.cutoff)}
            <p className="text-small text-muted-foreground">{t('cutoffNote')}</p>
          </>) : null}
        </fieldset>
        {banner ? <Alert variant="destructive" role="alert"><AlertTitle>{banner}</AlertTitle></Alert> : null}
        <div className="flex flex-wrap justify-between gap-2">
          <Button type="button" variant="outline" disabled={i === 0 || finish.isPending} onClick={() => { setI(i - 1); setErrors({}); setBanner(undefined); }}>{t('back')}</Button>
          <Button type="submit" disabled={finish.isPending}>{i === STEPS.length - 1 ? t('finish') : t('next')}</Button>
        </div>
      </form>
      <p className="text-small"><Link className="underline underline-offset-2" href="/login">{t('toLogin')}</Link></p>
    </main>
  );
}
