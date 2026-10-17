'use client';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useMe } from '@/app-shell/useMe';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RecordRow } from '@/domain/records';
import type { Doc, DocLine, Page, PayItems, PayrollTotals, PayslipLine } from '@/domain/types';
import { endpoints } from '@/lib/api/endpoints';
import { formatMoney } from '@/lib/format';
import { cleanDecimal, isComposing, moneyText } from './useLineGridKeys';

// PY1: the fourth line editor (a payroll run). One card per employee: the accountant types the pay items; gross, PIT, SSO, net and the year to date are the SERVER's (`compute.payroll`) and are only shown here, never computed.

const PAY_KEYS = ['salary', 'overtime', 'allowance', 'bonus', 'otherIncome', 'otherDeduction'] as const;
type PayKey = (typeof PAY_KEYS)[number];
type Cell = 'employee' | PayKey;
const ORDER: Cell[] = ['employee', ...PAY_KEYS];

/** A row of a payroll run: the employee and the pay items; the filler fields are what every document line carries. */
export const newPayrollLine = (employeeId = '', salary = ''): DocLine =>
  ({ id: crypto.randomUUID(), description: '', qty: '1', unit: '', unitPrice: '0.00', taxCode: 'EX', employeeId, pay: { salary } });
/** A row with no employee is never sent. */
export const isBlankPayrollLine = (l: DocLine) => !l.employeeId;
/** Wire format: the salary always, the other items only when typed, all as `n.nn`. */
export const payrollLinePayload = (l: DocLine): DocLine =>
  ({ ...l, employeeId: l.employeeId ?? '', pay: Object.fromEntries(PAY_KEYS.filter((k) => k === 'salary' || (l.pay?.[k] ?? '') !== '').map((k) => [k, moneyText(l.pay?.[k] ?? '')])) as unknown as PayItems });
/** The rows a new run starts with: the active employees employed at any time in the pay date's month (the server re-checks every row, and prorates a joiner / leaver). */
export function defaultPayrollLines(employees: RecordRow[], date: string): DocLine[] {
  const month = date.slice(0, 7), first = `${month}-01`, last = `${month}-31`;
  return employees.filter((r) => r.active !== false && String(r.startDate ?? '') <= last && (!r.endDate || String(r.endDate) >= first))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true })).map((r) => newPayrollLine(String(r.id), String(r.salary ?? '')));
}
/** Every page of the company's employees (PY1a m5: a new run starts with ALL of them, not the first 100). */
export async function listAllEmployees(status: 'true' | 'all'): Promise<Page<RecordRow>> {
  const items: RecordRow[] = [];
  let cursor: string | undefined;
  do { const r = await endpoints.listRecords('employee', { active: status, limit: 100, cursor }); items.push(...r.items); cursor = r.nextCursor; } while (cursor);
  return { items, total: items.length };
}
/** The active employees of the company (the picker, and the default rows of a new run). */
export function useEmployees(enabled: boolean, status: 'true' | 'all' = 'true') {
  const { me } = useMe();
  return useQuery({ queryKey: [me?.activeCompanyId ?? '', 'records', 'employee', 'picker', status], enabled: enabled && !!me, queryFn: () => listAllEmployees(status) });
}

export interface PayrollGridProps {
  lines: DocLine[];
  onChange: (lines: DocLine[]) => void;
  /** The server's slips (one per employee row): shown as they are. */
  slips?: PayslipLine[];
  totals?: PayrollTotals;
  /** The employees a row can be (the company's active ones). */
  employees?: RecordRow[];
  computing?: boolean;
  readOnly?: boolean;
}

export function PayrollGrid({ lines, onChange, slips, totals, employees = [], computing, readOnly }: PayrollGridProps) {
  const t = useTranslations('docEditor.payrollGrid');
  const root = useRef<HTMLDivElement>(null);
  const focusReq = useRef<{ row: number; cell: Cell } | null>(null);
  const focus = (row: number, cell: Cell) => root.current?.querySelector<HTMLElement>(`[data-cell="${row}:${cell}"]`)?.focus();
  useEffect(() => { if (focusReq.current) { focus(focusReq.current.row, focusReq.current.cell); focusReq.current = null; } });

  const nameOf = (l: DocLine) => slips?.find((s) => s.employeeId === l.employeeId)?.name ?? String(employees.find((e) => e.id === l.employeeId)?.name ?? l.employeeId ?? '');
  const patch = (i: number, p: Partial<DocLine>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const setPay = (i: number, k: PayKey, v: string) => patch(i, { pay: { ...(lines[i].pay ?? { salary: '' }), [k]: cleanDecimal(v, 2) } as PayItems });
  const addRow = () => { focusReq.current = { row: lines.length, cell: 'employee' }; onChange([...lines, newPayrollLine()]); };
  const pick = (i: number, id: string) => {
    const e = employees.find((x) => x.id === id);
    patch(i, { employeeId: id, pay: { ...(lines[i].pay ?? { salary: '' }), salary: e && e.salary !== undefined ? String(e.salary) : '' } as PayItems }); // the salary starts at the master's; the server does the proration
  };
  const move = (i: number, cell: Cell, back: boolean) => {
    const at = ORDER.indexOf(cell) + (back ? -1 : 1);
    if (at >= 0 && at < ORDER.length) focus(i, ORDER[at]);
    else if (!back && i + 1 < lines.length) focus(i + 1, ORDER[0]);
    else if (!back) addRow();
    else if (i > 0) focus(i - 1, ORDER[ORDER.length - 1]);
  };
  const onCellKey = (e: KeyboardEvent<HTMLElement>, i: number, cell: Cell) => {
    if (e.key !== 'Enter' || isComposing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    move(i, cell, e.shiftKey);
  };
  const taken = new Set(lines.map((l) => l.employeeId).filter(Boolean));
  const unplaced = employees.filter((e) => !taken.has(String(e.id)));

  return (
    <div ref={root} className="grid gap-3">
      {!lines.length ? <p className="rounded-lg border border-dashed border-border p-4 text-body text-muted-foreground">{t('empty')}</p> : null}
      {lines.map((l, i) => {
        const s = slips?.find((x) => x.employeeId === l.employeeId);
        const server: [string, string | undefined, string][] = [['gross', s?.gross, 'gross'], ['pit', s?.pit, 'pit'], ['sso', s?.sso, 'sso'], ['net', s?.net, 'net'], ['ytdIncome', s?.ytdIncome, 'ytd-income'], ['ytdPit', s?.ytdPit, 'ytd-pit']];
        return (
          <div key={l.id} className="grid gap-3 rounded-lg border border-border p-3" data-row={i} data-testid="payroll-row">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {readOnly || l.employeeId ? <p className="text-body font-medium" data-testid="payroll-employee">{nameOf(l)}</p> : (
                <select aria-label={t('employeeN', { n: i + 1 })} data-cell={`${i}:employee`} value={l.employeeId ?? ''} onChange={(e) => pick(i, e.target.value)} onKeyDown={(e) => onCellKey(e, i, 'employee')}
                  className="h-(--ctl-h) min-w-0 rounded-lg border border-input bg-card px-3 text-body outline-none">
                  <option value="">{t('pick')}</option>
                  {unplaced.map((e) => <option key={String(e.id)} value={String(e.id)}>{String(e.code)} · {String(e.name)}</option>)}
                </select>
              )}
              <div className="flex items-center gap-2">
                {s?.proratedDays !== undefined ? <span className="text-small text-muted-foreground" data-testid="payroll-prorated">{t('prorated', { days: s.proratedDays })}</span> : null}
                {readOnly ? null : <Button type="button" variant="ghost" size="icon" aria-label={t('remove', { n: i + 1 })} onClick={() => onChange(lines.filter((_, k) => k !== i))}><Trash2Icon aria-hidden /></Button>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
              {PAY_KEYS.map((k) => (
                <label key={k} className="grid gap-1">
                  <span className="text-small text-muted-foreground">{t(`pay.${k}`)}</span>
                  <Input type="text" inputMode="decimal" autoComplete="off" className="text-right tabular-nums" aria-label={`${t(`pay.${k}`)} ${nameOf(l)}`.trim()} data-cell={`${i}:${k}`}
                    value={l.pay?.[k] ?? ''} placeholder="0.00" readOnly={readOnly} onChange={(e) => setPay(i, k, e.target.value)}
                    onBlur={() => { const v = l.pay?.[k] ?? ''; if (v !== '' && moneyText(v) !== v) setPay(i, k, moneyText(v)); }}
                    onFocus={(e) => e.target.select()} onKeyDown={(e) => onCellKey(e, i, k)} />
                </label>
              ))}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-2 text-small md:grid-cols-6" aria-busy={computing}>
              {server.map(([k, v, id]) => (
                <div key={k} className="flex justify-between gap-2 md:grid">
                  <dt className="text-muted-foreground">{t(`server.${k}`)}</dt>
                  <dd className="text-right tabular-nums md:text-left" data-testid={`slip-${id}`}>{v !== undefined ? formatMoney(v) : computing ? '…' : ''}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" onClick={addRow} disabled={!unplaced.length && employees.length > 0}><PlusIcon aria-hidden data-icon="inline-start" />{t('add')}</Button>
          <p className="text-small text-muted-foreground">{t('hint')}</p>
        </div>
      )}
      <section aria-label={t('totals.title')} aria-busy={computing} className="grid gap-1 rounded-lg bg-muted/40 p-3 text-body md:max-w-md md:w-full md:justify-self-end">
        <dl className="grid gap-1">
          {(['gross', 'pit', 'sso', 'ssoEmployer', 'net'] as const).map((k) => (
            <div key={k} className={`flex justify-between gap-4 ${k === 'net' ? 'mt-1 border-t border-foreground pt-2 font-semibold' : ''}`}>
              <dt className={k === 'net' ? '' : 'text-muted-foreground'}>{t(`totals.${k}`)}</dt>
              <dd className="tabular-nums" data-testid={`total-${k}`}>{totals ? formatMoney(totals[k]) : computing ? '…' : ''}</dd>
            </div>
          ))}
        </dl>
        <p role="status" className="text-small text-muted-foreground">{computing ? t('computing') : t('serverNote')}</p>
      </section>
    </div>
  );
}

/** The issued (or saved) run on a document page: the frozen slips, read-only. */
export function PayrollSummary({ doc }: { doc: Doc }) {
  const t = useTranslations('docEditor.payrollGrid');
  const names = useEmployees(!doc.payroll, 'all'); // a draft has no slips yet: names come from the master
  const slips = doc.payroll?.slips ?? [];
  const nameOf = (id: string) => slips.find((s) => s.employeeId === id)?.name ?? String(names.data?.items.find((e) => e.id === id)?.name ?? id);
  const cols = ['gross', 'pit', 'sso', 'otherDeduction', 'net', 'ytdIncome', 'ytdPit'] as const;
  return (
    <section aria-label={t('title')} className="overflow-x-auto rounded-lg border bg-card" data-testid="payroll-summary">
      <Table>
        <TableHeader><TableRow>
          <TableHead>{t('employee')}</TableHead>{cols.map((k) => <TableHead key={k} className="text-right">{t(k === 'otherDeduction' ? 'pay.otherDeduction' : `server.${k}`)}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>
          {(slips.length ? slips.map((s) => s.employeeId) : doc.lines.map((l) => l.employeeId ?? '')).map((id) => {
            const s = slips.find((x) => x.employeeId === id);
            return (
              <TableRow key={id} data-testid="payroll-summary-row">
                <TableCell className="whitespace-normal">{nameOf(id)}{s?.proratedDays !== undefined ? <span className="ml-2 text-small text-muted-foreground">{t('prorated', { days: s.proratedDays })}</span> : null}</TableCell>
                {cols.map((k) => <TableCell key={k} className="text-right tabular-nums">{s ? formatMoney(s[k]) : ''}</TableCell>)}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {slips.length ? <p className="p-3 text-small text-muted-foreground">{t('frozenNote', { version: slips[0].tables.version })}</p> : null}
    </section>
  );
}

/** What issuing a run commits (the server's totals): the cost, the tax and social security withheld, and the net pay. */
export function PayrollConfirmDialog({ open, title, body, totals, onConfirm, onCancel }: { open: boolean; title: string; body?: string; totals?: PayrollTotals; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('docEditor.payrollGrid');
  const tc = useTranslations('docEditor');
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body ?? t('confirmBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-body">
          {(['gross', 'pit', 'sso', 'ssoEmployer'] as const).map((k) => <div key={k} className="contents"><dt className="text-muted-foreground">{t(`totals.${k}`)}</dt><dd className="text-right tabular-nums">{totals ? formatMoney(totals[k]) : ''}</dd></div>)}
          <dt className="border-t border-foreground pt-1 font-semibold">{t('totals.net')}</dt>
          <dd className="border-t border-foreground pt-1 text-right font-semibold tabular-nums">{totals ? formatMoney(totals.net) : ''}</dd>
        </dl>
        <AlertDialogFooter>
          <AlertDialogCancel>{tc('confirm.back')}</AlertDialogCancel>
          <Button ref={confirmRef} type="button" onClick={onConfirm}>{title}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
