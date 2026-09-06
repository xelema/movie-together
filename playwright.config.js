import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', timeout: 90_000, workers: 1, fullyParallel: false,
  use: { baseURL: 'http://localhost:3100', headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/server.js', url: 'http://localhost:3100/healthz', timeout: 60_000, reuseExistingServer: false },
});
