'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** The secret of a new / rotated API key. It is on screen exactly once: nothing can fetch it again, so closing this dialog is final. */
export function SecretOnceDialog({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
  const t = useTranslations('connect.secret');
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const copy = async () => {
    try { await navigator.clipboard.writeText(secret); setCopied('ok'); } catch { setCopied('failed'); }
  };
  return (
    <Dialog open onOpenChange={() => { /* closing is only through the button: the secret is not shown again */ }}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('title', { name })}</DialogTitle>
          <DialogDescription>{t('lead')}</DialogDescription>
        </DialogHeader>
        <code data-testid="secret-once" className="block break-all rounded-lg border bg-muted p-3 text-small select-all">{secret}</code>
        <p role="status" className="text-small text-muted-foreground">{copied === 'ok' ? t('copied') : copied === 'failed' ? t('copyFailed') : ' '}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy()}>{t('copy')}</Button>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
