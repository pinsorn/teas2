import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

export const LOCALES = ['th', 'en'] as const;
const defaultLocale = 'th';

export default getRequestConfig(async () => {
  const c = (await cookies()).get('locale')?.value;
  const locale = (LOCALES as readonly string[]).includes(c ?? '') ? (c as string) : defaultLocale;
  return { locale, messages: (await import(`../messages/${locale}.json`)).default };
});
