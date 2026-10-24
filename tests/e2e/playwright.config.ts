import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  workers: 1,
  timeout: 5 * 60_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 1000 }
  },
  webServer: {
    command: 'node mock-httpd.mjs',
    url: 'http://127.0.0.1:8080/user1.asp',
    reuseExistingServer: false,
    timeout: 60_000
  }
});
