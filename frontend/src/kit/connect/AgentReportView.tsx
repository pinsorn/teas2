'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DESCRIPTORS } from '@/descriptors';
import { formatDateBE, formatMoney } from '@/lib/format';
import type { AgentReport, Severity } from '@/records/connect';

const ORDER: Severity[] = ['error', 'warning', 'info'];
const when = (iso: string) => `${formatDateBE(iso.slice(0, 10))} ${new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(11, 16)}`; // Bangkok time

/** SP0 §8.2: the stored review report of an agent's draft: totals and tax (the server's), the journal with the rule that chose each account, the checks by severity, the route under the policy in force when the report was made, and the token expiry. Display only: nothing here is computed. */
export function AgentReportView({ report: r }: { report: AgentReport }) {
  const t = useTranslations('connect.report');
  const td = useTranslations('docTypes');
  const base = DESCRIPTORS[r.docType]?.basePath;
  const lines = r.journal.entries.flatMap((e) => e.lines);
  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-title font-semibold">{t('title')}</h1>
        <p className="text-body text-muted-foreground">
          {td(`${r.docType}.title`)} {base ? <Link href={`${base}/${r.docId}`} className="text-primary underline underline-offset-4">{r.docNumber ?? t('draft')}</Link> : (r.docNumber ?? t('draft'))} · {r.partyName || '–'}
        </p>
        <p className="text-small text-muted-foreground">{t('by', { agent: r.agentName, owner: r.ownerName ?? '–', version: r.version })}</p>
        <p className="text-small font-medium" data-testid="report-for-version">{t('forVersion', { n: r.docVersion })}</p>
        {r.docNowVersion !== undefined && r.docNowVersion !== r.docVersion ? <Alert role="alert" className="mt-2" data-testid="report-moved"><AlertTitle>{t('moved', { n: r.docVersion, now: r.docNowVersion })}</AlertTitle></Alert> : null}
      </div>

      <section aria-labelledby="ar-route" className="grid gap-2 rounded-lg border bg-card p-4">
        <h2 id="ar-route" className="text-section font-semibold">{t('route.title')}</h2>
        <p><Badge variant={r.route === 'auto' ? 'secondary' : 'outline'}>{t(`route.${r.route}`)}</Badge></p>
        <p className="text-small text-muted-foreground">{t('route.policy', { mode: t(`mode.${r.policy.mode}`), cap: formatMoney(r.policy.cap) })}</p>
        <p className="text-small text-muted-foreground">{t('route.frozen')}</p>
        <p className="text-small text-muted-foreground">{t('expires', { at: when(r.expiresAt) })} · {t('made', { at: when(r.createdAt) })}</p>
      </section>

      <section aria-labelledby="ar-checks" className="grid gap-3 rounded-lg border bg-card p-4">
        <h2 id="ar-checks" className="text-section font-semibold">{t('checks.title')}</h2>
        {ORDER.map((sev) => {
          const list = r.checks.filter((c) => c.severity === sev);
          return (
            <div key={sev} data-severity={sev}>
              <h3 className="text-body font-semibold">{t(`checks.${sev}`)} ({list.length})</h3>
              {list.length ? <ul className="ml-5 list-disc">{list.map((c) => <li key={c.code} data-check={c.code}>{c.message}</li>)}</ul> : <p className="text-small text-muted-foreground">{t('checks.none')}</p>}
            </div>
          );
        })}
      </section>

      <section aria-labelledby="ar-totals" className="grid gap-2 rounded-lg border bg-card p-4">
        <h2 id="ar-totals" className="text-section font-semibold">{t('totals.title')}</h2>
        <dl className="grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
          {(['net', 'vat', 'total'] as const).map((k) => <div key={k} className="contents"><dt>{t(`totals.${k}`)}</dt><dd className="text-end">{formatMoney(r.totals[k])}</dd></div>)}
        </dl>
      </section>

      <section aria-labelledby="ar-journal" className="grid gap-2 rounded-lg border bg-card p-4">
        <h2 id="ar-journal" className="text-section font-semibold">{t('journal.title')}</h2>
        {lines.length === 0 ? <p className="text-small text-muted-foreground">{t('journal.none')}</p> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>{(['account', 'debit', 'credit', 'rule'] as const).map((c) => <TableHead key={c} className={c === 'debit' || c === 'credit' ? 'text-end' : undefined}>{t(`journal.${c}`)}</TableHead>)}</TableRow></TableHeader>
              <TableBody>
                {lines.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell>{l.accountCode} {l.accountName}</TableCell>
                    <TableCell className="text-end tabular-nums">{l.debit === '0.00' ? '' : formatMoney(l.debit)}</TableCell>
                    <TableCell className="text-end tabular-nums">{l.credit === '0.00' ? '' : formatMoney(l.credit)}</TableCell>
                    <TableCell className="text-small text-muted-foreground">{l.rule}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
