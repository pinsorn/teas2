'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState } from '@/kit/states/ErrorState';
import { LoadingState } from '@/kit/states/LoadingState';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';
import { authApi } from '@/records/auth';

const isGone = (e: unknown) => e instanceof ApiError && e.code === 'auth.link_invalid';

/** SP3 Q4 (routes 13-14): "set your password" from an invite or reset link. Outside the app shell, sessionless, never indexed, no referrer. Unknown, used, expired and inactive-member links are ONE plain state.
 *  An invite of an EXISTING account has no password form: sign in as that user, then accept. The token is the path of this page and is never kept anywhere else. */
export default function SetPasswordPage() {
  const t = useTranslations('auth.link');
  const { token } = useParams<{ token: string }>();
  const [done, setDone] = useState(false);
  // the link is read once: no refetch on focus / reconnect, and none after it has been used (a used link would answer 404 and replace the success state)
  const info = useQuery({ queryKey: ['auth-link', token], queryFn: () => endpoints.linkInfo(token), retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false, enabled: !done });
  const existing = info.data?.existingAccount === true;
  const me = useQuery({ queryKey: ['auth-link-session'], queryFn: authApi.session, enabled: existing && !done, retry: false, refetchOnWindowFocus: false });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const save = useMutation({ mutationFn: () => endpoints.setPassword(token, existing ? { password: '', confirm: '' } : { password, confirm }), onSuccess: () => setDone(true), onError: (e) => { if (existing && isGone(e)) void me.refetch(); } }); // the server keeps one 404; for an accept, ask the session whether we are even signed in
  const signedIn = existing && me.data?.email?.toLowerCase() === info.data?.email.toLowerCase() && (me.data?.state === 'active' || me.data?.state === 'expiring');
  const notSignedIn = existing && save.isError && isGone(save.error) && !me.isFetching && !signedIn; // a refused accept from a signed-out browser is not a dead link

  if (done && info.data) { // the success state wins over anything a later fetch says
    return (
      <Shell>
        <title>{t('doneTitle')}</title>
        <div className="grid gap-3" data-testid="link-done">
          <h1 className="text-title font-semibold">{t('doneTitle')}</h1>
          <p className="text-body text-muted-foreground">{existing ? t('doneExisting') : info.data.kind === 'invite' ? t('doneInvite') : t('doneReset')}</p>
          <Button asChild><Link href="/login">{t('toLogin')}</Link></Button>
        </div>
      </Shell>
    );
  }
  if (info.isPending) return <Shell><LoadingState rows={3} /></Shell>;
  if ((info.isError && isGone(info.error)) || (save.isError && isGone(save.error) && !notSignedIn && !(existing && me.isFetching))) {
    return (
      <Shell>
        <div className="grid gap-2 py-16 text-center" data-screen-state="not-found">
          <title>{t('invalidTitle')}</title>
          <h1 className="text-title font-semibold">{t('invalidTitle')}</h1>
          <p className="text-body text-muted-foreground" data-testid="link-invalid">{t('invalidBody')}</p>
          <p className="text-small"><Link className="underline underline-offset-2" href="/login">{t('toLogin')}</Link></p>
        </div>
      </Shell>
    );
  }
  if (info.isError) return <Shell><ErrorState error={info.error} onRetry={() => void info.refetch()} /></Shell>;
  const d = info.data;
  const title = existing ? t('existingTitle') : d.kind === 'invite' ? t('inviteTitle') : t('resetTitle');
  if (existing) {
    return (
      <Shell>
        <title>{title}</title>
        <div>
          <h1 className="text-title font-semibold">{title}</h1>
          <p className="text-body text-muted-foreground">{d.companyName ? t('existingLead', { company: d.companyName, email: d.email }) : t('existingLeadNoCompany', { email: d.email })}</p>
        </div>
        <div className="grid gap-3 rounded-lg border bg-card p-4">
          {save.isError && !notSignedIn ? <Alert variant="destructive" role="alert" data-testid="link-error"><AlertTitle>{save.error instanceof ApiError ? save.error.problem.title : t('failed')}</AlertTitle></Alert> : null}
          {signedIn
            ? <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="link-accept">{save.isPending ? t('submitting') : t('accept')}</Button>
            : <Button asChild data-testid="link-signin"><Link href="/login">{t('toLogin')}</Link></Button>}
        </div>
        <p className="text-small text-muted-foreground">{t('expires', { at: formatDateBE(d.expiresAt.slice(0, 10)) })}</p>
      </Shell>
    );
  }
  const lead = d.kind === 'invite' ? (d.companyName ? t('inviteLead', { company: d.companyName, email: d.email }) : t('inviteLeadNoCompany', { email: d.email })) : t('resetLead', { email: d.email });
  return (
    <Shell>
      <title>{title}</title>
      <div>
        <h1 className="text-title font-semibold">{title}</h1>
        <p className="text-body text-muted-foreground">{lead}</p>
      </div>
      <form className="grid gap-4 rounded-lg border bg-card p-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-1.5">
          <Label htmlFor="link-password">{t('password')}</Label>
          <Input id="link-password" type="password" autoComplete="new-password" autoFocus required aria-describedby="link-rule" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={save.isError} />
          <p id="link-rule" className="text-small text-muted-foreground">{t('rule')}</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="link-confirm">{t('confirm')}</Label>
          <Input id="link-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={save.isError} />
        </div>
        {save.isError ? <Alert variant="destructive" role="alert" data-testid="link-error"><AlertTitle>{save.error instanceof ApiError ? save.error.problem.title : t('failed')}</AlertTitle></Alert> : null}
        <Button type="submit" disabled={save.isPending}>{save.isPending ? t('submitting') : t('submit')}</Button>
      </form>
      <p className="text-small text-muted-foreground">{t('expires', { at: formatDateBE(d.expiresAt.slice(0, 10)) })}</p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="content" className="mx-auto grid min-h-dvh max-w-md content-center gap-5 p-4 md:p-8">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      {children}
    </main>
  );
}
