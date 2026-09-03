import type { NextConfig } from "next";

/**
 * The backend is reached through THIS server, not directly by the browser.
 *
 * WHY
 *   `NEXT_PUBLIC_API_URL` is baked into the client bundle, so it names a host the
 *   VIEWER's browser has to resolve. Pointing it at 127.0.0.1:8102 works only while
 *   the viewer is the same machine that runs the API. Share the dashboard over a
 *   tunnel and every request goes to the visitor's own loopback, which is either
 *   nothing at all or — worse — something else of theirs.
 *
 *   Rewriting /api and /ws here makes the API same-origin: the browser asks the page
 *   it is already on, and Next forwards to the local backend. One public URL then
 *   carries the whole application, and the API is never exposed on its own.
 *
 * SECURITY NOTE
 *   This does not add authentication — there is none — it only removes the need to
 *   publish a second origin. Anyone holding the tunnel URL can reach every endpoint
 *   behind it, including case decisions and the policy upload.
 */
const API_ORIGIN = process.env.AREE_API_ORIGIN ?? "http://127.0.0.1:8102";

/**
 * Hosts the dev server will serve its own JS chunks to.
 *
 * Next blocks cross-origin requests for dev resources by default. Reached through a
 * tunnel the HTML arrives fine and then every chunk is refused, so the page renders
 * its shell, never hydrates, and sits on "Loading outlook…" forever — with the API
 * answering 200 the whole time, which makes it look like a data problem rather than
 * an asset one.
 *
 * Set AREE_DEV_ORIGIN to the tunnel host when sharing. This is a DEV-SERVER
 * allowance only and has no effect on a production build.
 */
const DEV_ORIGINS = [
  process.env.AREE_DEV_ORIGIN,
  ".trycloudflare.com",
].filter((v): v is string => Boolean(v));

const nextConfig: NextConfig = {
  allowedDevOrigins: DEV_ORIGINS,

  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` },
      { source: "/ws/:path*", destination: `${API_ORIGIN}/ws/:path*` },
    ];
  },
};

export default nextConfig;
