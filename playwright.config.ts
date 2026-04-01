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
    command: 'npx tsx bin/evo.ts dashboard --port 4201 --evo-dir ./tests/e2e/fixtures/.evo',
    port: 4201,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
