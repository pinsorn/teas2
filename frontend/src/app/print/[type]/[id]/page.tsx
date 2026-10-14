import { notFound } from 'next/navigation';
import type { DocType } from '@/domain/types';
import { PAPERS } from '@/kit/paper/registry';
import { PaperView } from '@/kit/paper/PaperView';

/** Stand-alone print route (no app shell): only the paper. `?copy=1` prints the สำเนา. */
export default async function PrintPage({ params, searchParams }: PageProps<'/print/[type]/[id]'>) {
  const { type, id } = await params;
  if (!Object.hasOwn(PAPERS, type)) notFound();
  const copy = (await searchParams).copy === '1';
  return <PaperView type={type as DocType} id={id} copy={copy} toolbar />;
}
