import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RegisterAssets } from '@/kit/assets/AssetPanels';
import { TypeGate } from '@/kit/pages/TypeGate';

// AC5: the register of capex lines (bills, vouchers, opening-balance rows) not yet made into assets; the list and a view are the generic document screens
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('assets.register.title') };
}
export default function Page() {
  return <TypeGate type="FA"><RegisterAssets /></TypeGate>;
}
