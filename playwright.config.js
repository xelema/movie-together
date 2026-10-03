import { defineConfig } from '@playwright/test';
import { execSync } from 'node:child_process';

// Headless Firefox on Linux needs an audio sink (PulseAudio auto_null) for WebAudio/cubeb.
if (process.platform === 'linux') {
  try { execSync('pulseaudio --start --exit-idle-time=-1', { stdio: 'ignore' }); } catch {}
}

export default defineConfig({
  // Playwright empties outputDir on start: keep it away from the colour report and the screenshots.
  // The self-hosted runner shares a 2 vCPU box with prod: one retry absorbs timing flakes.
  testDir: './e2e', outputDir: './test-results/e2e', timeout: 90_000, workers: 1, fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    // CI has no GPU: mesa gives Firefox software WebGL, which it refuses unless allowed.
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: { 'webgl.forbid-software': false } } } },
    { name: 'webkit', use: { browserName: 'webkit' } }],
  use: { baseURL: `http://localhost:${process.env.E2E_PORT || 3100}`, headless: true, locale: 'fr-FR', timezoneId: 'Europe/Paris', trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/server.js', url: `http://localhost:${process.env.E2E_PORT || 3100}/healthz`, timeout: 60_000, reuseExistingServer: false,
    env: { E2E_PORT: process.env.E2E_PORT || '3100' } },
});
