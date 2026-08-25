# AREE 2.0 — PS 26082

Air Pollution–Weather Coupled Forecasting System for Delhi NCR
Team Devengers · Ministry of Earth Sciences / NCMRWF · Disaster Management

---

## What this repository is

The validation pipeline for the scientific claim the whole submission rests on:
that the **aerosol–radiation–boundary-layer feedback loop gain (λ)** can be
measured from observations, and that it separates pollution episodes which
*lock in* from those which *ventilate out*, with useful lead time.

**Read `docs/AREE_PS26082_Architecture.pdf` first.** It contains the module
split, algorithm selection, evidence base and work plan.

---

## Environment

Everything lives on `D:`. Nothing is installed on the system drive.

```
venv        d:\AZUO\chat\.venv
pip cache   d:\AZUO\chat\.pipcache
temp        d:\AZUO\chat\.tmp
```

To use it:

```
d:\AZUO\chat\.venv\Scripts\python.exe scripts\<name>.py
```

---

## Pipeline

| Step | Script | Needs a key | What it does |
|------|--------|-------------|--------------|
| 0 | `00_selftest_synthetic.py` | no | Generates synthetic data with a **known** λ and checks the estimator recovers it. Run this first, always. |
| 1 | `01_fetch_era5.py` | CDS | ERA5 hourly: `blh`, `ssrd`, `ssrdc`, `t2m`, `d2m`, `u10/v10`, `sp`, `tp`, `sshf`. Use `--dry-run` to print the request without pulling. |
| 2 | `02_fetch_ground_aq.py` | OpenAQ | Hourly PM2.5 across NCR stations. Falls back to `data/raw/ground_aq_manual.csv`. |
| 3 | `03_build_panel.py` | no | Merges everything into one hourly panel. Converts ERA5 J m⁻² accumulations to W m⁻². |
| 4 | `04_compute_lambda.py` | no | Estimates e1, e2, e3 and λ. Prints physical sign checks. |
| 5 | `05_label_episodes.py` | no | Labels episodes locked-in vs ventilated. **Never sees λ.** |
| 6 | `06_validate_lambda.py` | no | The go/no-go gate: AUC, lead time, false-alarm rate, vs the ventilation-coefficient baseline. |

### Keys

```
set CDSAPI_KEY=...
set OPENAQ_API_KEY=...
set FIRMS_MAP_KEY=...
```

---

## Current status

Self-test **passes**:

```
true lambda       +0.1386
recovered lambda  +0.1513   (9.2% error)
all three physical sign checks PASS
```

Not yet run on real ERA5 — that needs a Copernicus CDS key and is step 1 of
the work plan.

---

## The three things that will kill this project

1. **PBL height is unobtainable at hourly cadence.** ERA5 `blh` is the plan;
   confirm CDS access before anything else. If it fails, λ as formulated is
   dead and you need to know in week one.
2. **λ does not separate the classes on real data.** That is what step 6 is
   for. The fallback positioning is written in §4 of the architecture doc.
3. **Simultaneity bias.** OLS on a closed loop is endogenous — the individual
   elasticities are biased even though the product survives. Module B replaces
   it with instrumental variables.

---

## Rules that are not negotiable

- **Never quote 23 ms near forecasting.** It is API latency. An NWP scientist
  reads it as a category error.
- **Never present λ as a published standard index.** The *physics* is
  published; operationalising it as a live scalar is ours. Say exactly that.
- **Hold out Nov 2023 and Nov 2024.** Every public number comes from episodes
  the fit never saw.
- **Labels never see λ.** Step 5 must stay independent of step 4 or the whole
  validation is circular.

---

## Running the application

Two processes. Neither needs Pathway, Docker or WSL.

```
# backend  (from the repo root)
set OPENAQ_API_KEY=...
d:\AZUO\chat\.venv\Scripts\python.exe -m uvicorn backend.api.main:api --port 8077

# frontend (from frontend/)
set NEXT_PUBLIC_API_URL=http://127.0.0.1:8077
npx next dev --port 3077
```

Then open **http://localhost:3077**. All four tabs work.

### Two engine modes

| | streaming | direct |
|---|---|---|
| Requires Pathway | yes | no |
| Platform | Linux / macOS / Docker / WSL | anywhere |
| GRAP state machine | same code | same code |
| Persistence + hysteresis | same code | same code |
| Causal attribution, FIRMS | yes | yes |
| Event-time windowing | yes | **no** — interval sampling |
| Policy RAG advisories | yes | **no** — needs the DocumentStore |
| Carbon tracking | yes | **no** |

`engine.load_engine()` tries Pathway first and falls back to
`backend/fallback_engine.py` when the import fails. Every state carries
`mode="direct"` and the unavailable subsystems report as unavailable rather
than returning plausible defaults.

Direct mode exists because only `rag/advisory_engine.py` actually imports
Pathway. The state machine that decides GRAP stages is pure Python and never
needed a streaming runtime — three tabs were dark because of one import in one
module.

### The ventilation view specifically

`/ventilation` is the PS 26082 deliverable and is independent of **both**
engines. It reads a numerical weather model for the forecast and the CPCB/DPCC
network for observations. It stays up whatever the engine is doing, which is
deliberate: the forecast layer is upstream of the streaming layer in the data
flow, so it should not be downstream of it in the dependency graph.

### Endpoints

| Route | Purpose |
|---|---|
| `/api/ventilation/forecast` | 72 h ventilation outlook + intervention window |
| `/api/ventilation/observed` | live NCR PM2.5 composite |
| `/api/ventilation/stations` | every reporting station behind the composite |
| `/api/ventilation/assessment` | escalation assessment (live or supplied PM2.5) |
| `/api/ventilation/operating-point` | the calibrated threshold and its measured skill |

---

## Data-source gotchas worth knowing

- **OpenAQ `/parameters/{id}/latest` ignores `bbox` and `coordinates`.** It
  returns global rows and does not error. Use `/v3/locations?bbox=` to resolve
  the domain, then read each location. Always re-check returned coordinates.
- **Location dates are not sensor dates.** A location's `datetimeLast` spans
  every sensor ever sited there; individual sensor ids retire.
- **OpenAQ's Indian feed has a gap from Nov 2022 to Feb 2025**, present in the
  S3 archive too. Only the US Embassy monitor spans it.
- **data.gov.in returns an empty-bodied HTTP 502 after ~60 s under burst**,
  never a 429, so retry logic written from the spec will not catch it.
- **Request OpenAQ history in monthly chunks.** A month fits one 1000-row page;
  deep pagination returns 500s and 408s.

---

## Reading the ventilation chart

The chart is live. Every point is computed at request time from the current
model run — nothing is cached beyond 90 seconds and nothing is replayed.

### What each point is

```
ventilation coefficient  =  boundary layer height (m)  ×  10 m wind speed (m/s)
```

Both come from the same Open-Meteo (ECMWF/GFS) hourly forecast. Verified
against the upstream API directly:

```
chart peak, 24 Aug 10:00 UTC        1262.2 m²/s
upstream   BLH 935 m × wind 1.35    1262.2 m²/s   exact match
```

### Why it looks like a sawtooth

That shape is the diurnal boundary-layer cycle, and it is the single most
important thing on the page:

| Hour UTC | BLH | Wind | Ventilation |
|---|---|---|---|
| 00:00 | 55 m | 0.18 m/s | 9.9 |
| 03:00 | 290 m | 0.21 m/s | 60.9 |
| 06:00 | 375 m | 1.25 m/s | 468.8 |
| 09:00 | 850 m | 0.81 m/s | 688.5 |
| 12:00 | 335 m | 2.66 m/s | 891.1 |
| 15:00 | 120 m | 0.75 m/s | 90.0 |
| 18:00 | 60 m | 0.51 m/s | 30.6 |

Solar heating grows the mixed layer through the morning, so the atmosphere's
capacity to dilute rises by two orders of magnitude between night and midday.
After sunset the layer collapses and whatever is emitted accumulates in a
shallow volume. **Delhi's winter smog is not primarily an emissions story —
it is this curve failing to rise.**

### Chart furniture

- **Red dashed line** — the calibrated decision threshold (466 m²/s), derived
  in `scripts/10_calibrate_operating_point.py`, not chosen by eye.
- **Shaded red region** — the forecast sustained collapse: six or more
  consecutive hours below threshold. One hour below at 03:00 is a normal
  night, not a ventilation failure, which is why the run length is required.
- **Horizon** — usually less than 72 h. It is the model's forward window minus
  the hours already elapsed since the run, so it shrinks through the day and
  jumps back up when the upstream model re-runs.

### Refresh behaviour

| Layer | Cadence | Why |
|---|---|---|
| Upstream model | hourly | ECMWF/GFS run cadence |
| Backend cache | 90 s | CPCB publishes hourly; re-querying faster buys nothing |
| Chart poll | 5 min | matches how fast the underlying forecast can change |
| Station poll | 2 min | dropouts are what an operator needs to see promptly |

If the graph looks static for a few minutes, that is correct: the forecast
behind it has not changed. `generated_at` in the payload is the honest answer
to "when was this computed", and station panels show measured data age rather
than implying the poll interval is the freshness.
