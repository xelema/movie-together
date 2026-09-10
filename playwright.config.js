import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Playwright empties outputDir on start: keep it away from the colour report and the screenshots.
  testDir: './e2e', outputDir: './test-results/e2e', timeout: 90_000, workers: 1, fullyParallel: false,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  use: { baseURL: 'http://localhost:3100', headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/server.js', url: 'http://localhost:3100/healthz', timeout: 60_000, reuseExistingServer: false },
});
