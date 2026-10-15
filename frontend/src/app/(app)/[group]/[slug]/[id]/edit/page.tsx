import { notFound } from 'next/navigation';
import { descriptorByPath } from '@/descriptors';
import { DocEditPage } from '@/kit/pages/DocEditPage';

export default async function Page({ params }: PageProps<'/[group]/[slug]/[id]/edit'>) {
  const { group, slug } = await params;
  const d = descriptorByPath(`/${group}/${slug}`);
  if (!d) notFound();
  return <DocEditPage type={d.type} />;
}
