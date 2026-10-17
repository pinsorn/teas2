'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/app-shell/useMe';
import type { RecordRow } from '@/domain/records';
import type { Doc } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';

export const selectClass = 'h-(--ctl-h) w-full rounded-lg border border-input bg-card px-3 text-body outline-none';
export const FREQUENCIES = ['monthly', 'quarterly', 'yearly'] as const;
const EXPENSE_CLASSES = ['cost-of-sales', 'selling-admin-expense', 'other-expense', 'finance-cost'];
/** The same day next month, clamped to the month end. */
export const addMonthIso = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = y * 12 + m, ny = Math.floor(t / 12), nm = (t % 12) + 1, dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
};

export function FormRow({ label, htmlFor, error, children }: { label: string; htmlFor: string; error?: string; children: ReactNode }) {
  return <div className="grid gap-1.5"><Label htmlFor={htmlFor}>{label}</Label>{children}{error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}</div>;
}

/** The server's refusal, in place: its title (the field messages show under their fields). */
export function Problem({ error }: { error: unknown }) {
  const tp = useTranslations('problem');
  if (!error) return null;
  return <Alert variant="destructive" role="alert"><AlertTitle>{error instanceof ApiError ? error.problem.title : tp('default')}</AlertTitle></Alert>;
}
export const fieldError = (e: unknown, key: string) => (e instanceof ApiError ? e.problem.fieldErrors?.[key]?.[0] : undefined);

/** Shared by both create dialogs: one idempotency key per opening; success lands on the new schedule. */
function useCreate(onClose: () => void) {
  const qc = useQueryClient();
  const router = useRouter();
  const { me } = useMe();
  const key = useRef(crypto.randomUUID());
  return useMutation({
    mutationFn: (values: Record<string, unknown>) => endpoints.createRecord('schedule', values, key.current),
    onSuccess: async (row: RecordRow) => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId] }); onClose(); router.push(`/accounting/schedules/${row.id}`); },
  });
}

/** "ตั้งเป็นรายการซ้ำ": the document becomes a frozen template; each run makes a draft dated the next run (it never issues). */
export function RecurringDialog({ doc, label, onClose }: { doc: Doc; label: string; onClose: () => void }) {
  const t = useTranslations('schedules');
  const id = useId();
  const [name, setName] = useState(`${label}${doc.party?.name ? ` · ${doc.party.name}` : ''}`);
  const [frequency, setFrequency] = useState<(typeof FREQUENCIES)[number]>('monthly');
  const [nextRun, setNextRun] = useState(addMonthIso(doc.header.documentDate));
  const [endAfter, setEndAfter] = useState('');
  const create = useCreate(onClose);
  const submit = () => create.mutate({ kind: 'recurring', docId: doc.id, name: name.trim(), frequency, nextRun, ...(endAfter.trim() ? { endAfter: Number(endAfter) } : {}) });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('recurring.title', { doc: label })}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <p className="text-muted-foreground">{t('recurring.body')}</p>
          <FormRow label={t('fields.name')} htmlFor={`${id}-name`} error={fieldError(create.error, 'name')}><Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} /></FormRow>
          <FormRow label={t('fields.frequency')} htmlFor={`${id}-freq`} error={fieldError(create.error, 'frequency')}>
            <select id={`${id}-freq`} className={selectClass} value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>{FREQUENCIES.map((f) => <option key={f} value={f}>{t(`frequency.${f}`)}</option>)}</select>
          </FormRow>
          <FormRow label={t('fields.nextRun')} htmlFor={`${id}-next`} error={fieldError(create.error, 'nextRun')}><Input id={`${id}-next`} type="date" value={nextRun} onChange={(e) => setNextRun(e.target.value)} /></FormRow>
          <FormRow label={t('fields.endAfter')} htmlFor={`${id}-end`} error={fieldError(create.error, 'endAfter')}><Input id={`${id}-end`} type="number" min={1} step={1} inputMode="numeric" value={endAfter} placeholder={t('fields.endAfterHint')} onChange={(e) => setEndAfter(e.target.value)} /></FormRow>
          <Problem error={create.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>{create.isPending ? t('saving') : t('recurring.submit')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const lineAmount = (doc: Doc, l: Doc['lines'][number]): string => {
  if (doc.type === 'JV') return l.debit ?? '0.00';
  const n = Number(l.qty) * Number(l.unitPrice) * (1 - Number(l.discountPct ?? 0) / 100);
  return (Math.round(n * 100) / 100).toFixed(2);
};

/** "ตั้งตัดจ่าย": a line that posted to a prepaid / deferred account is spread over months; everything typed here is frozen on the schedule. */
export function AmortiseDialog({ doc, label, onClose }: { doc: Doc; label: string; onClose: () => void }) {
  const t = useTranslations('schedules');
  const id = useId();
  const lines = doc.lines.filter((l) => (doc.type === 'JV' ? Number(l.debit ?? 0) > 0 : true));
  const accounts = useQuery({ queryKey: ['journal-accounts'], queryFn: endpoints.journalAccounts });
  const first = lines.find((l) => l.expenseCategory === 'prepaid' || l.accountCode === '1150') ?? lines[0];
  const [lineId, setLineId] = useState(first?.id ?? '');
  const [name, setName] = useState(`${t('amortise.namePrefix')} ${first?.description ?? ''}`.trim());
  const [total, setTotal] = useState(first ? lineAmount(doc, first) : '');
  const [months, setMonths] = useState('12');
  const [startMonth, setStartMonth] = useState(doc.header.documentDate.slice(0, 7));
  const [expense, setExpense] = useState('');
  const create = useCreate(onClose);
  const expenseOptions = (accounts.data ?? []).filter((a) => EXPENSE_CLASSES.includes(a.class));
  const submit = () => create.mutate({ kind: 'amortisation', docId: doc.id, lineId, name: name.trim(), total, months: Number(months), startMonth, expenseAccount: expense });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('amortise.title', { doc: label })}</DialogTitle></DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <p className="text-muted-foreground">{t('amortise.body')}</p>
          <FormRow label={t('fields.line')} htmlFor={`${id}-line`} error={fieldError(create.error, 'lineId')}>
            <select id={`${id}-line`} className={selectClass} value={lineId} onChange={(e) => { setLineId(e.target.value); const l = lines.find((x) => x.id === e.target.value); if (l) setTotal(lineAmount(doc, l)); }}>
              {lines.map((l, i) => <option key={l.id} value={l.id}>{`${i + 1}. ${l.description}`}</option>)}
            </select>
          </FormRow>
          <FormRow label={t('fields.name')} htmlFor={`${id}-name`} error={fieldError(create.error, 'name')}><Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} /></FormRow>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormRow label={t('fields.total')} htmlFor={`${id}-total`} error={fieldError(create.error, 'total')}><Input id={`${id}-total`} inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} /></FormRow>
            <FormRow label={t('fields.months')} htmlFor={`${id}-months`} error={fieldError(create.error, 'months')}><Input id={`${id}-months`} type="number" min={1} max={120} step={1} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} /></FormRow>
          </div>
          <FormRow label={t('fields.startMonth')} htmlFor={`${id}-start`} error={fieldError(create.error, 'startMonth')}><Input id={`${id}-start`} type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} /></FormRow>
          <FormRow label={t('fields.expenseAccount')} htmlFor={`${id}-exp`} error={fieldError(create.error, 'expenseAccount')}>
            <select id={`${id}-exp`} className={selectClass} value={expense} onChange={(e) => setExpense(e.target.value)}>
              <option value="">{t('choose')}</option>
              {expenseOptions.map((a) => <option key={a.code} value={a.code}>{`${a.code} ${a.nameTh}`}</option>)}
            </select>
          </FormRow>
          <Problem error={create.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={create.isPending || !name.trim() || !expense || !lineId}>{create.isPending ? t('saving') : t('amortise.submit')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
