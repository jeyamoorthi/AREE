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

### 3.2 The disk is not optional

`render.yaml` declares a 2 GB disk at `/app/data`. **A persistent disk needs a
paid instance type.** Without one:

- the store is wiped on every deploy *and* every restart,
- so the capture never accumulates the ~24 h of observations the live forecast
  needs,
- so live permanently returns 424 while replay keeps working.

That is a real, visible failure, not a degradation.

### 3.3 The free tier will break live mode even with a disk

Render's free web services **spin down after ~15 minutes of inactivity**. The
capture is an in-process thread; when the process sleeps, capture stops, and the
observation series develops exactly the holes that produce:

```
observed PM2.5 missing at lag(s) [0, 1, 3] h before ...
```

Replay is unaffected — it reads Nov 2024 from the store. If you only need the
**02 Nov 2024 hero replay** for a demo, free tier is fine. If you want the live
tab to work, you need an always-on instance.

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
3. Add ONE environment variable:

   | Name | Value |
   |---|---|
   | `AREE_API_ORIGIN` | `https://<your-backend>.onrender.com` |

4. Deploy.

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
