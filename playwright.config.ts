import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/web',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 3 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:7391',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 60000,
});
