/**
 * Relay for CPCB's public CAAQMS station feed.
 *
 * WHY THIS EXISTS
 *   The hosted backend (Render, Singapore) could not read airquality.cpcb.gov.in,
 *   while the identical request succeeded from a machine in India and from a
 *   server outside it. So the per-pollutant tiles were filled locally and blank in
 *   production. The backend (backend/ingestion/cpcb_live.py) reads the feed
 *   directly first and falls back to this route when that fails.
 *
 * WHY vercel.json PINS FUNCTIONS TO MUMBAI (bom1)
 *   Measured after the first deploy: Render (Singapore) got a ConnectTimeout and this
 *   route, running in Vercel's default US region, got "fetch failed". CPCB drops
 *   connections from those hosts. The relay is only useful from an Indian region, and
 *   Next 16 no longer lets one route pick its region, so the project's functions run
 *   in bom1 - which is also the region nearest this app's users and its backend.
 *
 * WHAT IT CANNOT DO
 *   Fetch anything else. It takes no parameters and the upstream URL is fixed, so
 *   it is not an open proxy.
 *
 * CACHING
 *   CPCB refreshes the feed hourly. A good response is cached at the edge for five
 *   minutes, so however often the backend or anyone else calls this, CPCB sees at
 *   most one request per five minutes from it. Failures are never cached: an error
 *   held for five minutes would outlive the outage that caused it.
 */

const FEED_URL = "https://airquality.cpcb.gov.in/caaqms/iit_rss_feed_with_coordinates";

// Same browser identity the backend sends; see REQUEST_HEADERS in cpcb_stream.py.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function failure(detail: string): Response {
  return Response.json(
    { error: "cpcb_feed_unavailable", detail },
    { status: 502, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(): Promise<Response> {
  let body: string;
  try {
    const upstream = await fetch(FEED_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    if (!upstream.ok) return failure(`upstream HTTP ${upstream.status}`);
    body = await upstream.text();
  } catch (err) {
    return failure(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }

  // An error page served with a 200 must not be cached as the feed.
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("country" in parsed)) {
      return failure("upstream response is not the CPCB station feed");
    }
  } catch {
    return failure("upstream response is not JSON");
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
