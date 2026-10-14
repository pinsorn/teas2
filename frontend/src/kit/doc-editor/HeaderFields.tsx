'use client';
import { Fragment, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { HeaderFieldKey } from '@/domain/descriptors';
import type { DocHeader } from '@/domain/types';
import { formatDateBE } from '@/lib/format';

export function HeaderFields({ keys, ids, header, setHeader }: {
  keys: HeaderFieldKey[]; ids: string; header: DocHeader; setHeader: Dispatch<SetStateAction<DocHeader>>;
}) {
  const t = useTranslations('docEditor');
  const field = (key: HeaderFieldKey) => {
    switch (key) {
      case 'documentDate': return (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-date`}>{t('documentDate')}</Label>
          <Input id={`${ids}-date`} type="date" value={header.documentDate} onChange={(e) => setHeader((h) => ({ ...h, documentDate: e.target.value }))} />
          {header.documentDate && <p className="text-small text-muted-foreground">{formatDateBE(header.documentDate)}</p>}
        </div>
      );
      case 'dueDate': return (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-due`}>{t('dueDate')}</Label>
          <Input id={`${ids}-due`} type="date" value={header.dueDate ?? ''} onChange={(e) => setHeader((h) => ({ ...h, dueDate: e.target.value || undefined }))} />
          {header.dueDate && <p className="text-small text-muted-foreground">{formatDateBE(header.dueDate)}</p>}
        </div>
      );
      case 'reference': return (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-ref`}>{t('reference')}</Label>
          <Input id={`${ids}-ref`} type="text" autoComplete="off" value={header.reference ?? ''} onChange={(e) => setHeader((h) => ({ ...h, reference: e.target.value }))} />
        </div>
      );
      case 'notes': return (
        <div className="grid gap-1.5 md:col-span-2">
          <Label htmlFor={`${ids}-notes`}>{t('notes')}</Label>
          <Textarea id={`${ids}-notes`} value={header.notes ?? ''} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
        </div>
      );
      default:
        if (process.env.NODE_ENV !== 'production') throw new Error(`Unsupported header field: ${key}`);
        return null;
    }
  };
  return keys.map((key) => <Fragment key={key}>{field(key)}</Fragment>);
}
