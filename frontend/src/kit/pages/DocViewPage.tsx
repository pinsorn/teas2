'use client';
import { useParams } from 'next/navigation';
import { DESCRIPTORS } from '@/descriptors';
import type { DocType } from '@/domain/types';
import { DocView } from '@/kit/doc-view/DocView';
import { TypeGate } from './TypeGate';

export function DocViewPage({ type }: { type: DocType }) {
  const d = DESCRIPTORS[type]!;
  const { id } = useParams<{ id: string }>();
  return <TypeGate type={type}><DocView descriptor={d} id={id} /></TypeGate>;
}
