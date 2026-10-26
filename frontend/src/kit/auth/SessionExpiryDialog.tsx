'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/client';
import { authApi } from '@/records/auth';

export const SESSION_KEY = ['auth', 'session'] as const;

/** Mounted once in the app shell (Topbar). `expiring` asks to stay or sign out; `expired` is a re-login dialog OVER the page - nothing is unmounted or reloaded, so what the editor holds (and its autosaved draft) is still there afterwards;
 *  `out` goes to the sign-in page. The session's state is the server's: here the mock toolbar's toggle. */
export function SessionExpiryDialog() {
  const t = useTranslations('auth.session');
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: SESSION_KEY, queryFn: authApi.session, refetchInterval: 30_000, retry: false });
  const [password, setPassword] = useState('');
  const state = q.data?.state;
  useEffect(() => { if (state === 'out') router.replace('/login'); }, [state, router]);

  const stay = useMutation({ mutationFn: authApi.extend, onSuccess: () => qc.invalidateQueries({ queryKey: SESSION_KEY }) });
  const leave = useMutation({ mutationFn: authApi.logout, onSuccess: () => { void qc.invalidateQueries({ queryKey: SESSION_KEY }); router.replace('/login'); } });
  const again = useMutation({
    mutationFn: () => authApi.relogin(password),
    onSuccess: () => { setPassword(''); void qc.invalidateQueries(); }, // refetch what failed with 401; the mounted screens keep their local state
  });

  if (state === 'expiring') {
    return (
      <Dialog open onOpenChange={() => { /* answered with a button */ }}>
        <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>{t('expiringTitle')}</DialogTitle>
            <DialogDescription>{t('expiringBody', { minutes: Math.max(1, Math.round((q.data?.expiresInSec ?? 120) / 60)) })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={leave.isPending} onClick={() => leave.mutate()}>{t('signOut')}</Button>
            <Button disabled={stay.isPending} onClick={() => stay.mutate()}>{t('stay')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  if (state === 'expired') {
    return (
      <Dialog open onOpenChange={() => { /* only the buttons */ }}>
        <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (password) again.mutate(); }}>
            <DialogHeader>
              <DialogTitle>{t('expiredTitle')}</DialogTitle>
              <DialogDescription>{t('expiredBody', { email: q.data?.email ?? '' })}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="relogin-password">{t('password')}</Label>
              <Input id="relogin-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={again.isError} />
            </div>
            {again.isError ? <Alert variant="destructive" role="alert"><AlertTitle>{again.error instanceof ApiError ? again.error.problem.title : t('failed')}</AlertTitle></Alert> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={leave.isPending} onClick={() => leave.mutate()}>{t('signOut')}</Button>
              <Button type="submit" disabled={again.isPending || !password}>{t('relogin')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }
  return null;
}
