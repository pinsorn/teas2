import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RunDepreciation } from '@/kit/assets/AssetPanels';
import { TypeGate } from '@/kit/pages/TypeGate';

// AC5: preview and issue one month's depreciation; the list and a view are the generic document screens
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('assets.dp.runTitle') };
}
export default function Page() {
  return <TypeGate type="DP"><RunDepreciation /></TypeGate>;
}
