'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
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

/** A placeholder for the QR code: a stable pattern from the secret, three finder squares. It is NOT scannable; the secret is shown beside it. */
function QrPlaceholder({ secret }: { secret: string }) {
  const N = 21;
  const cells = useMemo(() => {
    let h = 2166136261;
    for (const c of secret) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const out: [number, number][] = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const finder = (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
      h = Math.imul(h ^ (x * 31 + y), 16777619) >>> 0;
      if (!finder && h % 3 === 0) out.push([x, y]);
    }
    return out;
  }, [secret]);
  const finder = (x: number, y: number) => <g key={`${x}${y}`}><rect x={x} y={y} width="7" height="7" /><rect x={x + 1} y={y + 1} width="5" height="5" fill="white" /><rect x={x + 2} y={y + 2} width="3" height="3" /></g>;
  return (
    <svg viewBox={`-1 -1 ${N + 2} ${N + 2}`} role="img" aria-label="QR code (ตัวอย่าง)" className="size-36 shrink-0 rounded border bg-white p-1" fill="black" shapeRendering="crispEdges">
      {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" />)}
      {finder(0, 0)}{finder(N - 7, 0)}{finder(0, N - 7)}
    </svg>
  );
}

/** Two-step authentication: start (secret + QR placeholder), verify a code, then the recovery codes - shown ONCE in a dialog that can only be closed with its button. */
export function TotpEnrol({ profile, onChanged }: { profile: ProfileView; onChanged: () => void }) {
  const t = useTranslations('auth.profile.totp');
  const [secret, setSecret] = useState<string>();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [copied, setCopied] = useState(false);
  const start = useMutation({ mutationFn: authApi.startEnrol, onSuccess: (r) => { setSecret(r.secret); setCode(''); } });
  const verify = useMutation({ mutationFn: () => authApi.verifyEnrol(code), onSuccess: (r) => { setCodes(r.recoveryCodes); setSecret(undefined); onChanged(); } });
  const problem = (e: unknown) => (e instanceof ApiError ? e.problem.title : t('failed'));
  return (
    <div className="grid gap-3">
      <p data-testid="totp-status">{profile.totpEnabled ? t('enabled', { count: profile.recoveryRemaining }) : t('disabled')}</p>
      {secret ? (
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (/^\d{6}$/.test(code)) verify.mutate(); }}>
          <div className="flex flex-wrap items-start gap-4">
            <QrPlaceholder secret={secret} />
            <div className="grid min-w-0 gap-1">
              <p className="text-small text-muted-foreground">{t('scan')}</p>
              <p className="text-small">{t('secretLabel')}</p>
              <code data-testid="totp-secret" className="break-all rounded border bg-muted px-2 py-1 select-all">{secret}</code>
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
            <Button type="button" variant="outline" onClick={() => { setSecret(undefined); verify.reset(); }}>{t('cancel')}</Button>
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
