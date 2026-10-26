'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DemoHint } from '@/kit/auth/TotpEnrol';
import { ApiError } from '@/lib/api/client';
import { authApi } from '@/records/auth';

const readChallenge = (): string | null => { try { return sessionStorage.getItem('teas2.auth.challenge'); } catch { return null; } };

/** The second step of the sign-in: a 6-digit code, or one recovery code (each works once). The challenge comes from the tab's storage, never from the URL. */
export default function TotpPage() {
  const t = useTranslations('auth.totp');
  const router = useRouter();
  const qc = useQueryClient();
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  useEffect(() => { if (!readChallenge()) router.replace('/login'); }, [router]);
  const verify = useMutation({
    mutationFn: () => authApi.totp(readChallenge() ?? '', recovery ? { recoveryCode: value } : { code: value }),
    onSuccess: () => {
      try { sessionStorage.removeItem('teas2.auth.challenge'); } catch { /* ignore */ }
      qc.clear(); // a new sign-in: nothing cached under the old session may outlive it
      router.replace('/');
    },
  });
  const dead = verify.error instanceof ApiError && ['auth.challenge_invalid', 'auth.locked'].includes(verify.error.code);
  return (
    <main id="content" className="mx-auto grid min-h-dvh max-w-md content-center gap-5 p-4 md:p-8">
      <title>{t('title')}</title>
      <div>
        <h1 className="text-title font-semibold">{t('title')}</h1>
        <p className="text-body text-muted-foreground">{recovery ? t('recoveryLead') : t('lead')}</p>
      </div>
      <form className="grid gap-4 rounded-lg border bg-card p-4" onSubmit={(e) => { e.preventDefault(); if (value) verify.mutate(); }}>
        <div className="grid gap-1.5">
          <Label htmlFor="totp-value">{recovery ? t('recovery') : t('code')}</Label>
          {recovery
            ? <Input id="totp-value" autoComplete="off" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={verify.isError} />
            : <Input id="totp-value" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" autoFocus value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} aria-invalid={verify.isError} />}
        </div>
        {verify.isError ? <Alert variant="destructive" role="alert" data-testid="totp-error"><AlertTitle>{verify.error instanceof ApiError ? verify.error.problem.title : t('failed')}</AlertTitle></Alert> : null}
        <Button type="submit" disabled={verify.isPending || dead || !value}>{t('submit')}</Button>
        <Button type="button" variant="link" className="w-fit px-0" onClick={() => { setRecovery(!recovery); setValue(''); verify.reset(); }}>{recovery ? t('useCode') : t('useRecovery')}</Button>
      </form>
      <DemoHint kind="totp" />
      <p className="text-small"><Link className="underline underline-offset-2" href="/login">{t('back')}</Link></p>
    </main>
  );
}
