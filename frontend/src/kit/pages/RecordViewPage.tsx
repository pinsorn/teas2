'use client';
import { useParams } from 'next/navigation';
import type { RecordDescriptor } from '@/domain/records';
import { RecordView } from '@/kit/record-view/RecordView';

export function RecordViewPage({ descriptor }: { descriptor: RecordDescriptor }) {
  const { id } = useParams<{ id: string }>();
  return <RecordView descriptor={descriptor} id={id} />;
}
