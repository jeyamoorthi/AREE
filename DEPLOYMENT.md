# Deploying AREE

**Backend → Render. Frontend → Vercel.**

Everything below has been built and run locally first; the container numbers and
status codes are measured, not expected.

---

## 1. Why not "just put it all on Vercel"

Vercel runs serverless functions. The AREE backend cannot be one, for three
reasons that are properties of the system rather than preferences:

| Requirement | Why | Vercel |
|---|---|---|
| Persistent filesystem | the store is SQLite + WAL | ✗ ephemeral per invocation |
| A process that keeps running between requests | the hourly capture is an in-process thread; the live forecast needs an unbroken run of observations for lags `[0,1,3,6,12,24]` | ✗ dies after the response |
| Reading 4.5 MB of LightGBM boosters at request time | `load_for()` opens them per forecast | ✗ bundle/size limits |

That last one is not theoretical: this project has already watched the live
forecast return **424** because the API was restarted a few times and the capture
missed hours. On serverless it would never accumulate them at all.

The frontend has none of those constraints, and Vercel is the best place for it.

---

## 2. What you need before starting

```bash
# 1. An operator password hash (never store or transmit the plaintext)
python -c "from backend.api.auth import hash_password; print(hash_password('CHOOSE-A-STRONG-PASSWORD'))"

# 2. Build the AREE_OPERATORS string: user:role:hash;user:role:hash
#    Roles: authority (can decide cases) · admin (can upload policy). No role holds both.
```

Optional feed keys — every one of them degrades gracefully if absent, and the API
says so rather than inventing data: `DATA_GOV_API_KEY` (CPCB), `OPENAQ_API_KEY`,
`WAQI_TOKEN`, `FIRMS_API_KEY`, `GEMINI_API_KEY`.

---

## 3. Backend on Render

### 3.1 Deploy

1. Push the repository to GitHub.
2. Render → **New** → **Blueprint**, point it at the repo. It reads
   `render.yaml`, which already declares the Docker runtime, the health check
   path, the disk and the environment variables.
3. Render will prompt for the `sync: false` variables. Set **`AREE_OPERATORS`**
   to the string from step 2. The feed keys are optional.
4. Deploy.

### 3.2 Keeping live mode up on the free tier

The free tier has no persistent disk and **spins down after ~15 minutes without
traffic**. Every wake is a fresh container with an empty store, and the live
forecast needs an unbroken record of observed PM2.5 at lags 0–24 h. Four pieces
keep that working; each covers a failure the others cannot:

| Piece | Where | What it prevents |
|---|---|---|
| External pinger | cron-job.org (below) | the spin-down itself |
| Hole-filling capture | `capture.yml` → `capture_csv.py export` | an archive with missing hours |
| Remote import at boot | `docker-entrypoint.sh` → `import --remote` | booting from the image's stale copy |
| Last-known outlook | frontend, `OutlookDataProvider` | a blank page during the rare cold start |

**Why an external pinger, and not only `keep-awake.yml`.** GitHub runs scheduled
workflows best-effort. Measured on 2026-09-28, the hourly capture fired 7 times
out of 24, and the `*/10` keep-awake is subject to the same delays, so it cannot
be relied on to beat a 15-minute idle timer.

Set up the pinger once:

1. Create a free account at <https://cron-job.org>.
2. **Keep-awake job**: URL `https://<your-backend>.onrender.com/api/health`,
   every **5 minutes**, method GET. This uses about 730 of Render's 750 free
   instance-hours a month, so it fits one always-on service.
3. **Capture trigger** (recommended): makes the capture actually run hourly.
   - Create a fine-grained GitHub token scoped to this repository only, with
     **Actions: Read and write**.
   - New cron-job.org job, schedule `10 * * * *` (minute 10 of every hour),
     method **POST**, URL
     `https://api.github.com/repos/<owner>/AREE/actions/workflows/capture.yml/dispatches`
   - Headers: `Authorization: Bearer <token>`,
     `Accept: application/vnd.github+json`
   - Body: `{"ref":"main"}`

   The workflow's `concurrency` group stops this and GitHub's own schedule from
   overlapping. Even without this trigger the archive now repairs itself: every
   capture run refills any hour in the last 49 that OpenAQ can supply.

**What is still lost without a disk:** case decisions, escalations and uploaded
policies, which reset on every restart. If this becomes more than a
demonstration, move to a paid instance with the disk described in
`render.yaml`.

### 3.3 Capture commits do not redeploy

`render.yaml` sets `buildFilter.ignoredPaths: observations/**`, so the hourly
capture commits no longer rebuild and restart the backend. A starting container
reads the newest day files from the repository itself. If the service was
created by hand rather than from the Blueprint, set the same ignored path under
**Settings → Build Filters**.

### 3.4 First boot

The entrypoint seeds the store from the committed 1 MB fixture:

```
entrypoint: no store at /app/data/aree.db — seeding from the committed fixture
entrypoint: seeded (1048576 bytes). Replay works now;
entrypoint: live forecasting needs ~24 h of capture to accumulate.
```

Check it came up correctly:

```bash
curl https://<your-backend>.onrender.com/api/health
curl https://<your-backend>.onrender.com/api/auth/config     # expect mode: "configured"
curl "https://<your-backend>.onrender.com/api/aree/outlook?at=2024-11-02T06:00:00Z"
```

If `/api/auth/config` reports `mode: "demo-credentials"`, `AREE_OPERATORS` did not
reach the service — the passwords are then random, per-process, and printed in
the log. Fix it before sharing the link.

---

## 4. Frontend on Vercel

### 4.1 Deploy

1. Vercel → **Add New** → **Project** → import the repo.
2. **Root Directory: `frontend`**. Vercel detects Next.js; leave the build
   command alone.
3. Add these environment variables:

   | Name | Value | Required |
   |---|---|---|
   | `AREE_API_ORIGIN` | `https://<your-backend>.onrender.com` | yes |
   | `NEXT_PUBLIC_CARTO_KEY` | your CARTO basemap key | no |

4. Deploy.

#### `NEXT_PUBLIC_CARTO_KEY`

Without it the maps still render — CARTO serves the tiles watermarked, so a
missing key costs appearance and nothing else. With it the watermark goes away.

It is a **browser-side** key: it is compiled into the bundle and travels in the
tile URL, so anyone using the site can read it. That is simply how tile auth
works and is not a leak. What it is NOT is a repository secret — CARTO asks that
it not be shared with everyone who clones the repo, so it is set here and in
`frontend/.env.local` for local development, and never committed. See the comment
at the top of `src/components/StationMap.tsx`.

Tiles are cached hard by both the browser and CARTO's CDN, so after setting it
**redeploy and then force-refresh** (Ctrl-F5); an old watermarked tile can
otherwise linger for a while and look like the key did not work.

#### Functions run in Mumbai (`bom1`)

`frontend/vercel.json` pins the project's functions to `bom1`. CPCB's
per-pollutant feed (`airquality.cpcb.gov.in`) drops connections from the
backend on Render and from Vercel's default US region, so the backend reads it
through the relay at `/relay/cpcb-feed`, and that relay only works from India.
If you rename the Vercel project, set `AREE_CPCB_RELAY_URL` on the backend to
`https://<your-app>.vercel.app/relay/cpcb-feed`. `/api/system/status` →
`pollutant_sources` shows which route answered.

### 4.2 Do NOT set `NEXT_PUBLIC_API_URL`

This is the single most important line on this page.

`NEXT_PUBLIC_*` values are **compiled into the client bundle**, so they name a
host the *visitor's browser* must resolve. This project has already shipped that
bug twice — once as a `http://localhost:8000` fallback in `api.ts`, once as a
build arg in the frontend Dockerfile. In both cases every visitor's browser
fetched **their own** localhost, which resolves on the developer's machine and
silently fails for everyone else, with the API answering 200 to every check the
developer runs.

`AREE_API_ORIGIN` is different: it is read by the **Next server at run time** and
used by the rewrite in `next.config.ts`. The browser only ever talks to the
Vercel origin it is already on. The API stays same-origin, and no CORS
configuration is required.

### 4.3 The WebSocket channel will NOT work on Vercel

`next.config.ts` rewrites `/ws` alongside `/api`, but **Vercel does not proxy
WebSocket connections**. `useLiveChannel` will fail to connect and the station
header will sit on "WebSocket connecting".

This is a real limitation and it is survivable, because the channel is not the
data path: it exists so the UI can refresh immediately instead of waiting for its
next poll (`backend/api/ws.py`). Every screen already polls REST, so the product
works — it just refreshes on its normal interval rather than instantly.

If you want the live channel, host the frontend on Render too (a second web
service) instead of Vercel, or point the browser at the backend directly with
`NEXT_PUBLIC_API_URL` and accept that you have moved the API off same-origin and
now need CORS. **The first option is the good one.** For a demo, losing the push
channel costs you nothing a judge will notice.

### 4.4 Verify like a browser, not like curl

```bash
SITE=https://<your-app>.vercel.app
curl -s -o /dev/null -w "%{http_code}\n" "$SITE/outlook"
curl -s -o /dev/null -w "%{http_code}\n" "$SITE/api/health"          # proxied to Render
curl -s -o /dev/null -w "%{http_code}\n" "$SITE/api/aree/outlook?at=2024-11-02T06:00:00Z"
```

Then **open it in an actual browser** and confirm the Atmospheric Outlook renders
numbers rather than "Loading outlook…". A curl check cannot catch an asset that
the browser is refused, because curl sends no `Origin` header — that exact gap hid
a broken deployment in this project for hours.

---

## 5. Containers (local, or any VPS)

Everything above also runs as plain containers:

```bash
cp .env.example .env      # if present; otherwise create .env
echo "AREE_JWT_SECRET=$(python -c 'import secrets;print(secrets.token_urlsafe(48))')" >> .env
echo "AREE_OPERATORS=ncr.officer:authority:<hash>" >> .env
docker compose up --build
#   frontend  http://localhost:3000
#   backend   http://localhost:8000/docs
```

Measured on this machine:

| | |
|---|---|
| backend image | **634 MB** (was ~2.5 GB — torch and the OCR stack are gone) |
| healthy after | ~2 s |
| `/api/aree/outlook?at=2024-11-02T06:00:00Z` | 200, 72-point series, case `9de99f8d8332` |
| unauthenticated `POST .../decision` | **401** |

`libgomp1` is installed explicitly: LightGBM dlopens `libgomp.so.1` and
`python:3.13-slim` does not ship it. Removing the old `build-essential` (which
had provided it by accident) produced an image whose `/api/health` returned 200
while every forecast raised `OSError: libgomp.so.1: cannot open shared object
file`. Do not remove that package.

---

## 6. Open items you are deploying with

Stated plainly, because a public URL changes who these affect:

1. **No rate limiting on `POST /api/auth/token`.** 🔴 Login failures are
   constant-time and indistinguishable, so usernames cannot be enumerated — but
   nothing slows down online password guessing. Mitigate at the edge (Cloudflare
   in front of the Vercel domain, or Render's WAF) or accept it knowingly for a
   short-lived demo. Use a long, random operator password either way.
2. **Tokens live 15 minutes and there is no revocation list.** A `jti` is minted
   so a deny-list has somewhere to hang; nothing consumes it yet.
3. **This is a local HS256 issuer, not an OIDC deployment.** The `TokenVerifier`
   seam exists so an RS256/JWKS verifier can replace it without touching route
   code, but no external identity provider has been wired or verified.
4. **The Pathway streaming engine is not deployed.** `AREE_ENGINE_MODE=direct` is
   the production path. Its pins in `requirements-streaming.txt` remain
   unverified — building with `INSTALL_STREAMING=1` should be expected to need
   dependency-resolution work.
5. **Live mode needs ~24 h of accumulated capture**, and any restart puts a hole
   in the series. Replay is unaffected.
