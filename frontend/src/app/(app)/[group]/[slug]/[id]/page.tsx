import { notFound } from 'next/navigation';
import { descriptorByPath } from '@/descriptors';
import { DocViewPage } from '@/kit/pages/DocViewPage';

export default async function Page({ params }: PageProps<'/[group]/[slug]/[id]'>) {
  const { group, slug } = await params;
  const d = descriptorByPath(`/${group}/${slug}`);
  if (!d) notFound();
  return <DocViewPage type={d.type} />;
}
