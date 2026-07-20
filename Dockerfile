# RecipeCart production image (Phase 4 / Spec 4 §2.7).
#
# ONE image, TWO Railway services ("api" and "worker") — see railway.json.
# CMD is deliberately NOT set here; each service supplies its own start
# command (`npm run start:api` / `npm run start:worker`) via Railway config,
# since both processes ship in the same image (they share dependencies and
# compiled output, and only differ in which entrypoint they run).
#
# Base image: node:22-slim (Debian bookworm), NOT node:22-alpine.
#   - tesseract.js (OCR) and @huggingface/transformers (local Whisper ASR)
#     pull in native/prebuilt-binary deps (onnxruntime-node, sharp) that
#     ship as glibc prebuilds. Alpine's musl libc means those either need a
#     from-source compile (slow, more build deps, more failure surface) or
#     simply have no musl prebuild published. Debian slim avoids that class
#     of problem entirely — confirmed locally: `npm ci --omit=dev` on this
#     glibc dev machine resolved sharp's platform-specific optional dep and
#     `require("sharp")` worked with no build step.
#   - yt-dlp is a Python script; Debian's apt has a straightforward
#     `python3` + `yt-dlp` (via pip, since Debian's own yt-dlp package lags
#     upstream releases and TikTok extractors change often) install path.

# ---- Stage 1: builder — full deps, compile TypeScript -> dist/ ----
FROM node:22-slim AS builder
WORKDIR /app

# package*.json first so `npm ci` is cached unless deps actually change.
COPY package.json package-lock.json ./
RUN npm ci

# App source + compile. tsconfig.json's rootDir/outDir (src/ -> dist/) means
# only src/ is needed here (spikes/ is excluded from tsc via tsconfig's
# "exclude").
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Web SPA — built separately (own package.json/lock, own Vite/tsc build) and
# served statically by the api process at runtime (src/api/server.ts). Built
# here, in the same builder stage, so the runtime stage only ever copies
# compiled output, never a second full npm ci.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# ---- Stage 2: runtime — slim, prod deps only + compiled JS ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production

# OS packages the code shells out to by name on PATH (grep-confirmed):
#   - ffmpeg (bundles ffprobe): src/pipeline/extract/media_split.ts,
#     resize_frames.ts, probe.ts, dedup_frames.ts
#   - yt-dlp (via python3/pip, see base-image comment above):
#     src/pipeline/extract/download.ts
# Installed as root before creating the unprivileged app user, then apt
# lists are cleaned up in the same layer to keep image size down.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       python3-pip \
       ca-certificates \
       util-linux \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. DATA_DIR (default ./data, overridable) is where the worker
# writes per-job temp media plus the tesseract/transformers model caches.
# Railway mounts an attached volume owned by root regardless of the image's
# USER — confirmed live in production (EACCES on every worker job before
# this fix) — so this container starts as root and docker-entrypoint.sh
# chowns the real runtime DATA_DIR before dropping to this user via
# setpriv (util-linux, installed above). USER is deliberately NOT set here
# anymore; see docker-entrypoint.sh.
RUN groupadd --gid 1001 nodejs && useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home appuser

WORKDIR /app

# package*.json + prod-only install, cached independently of app code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled output only — no src/, no tsconfig, no devDependencies.
COPY --from=builder /app/dist ./dist
# Built web SPA, served statically by the api process (server.ts checks this
# path exists — the worker service just never gets a request that hits it).
COPY --from=builder /app/web/dist ./web/dist

RUN mkdir -p /app/data && chown -R appuser:nodejs /app

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# No EXPOSE needed for correctness (Railway detects the bound port via
# PORT env var at runtime), but documents the api service's default for
# humans reading this file. The worker service does not listen on any port.
EXPOSE 3001

# No CMD: Railway's per-service Custom Start Command supplies one of
#   npm run start:api      (node dist/api/index.js)
#   npm run start:worker   (node dist/worker/index.js)
# as this ENTRYPOINT's argv — see docker-entrypoint.sh for what it does
# with them (chown the real runtime DATA_DIR, then exec as appuser).
ENTRYPOINT ["/app/docker-entrypoint.sh"]
