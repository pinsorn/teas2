'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Doc } from '@/domain/types';
import { AmortiseDialog, RecurringDialog } from '../schedules/ScheduleDialogs';
import { Guarded } from './Guarded';

const RECURRING = ['QT', 'TI', 'IV', 'PB', 'JV'];
const AMORTISE = ['PB', 'JV'];
export const SCHEDULE_PERMISSION = 'ledger.schedule.manage';

/** AC4: "ตั้งเป็นรายการซ้ำ" (QT TI IV PB JV) and "ตั้งตัดจ่าย" (a PB / JV line on a prepaid account) on an issued document. A disabled button says why. */
export function ScheduleActions({ doc, permissions }: { doc: Doc; permissions: string[] }) {
  const t = useTranslations('docView.actions');
  const [open, setOpen] = useState<'recurring' | 'amortise'>();
  const why = permissions.includes(SCHEDULE_PERMISSION) ? undefined : t('needSchedulePermission', { permission: SCHEDULE_PERMISSION });
  const label = `${doc.type} ${doc.number ?? ''}`.trim();
  return (
    <>
      {RECURRING.includes(doc.type) ? <Guarded why={why}>{(p) => <Button {...p} variant="outline" onClick={() => setOpen('recurring')}>{t('makeRecurring')}</Button>}</Guarded> : null}
      {AMORTISE.includes(doc.type) ? <Guarded why={why}>{(p) => <Button {...p} variant="outline" onClick={() => setOpen('amortise')}>{t('makeAmortisation')}</Button>}</Guarded> : null}
      {open === 'recurring' ? <RecurringDialog doc={doc} label={label} onClose={() => setOpen(undefined)} /> : null}
      {open === 'amortise' ? <AmortiseDialog doc={doc} label={label} onClose={() => setOpen(undefined)} /> : null}
    </>
  );
}
