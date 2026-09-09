# AREE — startup and live-data architecture

**Status:** phases 1–4.2 implemented and measured. The capture-worker split
(4.3) is designed, not built.
**Measured on:** Windows dev machine, 2026-09-09, against the live upstream feeds.
Numbers from a Render container will differ in absolute terms; the *shape* of the
critical path will not.

This document exists because two separate faults were being read as one — "the
backend is slow" — and one of them was not slowness at all.

---

## 1. The two faults, separated

| | Fault A | Fault B |
|---|---|---|
| Symptom | Dashboard empty for ~27 s after a restart | "Outlook unavailable" / "Ventilation outlook unavailable", recovering minutes later |
| Real cause | Serial upstream I/O on the first publish path | Holes in `station_readings`, so no anchor has a complete lag set |
| Fixed by | Phases 1–2 | Phases 4.1–4.2 (4.3 still open) |
| Made *visible* by | — | Phase 3 |

They share a root: **the observation store and the live station table are only ever
as continuous as the API process itself.** Everything below follows from that.

---

## 2. What the cold start used to do

```text
t=0.000   uvicorn up
t=0.011   load_engine() spawns the sampling thread
          → /api/health answers  engine_loaded: true      ← A LIE, IN EFFECT
t=0.011   capture thread starts

          ── direct engine thread ──────────────────────────────────
t≈1       CAQM GetGoogleMapData          roster, 1 call        ~1 s
t≈14      CAQM GetActualSiteData x73     6 workers            ~13 s
t≈14 →24  data.gov.in, FOUR STATES, ONE AFTER ANOTHER        ~10–34 s
                Delhi          10.7 s
                Haryana         9.0 s
                Uttar Pradesh   7.9 s
                Rajasthan       6.3 s
                              ───────
                               33.9 s serial
t=24.9    latest_state finally written
t=26.9    /api/stations returns 73 stations                  ← FIRST DATA
```

Two structural mistakes, both visible in that trace:

1. **`_attach_pollutants()` ran before the publish.** It adds NO2/SO2/CO/NH3
   concentrations to the station rows — enrichment for a detail panel. Its own
   docstring already said *"Failure is non-fatal: the station table is already
   complete without it."* It was nevertheless holding the entire table hostage.
2. **`/api/health` reported readiness it could not know.** `fallback_engine.start()`
   returns `True` the instant the thread object exists. Health went green at
   t+0.011 s and stayed green through 27 s of serving nothing.

---

## 3. What it does now

Two runs, back to back, showing the remaining variance honestly:

```text
                                       run A        run B
t=0.0    uvicorn up
         /api/health  200                1.0 s        1.0 s   liveness
         /api/ready   503 warming_up     1.1 s        1.1 s   readiness
         data.gov.in, four states IN
         PARALLEL; capture writes 81
         station-hours                   2.8 s        1.5 s
         CAQM 73 stations reporting     11.9 s       23.4 s   ← the whole path
         latest_state published;
         /api/ready 200 ready           13.1 s       24.5 s   ← FIRST DATA
         concentrations patched onto
         states already being served    15.2 s       24.9 s
```

**The spread between the runs is CAQM, not us.** `caqm.nic.in` is a public
dashboard's backend; its 73 per-station reads took 11 s once and 22 s the next
time. What changed structurally is that this is now the *only* thing on the
critical path — before, the same variance stacked on top of a serial
data.gov.in pull, so a bad CAQM run and a bad data.gov.in run compounded.

### 3.1 The ordering rule

```text
        fetch  ────►  publish  ────►  enrich
                         ▲               │
                         │               │
              servable the instant       adds detail to rows
              it is CORRECT              already on screen
```

`_poll_once()` now writes `latest_state` as soon as the CAQM sweep returns, and
`_enrich_published_pollutants()` patches concentrations in afterwards.

**Enrichment patches; it does not rebuild.** `_build_state()` appends to
`aqi_history` and calls `engine.process()`, which advances the persistence
counter and the hysteresis confirmation. Running it twice for one observation
would count that observation twice and could fire an escalation a window early.
So only the pollutant fields are written, onto a copy that then replaces the
entry in one assignment — `latest_state` is read by request threads without a
lock, and dict item assignment is atomic under the GIL, so a reader sees the
un-enriched state or the enriched one, never a mix.

### 3.2 Bounded fan-out on data.gov.in

`cpcb_stream` carried a warning that the endpoint *"degrades steeply with parallel
requests"* — which is true, and was measured under **several callers each running
a full four-state pull**: up to sixteen requests in flight, each caller slowing the
others. `_ncr_lock` already removed that: one pull runs per process at a time.

Inside that single pull the four states are independent queries on an indexed
column. Four concurrent requests is a bounded fan-out, not a herd. Paging *within*
a state stays sequential — an offset is only worth requesting once the previous
page shows there is more, and every state currently fits in one 500-row page.

```text
   before                          after
   Delhi ──10.7s──┐                Delhi     ─┐
   Haryana ─9.0s──┤                Haryana   ─┤
   UP ──────7.9s──┤  = 33.9 s      UP        ─┼──► bounded by slowest state
   Rajasthan 6.3s─┘                Rajasthan ─┘   measured 1.1 s / 2.8 s in situ
```

### 3.3 Liveness is not readiness

```text
                     ┌── GET /api/health   200 always
   backend running ──┤    "the process is up; replay endpoints work"
                     │
                     └── GET /api/ready
                              │
                     latest_state populated?
                        ╱               ╲
                      no                yes
                       │                 │
              503 warming_up         200 ready
              503 unavailable        {stations: 73, mode: "direct"}
```

`render.yaml` **keeps `healthCheckPath: /api/health`, deliberately.** Render
restarts a container that fails its health check, and readiness here depends on
third-party feeds. If a CAQM outage made `/api/ready` 503, Render would
restart-loop a backend that is working perfectly and still serving every replay
endpoint — turning someone else's outage into our own. Readiness is for the UI to
read, not for the orchestrator to act on.

The frontend consumes it through `UnavailableNotice`, which polls `/api/ready`
only while a failure panel is on screen and swaps the message:

```text
   state = warming_up   →  amber   "Backend is warming up"   (+ the error, quietly)
   state = unavailable  →  red     "Live engine is not running"
   state = ready        →  red     the caller's original error, unchanged
```

The last row is the important one. If the engine *is* ready and the screen still
failed, that is a real fault — a lag gap, say — and calling it a warm-up would be
the same lie told in the other direction.

---

## 4. Measured result

| | before | after |
|---|---:|---:|
| `/api/health` 200 | 2.1 s | 1.0 s |
| First live station data | 26.9 s | **13.1 s / 24.5 s** (CAQM-bound) |
| data.gov.in pull, in situ | 14.1 s | **1.5–2.8 s** |
| data.gov.in pull, isolated | 33.9 s serial | **1.1 s parallel** |
| Pollutant concentrations | **blocking**, ~6 s before the publish | **non-blocking**, ~1.5 s after it |
| Readiness signal | none (health lied) | `/api/ready`, 503 → 200 |
| Offline test suite | 61 passed | 63 passed |

Read the first row carefully: **it is not a clean 2× win, and claiming one would
be dishonest.** The data.gov.in fix is unambiguous and repeatable. The end-to-end
number now tracks CAQM, which varies by more than the entire saving on a bad run.

What actually changed is the *structure*: the critical path went from

```text
   before:  CAQM sweep (11–23 s)  +  data.gov.in serial (10–34 s)   ← they stacked
   after:   CAQM sweep (11–23 s)                                    ← alone
```

The CAQM cost stays, deliberately. Its bulk endpoint returns the whole network in
one 1 s call but carries **no timestamp**, and serves an `aqi` for analysers that
stopped reporting up to 24 days ago; `WORKERS` above 6 was already measured to
lose stations to timeouts. Trading a correct station table for a faster one is the
exact bargain this repository keeps refusing, and it should keep refusing it.

---

## 5. Phase 4 — observation continuity (designed, not built)

This is Fault B, and it is the deeper one.

### 5.1 The mechanism

`/api/aree/outlook` and the ventilation screens need observed PM2.5 at **exact**
lag hours `(0, 1, 3, 6, 12, 24)` before an anchor, and may step the anchor back at
most 6 hours. So they need a near-continuous **30-hour** history.

Measured on the dev store, 2026-09-09 09:00 UTC:

```text
MISSING HOURS:  08 Sep 16Z…22Z,  09 Sep 00Z, 01Z, 02Z

  anchor 09:00   missing lags [0, 12]
  anchor 08:00   missing lags [6, 12]
  anchor 07:00   missing lags [6, 12]
  anchor 06:00   missing lags [6, 12]
  anchor 05:00   missing lags [3, 12]
  anchor 04:00   missing lags [3, 6, 12]
  anchor 03:00   missing lags [1, 3, 6]
                 ───────────────────────
                 no anchor qualifies  →  HTTP 424
```

Lag 12 lands at 21:00 on 08 Sep — inside the hole — at four of the seven
candidates. One gap of seven hours disables the hero screen for a day.

### 5.2 Why the holes exist

Only the in-process capture thread writes `station_readings`, and each cycle
writes **one hour**. Neither CAQM nor data.gov.in serves history — both return
only the current reading — so an hour the API process was not running is lost.

### 5.3 The repair never fired — and lowering a threshold did not fix that

The plan was `MAX_TOLERABLE_GAP_HOURS: 2 → 1`. Doing it exposed that the
threshold was not the problem. `gap_hours()` measures the **trailing** gap,
`now - MAX(timestamp)`, and **a hole behind the newest row is invisible to it**.

Which is the case that actually happens. The API restarts, loses six hours, comes
back, and the hourly capture resumes: from that moment `MAX(timestamp)` tracks the
clock and the trailing gap reads healthy *forever*, while the hole sits inside the
lag window disqualifying every anchor. Measured on the dev store:

```text
   trailing gap      1.63 h      vs threshold 2 h  ->  "no backfill needed"
   actual holes      10          (08 Sep 16Z–22Z, 09 Sep 00Z–02Z)
   outlook           424, indefinitely
```

Tightening 2 → 1 makes a trailing measure more sensitive. It does not make it a
measure of continuity. So continuity is now measured directly:
`missing_hours()` walks the window the live forecast actually reads
(`OBSERVATION_WINDOW_HOURS`, imported rather than restated so the two cannot
drift) and reports every hour with no network reading, excluding the newest
`PUBLICATION_DELAY_HOURS` — CPCB and CAQM run 40–100 min behind, so their absence
is punctuality, not loss, and counting them would trigger a repair every hour
forever.

The repair fires on **either** signal: trailing gap too wide, or any hole inside
the window.

### 5.4 Bounding the pull to the hole — the change that mattered most

The backfill's location filter keys off its own window, and the two interact in a
way worth stating plainly. Locations are what cost requests (one per location,
regardless of how many hours it returns), and OpenAQ's budget is **60 requests per
60 seconds** — read from `X-Ratelimit-Limit`, not assumed.

The NCR location population is bimodal, measured:

```text
   pm25 locations with a datetimeLast : 134
      last <=  2 h :   7        <- the genuinely live network
      last <= 12 h :   7
      last <= 24 h :  93        <- a large cluster reporting daily
      last <= 72 h :  93
```

So a flat three-day window admits 93 locations ≈ 93 requests ≈ **127 s**, floored
by the rate limit rather than by anything we control. But a *recent* hole can only
be filled by a *recently reporting* location — and bounding the window to the
oldest missing hour admits exactly those:

```text
   19 h window  ->   7 of 136 locations  ->  10.1 s   (all 10 holes filled)
   72 h window  ->  93 of 136 locations  ->  127.1 s
```

The three-day pull is still correct for a cold or long-dead store, and is still
what an empty store gets. It is simply not what a six-hour outage needs.

### 5.5 What the rate limiter replaced

`_get()` used to end with `time.sleep(1.0)`. Serially that approximates 60/min and
was fine while nothing ran concurrently. It has two faults the moment anything
does: N workers each sleeping one second make N requests a second, so it bounds
one caller's pace and knows nothing about the others; and sleeping *after* a call
pays the price whether or not the budget was tight.

`_RateLimiter` is a shared sliding window, acquired *before* the request. It only
blocks when the budget is actually exhausted, so latency overlaps instead of
serialising behind a timer, and it is safe to call from several threads — which is
what makes the bounded pool legitimate rather than a way to quietly exceed the
limit. The 429 backoff stays as the backstop for when our accounting and the
server's disagree.

### 5.6 Measured, phase 4

| | before | after |
|---|---:|---:|
| Mid-window hole detected | **never** | yes, `missing_hours()` |
| Repair of a 10-hole, 19 h gap | would not have run | **10.1 s**, all 10 filled |
| Full 3-day cold backfill | ~177 s (derived) | **127 s** (rate-limit floor ≈ 102 s) |
| Forecast after repair | 424 | **available**, anchor 09 Sep 09:00Z |
| Repair blocks readiness? | — | **no** — ran at t+3.5 s while `/api/ready` went green at t+10.5 s |
| Offline test suite | 63 passed | 68 passed |

The last two rows carry the point. Recovery did not become instant; it became
**bounded, correct, and off the critical path**. A restart now serves the station
table in ~10 s and repairs its own history underneath, instead of stalling.

### 5.7 Honest limitations

- **The backfill restores continuity, not fidelity.** A repaired hour comes back
  with ~5–7 stations behind it, against 80–88 from CPCB. That is enough for a
  *lag* — a lag only has to exist — but such an hour would be a thin *anchor*,
  which is why `QUALIFYING_STATIONS = 20` exists and why the anchor selection
  still prefers a fuller hour. Nothing here changes that logic.
- **The repair runs at boot only.** A hole opened by a failed capture cycle
  mid-run is not repaired until the next restart. Making it periodic risks
  re-pulling for hours OpenAQ will never have; 4.3 is the better answer.
- **The rate limiter is per-process.** Two processes sharing one API key share no
  budget. That becomes real the moment the capture worker is split out.

### 5.8 Still open — 4.3, the capture worker

The real fix is that the gap should rarely open at all. A scheduled worker
(Render cron, or a GitHub Action) writes the hourly snapshot on a cadence that
does not stop when the API restarts or redeploys.

This forces a storage decision, and the reason is **not** that SQLite is slow —
it is not, and for a single-process application it is entirely adequate. The
reason is process lifecycle: a SQLite file on a Render disk can only be written
by the one container that mounts it, so ingestion cannot outlive the API while
the store lives there. What is needed is persistent *shared* storage, because
ingestion must survive independently of the API process:

```text
   today                              phase 4.3

   ┌──────────────┐                   ┌──────────────┐   ┌──────────────┐
   │  FastAPI     │                   │  FastAPI     │   │  capture     │
   │  + capture   │                   │  (read)      │   │  worker      │
   │  thread      │                   └──────┬───────┘   └──────┬───────┘
   └──────┬───────┘                          │                  │
          │                                  └────────┬─────────┘
   ┌──────▼───────┐                                   │
   │  SQLite      │  holes on every            ┌──────▼───────┐
   │  (one writer)│  restart / deploy          │  PostgreSQL  │  continuous
   └──────────────┘                            └──────────────┘
```

### 5.9 What NOT to do

**Do not migrate hosting yet.** The measured faults were serial I/O, publish
ordering and a missing readiness signal — none of which is a property of Render.
`render.yaml` already documents why serverless is ruled out: SQLite + WAL needs a
real filesystem, the capture is a long-lived thread, and two 2.3 MB LightGBM
boosters are read from disk at request time. Cloudflare Workers satisfies none of
those. Redeploy with phases 1–4.2, measure again, and let 4.3 — not the host — be
the next variable changed.

---

## 6. Files changed

| File | Change |
|---|---|
| `backend/fallback_engine.py` | `_poll_once` publishes before enriching; new `_enrich_published_pollutants()` patches concentrations onto already-served states |
| `backend/ingestion/cpcb_stream.py` | `NCR_STATES` + `STATE_WORKERS`; `_fetch_ncr_uncached` fans the four state pulls out under the existing `_ncr_lock`; per-state failure no longer costs the other three |
| `backend/api/main.py` | `GET /api/ready` — readiness, 503 until `latest_state` is populated |
| `backend/api/schemas.py` | `ReadinessResponse` |
| `backend/tests/test_http_chain.py` | status code and reported state must agree (network-independent invariant) |
| `backend/tests/test_route_table.py` | `/api/ready` pinned to its handler |
| `frontend/src/types/index.ts` | `ReadinessResponse` |
| `frontend/src/lib/api.ts` | `api.readiness()` — treats 503 as an answer, not an exception |
| `frontend/src/components/UnavailableNotice.tsx` | **new** — warming-up vs broken |
| `frontend/src/components/OutlookView.tsx` | uses it |
| `frontend/src/components/VentilationOutlook.tsx` | uses it |
| `backend/api/capture_scheduler.py` | `missing_hours()` / `observed_hours()`; `_bootstrap_if_stale` → `_repair_if_incomplete`, firing on a hole as well as a trailing gap and bounding the pull to the oldest one; `MAX_TOLERABLE_GAP_HOURS` 2 → 1 |
| `backend/backfill/openaq_history.py` | `_RateLimiter` — one shared 55/60 s budget acquired before each request, replacing the per-call `sleep(1.0)` |
| `capture.py` | `cmd_bootstrap` reads locations through a bounded pool; `--hours` bounds the window; the location filter is the window, not a flat 7 days |
| `backend/tests/test_capture_continuity.py` | **new** — a hole behind the newest row must be seen; punctual feeds must not read as holes |
| `backend/api/routes/system.py` | **new** `GET /api/system/capture` — store continuity over HTTP |
| `bench_startup.py` | **new** — the cold-start benchmark, local or deployed |

---

## 7. Observability — why `/api/system/capture` exists

`capture_scheduler.status()` existed and was exposed **nowhere**. So on a deployed
instance the only way to find out why the outlook was 424 was to read the server
log, which is the one thing you cannot do quickly there. "The outlook is broken"
and "the outlook is fine, the store lost four hours last night" looked identical
from outside.

```
GET /api/system/capture
{
  "running": true, "cycles": 1, "bootstrapped": true,
  "newest_hour": "2026-09-09T12:00:00+00:00",
  "trailing_gap_hours": 1.54,
  "holes": 0, "oldest_hole": null, "continuous": true,
  "observation_window_hours": 31
}
```

`continuous` is the field that answers it in one GET, and it is **not** the same
question as `trailing_gap_hours`: a store one hour behind can still be missing an
hour from yesterday, which is the entire failure of §5.3.

---

## 8. Phase 8 — measured, against a copy of a known-bad store

`bench_startup.py local --broken` copies the store, boots a real backend against
the copy, and measures from outside. The copy matters: repairing the real store
would spend the fixture to buy one measurement, and a reproducible known-bad store
is worth more than that.

```text
  MILESTONE                                          ELAPSED
  --------------------------------------------------------------------
  /api/health answers (process alive)                     1.0 s
  observation store continuous                            6.2 s
  /api/ready 200 (engine has data)                        9.3 s
  /api/stations returns rows                              9.3 s
  /api/aree/outlook 200                                  10.5 s

  STORE AT BOOT
    trailing gap        : 1.54 h        <- the old check called this healthy
    holes in lag window : 12   (oldest 2026-09-08T16:00Z)
    repaired by         : t+6.2 s, which is BEFORE /api/ready went green

  RESPONSIVENESS  (/api/health every 0.5 s throughout)
    whole run            18 req  0 failed   p50 16.4 ms   max 34.5 ms
    during repair        10 req  0 failed   p50  3.5 ms   max 17.9 ms
```

Three things in that table are the whole of phases 1–8:

1. **The outlook answered 200 on its first request.** No 424, no "unavailable"
   panel, no waiting. The reported fault is gone on this path.
2. **The repair finished before the station table was published.** It is not
   merely off the critical path, it is comfortably ahead of it — and the probe
   confirms it: zero failures, p50 3.5 ms *during* the repair.
3. **A store the old check called healthy had twelve holes.** `trailing_gap =
   1.54 h` against a 2 h threshold. That is the bug, stated as a measurement.

### 8.1 What this does NOT establish

This is one machine, on a warm network, with a store missing twelve hours. It does
not measure Render, where the CPU is slower, the disk is a network volume and the
region is Singapore rather than the same room. The point of committing the harness
is that the comparison can now be made with one command on each side instead of
two differently-written scripts.

CPU and RSS were **not sampled** — `psutil` is not installed here, and the harness
reports that rather than inventing a number. `pip install psutil` enables them
locally; on Render they come from the host's own metrics panel.

---

## 9. How to re-measure

```bash
# everything above, in one command
python bench_startup.py local --broken

# the same measurement against a deployed backend
python bench_startup.py url --url https://aree-backend.onrender.com

# keep the raw numbers for a before/after comparison
python bench_startup.py local --broken --json .tmp/before.json

# store continuity on its own, any environment
curl -s localhost:8130/api/system/capture | python -m json.tool

# the four-state pull, in a fresh process (the cache is per-process)
python -c "import time; from backend.ingestion import cpcb_stream as c; \
           s=time.monotonic(); r=c.fetch_ncr(); print(time.monotonic()-s, len(r))"

python -m pytest -m "not network"     # 69 passed
```

### The one scenario worth keeping

`data/aree.db` on this machine is **deliberately left broken** — twelve holes,
healthy-looking trailing gap. It is the fixture for the end-to-end regression:

```text
   known-bad store  ->  normal boot  ->  automatic detection
                    ->  bounded repair  ->  healthy store  ->  outlook 200
```

`--broken` runs that against a copy every time, so the scenario survives being
tested. Repairing the real store costs the fixture and buys nothing that the copy
does not already give.
