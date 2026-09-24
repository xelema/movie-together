import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Playwright empties outputDir on start: keep it away from the colour report and the screenshots.
  testDir: './e2e', outputDir: './test-results/e2e', timeout: 90_000, workers: 1, fullyParallel: false,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    // CI has no GPU: mesa gives Firefox software WebGL, which it refuses unless allowed.
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: { 'webgl.forbid-software': false } } } },
    { name: 'webkit', use: { browserName: 'webkit' } }],
  use: { baseURL: 'http://localhost:3100', headless: true, locale: 'fr-FR', timezoneId: 'Europe/Paris', trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/server.js', url: 'http://localhost:3100/healthz', timeout: 60_000, reuseExistingServer: false },
});
