'use client';
import { useTranslations } from 'next-intl';
import { formatDateBE } from '@/lib/format';
import { HomeSectionShell, useHomeSection } from './HomeSection';

/** What the AI agent posted / left waiting for review. */
export function AgentDigest() {
  const t = useTranslations('home');
  const q = useHomeSection('agent');
  return (
    <HomeSectionShell id="h-agent" title={t('agent.title')} q={q} isEmpty={(d) => !d.posted && !d.waiting} empty={t('agent.empty')}>
      {(d) => (
        <ul className="py-2 text-body tabular-nums">
          <li>{t('agent.posted', { count: d.posted })}</li>
          <li>{t('agent.waiting', { count: d.waiting })}</li>
        </ul>
      )}
    </HomeSectionShell>
  );
}

/** Returns owed and not yet filed, with the due date the filing itself states. */
export function DeadlinesSection() {
  const t = useTranslations('home');
  const q = useHomeSection('deadlines');
  return (
    <HomeSectionShell id="h-deadlines" title={t('deadlines.title')} q={q} isEmpty={(d) => !d.length} empty={t('deadlines.empty')}>
      {(d) => (
        <ul className="divide-y">
          {d.map((x) => (
            <li key={x.form} className="flex justify-between gap-3 py-2 text-body">
              <span className="font-medium">{x.form}</span>
              <span className="tabular-nums">{formatDateBE(x.due)}</span>
            </li>
          ))}
        </ul>
      )}
    </HomeSectionShell>
  );
}

/** FN2: bank statement lines still unmatched. */
export function BankSection() {
  const t = useTranslations('home');
  const q = useHomeSection('bank');
  return (
    <HomeSectionShell id="h-bank" title={t('bank.title')} q={q} isEmpty={(n) => !n} empty={t('bank.empty')} rows={1}>
      {(n) => <p className="py-2 text-body tabular-nums">{t('bank.count', { count: n })}</p>}
    </HomeSectionShell>
  );
}
