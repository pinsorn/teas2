import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ComingInSp1c } from '@/app-shell/ComingInSp1c';
import { matchNavItem } from '@/app-shell/nav';
import { descriptorByPath } from '@/descriptors';
import { DocListPage } from '@/kit/pages/DocListPage';
import { RecordListPage } from '@/kit/pages/RecordListPage';
import { RolesPage, UsersPage } from '@/kit/settings/PeopleRoles';
import { recordByPath } from '@/records';

type P = PageProps<'/[group]/[slug]'>;
const pathOf = async (params: P['params']) => { const { group, slug } = await params; return `/${group}/${slug}`; };
// notFound() here (before the shell streams) is what makes an unknown route answer 404 instead of 200
export async function generateMetadata({ params }: P): Promise<Metadata> {
  const path = await pathOf(params); const d = descriptorByPath(path); const hit = matchNavItem(path);
  if (d) return { title: d.titleTh };
  const rec = recordByPath(path);
  if (rec) return { title: (await getTranslations())(rec.titleKey) };
  if (!hit || hit.item.href !== path) notFound();
  return { title: (await getTranslations())(hit.item.labelKey) };
}
export default async function Page({ params }: P) {
  const path = await pathOf(params);
  const d = descriptorByPath(path);
  if (d) return <DocListPage type={d.type} />;
  if (path === '/settings/users') return <UsersPage />; // ST1: custom pages (invite / reset links and roles are commands, not a form)
  if (path === '/settings/roles') return <RolesPage />;
  const rec = recordByPath(path);
  if (rec) return <RecordListPage descriptor={rec} />;
  const hit = matchNavItem(path);
  if (!hit || hit.item.href !== path) notFound();
  return <ComingInSp1c title={(await getTranslations())(hit.item.labelKey)} href={path} />;
}
