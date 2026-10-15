import th from '@/messages/th.json';
import en from '@/messages/en.json';

export const PERMISSIONS: Record<string, { th: string; en: string }> = Object.fromEntries(
  Object.entries(th.permissions).map(([code, label]) => [code.replaceAll('_', '.'), { th: label, en: en.permissions[code as keyof typeof en.permissions] }]),
);
