'use client';
import { Suspense } from 'react';
import type { RecordDescriptor } from '@/domain/records';
import { RecordList } from '@/kit/record-list/RecordList';
import { TreeRecordList } from '@/kit/record-list/TreeRecordList';
import { LoadingState } from '@/kit/states/LoadingState';

export function RecordListPage({ descriptor }: { descriptor: RecordDescriptor }) {
  return <Suspense fallback={<LoadingState />}>{descriptor.tree ? <TreeRecordList descriptor={descriptor} /> : <RecordList descriptor={descriptor} />}</Suspense>;
}
