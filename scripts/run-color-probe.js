// Local check of public/color-probe.html: serves public/ statically and runs the
// probe in Chrome and Firefox, printing the report. Diagnostic only.
import express from 'express';
import path from 'node:path';
import { chromium, firefox } from '@playwright/test';

const app = express();
app.use(express.static(path.resolve('public')));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, type, options] of [['Chrome', chromium, process.platform === 'win32' ? { channel: 'chrome' } : {}], ['Firefox', firefox, {}]]) {
    const browser = await type.launch({ headless: process.platform !== 'win32', ...options });
    try {
      const page = await browser.newPage();
      page.on('console', message => { if (message.type() === 'error') console.log(`[${name} console]`, message.text()); });
      await page.goto(`${base}/color-probe.html`);
      await page.waitForFunction(() => document.getElementById('report').textContent.includes('Terminé'), { timeout: 60000 });
      console.log(`\n########## ${name} ${browser.version()} ##########\n${await page.locator('#report').textContent()}`);
      await page.screenshot({ path: `test-results/colors/probe-${name}.png`, fullPage: true });
    } finally { await browser.close(); }
  }
} finally { server.close(); }
