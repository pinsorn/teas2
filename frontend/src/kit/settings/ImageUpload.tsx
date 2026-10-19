'use client';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

export const MAX_IMAGE_BYTES = 1_048_576;
/** A picture as a data URL (png / jpeg / webp, <= 1 MB; svg is refused). The server judges the data URL again - this only saves a round trip. `value` '' = none. */
export function ImageUpload({ label, value, onChange, error }: { label: string; value?: string; onChange: (dataUrl: string) => void; error?: string }) {
  const t = useTranslations('settings.image');
  const id = useId();
  const [local, setLocal] = useState<string>();
  const types = ['image/png', 'image/jpeg', 'image/webp'];
  const pick = (file: File | undefined) => {
    setLocal(undefined);
    if (!file) return;
    if (!types.includes(file.type)) { setLocal(t('type')); return; }
    if (file.size > MAX_IMAGE_BYTES) { setLocal(t('size')); return; }
    const r = new FileReader();
    r.onload = () => onChange(String(r.result));
    r.onerror = () => setLocal(t('read'));
    r.readAsDataURL(file);
  };
  const shown = local ?? error;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex size-24 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {value
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={value} alt={label} className="max-h-full max-w-full object-contain" />
            : <span className="px-1 text-center text-small text-muted-foreground">{t('none')}</span>}
        </div>
        <input id={id} type="file" accept={types.join(',')} aria-invalid={!!shown} aria-describedby={shown ? `${id}-err` : `${id}-hint`}
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} className="max-w-full text-small" />
        {value ? <Button type="button" variant="outline" size="sm" onClick={() => { setLocal(undefined); onChange(''); }}>{t('remove')}</Button> : null}
      </div>
      <p id={`${id}-hint`} className="text-small text-muted-foreground">{t('hint')}</p>
      {shown ? <p id={`${id}-err`} role="alert" className="text-small text-destructive">{shown}</p> : null}
    </div>
  );
}
