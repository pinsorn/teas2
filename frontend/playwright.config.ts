import { defineConfig, devices } from '@playwright/test';

// TEAS_E2E_BASE_URL set = the hybrid run against the composed stack (CI `compose` job): only platform-live.spec.ts, no web server of ours.
// Unset = the mock suite on a local build; platform-live.spec.ts is left out (it needs a real API).
const composed = process.env.TEAS_E2E_BASE_URL;
const live = /platform-live\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  ...(composed ? { testMatch: live } : { testIgnore: live }),
  use: { baseURL: composed ?? 'http://localhost:3100', locale: 'th-TH', timezoneId: 'Asia/Bangkok' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' } }],
  webServer: composed ? undefined : {
    command: 'corepack pnpm build && corepack pnpm start -p 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    env: { NEXT_PUBLIC_API_MOCKING: 'enabled' },
    timeout: 240_000,
  },
});
