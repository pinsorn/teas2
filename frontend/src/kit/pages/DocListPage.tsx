'use client';
import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { DESCRIPTORS } from '@/descriptors';
import type { DocType } from '@/domain/types';
import { DocList } from '@/kit/doc-list/DocList';
import { LoadingState } from '@/kit/states/LoadingState';
import { columnsFor, savedViewsFor } from './columns';
import { TypeGate } from './TypeGate';

export function DocListPage({ type }: { type: DocType }) {
  const d = DESCRIPTORS[type]!;
  const t = useTranslations('docList');
  const common = useTranslations('common');
  return <TypeGate type={type}><Suspense fallback={<LoadingState />}>
    <DocList descriptor={d} columns={columnsFor(d, t, common)} savedViews={savedViewsFor(d, t)} bulkActions={[]} />
  </Suspense></TypeGate>;
}
