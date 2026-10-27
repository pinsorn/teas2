'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { encode } from 'uqr';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/client';
import { authApi, type ProfileView } from '@/records/auth';

/** Mock only: what a person reviewing the mockup types (GET /auth/demo; a real backend answers 404 and nothing shows). */
export function DemoHint({ kind }: { kind: 'login' | 'totp' | 'enrol' }) {
  const t = useTranslations('auth.demo');
  const mock = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled'; // a real build never asks (HC3a m5)
  const q = useQuery({ queryKey: ['auth', 'demo'], queryFn: authApi.demo, retry: false, staleTime: 0, enabled: mock });
  const d = mock ? q.data : undefined;
  if (!d) return null;
  const rows: [string, string][] = kind === 'login' ? [[t('email'), d.email], [t('password'), d.password], [t('totpEmail'), d.totpEmail], [t('totpPassword'), d.totpPassword]]
    : [[t('totpCode'), d.totpCode], ...(kind === 'totp' && d.recoveryCode ? [[t('recovery'), d.recoveryCode] as [string, string]] : [])];
  return (
    <section aria-label={t('title')} className="grid gap-1 rounded-lg border border-dashed bg-muted p-3 text-small">
      <h2 className="font-semibold">{t('title')}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="font-mono break-all select-all">{v}</dd></div>)}
      </dl>
    </section>
  );
}

/** The otpauth:// URI as a QR code an authenticator app can scan (uqr: exact-pinned, zero-dependency encoder; drawn as one SVG path, black on white with the 4-module quiet zone). */
function Qr({ uri }: { uri: string }) {
  const rows = useMemo(() => encode(uri, { ecc: 'M', border: 0 }).data, [uri]);
  const d = rows.flatMap((row, y) => row.flatMap((on, x) => (on ? [`M${x} ${y}h1v1h-1z`] : []))).join('');
  const n = rows.length;
  return (
    <svg viewBox={`-4 -4 ${n + 8} ${n + 8}`} role="img" aria-label="QR code" className="size-40 shrink-0 rounded border bg-white" shapeRendering="crispEdges">
      <path d={d} fill="black" />
    </svg>
  );
}

/** Two-step authentication: start (QR code + secret), verify a code, then the recovery codes - shown ONCE in a dialog that can only be closed with its button. */
export function TotpEnrol({ profile, onChanged }: { profile: ProfileView; onChanged: () => void }) {
  const t = useTranslations('auth.profile.totp');
  const [enrol, setEnrol] = useState<{ secret: string; uri: string }>();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [copied, setCopied] = useState(false);
  const start = useMutation({ mutationFn: authApi.startEnrol, onSuccess: (r) => { setEnrol(r); setCode(''); } });
  const verify = useMutation({ mutationFn: () => authApi.verifyEnrol(code), onSuccess: (r) => { setCodes(r.recoveryCodes); setEnrol(undefined); onChanged(); } });
  const problem = (e: unknown) => (e instanceof ApiError ? e.problem.title : t('failed'));
  return (
    <div className="grid gap-3">
      <p data-testid="totp-status">{profile.totpEnabled ? t('enabled', { count: profile.recoveryRemaining }) : t('disabled')}</p>
      {enrol ? (
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (/^\d{6}$/.test(code)) verify.mutate(); }}>
          <div className="flex flex-wrap items-start gap-4">
            <Qr uri={enrol.uri} />
            <div className="grid min-w-0 gap-1">
              <p className="text-small text-muted-foreground">{t('scan')}</p>
              <p className="text-small">{t('secretLabel')}</p>
              <code data-testid="totp-secret" className="break-all rounded border bg-muted px-2 py-1 select-all">{enrol.secret}</code>
            </div>
          </div>
          <div className="grid max-w-xs gap-1.5">
            <Label htmlFor="enrol-code">{t('code')}</Label>
            <Input id="enrol-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-invalid={verify.isError} />
          </div>
          {verify.isError ? <Alert variant="destructive" role="alert"><AlertTitle>{problem(verify.error)}</AlertTitle></Alert> : null}
          <DemoHint kind="enrol" />
          <div className="flex gap-2">
            <Button type="submit" disabled={verify.isPending || code.length !== 6}>{t('verify')}</Button>
            <Button type="button" variant="outline" onClick={() => { setEnrol(undefined); verify.reset(); }}>{t('cancel')}</Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-2">
          {start.isError ? <Alert variant="destructive" role="alert"><AlertTitle>{problem(start.error)}</AlertTitle></Alert> : null}
          <Button className="w-fit" variant={profile.totpEnabled ? 'outline' : 'default'} disabled={start.isPending} onClick={() => start.mutate()}>{profile.totpEnabled ? t('redo') : t('start')}</Button>
        </div>
      )}
      {codes ? (
        <Dialog open onOpenChange={() => { /* closing is only through the button: the codes are not shown again */ }}>
          <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
            <DialogHeader>
              <DialogTitle>{t('codesTitle')}</DialogTitle>
              <DialogDescription>{t('codesLead')}</DialogDescription>
            </DialogHeader>
            <ul data-testid="recovery-codes" className="grid grid-cols-2 gap-2 rounded-lg border bg-muted p-3 font-mono select-all">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
            <p role="status" className="text-small text-muted-foreground">{copied ? t('copied') : ' '}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(codes.join('\n')).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{t('copy')}</Button>
              <Button onClick={() => { setCodes(undefined); setCopied(false); }}>{t('saved')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
