import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DocListPage } from '@/kit/pages/DocListPage';

// the list of opening balances (at most one live per company, plus drafts and cancelled ones); the wizard is /new, a view is the generic document view
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('nav.items.openingBalances') };
}
export default function Page() {
  return <DocListPage type="OB" />;
}
