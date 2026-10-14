import { notFound } from 'next/navigation';
import { PaperView } from '@/kit/paper/PaperView';

/** Stand-alone print route (no app shell): only the paper. `?copy=1` prints the สำเนา. */
export default async function PrintPage({ params, searchParams }: PageProps<'/print/[type]/[id]'>) {
  const { type, id } = await params;
  if (type !== 'TI') notFound(); // SP1ab ships the tax-invoice form only
  const copy = (await searchParams).copy === '1';
  return <PaperView type="TI" id={id} copy={copy} toolbar />;
}
