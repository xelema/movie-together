import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Transform } from 'node:stream';

export class TokenBucketThrottle extends Transform {
  constructor({ bytesPerSecond, chunkSize = 16384 }) {
    super();
    this.bytesPerSecond = bytesPerSecond;
    this.chunkSize = chunkSize;
    this.tokens = bytesPerSecond / 10; // initial burst: 100ms
    this.maxTokens = bytesPerSecond / 2; // max burst: 500ms
    this.lastRefill = performance.now();
    this.timer = null;
    this.queue = [];
    this.isStreamEnded = false;
  }

  _transform(chunk, encoding, callback) {
    this.queue.push({ chunk, callback });
    this._drain();
  }

  _refill() {
    const now = performance.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.bytesPerSecond);
  }

  _drain() {
    this._refill();
    while (this.queue.length > 0) {
      const item = this.queue[0];
      const needed = item.chunk.length;
      if (this.tokens >= needed || this.tokens >= this.chunkSize) {
        const sendBytes = Math.min(needed, Math.max(this.chunkSize, Math.floor(this.tokens)));
        this.tokens -= sendBytes;
        if (sendBytes === needed) {
          this.push(item.chunk);
          this.queue.shift();
          item.callback();
        } else {
          this.push(item.chunk.subarray(0, sendBytes));
          item.chunk = item.chunk.subarray(sendBytes);
        }
      } else {
        // Need to wait for more tokens
        if (!this.timer) {
          const waitMs = Math.max(5, Math.ceil(((this.chunkSize - this.tokens) / this.bytesPerSecond) * 1000));
          this.timer = setTimeout(() => {
            this.timer = null;
            this._drain();
          }, waitMs);
        }
        return;
      }
    }
  }

  _flush(callback) {
    const check = () => {
      if (this.queue.length === 0) {
        callback();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  }
}

export function createNetworkShaper({
  targetPort,
  proxyPort,
  latency = 260, // Total RTT in ms
  jitter = 15,   // Jitter in ms (+/-)
  loss = 0.005,  // Packet drop probability (0.5%)
  bandwidthMbps = 40, // Mbps bandwidth cap
}) {
  const halfLatency = () => {
    const j = (Math.random() * 2 - 1) * jitter;
    return Math.max(1, latency / 2 + j);
  };

  const bytesPerSecond = (bandwidthMbps * 1_000_000) / 8;
  const metrics = {
    requests: 0,
    bytesTransferred: 0,
    drops: 0,
    segments: [],
    wsClientToServer: 0,
    wsServerToClient: 0,
    wsDrops: 0,
  };

  const server = http.createServer((req, res) => {
    metrics.requests++;
    const delayReq = halfLatency();
    const startTime = performance.now();

    if (Math.random() < loss) {
      metrics.drops++;
      setTimeout(() => {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Gateway Timeout (Simulated Loss)');
      }, delayReq);
      return;
    }

    setTimeout(() => {
      const options = {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      };

      const upstream = http.request(options, upstreamRes => {
        const delayRes = halfLatency();
        let firstByteTime = null;
        let bytesForThisReq = 0;

        setTimeout(() => {
          firstByteTime = performance.now();
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);

          const throttle = new TokenBucketThrottle({ bytesPerSecond });
          upstreamRes.on('data', chunk => {
            bytesForThisReq += chunk.length;
            metrics.bytesTransferred += chunk.length;
          });

          upstreamRes.pipe(throttle).pipe(res);

          res.on('finish', () => {
            const totalDuration = performance.now() - startTime;
            const ttfb = (firstByteTime || performance.now()) - startTime;
            const mbps = (bytesForThisReq * 8) / ((totalDuration / 1000) * 1e6);

            if (req.url.includes('/media/') || req.url.includes('.m4s') || req.url.includes('.mp4')) {
              metrics.segments.push({
                url: req.url,
                bytes: bytesForThisReq,
                ttfbMs: Math.round(ttfb),
                durationMs: Math.round(totalDuration),
                speedMbps: +mbps.toFixed(2),
              });
            }
          });
        }, delayRes);
      });

      upstream.on('error', err => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(err.message);
        }
      });

      req.pipe(upstream);
    }, delayReq);
  });

  // Handle WebSocket proxying
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const delayUpgrade = halfLatency();
    setTimeout(() => {
      wss.handleUpgrade(req, socket, head, clientWs => {
        const upstreamWs = new WebSocket(`ws://127.0.0.1:${targetPort}${req.url}`, {
          headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
        });

        upstreamWs.on('open', () => {
          clientWs.on('message', (data, isBinary) => {
            metrics.wsClientToServer++;
            if (Math.random() < loss) {
              metrics.wsDrops++;
              return;
            }
            setTimeout(() => {
              if (upstreamWs.readyState === WebSocket.OPEN) {
                upstreamWs.send(data, { binary: isBinary });
              }
            }, halfLatency());
          });

          upstreamWs.on('message', (data, isBinary) => {
            metrics.wsServerToClient++;
            if (Math.random() < loss) {
              metrics.wsDrops++;
              return;
            }
            setTimeout(() => {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data, { binary: isBinary });
              }
            }, halfLatency());
          });

          clientWs.on('close', (code, reason) => upstreamWs.close(code, reason));
          upstreamWs.on('close', (code, reason) => clientWs.close(code, reason));
          clientWs.on('error', () => upstreamWs.terminate());
          upstreamWs.on('error', () => clientWs.terminate());
        });

        upstreamWs.on('error', () => clientWs.terminate());
      });
    }, delayUpgrade);
  });

  return {
    server,
    metrics,
    listen: port => new Promise(res => server.listen(port, res)),
    close: () => new Promise(res => {
      wss.close();
      server.close(res);
    }),
  };
}
