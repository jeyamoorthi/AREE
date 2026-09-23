# AREE frontend — Next.js production image.
#
# NEXT_PUBLIC_API_URL is baked into the CLIENT BUNDLE at build time, which is why its
# default is empty rather than an absolute URL. An absolute value names a host the
# VIEWER's browser has to resolve, so "http://localhost:8000" only works for someone
# sitting at the machine that runs the container — over a LAN or a tunnel every visitor
# fetches their own localhost. Empty means same-origin, and next.config.ts rewrites
# /api and /ws to AREE_API_ORIGIN (a RUNTIME variable, set in docker-compose.yml).
#
# It is public by design; never pass engine API keys here.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# AREE_API_ORIGIN IS A BUILD-TIME VARIABLE, despite looking like a runtime one.
# Next resolves rewrites() during `next build` and freezes the destinations into
# .next/routes-manifest.json; `next start` reads them from there and never calls the
# config function again. Setting it only in the container's environment therefore did
# nothing — the manifest still pointed at the 127.0.0.1:8102 default and every proxied
# request returned 500.
ARG AREE_API_ORIGIN=http://127.0.0.1:8102
ENV AREE_API_ORIGIN=$AREE_API_ORIGIN

# CARTO basemap key. Build-time, like every NEXT_PUBLIC_ value: it is substituted
# into the client bundle by `next build` below, so supplying it only to the running
# container leaves the maps watermarked "API KEY REQUIRED".
#
# This is the one exception to the "never pass keys to the frontend image" rule at
# the top of this file, and it is not really an exception: tile requests are made by
# the BROWSER, so a basemap key is public by construction. Engine credentials
# (WAQI_TOKEN, GEMINI_API_KEY, FIRMS_API_KEY, ...) are server-side and still must
# never appear here. Empty default so a build without the key still succeeds, with
# watermarked tiles rather than a broken map.
ARG NEXT_PUBLIC_CARTO_KEY=
ENV NEXT_PUBLIC_CARTO_KEY=$NEXT_PUBLIC_CARTO_KEY

ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000
CMD ["npm", "run", "start"]
