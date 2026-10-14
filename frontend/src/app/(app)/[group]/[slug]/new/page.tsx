import { notFound } from 'next/navigation';
import { descriptorByPath } from '@/descriptors';
import { DocNewPage } from '@/kit/pages/DocNewPage';

export default async function Page({ params }: PageProps<'/[group]/[slug]/new'>) {
  const { group, slug } = await params;
  const d = descriptorByPath(`/${group}/${slug}`);
  if (!d) notFound();
  return <DocNewPage type={d.type} />;
}
