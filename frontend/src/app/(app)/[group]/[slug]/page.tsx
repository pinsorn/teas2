import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ComingInSp1c } from '@/app-shell/ComingInSp1c';
import { matchNavItem } from '@/app-shell/nav';
import { descriptorByPath } from '@/descriptors';
import { DocListPage } from '@/kit/pages/DocListPage';

type P = PageProps<'/[group]/[slug]'>;
const pathOf = async (params: P['params']) => { const { group, slug } = await params; return `/${group}/${slug}`; };
// notFound() here (before the shell streams) is what makes an unknown route answer 404 instead of 200
export async function generateMetadata({ params }: P): Promise<Metadata> {
  const path = await pathOf(params); const d = descriptorByPath(path); const hit = matchNavItem(path);
  if (d) return { title: d.titleTh };
  if (!hit || hit.item.href !== path) notFound();
  return { title: (await getTranslations())(hit.item.labelKey) };
}
export default async function Page({ params }: P) {
  const path = await pathOf(params);
  const d = descriptorByPath(path);
  if (d) return <DocListPage type={d.type} />;
  const hit = matchNavItem(path);
  if (!hit || hit.item.href !== path) notFound();
  return <ComingInSp1c title={(await getTranslations())(hit.item.labelKey)} href={path} />;
}
