# AREE frontend — Next.js production image.
#
# THE BUG THIS FILE USED TO CONTAIN
#   `ARG NEXT_PUBLIC_API_URL=http://localhost:8000`. That value is compiled INTO
#   the client bundle, so it names a host the VIEWER's browser must resolve.
#   Every visitor's browser then fetched THEIR OWN localhost:8000 — which works
#   only for someone browsing on the Docker host itself, and silently fails for
#   everyone else with the API answering 200 to every check the developer runs.
#
#   The frontend now defaults to SAME-ORIGIN (empty string) and reaches the API
#   through the rewrite in next.config.ts. That rewrite is evaluated by the Next
#   server at RUNTIME, so the backend address is supplied then, as
#   AREE_API_ORIGIN — not compiled into anything the browser sees.
#
#   NEXT_PUBLIC_API_URL is left unset on purpose. Set it only to point the
#   browser directly at a different public origin, and understand that doing so
#   moves the API off same-origin.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
# Empty by default: same-origin. See the note above before changing this.
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# AREE_API_ORIGIN IS A BUILD-TIME VARIABLE, despite looking like a runtime one.
# Next resolves rewrites() during `next build` and freezes the destinations into
# .next/routes-manifest.json; `next start` reads them from there and never calls the
# config function again. Setting it only in the container's environment therefore did
# nothing — the manifest still pointed at the 127.0.0.1:8102 default and every proxied
# request returned 500.
ARG AREE_API_ORIGIN=http://backend:8000
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

# Where the Next server forwards /api and /ws. Overridden at run time; in
# compose this is the backend service name, on Render it is the backend's URL.
ENV AREE_API_ORIGIN=http://backend:8000

EXPOSE 3000
CMD ["npm", "run", "start"]
