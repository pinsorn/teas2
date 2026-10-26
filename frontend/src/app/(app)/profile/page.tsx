'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TotpEnrol } from '@/kit/auth/TotpEnrol';
import { ErrorState } from '@/kit/states/ErrorState';
import { LoadingState } from '@/kit/states/LoadingState';
import { ApiError } from '@/lib/api/client';
import { authApi, setLocale } from '@/records/auth';

/** SP1c HC3: the signed-in person's own page - password, two-step authentication, signed-in devices, language. Nothing here needs a company permission. */
export default function ProfilePage() {
  const t = useTranslations('auth.profile');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['auth', 'profile'], queryFn: authApi.profile });
  const sessions = useQuery({ queryKey: ['auth', 'sessions'], queryFn: authApi.sessions });
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const change = useMutation({ mutationFn: () => authApi.changePassword(pw.current, pw.next, pw.confirm), onSuccess: () => { setPw({ current: '', next: '', confirm: '' }); void qc.invalidateQueries({ queryKey: ['auth', 'sessions'] }); } });
  const revoke = useMutation({
    mutationFn: (id: string) => authApi.revokeSession(id),
    onSuccess: (r) => { if (r.signedOut) router.replace('/login'); else void qc.invalidateQueries({ queryKey: ['auth', 'sessions'] }); },
  });
  const when = (iso: string) => new Date(iso).toLocaleString(locale === 'en' ? 'en-GB' : 'th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  const msg = (e: unknown) => (e instanceof ApiError ? e.problem.title : t('failed'));

  if (profile.isError) return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  if (!profile.data) return <LoadingState rows={4} />;
  const p = profile.data;
  const set = (k: 'current' | 'next' | 'confirm', v: string) => setPw((x) => ({ ...x, [k]: v }));
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <title>{t('title')}</title>
      <div>
        <h1 className="text-title font-semibold">{t('title')}</h1>
        <p className="text-body text-muted-foreground">{p.displayName} · {p.email}</p>
      </div>

      <section aria-labelledby="pf-password" className="grid gap-3 rounded-lg border bg-card p-4">
        <h2 id="pf-password" className="text-section font-semibold">{t('password.title')}</h2>
        <form className="grid max-w-md gap-3" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <div className="grid gap-1.5"><Label htmlFor="pf-current">{t('password.current')}</Label><Input id="pf-current" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => set('current', e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="pf-next">{t('password.next')}</Label><Input id="pf-next" type="password" autoComplete="new-password" aria-describedby="pf-rule" value={pw.next} onChange={(e) => set('next', e.target.value)} /><p id="pf-rule" className="text-small text-muted-foreground">{t('password.rule')}</p></div>
          <div className="grid gap-1.5"><Label htmlFor="pf-confirm">{t('password.confirm')}</Label><Input id="pf-confirm" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => set('confirm', e.target.value)} /></div>
          {change.isError ? <Alert variant="destructive" role="alert"><AlertTitle>{msg(change.error)}</AlertTitle></Alert> : null}
          {change.isSuccess ? <Alert role="status"><AlertTitle>{t('password.done')}</AlertTitle></Alert> : null}
          <Button type="submit" className="w-fit" disabled={change.isPending || !pw.current || !pw.next || !pw.confirm}>{t('password.submit')}</Button>
        </form>
      </section>

      <section aria-labelledby="pf-totp" className="grid gap-3 rounded-lg border bg-card p-4">
        <h2 id="pf-totp" className="text-section font-semibold">{t('totp.title')}</h2>
        <TotpEnrol profile={p} onChanged={() => void profile.refetch()} />
      </section>

      <section aria-labelledby="pf-sessions" className="grid gap-3 rounded-lg border bg-card p-4">
        <h2 id="pf-sessions" className="text-section font-semibold">{t('sessions.title')}</h2>
        {sessions.isError ? <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} /> : !sessions.data ? <LoadingState rows={2} /> : (
          <ul className="grid gap-2">
            {sessions.data.items.map((s) => (
              <li key={s.id} data-testid="session-row" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="font-medium">{s.device} {s.current ? <span className="ml-1 rounded-full bg-primary px-2 py-0.5 text-small text-primary-foreground">{t('sessions.current')}</span> : null}</p>
                  <p className="text-small text-muted-foreground">{s.ip} · {t('sessions.lastSeen', { when: when(s.lastSeenAt) })}</p>
                </div>
                <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)} aria-label={t(s.current ? 'sessions.revokeCurrent' : 'sessions.revoke', { device: s.device })}>{t(s.current ? 'sessions.signOut' : 'sessions.end')}</Button>
              </li>
            ))}
          </ul>
        )}
        {revoke.isError ? <Alert variant="destructive" role="alert"><AlertTitle>{msg(revoke.error)}</AlertTitle></Alert> : null}
      </section>

      <section aria-labelledby="pf-lang" className="grid gap-3 rounded-lg border bg-card p-4">
        <h2 id="pf-lang" className="text-section font-semibold">{t('language.title')}</h2>
        <div role="group" aria-labelledby="pf-lang" className="flex gap-2">
          {(['th', 'en'] as const).map((l) => <Button key={l} variant={locale === l ? 'default' : 'outline'} aria-pressed={locale === l} onClick={() => { setLocale(l); router.refresh(); }}>{t(`language.${l}`)}</Button>)}
        </div>
      </section>

      <p className="text-small text-muted-foreground"><Link className="underline underline-offset-2" href="/onboarding">{t('newCompany')}</Link></p>
    </div>
  );
}
