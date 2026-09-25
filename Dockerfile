FROM node:22-bookworm-slim AS ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) asset=ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1; sha=c733b4b2951e5957e15505f788b2c65a7a41b6da4b289e295852cc38079b4d2b ;; \
        arm64) asset=ffmpeg-n8.1.2-50-g1a748fe2cd-linuxarm64-gpl-8.1; sha=ae5da4f51b9052390f414005f8ab26c1eed1268f327cce7cb79aa076b29bd66e ;; \
        *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/$asset.tar.xz" -o /tmp/ffmpeg.tar.xz \
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
