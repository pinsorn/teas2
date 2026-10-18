import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ReportTabs } from '../reports-tabs';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('nav.items.salesPurchases') };
}
export default function Page() {
  return <ReportTabs page="sp" />;
}
