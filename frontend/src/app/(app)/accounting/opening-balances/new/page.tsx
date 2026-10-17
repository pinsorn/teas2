import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ObWizard } from '@/kit/opening/ObWizard';
import { TypeGate } from '@/kit/pages/TypeGate';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations())('opening.title') };
}
export default function Page() {
  return <TypeGate type="OB"><ObWizard mode="create" /></TypeGate>;
}
