'use client';
import { Suspense } from 'react';
import type { RecordDescriptor } from '@/domain/records';
import { RecordList } from '@/kit/record-list/RecordList';
import { LoadingState } from '@/kit/states/LoadingState';

export function RecordListPage({ descriptor }: { descriptor: RecordDescriptor }) {
  return <Suspense fallback={<LoadingState />}><RecordList descriptor={descriptor} /></Suspense>;
}
