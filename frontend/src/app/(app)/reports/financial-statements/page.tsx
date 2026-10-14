import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FinancialStatementsView } from './financial-statements-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('nav.items.financialStatements') };
}
export default function Page() {
  return <FinancialStatementsView />;
}
