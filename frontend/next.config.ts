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
/**
 * THE PATTERN SYNTAX IS GLOB, NOT A SUFFIX. This was wrong and it mattered.
 *
 *   ".trycloudflare.com"   ← what this used to say, and it NEVER matched
 *   "**.trycloudflare.com" ← what actually works
 *
 * Next matches with `matchWildcardDomain` (server/app-render/csrf-protection),
 * which splits the pattern on "." and compares segment by segment. A leading dot
 * produces an empty first segment, and an empty segment is explicitly rejected —
 * so every tunnel host fell through to blocked.
 *
 * WHY IT LOOKED FINE FOR SO LONG
 *   Next only blocks when the request carries a cross-site Origin/Referer. curl
 *   sends neither, so every command-line check of a chunk returned 200 while a
 *   real browser got 403 on the same URL. The page then served its HTML, failed
 *   to fetch its JS, and sat on "Loading outlook…" — with the API answering 200
 *   throughout, which makes it look like a data problem instead of an asset one.
 *
 *   Verifying this needs `-H "Origin: https://<tunnel-host>"`. Without that
 *   header the check cannot fail, which makes it worthless.
 */
const DEV_ORIGINS = [
  process.env.AREE_DEV_ORIGIN,
  "**.trycloudflare.com",
  // 127.0.0.1 IS NOT localhost, as far as this check is concerned.
  //
  // Next allows "localhost" and "**.localhost" out of the box, plus whatever
  // hostname the dev server was started with. The loopback IP matches none of
  // them, so opening http://127.0.0.1:3101 got its chunks blocked while
  // http://localhost:3101 worked — same server, same port, different spelling.
  //
  // The symptom was the Ventilation page sitting on "Loading ventilation
  // diagnostic…" forever, which reads as a data problem and is not one.
  "127.0.0.1",
  // For a LAN address (Next prints one as "Network:" at startup) set
  // AREE_DEV_ORIGIN=192.168.x.x — a bare IP cannot be globbed usefully.
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
