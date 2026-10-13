import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const nextConfig: NextConfig = {
  output: 'standalone',
  // Scaffold default: Tailwind v4 CSS goes through the Turbopack loader (there is no postcss config).
  turbopack: { rules: { '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' } } },
};
export default withNextIntl(nextConfig);
