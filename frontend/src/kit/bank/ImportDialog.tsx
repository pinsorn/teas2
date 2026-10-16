'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useMe } from '@/app-shell/useMe';
import type { BankImport } from '@/domain/types';
import { ApiError } from '@/lib/api/client';
import { endpoints } from '@/lib/api/endpoints';
import { formatDateBE } from '@/lib/format';

const formatOf = (name: string): BankImport['format'] | undefined => (/\.csv$/i.test(name) ? 'kbiz-csv' : /\.pdf$/i.test(name) ? 'kplus-pdf' : undefined);
const toBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** FN1: upload a KBiz CSV (text) or a K PLUS PDF (base64 + the file's password). The password lives in this form only: it is sent once and cleared the moment the request leaves. */
export function ImportDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const t = useTranslations('bank.import');
  const qc = useQueryClient();
  const { me } = useMe();
  const id = useId();
  const [file, setFile] = useState<File>();
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string>();
  const [done, setDone] = useState<BankImport>();
  const format = file ? formatOf(file.name) : undefined;

  const run = useMutation({
    mutationFn: async () => {
      const f = file!;
      const body = format === 'kplus-pdf'
        ? { fileName: f.name, format, content: toBase64(await f.arrayBuffer()), ...(password ? { password } : {}) }
        : { fileName: f.name, format: 'kbiz-csv' as const, content: await f.text() };
      setPassword(''); // gone from the form before the request is even sent
      return endpoints.importStatement(accountId, body);
    },
    onSuccess: async (imp) => { await qc.invalidateQueries({ queryKey: [me?.activeCompanyId, 'bank-lines'] }); setDone(imp); },
    onError: (e) => setFormError(e instanceof ApiError ? e.problem.title : t('failed')),
  });
  const submit = () => {
    setFormError(undefined);
    if (!file) { setFormError(t('chooseFile')); return; }
    if (!format) { setFormError(t('unsupported')); return; }
    run.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('title')}</DialogTitle></DialogHeader>
        {done ? (
          <div className="grid gap-3" role="status">
            <p className="text-section font-semibold">{t('success', { count: done.lines })}</p>
            <p className="text-muted-foreground">{t('period', { from: formatDateBE(done.from), to: formatDateBE(done.to) })}</p>
            {done.warnings.length ? (
              <Alert>
                <AlertTitle>{t('warnings')}</AlertTitle>
                <AlertDescription className="text-foreground!"><ul className="list-disc pl-4">{done.warnings.map((w) => <li key={w}>{w}</li>)}</ul></AlertDescription>
              </Alert>
            ) : null}
            <div className="flex justify-end"><Button onClick={onClose}>{t('close')}</Button></div>
          </div>
        ) : (
          <form className="grid gap-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {formError ? <Alert variant="destructive" role="alert"><AlertTitle>{formError}</AlertTitle></Alert> : null}
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-file`}>{t('file')}</Label>
              <Input id={`${id}-file`} type="file" accept=".csv,.pdf,text/csv,application/pdf" onChange={(e) => { setFile(e.target.files?.[0]); setFormError(undefined); }} />
            </div>
            {format === 'kplus-pdf' ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-pw`}>{t('password')}</Label>
                <Input id={`${id}-pw`} type="password" autoComplete="off" value={password} aria-describedby={`${id}-pw-hint`} onChange={(e) => setPassword(e.target.value)} />
                <p id={`${id}-pw-hint`} className="text-small text-muted-foreground">{t('passwordHint')}</p>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>{t('close')}</Button>
              <Button type="submit" disabled={run.isPending}>{run.isPending ? t('submitting') : t('submit')}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
