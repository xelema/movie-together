// Mesure ce que la détection HDR voit sur un écran donné : une fenêtre Chrome
// est placée aux coordonnées passées en argument (viser un point de l'écran à
// tester, ex. un coin de la TV), puis la page rapporte dynamic-range,
// color-gamut et la réponse HDR de MediaCapabilities.
// Usage : node scripts/check-hdr.js [--position 100,100]
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values: args } = parseArgs({ options: { position: { type: 'string', default: '100,100' } } });
const [x, y] = args.position.split(',').map(Number);

const browser = await chromium.launch({
  headless: process.platform !== 'win32',
  ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
  args: [`--window-position=${x},${y}`],
});
try {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const report = await page.evaluate(async () => ({
    at: [window.screenX, window.screenY], screen: [screen.width, screen.height, screen.colorDepth], dpr: devicePixelRatio,
    dynamicRange: matchMedia('(dynamic-range: high)').matches,
    videoDynamicRange: matchMedia('(video-dynamic-range: high)').matches,
    gamut: ['rec2020', 'p3', 'srgb'].find(g => matchMedia(`(color-gamut: ${g})`).matches),
    hdr: await navigator.mediaCapabilities?.decodingInfo({
      type: 'media-source',
      video: {
        contentType: 'video/mp4; codecs="vp09.02.10.10"', width: 3840, height: 1608,
        bitrate: 20_000_000, framerate: 24,
        transferFunction: 'pq', colorGamut: 'rec2020', hdrMetadataType: 'smpteSt2086',
      },
    }).then(({ supported, smooth, powerEfficient }) => ({ supported, smooth, powerEfficient })).catch(String),
  }));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
