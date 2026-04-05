import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4201',
    headless: true,
  },
  webServer: {
    command: 'npx tsx bin/kultiv.ts dashboard --port 4201 --kultiv-dir ./tests/e2e/fixtures/.kultiv',
    port: 4201,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
