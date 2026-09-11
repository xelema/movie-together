FROM node:22-bookworm-slim AS ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) asset=ffmpeg-n8.1.2-52-g5a03dfa0f6-linux64-gpl-8.1; sha=6fc8d0a3ac9e3956bef486655fbc0a049fb3dacb74ea2e44cc2fc62eeb80a182 ;; \
        arm64) asset=ffmpeg-n8.1.2-52-g5a03dfa0f6-linuxarm64-gpl-8.1; sha=077a3a11f41e38b2d54c905157d6bcb86e6ea6d027a0c0a582582e470149458d ;; \
        *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-11-13-20/$asset.tar.xz" -o /tmp/ffmpeg.tar.xz \
    && echo "$sha  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
    && install -m 755 "/tmp/$asset/bin/ffmpeg" "/tmp/$asset/bin/ffprobe" /usr/local/bin/

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffprobe
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
