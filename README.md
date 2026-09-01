<h1 align="center">🌬️ AREE</h1>
<h3 align="center">Autonomous Regulatory Escalation Engine</h3>
<p align="center"><i>Air pollution–weather coupled forecasting for Delhi NCR — SIH PS 26082 · Team Devengers</i></p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-blue?style=for-the-badge&logo=python&logoColor=white" alt="Python"/>
  <img src="https://img.shields.io/badge/FastAPI-API_Layer-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/Next.js_16-Frontend-000000?style=for-the-badge&logo=next.js&logoColor=white" alt="Next.js"/>
  <img src="https://img.shields.io/badge/Pathway-Optional-00B4D8?style=for-the-badge" alt="Pathway"/>
  <img src="https://img.shields.io/badge/Open--Meteo-NWP-FF7F0E?style=for-the-badge" alt="Open-Meteo"/>
  <img src="https://img.shields.io/badge/CAQM_%2F_CPCB-Ground_Truth-138808?style=for-the-badge" alt="CAQM"/>
</p>

---

## What this is, in one paragraph

AREE answers a question that "what will the AQI be tomorrow" does not: **will the
atmosphere still be able to clear itself, and for how much longer?** It forecasts the
**ventilation coefficient** (mixing depth × transport speed) for the next ~72 hours,
finds the first *sustained* collapse below a calibrated threshold, and reports the
**intervention window** — the hours of usable lead time remaining before that collapse
begins. Combined with live ground PM2.5 from the CPCB/CAQM network, it produces a
GRAP escalation *recommendation* carrying its evidence, its operating point, and its
false-alarm rate. It never issues the order: a human approves, and the whole decision is
replayable from the audit record.

Everything below reflects the repository as it stands today, including what does **not**
work yet.

---

## Two decision paths, one engine

```
                        ┌──────────────────────────────────────┐
  Open-Meteo (ECMWF/GFS)│  PREDICTED PATH  (PS 26082)          │
  BLH + wind10m ───────►│  ventilation forecast → collapse     │
                        │  onset → intervention window         │
                        └──────────────┬───────────────────────┘
                                       │  AND
  CPCB / data.gov.in ──► PM2.5 µg/m³ ──┤       ► escalation case (AWAITING_APPROVAL)
                                       │
                        ┌──────────────┴───────────────────────┐
  CAQM / WAQI ─────────►│  OBSERVED PATH  (original AREE)      │
  station AQI           │  persistence → hysteresis → GRAP     │
                        └──────────────────────────────────────┘
```

The **observed path** is the original engine: sliding-window persistence, a hysteresis
state machine, causal attribution against NASA FIRMS fires. It tells you an episode is
*happening*. The **predicted path** is new and is the PS 26082 deliverable. It tells you
whether an episode would *persist*. Neither is sufficient alone, which is why the trigger
is a conjunction — see [Why the trigger is a conjunction](#why-the-trigger-is-a-conjunction).

---

## The ventilation layer

### The quantity

```
ventilation coefficient  VC  =  boundary layer height (m)  ×  10 m wind speed (m/s)     [m²/s]
```

Mixing depth times transport speed — the volume flux available to dilute whatever is
emitted. It is a long-standing quantity in air-quality meteorology, not one invented for a
hackathon.

Think of a room. **High ventilation** is windows open with a fan running, so smoke leaves
quickly. **Low ventilation** is windows shut and a weak fan, so smoke stays trapped.

| | PBL | Wind | VC | Meaning |
|---|---|---|---|---|
| Well ventilated | 1000 m | 3.0 m/s | 3000 m²/s | 🟢 the atmosphere disperses pollution effectively |
| Poorly ventilated | 200 m | 1.0 m/s | 200 m²/s | 🔴 pollution accumulates in a shallow volume |

> 🟢 Higher ventilation → the atmosphere can dilute and clear pollution.
> 🔴 Lower ventilation → the atmosphere struggles to clear it, so pollution can stay trapped.

### How the system actually uses it

```
Open-Meteo forecast (BLH + 10 m wind, hourly)
        ↓
VC per forecast hour
        ↓
compare against the calibrated threshold  (465.9 m²/s, "balanced")
        ↓
does it stay below for ≥ 6 consecutive hours?
        ↓
yes → that run's FIRST hour is the collapse onset
        ↓
intervention window = onset − now
        ↓
combine with live observed PM2.5
        ↓
AREE assessment → case → operator approval
```

**Step 1 — compute.** `VC_t = BLH_t × wind_t`. E.g. 500 m × 0.8 m/s = **400 m²/s**.

**Step 2 — compare.** 800 🟢 · 500 🟢 · 400 🔴 · 250 🔴. One hour below is not enough.

**Step 3 — require persistence.** Six consecutive hours below threshold:

```
14:00  700  🟢     18:00  300  🔴
15:00  500  🟢     19:00  280  🔴
16:00  420  🔴     20:00  260  🔴
17:00  350  🔴     21:00  240  🔴     → onset = 16:00
```

The onset is the start of the *run*, not the first hour below threshold anywhere. An alert
should describe when the atmosphere actually stops clearing.

**Step 4 — window.** Forecast issued 13:00, onset 16:00 → **intervention window = 3 h**:
"we have roughly three hours before the forecast sustained poor-ventilation period begins."

**Step 5 — combine with pollution.** PM2.5 high **and** a sustained collapse forecast →
elevated persistence risk, and AREE evaluates the rule. PM2.5 low with a collapse forecast
→ that is just a winter night; monitor.

```
PM2.5                  how bad the pollution is
Ventilation            how capable the atmosphere is of clearing it
Intervention window    how much time is left to act
```

### Reading the chart on `/ventilation`

The blue line is ventilation, not AQI. The red dashed line is the calibrated threshold. The
shaded red band is a forecast *sustained* collapse.

The sawtooth is the diurnal boundary-layer cycle, and it is the most important thing on the
page. Measured from the live feed:

| Hour UTC | BLH | Wind | VC |
|---|---|---|---|
| 00:00 | 55 m | 0.18 m/s | 9.9 |
| 03:00 | 290 m | 0.21 m/s | 60.9 |
| 06:00 | 375 m | 1.25 m/s | 468.8 |
| 09:00 | 850 m | 0.81 m/s | 688.5 |
| 12:00 | 335 m | 2.66 m/s | 891.1 |
| 15:00 | 120 m | 0.75 m/s | 90.0 |
| 18:00 | 60 m | 0.51 m/s | 30.6 |

Solar heating grows the mixed layer through the morning, so the atmosphere's capacity to
dilute rises by **two orders of magnitude** between night and midday. After sunset the layer
collapses and whatever is emitted accumulates in a shallow volume. *Delhi's winter smog is
not primarily an emissions story — it is this curve failing to rise.*

Because it collapses every single night, "VC below threshold" on its own would fire
constantly. That is exactly why the six-hour run length and the PM2.5 conjunction exist.

Chart values are computed at request time from the current model run, verified against the
upstream API directly (chart peak 1262.2 m²/s = BLH 935 m × wind 1.35 m/s, exact match). The
horizon is usually under 72 h: it is the model's forward window minus the hours already
elapsed since the run, so it shrinks through the day and jumps back when the upstream model
re-runs.

### What the chart does **not** say

❌ "AQI will be 400."  ❌ "Pollution lock-in is guaranteed."

✅ "Forecast ventilation falls below the calibrated operating threshold and stays there for
a sustained period. If observed pollution is also elevated, this is an early-warning window
for intervention."

---

## Why the trigger is a conjunction

Five winters of Delhi NCR data (`research/ps26082`) established three things by measurement
rather than assumption:

1. Whether an episode locks in **cannot** be diagnosed from the atmospheric state at its
   onset — AUC **0.514**, i.e. chance.
2. It **is** determined by the ventilation over the following 48 hours — AUC **0.736**.
3. A one-to-two day forecast reproduces that ventilation closely enough to retain the skill
   — r = 0.75, RMSE 0.79 m/s on window-mean wind.

So current air quality tells you an episode is *happening* but not whether it will last
(peak PM2.5 barely separates a 16-hour spike from a 10-day event), and forecast ventilation
tells you whether one would *persist* but is not itself an episode detector.

```
triggered  =  observed PM2.5 ≥ 120 µg/m³   AND   forecast sustained ventilation collapse
```

Firing on either half alone is precisely how a system generates the false alarms that get it
switched off.

---

## The calibrated operating point

Loaded at runtime from
[`backend/config/ventilation_operating_point.json`](backend/config/ventilation_operating_point.json),
not hard-coded, so it can be re-derived without touching application code and the running
system can state which calibration it is using.

| Mode | Threshold | Hit rate | False-alarm rate | Precision |
|---|---|---|---|---|
| **balanced** (default) | 465.9 m²/s | 0.606 | 0.191 | 0.488 |
| precautionary | 765.0 m²/s | 0.818 | 0.527 | 0.318 |
| conservative | 465.9 m²/s | 0.606 | 0.191 | 0.488 |

Training AUC 0.736 · 143 episodes, 33 locked-in · 48-hour outcome window · holdout
Nov 2023 + Nov 2024 (11 episodes, hit 0.20, FAR 0.50) · sustained-run requirement
**6 hours**.

> ⚠️ **Caveat carried in the config file and surfaced by the API:** derived from five
> winters of Delhi NCR data in which 64% of in-season hours rest on two or fewer PM2.5
> stations. The sample is small and the holdout is 11 episodes. Treat 466 m²/s as a
> **current operating point to be re-derived** once the OpenAQ 2022–2025 gap is closed from
> CPCB — not as a universal atmospheric law.

`GET /api/ventilation/operating-point` exists so a regulator can answer "on what basis did
you decide?" without reading source code. An uncalibrated mode is rejected with 422 rather
than silently falling back, because the operating point *is* the false-alarm rate being
accepted.

### Lead-time bands

Bands are lead-time, not severity, because for disaster management the actionable quantity
is how long is left to act.

| Window remaining | Forecast state | Case priority |
|---|---|---|
| collapse already begun | `collapsed` | CRITICAL — window closing or closed |
| ≤ 12 h | `imminent` | HIGH |
| ≤ 36 h | `approaching` | MEDIUM — prepare and pre-position |
| > 36 h | `watch` | LOW — monitoring, time available |
| no collapse forecast | `clear` | LOW |

---

## Two engine modes

`engine.load_engine()` tries Pathway first and falls back to
[`backend/fallback_engine.py`](backend/fallback_engine.py) when the import fails. Set
`AREE_ENGINE_MODE=direct` to select direct mode explicitly. Every state carries
`mode="direct"` so nothing downstream — and nobody reading the UI — can mistake it for the
streaming engine.

| | streaming | direct |
|---|---|---|
| Requires Pathway | yes | **no** |
| Platform | Linux / macOS / Docker / WSL | anywhere, including Windows |
| GRAP state machine | same code | same code |
| Persistence + hysteresis | same code | same code |
| Causal attribution, FIRMS | yes | yes |
| Event-time windowing | yes | **no** — 120 s interval sampling |
| Policy RAG advisories | yes | **no** — needs the DocumentStore |
| Carbon tracking | measured | deterministic estimate, flagged `measured: false` |

Direct mode exists because only `rag/advisory_engine.py` actually imports Pathway. The state
machine that decides GRAP stages is pure Python and never needed a streaming runtime — three
tabs were dark because of one import in one module.

**`/ventilation` is independent of both engines.** It reads a numerical weather model and the
ground network directly, so it stays up whatever the engine is doing. That is deliberate:
the forecast layer is upstream of the streaming layer in the data flow, so it must not be
downstream of it in the dependency graph.

[`backend/tests_contract.py`](backend/tests_contract.py) parses `app.py` and compares the
keys direct mode publishes against the keys the Pathway path declares. Several routes pass
engine state to the client unvalidated, so a differently-spelled key does not fail a schema
— it crashes a React component.

```bash
python -m backend.tests_contract
```

---

## Data sources, and what each is authoritative for

| Source | Used for | Why this one | Cadence |
|---|---|---|---|
| **Open-Meteo** (ECMWF/GFS) | BLH, 10 m wind, SW/TOA radiation, cloud, T, RH, pressure, precip | ECMWF-family fields over plain REST, no key, arbitrary horizon in one call. Copernicus CDS is the archive source but queues for minutes to hours — unusable on a request path | hourly runs, 90 s backend cache |
| **CAQM** `caqm.nic.in` | live NCR station roster + sub-index AQI | measured **79 min** median behind, 75 of 79 stations inside the freshness window, against data.gov.in at **322 min** with 0 of 78 | hourly |
| **CPCB** via `data.gov.in` | PM2.5 **concentrations** in µg/m³, verbatim CPCB station names | CAQM publishes sub-indices only, and the episode threshold is calibrated in µg/m³. Inverting the breakpoint table would fabricate precision inside the one number the decision turns on | a few times daily |
| **OpenAQ v3** | NCR ground composite (median PM2.5 + percentiles) | station-level provenance behind the composite | on demand |
| **WAQI** | pan-India AQI, dynamic station discovery | coverage outside the NCR domain | 30 s poll |
| **NASA FIRMS** (VIIRS_SNPP_NRT) | per-station fire hotspots, FRP, transport vector | causal attribution of crop-residue transport | 5 min |
| **Google Gemini** | risk narrative | **explanation only** — never influences an escalation decision | 10 s cooldown |

### Traps these modules exist to avoid

Each of these is a real bug that was found, reproduced, and is now defended against in code.

- **OpenAQ `/parameters/{id}/latest` silently ignores `bbox` and `coordinates`.** The first
  implementation reported "198 NCR stations"; the rows were from South Korea, Lithuania and
  China, and the "Delhi composite" was a global median. It looked entirely plausible, which
  is what made it dangerous. Every geographic query now re-checks returned coordinates, as a
  hard filter rather than an assertion.
- **CAQM `GetGoogleMapData` serves an `aqi` with no timestamp**, including for analysers that
  stopped reporting weeks ago (`New Moti Bagh` — 24.3 days old, indistinguishable from live).
  It is now used for the **roster only**; every value is re-read from `GetActualSiteData`,
  which carries `lastupdate`, and anything without a fresh timestamp is dropped rather than
  displayed.
- **`data.gov.in` returns an empty-bodied HTTP 502 after ~60 s under burst**, never a 429, so
  retry logic written from the spec will not catch it.
- **Location dates are not sensor dates.** A location's `datetimeLast` spans every sensor ever
  sited there; individual sensor ids retire.
- **OpenAQ's Indian feed has a gap from Nov 2022 to Feb 2025**, present in the S3 archive too.
  Only the US Embassy monitor spans it. This is why the operating point is provisional.
- **Request OpenAQ history in monthly chunks.** Deep pagination returns 500s and 408s.

### Freshness

WAQI and CPCB publish hourly, so a healthy feed is routinely 40–100 minutes old. The bands in
`config.py` describe the upstream cadence rather than relaxing a warning:

| Band | Age | Meaning |
|---|---|---|
| current | 0–90 min | normal operation |
| aging | 90–120 min | older than expected, still plausible for an hourly feed |
| stale | > 120 min | outside the acceptable window, reported prominently |

Station panels show **measured data age**, never the poll interval. `generated_at` in every
forecast payload is the honest answer to "when was this computed". If the chart looks static
for a few minutes, that is correct — the forecast behind it has not changed.

---

## Repository layout

```
AREE/
├── backend/
│   ├── app.py                     Pathway streaming pipeline & DAG (Linux/macOS)
│   ├── fallback_engine.py         direct mode — same state machine, no Pathway
│   ├── config.py                  thresholds, stations, CPCB bands, freshness bands
│   ├── tests_contract.py          direct-vs-streaming key-shape contract check
│   ├── station_loader.py          pan-India station discovery (WAQI)
│   ├── report_generator.py        4-page municipal PDF (ReportLab)
│   │
│   ├── config/
│   │   └── ventilation_operating_point.json    ← the calibrated threshold + its skill
│   │
│   ├── forecast/
│   │   └── ventilation.py         VC series, sustained-collapse detection, window
│   │
│   ├── ingestion/
│   │   ├── weather_stream.py      Open-Meteo forecast + archive (BLH, wind, radiation)
│   │   ├── caqm_stream.py         CAQM roster + per-station timestamped readings
│   │   ├── cpcb_stream.py         CPCB via data.gov.in — concentrations, µg/m³
│   │   ├── ncr_observations.py    NCR PM2.5 composite with station-level provenance
│   │   ├── aqi_stream.py          WAQI polling with retry & staleness
│   │   ├── firms_stream.py        per-station satellite fire intelligence
│   │   ├── fire_stream.py         legacy fire count
│   │   ├── feed_time.py           observed_at / received_at / issued_at semantics
│   │   └── micro_nodes.py         empty — placeholder, see Known gaps
│   │
│   ├── streaming/
│   │   ├── predictive_engine.py   the conjunction, priority bands, case builder
│   │   ├── state_machine.py       GRAP stages + hysteresis + persistence
│   │   └── risk_engine.py         causal attribution + transport vector model
│   │
│   ├── rag/                       Pathway DocumentStore advisories + Gemini narrative
│   ├── policies/                  GRAP schedule, HSPCB winter plan, AQI methodology
│   └── api/
│       ├── main.py                app, CORS, structured errors, health
│       ├── engine.py              streaming ⇄ direct bridge
│       ├── schemas.py             Pydantic response models (the API contract)
│       └── routes/                system, dashboard, stations, aqi, risk, grap,
│                                  forecast, advisory, ai, carbon, escalations,
│                                  policy, reports, ventilation
│
├── frontend/                      Next.js 16 · React 19 · Tailwind 4 · Recharts · Leaflet
│   └── src/
│       ├── app/                   / · /dashboard · /stations/[station] · /ventilation · /reports
│       ├── components/            VentilationOutlook, AQICard, GRAPCard, SatelliteCard,
│       │                          StationMap, PolicyConsole, AIAnalysis, …
│       ├── hooks/                 usePolling, useLiveChannel, useEngineConfig
│       └── lib/                   api.ts (every call), theme.ts, freshness.ts, clock.ts
│
├── research/ps26082/              the validation pipeline — scripts 00→10, docs, figures
├── docs/                          architecture / pipeline / dashboard images
├── Dockerfile · docker-compose.yml · .env
├── MIGRATION.md                   Streamlit → Next.js migration map
└── TEAM_OWNERSHIP.md              who owns which directory
```

---

## Quick start

### Prerequisites

Python 3.10+, Node 20+. Keys in `.env` at the repo root:

```
WAQI_TOKEN=…            aqicn.org/data-platform/token
FIRMS_API_KEY=…         firms.modaps.eosdis.nasa.gov/api
GEMINI_API_KEY=…        aistudio.google.com/apikey
DATA_GOV_API_KEY=…      data.gov.in  (CPCB concentrations)
OPENAQ_API_KEY=…        openaq.org   (NCR composite)
```

Open-Meteo and CAQM need no key.

### Local — works on Windows, no Pathway required

```bash
python -m venv venv
venv\Scripts\activate                 # Linux/macOS: source venv/bin/activate
pip install fastapi "uvicorn[standard]" requests python-dotenv python-multipart numpy reportlab
python -m uvicorn backend.api.main:api --port 8077
```

```bash
cd frontend
npm install
set NEXT_PUBLIC_API_URL=http://127.0.0.1:8077      # Linux/macOS: export …
npx next dev --port 3077
```

Open **http://localhost:3077**. All views work; the engine reports `mode: "direct"` and the
RAG advisory panel reports itself unavailable rather than faking output.

### Full streaming engine

```bash
pip install -r backend/requirements.txt            # Linux/macOS/WSL — Pathway wheels
python -m uvicorn backend.api.main:api --reload --port 8000
```

### Docker Compose

```bash
docker compose up --build
# backend  → http://localhost:8000/docs
# frontend → http://localhost:3000
```

The compose file mounts `backend/policies` so uploaded policy documents survive restarts, and
never passes secrets to the frontend image.

---

## API

Interactive docs at `/docs`. Everything is served under `/api`.

### Ventilation — the PS 26082 layer (no engine dependency)

| Method | Endpoint | Returns |
|---|---|---|
| GET | `/api/ventilation/forecast` | 72 h VC series, sustained collapse, intervention window |
| GET | `/api/ventilation/current` | observed VC over recent hours — analysis values only |
| GET | `/api/ventilation/observed` | live NCR PM2.5 composite with provenance |
| GET | `/api/ventilation/stations` | every reporting station behind that composite |
| GET | `/api/ventilation/assessment` | the conjunction → assessment + case |
| GET | `/api/ventilation/operating-point` | the threshold, where it came from, what it costs |

Query params: `lat`/`lon` (default Delhi NCR centroid 28.63, 77.22), `hours` (6–168), `mode`
(`balanced` · `precautionary` · `conservative`), and on `/assessment` an optional `pm25=`
override. A supplied PM2.5 is flagged `input_source: "manual"` — a reviewer probing the
decision boundary must never have their input presented as a measurement.

### Engine-backed routes

| Method | Endpoint | Returns |
|---|---|---|
| GET | `/api/health` | liveness + engine load state — always answers |
| GET | `/api/system/status` | pipeline status, mode, active stations, decisions processed |
| GET | `/api/system/config` | thresholds, window params, CPCB bands, GRAP stages |
| GET | `/api/dashboard` | national overview: map points, top-5 lists, rankings |
| GET | `/api/stations` · `/api/stations/{station}` | roster with live state · full station state |
| GET | `/api/aqi/{station}` · `/api/aqi/{station}/history` | AQI, pollutants, provenance, freshness |
| GET | `/api/grap/{station}` | GRAP stage, persistence, hysteresis, decision trace |
| GET | `/api/risk/{station}` | ERI, transport score, causal attribution |
| GET | `/api/forecast/{station}` · `/health` | 5/30-min projection, anomaly · VPPE risk matrix |
| GET | `/api/advisory/{station}` · `/api/ai/{station}` | grounded advisory · Gemini narrative |
| GET | `/api/carbon` · `/api/escalations` | carbon accounting · GRAP transition log |
| GET/POST | `/api/policy` · `/api/policy/upload` | RAG index status · add a document |
| GET | `/api/reports/{station}` · `/pdf` | report availability · the municipal PDF |
| WS | `/ws/live` | change events: `station_update`, `escalation`, `status` |

### Error contract

Structured JSON, never an HTML page:

```json
{
  "error": "met_feed_unavailable",
  "detail": "No recent meteorological analysis returned.",
  "status_code": 503
}
```

| Status | Meaning |
|---|---|
| `422` | invalid operating mode, or an upstream payload failed validation |
| `424` | ground observations unavailable, or an upstream feed is dormant/failing |
| `425` | station known, but no sliding window has closed yet |
| `503` | engine not running in this process, or the met feed returned nothing |

### Refresh cadence

| Layer | Cadence | Why |
|---|---|---|
| Upstream NWP | hourly | ECMWF/GFS run cadence |
| Backend forecast cache | 90 s | the ground network publishes hourly; faster buys nothing |
| Chart poll | 5 min | matches how fast the forecast can actually change |
| Station poll | 2 min | dropouts are what an operator needs to see promptly |
| Direct-engine cycle | 120 s | one full network sample |

REST is the data path; the WebSocket only *announces* change. If the socket never connects the
dashboard keeps working on polling alone and says `polling only`.

---

## Frontend

Next.js 16 App Router, React 19, Tailwind 4, Recharts, React-Leaflet. It holds **no business
logic** — every value it renders is computed by the Python engine and served over the API.

| Route | Contents |
|---|---|
| `/` | national overview: live map, top-5 AQI/ERI, cross-station rankings, escalations, carbon |
| `/dashboard?station=…` | single-station command center with inline selector |
| `/stations/[station]` | the same command center, deep-linkable |
| `/ventilation` | **PS 26082**: VC chart, collapse band, intervention window, composite, station table, assessment |
| `/reports` | per-station PDF escalation report downloads |

---

## Design principles

1. **Forecast, don't just observe.** The operationally useful quantity is not "what will AQI
   be" but "will the atmosphere still be able to clear itself".
2. **Deterministic decisions.** All escalation logic is rule-based and auditable. The LLM
   explains; it never decides.
3. **Never blur observed and predicted.** Forecast rows carry `is_forecast`; analysis and
   forecast endpoints are separate. In a system that issues regulatory escalations, that is
   the failure mode that matters most.
4. **The system proposes, the authority disposes.** Cases open as `AWAITING_APPROVAL`. Legal
   authority for GRAP invocation rests with CAQM and the state pollution control boards.
5. **Provenance on every number.** Station names, measured data age, station counts, the
   operating point in force, and whether an input was measured or supplied.
6. **Degrade visibly, never plausibly.** Unavailable subsystems say so instead of returning
   defaults that look like measurements.
7. **Verify what an API claims to have filtered.** An endpoint that ignores a filter rather
   than rejecting it will hand you a confident wrong answer.

---

## Current status

### Working end to end
- ✅ 72 h ventilation forecast, sustained-collapse detection, intervention window
- ✅ Calibrated operating point loaded from disk, three modes, skill metrics exposed
- ✅ Live NCR PM2.5 composite with per-station provenance and staleness filtering
- ✅ Predictive assessment + case builder with recommended GRAP measures
- ✅ CAQM ingestion with timestamp verification, roster cache and bounded retries
- ✅ Direct mode — full GRAP / persistence / attribution stack without Pathway, on Windows
- ✅ All five frontend routes, live charts, station map, PDF reports
- ✅ Structured error contract, plus a contract test for direct-vs-streaming key shapes

### In progress (uncommitted working tree)
- 🔧 `pollutant_source` / `pollutant_age_minutes` on `/api/aqi` — concentrations can come from
  a slower feed than the AQI above them, so both ages are published rather than one implying
  the other
- 🔧 CAQM concurrency lowered 10 → 6 workers, with retries and a 15 s per-read timeout
  (10 workers returned 44 of 67 stations; fewer parallel reads recover more)
- 🔧 Roster caching (1 h) so a transient roster timeout no longer takes the whole source down
  and flips the station table to a differently-named network
- 🔧 Station pruning in direct mode against the source roster, so the table stops accumulating
  ghosts from a previous feed

### Known gaps — stated rather than hidden
- ⚠️ **λ is not validated on real data.** `research/ps26082` recovers a known λ from synthetic
  data (+0.1386 true → +0.1513 recovered, 9.2% error, all three physical sign checks pass),
  but step 1 needs a Copernicus CDS key and has not been run on real ERA5. The shipped system
  therefore uses the **ventilation-coefficient baseline**, not λ.
- ⚠️ **The holdout is thin.** 11 episodes, hit rate 0.20, FAR 0.50. 466 m²/s is a starting
  operating point, not a settled one.
- ⚠️ **`backend/ingestion/micro_nodes.py` is empty** — a placeholder for low-cost sensor
  ingestion, not implemented.
- ⚠️ **Two GRAP AQI mappings exist.** `config.GRAP_STAGES` puts Stage I at 101–200;
  `predictive_engine.GRAP_BY_AQI` puts it at 201–300, which matches the official CAQM
  schedule. The predictive path is the correct one; `config.py` needs reconciling.
- ⚠️ **RAG advisories and measured CodeCarbon tracking require Pathway**, so they are
  unavailable in direct mode — reported as unavailable, never faked.
- ⚠️ **Ventilation is currently NCR-centroid single-point.** Per-station coordinates are
  accepted by the API, but the dashboard uses one location.

### Rules the team does not break
- Never quote **23 ms** anywhere near forecasting. It is API latency; an NWP scientist reads
  it as a category error.
- Never present λ as a published standard index. The *physics* is published; operationalising
  it as a live scalar is ours. Say exactly that.
- Hold out **Nov 2023 and Nov 2024**. Every public number comes from episodes the fit never
  saw.
- Episode labels never see λ. Step 5 stays independent of step 4, or the validation is
  circular.

---

## Research pipeline

`research/ps26082` — read `docs/AREE_PS26082_Architecture.pdf` first.

| Step | Script | Key | What it does |
|---|---|---|---|
| 0 | `00_selftest_synthetic.py` | — | synthetic data with a **known** λ; checks the estimator recovers it. Run first, always |
| 1 | `01_fetch_era5.py` / `01b_fetch_openmeteo_era5.py` | CDS | ERA5 hourly `blh`, `ssrd`, `ssrdc`, `t2m`, `u10/v10`, `sp`, `tp`, `sshf` |
| 2 | `02_fetch_ground_aq.py` | OpenAQ | hourly PM2.5 across NCR stations |
| 3 | `03_build_panel.py` | — | one hourly panel; converts ERA5 J m⁻² accumulations to W m⁻² |
| 4 | `04_compute_lambda.py` | — | estimates e1, e2, e3 and λ, with physical sign checks |
| 5 | `05_label_episodes.py` | — | labels episodes locked-in vs ventilated — **never sees λ** |
| 6 | `06_validate_lambda.py` | — | the go/no-go gate: AUC, lead time, FAR vs the VC baseline |
| 7–9 | `07_diagnose_elasticities` · `08_dilution_index` · `09_forecast_skill_chain` | — | endogeneity diagnosis, dilution index, forecast-skill chain |
| 10 | `10_calibrate_operating_point.py` | — | derives the 465.9 m²/s threshold shipped in `backend/config/` |

---

## Acknowledgments

**[Open-Meteo](https://open-meteo.com/)** ECMWF/GFS fields · **[CAQM](https://caqm.nic.in/)**
and **[CPCB](https://cpcb.nic.in/)** ground network · **[data.gov.in](https://data.gov.in/)**
· **[OpenAQ](https://openaq.org/)** · **[WAQI](https://aqicn.org/)** ·
**[NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)** · **[Pathway](https://pathway.com/)**
· **[Google Gemini](https://ai.google.dev/)** · **[CodeCarbon](https://codecarbon.io/)**

Built for **SIH PS 26082** — Air Pollution–Weather Coupled Forecasting, Ministry of Earth
Sciences / NCMRWF, Disaster Management. Team **Devengers**.

<p align="center"><sub>The system proposes. The authority disposes. Every number carries its provenance.</sub></p>
