import { createApplication } from '../src/app.js';
import { chromium, webkit, devices } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/storage.js';

export const PROFILES = {
  'seoul-fiber': {
    name: 'Seoul Transcontinental Fiber',
    rtt: 260, // ms
    jitter: 15, // ms
    bandwidthMbps: 40,
    lossRate: 0.002, // 0.2%
  },
  'seoul-mobile': {
    name: 'Seoul Mobile 4G/5G Congested',
    rtt: 340, // ms
    jitter: 35, // ms
    bandwidthMbps: 18,
    lossRate: 0.015, // 1.5%
  },
  'poor-connection': {
    name: 'Poor / Flaky Long-Haul Link',
    rtt: 220, // ms
    jitter: 50, // ms
    bandwidthMbps: 8,
    lossRate: 0.030, // 3.0%
  },
};

export const DEVICES = {
  pc: {
    name: 'Desktop PC (Chromium)',
    browserType: 'chromium',
    options: {
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      isMobile: false,
      hasTouch: false,
    },
  },
  ipad: {
    name: 'Apple iPad Pro (WebKit)',
    browserType: 'webkit',
    options: {
      ...devices['iPad Pro 11'],
    },
  },
};

export async function runBenchmarkScenario({
  profileKey = 'seoul-fiber',
  deviceKey = 'pc',
  durationSeconds = 15,
  minBuffer = 8,
  dataDir = path.resolve('data'),
} = {}) {
  const profile = PROFILES[profileKey];
  const device = DEVICES[deviceKey];
  if (!profile) throw new Error(`Unknown profile: ${profileKey}`);
  if (!device) throw new Error(`Unknown device: ${deviceKey}`);

  const store = createStore(dataDir);
  const readyMovie = [...store.movies.values()].find(m => m.status === 'ready');
  if (!readyMovie) throw new Error('No ready movie found in data store');

  const targetPort = 3399;
  const baseUrl = `http://localhost:${targetPort}`;

  const instance = createApplication({
    dataDir,
    origin: baseUrl,
    password: 'bench-password-16chars-secure',
  });

  await new Promise(r => instance.server.listen(targetPort, '127.0.0.1', r));

  let browser;
  try {
    // 1. Admin login to create room
    const loginRes = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ password: 'bench-password-16chars-secure' }),
    });
    const adminCookie = loginRes.headers.get('set-cookie');

    // Tune minBuffer if specified
    await fetch(`${baseUrl}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: baseUrl },
      body: JSON.stringify({ minBuffer, lowBuffer: Math.max(1, minBuffer - 5) }),
    });

    // 2. Create room with movie
    const roomCode = 'bench-' + randomUUID().slice(0, 8);
    const roomRes = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: baseUrl },
      body: JSON.stringify({ code: roomCode, movieId: readyMovie.id }),
    });
    if (!roomRes.ok) throw new Error(`Failed to create room: ${roomRes.status} ${await roomRes.text()}`);
    const room = await roomRes.json();

    // 3. Launch browser
    const browserLauncher = device.browserType === 'webkit' ? webkit : chromium;
    browser = await browserLauncher.launch({
      headless: true,
      args: device.browserType === 'chromium' ? [
        '--autoplay-policy=no-user-gesture-required',
      ] : [],
    });

    const context = await browser.newContext(device.options);

    // Track segment downloads
    const segmentDownloads = [];
    const bytesPerSec = (profile.bandwidthMbps * 1_000_000) / 8;

    // HTTP Route throttling: simulate network latency, jitter, loss & bandwidth limit on media segments
    await context.route('**/*', async (route, request) => {
      const url = request.url();
      const isMedia = url.includes('/media/') || url.includes('.m4s') || url.includes('.mp4');

      if (!isMedia) {
        await route.continue();
        return;
      }

      // Random loss on media
      if (Math.random() < profile.lossRate) {
        await route.abort('timedout');
        return;
      }

      const halfDelay = () => {
        const j = (Math.random() * 2 - 1) * profile.jitter;
        return Math.max(1, Math.round(profile.rtt / 2 + j));
      };

      const delayReq = halfDelay();
      await new Promise(r => setTimeout(r, delayReq));

      const startTime = performance.now();
      let response;
      try {
        response = await route.fetch();
      } catch (err) {
        await route.abort('failed');
        return;
      }

      const body = await response.body();
      const delayRes = halfDelay();

      if (body.length > 1000) {
        // Bandwidth throttling: time to transfer body bytes
        const transferTimeMs = (body.length / bytesPerSec) * 1000;
        await new Promise(r => setTimeout(r, delayRes + transferTimeMs));
        const totalDuration = performance.now() - startTime;
        const mbps = (body.length * 8) / ((totalDuration / 1000) * 1e6);
        segmentDownloads.push({
          url: url.split('/').pop(),
          bytes: body.length,
          durationMs: Math.round(totalDuration),
          speedMbps: +mbps.toFixed(2),
        });
      } else {
        await new Promise(r => setTimeout(r, delayRes));
      }

      await route.fulfill({ response, body });
    });

    const page = await context.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERR:', err));
    page.on('response', resp => {
      if (!resp.ok()) console.log('RESP FAILED:', resp.status(), resp.url());
    });

    // Emulate WebSocket latency & jitter via addInitScript
    await page.addInitScript(
      ({ rtt, jitter, lossRate }) => {
        const OrigWS = window.WebSocket;
        window.WebSocket = class extends OrigWS {
          constructor(...args) {
            super(...args);
            const halfDelay = () => {
              const j = (Math.random() * 2 - 1) * jitter;
              return Math.max(1, Math.round(rtt / 2 + j));
            };

            const sendOrig = this.send.bind(this);
            this.send = data => {
              if (Math.random() < lossRate) return;
              const delay = halfDelay();
              setTimeout(() => {
                try {
                  if (this.readyState === OrigWS.OPEN) sendOrig(data);
                } catch {}
              }, delay);
            };

            let clientOnMessage = null;
            Object.defineProperty(this, 'onmessage', {
              get: () => clientOnMessage,
              set: fn => {
                clientOnMessage = fn;
                OrigWS.prototype.addEventListener.call(this, 'message', event => {
                  if (Math.random() < lossRate) return;
                  const delay = halfDelay();
                  setTimeout(() => {
                    if (clientOnMessage) clientOnMessage(event);
                  }, delay);
                });
              },
            });
          }
        };
      },
      { rtt: profile.rtt, jitter: profile.jitter, lossRate: profile.lossRate }
    );

    // Join room
    await page.goto(`${baseUrl}/`);
    await page.locator('#join-form input').fill(roomCode);
    await page.locator('#join-form button').click();

    await page.waitForSelector('#name-dialog', { state: 'visible' });
    await page.locator('#room-name').fill('BenchUser');
    await page.locator('#name-dialog button').click();

    // Wait for player to load and establish connection
    const t0 = performance.now();
    await page.waitForFunction(() => !!window.player, { timeout: 15_000 });

    // Track playback progression and metrics
    const metrics = await page.evaluate(async ({ durationSeconds }) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const samples = [];
      const startTime = performance.now();
      let firstPlayableTime = null;
      let startHandshakeMs = null;
      let startFreezeCount = 0;
      let prevPhase = null;

      // Monitor loop
      while (performance.now() - startTime < durationSeconds * 1000) {
        const player = window.player;
        const video = document.querySelector('video');

        if (player) {
          const clock = player.clock;
          const phase = player.state?.phase;
          const position = player.position ? player.position() : 0;
          const target = player.target ? player.target() : 0;

          // Check if buffer reached minBuffer
          const bufferedAhead = Math.max(0, (video?.buffered?.length ? video.buffered.end(video.buffered.length - 1) : 0) - position);

          if (!firstPlayableTime && bufferedAhead >= (player.sync?.minBuffer || 8)) {
            firstPlayableTime = performance.now() - startTime;
          }

          if (prevPhase === 'playing' && phase === 'buffering') {
            startFreezeCount++;
          }
          prevPhase = phase;

          // Check clock
          samples.push({
            t: Math.round(performance.now() - startTime),
            phase,
            clockReady: clock?.ready || false,
            clockBestRtt: clock?.best ? Math.round(clock.best.rtt) : null,
            clockOffset: clock?.offset ? Math.round(clock.offset) : null,
            bufferedAhead: +bufferedAhead.toFixed(2),
            currentTime: +(video?.currentTime || 0).toFixed(2),
            drift: +Math.abs(target - position).toFixed(3),
            paused: video?.paused,
            readyState: video?.readyState,
            hlsBufferSize: player.backend?.hls?.bufferController?.mediaBufferSize || null,
          });

          // If room wants to play, trigger play command if not yet done
          if (!player.activated) {
            try { player.activate?.(); } catch {}
          }
        }
        await wait(250);
      }

      return {
        samples,
        firstPlayableTime,
        startFreezeCount,
      };
    }, { durationSeconds });

    // Post-process metrics
    const p50 = arr => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const p95 = arr => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)];
    };

    const segmentDurations = segmentDownloads.map(s => s.durationMs);
    const segmentSpeeds = segmentDownloads.map(s => s.speedMbps);
    const drifts = metrics.samples.map(s => s.drift).filter(d => Number.isFinite(d));
    const buffers = metrics.samples.map(s => s.bufferedAhead).filter(b => Number.isFinite(b));
    const clockRtts = metrics.samples.map(s => s.clockBestRtt).filter(r => r !== null);
    const clockReadySamples = metrics.samples.filter(s => s.clockReady);

    const clockCalibrated = clockReadySamples.length > 0;
    const clockCalibrationTimeMs = clockCalibrated ? clockReadySamples[0].t : null;

    const stalls = metrics.samples.filter((s, i) => i > 0 && s.phase === 'playing' && s.bufferedAhead <= 0.1).length;

    const totalBytes = segmentDownloads.reduce((acc, s) => acc + s.bytes, 0);
    const totalSegDuration = segmentDownloads.reduce((acc, s) => acc + s.durationMs, 0);
    const overallGoodputMbps = totalSegDuration > 0 ? +((totalBytes * 8) / ((totalSegDuration / 1000) * 1e6)).toFixed(2) : 0;

    return {
      profileKey,
      profileName: profile.name,
      deviceKey,
      deviceName: device.name,
      rttTargetMs: profile.rtt,
      bandwidthCapMbps: profile.bandwidthMbps,
      lossRatePercent: profile.lossRate * 100,

      // Results
      ttfpSeconds: metrics.firstPlayableTime ? +(metrics.firstPlayableTime / 1000).toFixed(2) : null,
      goodputMbps: overallGoodputMbps,
      segmentCount: segmentDownloads.length,
      segmentDurationP50Ms: p50(segmentDurations),
      segmentDurationP95Ms: p95(segmentDurations),
      segmentDurationMaxMs: segmentDurations.length ? Math.max(...segmentDurations) : 0,

      clockCalibrated,
      clockCalibrationTimeMs,
      clockRttP50Ms: p50(clockRtts),
      clockRttMaxMs: clockRtts.length ? Math.max(...clockRtts) : 0,

      maxBufferAheadSeconds: buffers.length ? +Math.max(...buffers).toFixed(2) : 0,
      bufferAheadAt15s: buffers.length ? +buffers[buffers.length - 1].toFixed(2) : 0,

      driftP95Ms: Math.round(p95(drifts) * 1000),
      stallsCount: stalls,
      freezesCount: metrics.startFreezeCount,
    };
  } finally {
    if (browser) await browser.close();
    await instance.close();
  }
}

// CLI execution
if (process.argv[1] && process.argv[1].endsWith('benchmark-network.mjs')) {
  console.log('--- Starting Network Benchmark ---');
  const targetProfile = process.argv[2] || 'seoul-fiber';
  const targetDevice = process.argv[3] || 'pc';
  console.log(`Profile: ${targetProfile}, Device: ${targetDevice}`);
  const result = await runBenchmarkScenario({
    profileKey: targetProfile,
    deviceKey: targetDevice,
    durationSeconds: 12,
  });
  console.log(JSON.stringify(result, null, 2));
}
