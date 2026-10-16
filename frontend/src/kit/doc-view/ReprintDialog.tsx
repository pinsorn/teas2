'use client';
import { useTranslations } from 'next-intl';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/** The original has been printed: another print is a สำเนา. Confirming opens the print page on `?copy=1`. */
export function ReprintDialog({ docLabel, onConfirm, onCancel }: { docLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations('docView.print');
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('reprintTitle', { doc: docLabel })}</AlertDialogTitle>
          <AlertDialogDescription>{t('reprintBody')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('back')}</AlertDialogCancel>
          <Button type="button" onClick={onConfirm}>{t('reprintConfirm')}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
