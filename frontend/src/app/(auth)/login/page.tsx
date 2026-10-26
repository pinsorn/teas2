'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DemoHint } from '@/kit/auth/TotpEnrol';
import { ApiError } from '@/lib/api/client';
import { authApi } from '@/records/auth';

/** SP1c HC3 (D-32, mock-only auth): outside the app shell. A failure never says which field was wrong. The TOTP challenge travels in the tab's storage, never in the URL. */
export default function LoginPage() {
  const t = useTranslations('auth.login');
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => authApi.login(email, password),
    onSuccess: (r) => {
      if (r.status === 'totp_required') { try { sessionStorage.setItem('teas2.auth.challenge', r.challenge); } catch { /* the TOTP page sends you back here */ } router.push('/login/totp'); return; }
      qc.clear(); // a new sign-in: nothing cached under the old session (the toolbar's "signed out" included) may outlive it
      router.replace('/');
    },
  });
  return (
    <main id="content" className="mx-auto grid min-h-dvh max-w-md content-center gap-5 p-4 md:p-8">
      <title>{t('title')}</title>
      <div>
        <h1 className="text-title font-semibold">{t('title')}</h1>
        <p className="text-body text-muted-foreground">{t('lead')}</p>
      </div>
      <form className="grid gap-4 rounded-lg border bg-card p-4" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
        <div className="grid gap-1.5">
          <Label htmlFor="login-email">{t('email')}</Label>
          <Input id="login-email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={login.isError} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="login-password">{t('password')}</Label>
          <Input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={login.isError} />
        </div>
        {login.isError ? <Alert variant="destructive" role="alert" data-testid="login-error"><AlertTitle>{login.error instanceof ApiError ? login.error.problem.title : t('failed')}</AlertTitle></Alert> : null}
        <Button type="submit" disabled={login.isPending}>{login.isPending ? t('submitting') : t('submit')}</Button>
      </form>
      <DemoHint kind="login" />
      <p className="text-small text-muted-foreground"><Link className="underline underline-offset-2" href="/onboarding">{t('firstRun')}</Link></p>
    </main>
  );
}
