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

const isGone = (e: unknown) => e instanceof ApiError && e.code === 'auth.link_invalid';

/** SP3 Q4 (routes 13-14): "set your password" from an invite or reset link. Outside the app shell, sessionless. Unknown, used and expired links are ONE plain state; the token is the path of this page and is never kept anywhere else. */
export default function SetPasswordPage() {
  const t = useTranslations('auth.link');
  const { token } = useParams<{ token: string }>();
  const info = useQuery({ queryKey: ['auth-link', token], queryFn: () => endpoints.linkInfo(token), retry: false, staleTime: 0, gcTime: 0 });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const save = useMutation({ mutationFn: () => endpoints.setPassword(token, { password, confirm }) });

  if (info.isPending) return <Shell><LoadingState rows={3} /></Shell>;
  if ((info.isError && isGone(info.error)) || (save.isError && isGone(save.error))) {
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
  if (save.isSuccess) {
    return (
      <Shell>
        <title>{t('doneTitle')}</title>
        <div className="grid gap-3" data-testid="link-done">
          <h1 className="text-title font-semibold">{t('doneTitle')}</h1>
          <p className="text-body text-muted-foreground">{d.kind === 'invite' ? t('doneInvite') : t('doneReset')}</p>
          <Button asChild><Link href="/login">{t('toLogin')}</Link></Button>
        </div>
      </Shell>
    );
  }
  const title = d.kind === 'invite' ? t('inviteTitle') : t('resetTitle');
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
  return <main id="content" className="mx-auto grid min-h-dvh max-w-md content-center gap-5 p-4 md:p-8">{children}</main>;
}
