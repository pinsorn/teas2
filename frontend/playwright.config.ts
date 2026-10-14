import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:3100', locale: 'th-TH', timezoneId: 'Asia/Bangkok' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' } }],
  webServer: {
    command: 'corepack pnpm build && corepack pnpm start -p 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    env: { NEXT_PUBLIC_API_MOCKING: 'enabled' },
    timeout: 240_000,
  },
});
