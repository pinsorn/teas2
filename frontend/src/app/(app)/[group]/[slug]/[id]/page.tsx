import { notFound } from 'next/navigation';
import { descriptorByPath } from '@/descriptors';
import { DocViewPage } from '@/kit/pages/DocViewPage';
import { RecordViewPage } from '@/kit/pages/RecordViewPage';
import { recordByPath } from '@/records';

export default async function Page({ params }: PageProps<'/[group]/[slug]/[id]'>) {
  const { group, slug } = await params;
  const d = descriptorByPath(`/${group}/${slug}`);
  const rec = d ? undefined : recordByPath(`/${group}/${slug}`);
  if (rec?.detail) return <RecordViewPage descriptor={rec} />;
  if (!d) notFound();
  return <DocViewPage type={d.type} />;
}
