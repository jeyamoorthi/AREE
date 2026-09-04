<h1 align="center">🌬️ AREE</h1>
<h3 align="center">Autonomous Regulatory Escalation Engine</h3>
<p align="center"><i>Delhi NCR · SIH PS 26082 — Air Pollution–Weather Coupled Forecasting · Team Devengers</i></p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-blue?style=for-the-badge&logo=python&logoColor=white" alt="Python"/>
  <img src="https://img.shields.io/badge/FastAPI-API-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/React_19_/_Next.js_16-Dashboard-000000?style=for-the-badge&logo=next.js&logoColor=white" alt="Next.js"/>
  <img src="https://img.shields.io/badge/Open--Meteo-Weather-FF7F0E?style=for-the-badge" alt="Open-Meteo"/>
  <img src="https://img.shields.io/badge/NASA_FIRMS-Fires-EF4444?style=for-the-badge" alt="FIRMS"/>
  <img src="https://img.shields.io/badge/CPCB_%2F_CAQM-Ground_Truth-138808?style=for-the-badge" alt="CPCB"/>
</p>

> **This document is the frozen, honest description of what AREE is today.** What is built,
> what data enters it, what each part does, and what is still future work. Nothing here is
> aspirational. Where something is not built, it says so.

---

## 1. The problem we are solving

Delhi NCR needs a system that understands how weather and atmospheric conditions affect
**pollution persistence**, forecasts deteriorating conditions, and helps disaster-management
and regulatory authorities act *early*.

A normal pollution dashboard tells an authority:

> "PM2.5 is 250."

True, useful, and entirely about the **present**. AREE tries to answer the next five
questions:

- What is the atmosphere going to do?
- Will it become difficult for pollution to disperse?
- When is that deterioration expected?
- How much lead time do authorities have?
- What regulatory response applies, and on what evidence?

**In one sentence:**

> AREE is a real-time atmospheric risk and regulatory decision system that combines observed
> pollution with forecast meteorology to determine whether atmospheric ventilation is likely
> to deteriorate and persist, estimates the remaining intervention lead time, and connects
> that to deterministic regulatory rules, evidence, explanations, and human-authorised action.

---

## 2. Architecture at a glance

```text
                    REAL WORLD
                        │
        ┌───────────────┼────────────────┐
        ↓               ↓                ↓
   Air Quality       Weather          Satellite /
      Data            Data             Fire Data
        │               │                │
        └───────────────┼────────────────┘
                        ↓
                 DATA / STREAMING
                        ↓
              ATMOSPHERIC ANALYSIS
                        ↓
             VENTILATION FORECAST
                        ↓
            PERSISTENCE / RISK LOGIC
                        ↓
             INTERVENTION WINDOW
                        ↓
              AREE DECISION ENGINE
                        ↓
             REGULATORY RULE ENGINE
                        ↓
       ┌────────────────┴────────────────┐
       ↓                                 ↓
  Evidence / Explanation            Recommended
                                       Action
       │                                 │
       └────────────────┬────────────────┘
                        ↓
                 HUMAN AUTHORITY
                        ↓
                AUDIT / REPLAY
```

The React dashboard is the interface through which all of this is presented.

---

## 3. Data layer — what actually enters the system

We deliberately moved off simulated and demo data. Every source below is a real external
feed.

| Source | Role | Status |
|---|---|---|
| **Open-Meteo** | live forecast meteorology (PBLH, wind, radiation) — one URL, pinned to Delhi NCR | ✅ working, the backbone of the forecast layer |
| **NASA FIRMS** | satellite fire / hotspot detections | ✅ integrated |
| **CAQM** `caqm.nic.in` | live NCR station roster + timestamped sub-index AQI | ✅ working |
| **CPCB** via `data.gov.in` | PM2.5 **concentrations** in µg/m³, verbatim CPCB station names | ✅ working, slow |
| **OpenAQ v3** | per-station provenance behind the NCR composite | ⚠️ **key in `.env` returns 401**; the live composite falls back to CPCB and is unaffected |
| **WAQI** | pan-India AQI + station discovery | ⚠️ **integration exists, real-time retrieval is not reliable yet** |

### ⚠️ On WAQI, say this and nothing stronger

> "WAQI integration exists, but real-time retrieval still needs to be fixed and verified."

Do **not** tell a judge WAQI is perfectly live. It is not, today.

### 🌦️ Weather data — the live Delhi URL we use

The scope is **Delhi NCR only**, so the weather layer is one live Open-Meteo call pinned to
the NCR centroid (28.63 °N, 77.22 °E). No API key, no queue, no account — the whole 72-hour
horizon comes back in a single request:

```
https://api.open-meteo.com/v1/forecast
  ?latitude=28.63&longitude=77.22
  &hourly=boundary_layer_height,shortwave_radiation,terrestrial_radiation,cloud_cover,
          temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,
          surface_pressure,precipitation
  &forecast_days=3&timezone=UTC&wind_speed_unit=ms
```

That is the URL behind every point on the `/ventilation` chart. `PBLH × wind_speed_10m` from
this response *is* the ventilation coefficient — verified against the raw payload directly
(chart peak 1262.2 m²/s = BLH 935 m × wind 1.35 m/s, exact match). Built in
[`weather_stream.py`](backend/ingestion/weather_stream.py); the coordinates are the default,
and the API accepts `lat`/`lon` overrides if we ever widen beyond NCR.

The same URL with `&past_days=2&forecast_days=1` returns recent **observed** hours. Those
rows are flagged `is_forecast=False` and served from a separate endpoint
(`/api/ventilation/current`), because analysis values and predictions must never be mixed in
a system that issues regulatory escalations.

Two further Open-Meteo endpoints are used by the **research pipeline only**, never on the
live request path:

| Endpoint | Used for | Where |
|---|---|---|
| `archive-api.open-meteo.com/v1/archive` | ERA5 reanalysis — the historical training corpus | [`01b_fetch_openmeteo_era5.py`](research/ps26082/scripts/01b_fetch_openmeteo_era5.py) |
| `previous-runs-api.open-meteo.com/v1/forecast` | past forecast runs at fixed lead times | [`09_forecast_skill_chain.py`](research/ps26082/scripts/09_forecast_skill_chain.py) |

**The distinction that will bite us if we get it wrong:** the archive is *reanalysis* — it
already knows the answer. Training or scoring on it and calling the result "forecast
accuracy" is self-deception. Skill evaluation uses the previous-runs endpoint, at the lead
time we would actually have had.

Every row carries `observed_at` (the hour it describes), `received_at` (when we fetched it)
and, for forecast rows, `issued_at` — plus an `is_forecast` flag, so nothing downstream can
mistake a prediction for an observation.

---

## 4. Ventilation — the weather-to-pollution connection

Imagine Delhi as a room full of smoke. Large room with moving air → the smoke disperses.
Shallow room with still air → the smoke stays. The atmosphere behaves the same way.

```
VC = PBLH × Wind₁₀ₘ          [m²/s]
```

```text
Deep PBL + strong wind          Shallow PBL + weak wind
        ↓                               ↓
  High ventilation                Low ventilation
        ↓                               ↓
  Good dispersion                 Poor dispersion
                                        ↓
                                Pollution persists
```

| | PBL | Wind | VC | |
|---|---|---|---|---|
| Well ventilated | 1500 m | 2.0 m/s | 3000 m²/s | 🟢 |
| Poorly ventilated | 100 m | 0.5 m/s | 50 m²/s | 🔴 |

This is a long-standing quantity in air-quality meteorology. **We did not invent the
ventilation coefficient** and must never claim we did. What is ours is the operational chain
built on top of it.

---

## 5. The ventilation forecast layer (built)

For every forecast hour: `VC_t = PBLH_t × Wind_t`.

Example: PBLH 500 m × wind 0.8 m/s = **400 m²/s**.

Compared against the calibrated operating point:

```
465.9 m²/s
```

`VC > 465.9` → better ventilation.  `VC < 465.9` → poor ventilation.

### We do not trigger on one bad hour

Ventilation naturally rises and falls every day, and collapses every winter night. A single
hour below threshold at 03:00 is the nocturnal boundary layer doing what it always does.

```text
14:00 → 300  ↓
15:00 → 350  ↓
16:00 → 600  ↑     ← not a collapse
```

So the system requires:

```
≥ 6 consecutive hours below threshold
```

and reports the **first hour of that run** as the onset. That is what
[`find_collapse()`](backend/forecast/ventilation.py) does. Firing without the run-length
requirement would produce an alarm every night, which is precisely how a system gets
switched off.

---

## 6. Intervention window (built)

```text
Forecast generated                13:23
Sustained poor ventilation from   16:30
                                  ─────
Intervention window            ≈  3.1 hours
```

It means:

> "Based on the current forecast, approximately 3.1 hours remain before the predicted start
> of the sustained poor-ventilation period."

It does **not** mean "pollution will become dangerous in exactly 3.1 hours," and it does not
come from AQI at all:

```text
Open-Meteo forecast → PBLH + wind → ventilation → threshold
        → 6-hour persistence → predicted onset → onset − now → window
```

### Lead-time bands

Bands are lead time, not severity — for disaster management the actionable quantity is how
long is left to act.

| Window | State | Priority |
|---|---|---|
| already begun | `collapsed` | CRITICAL |
| ≤ 12 h | `imminent` | HIGH |
| ≤ 36 h | `approaching` | MEDIUM |
| > 36 h | `watch` | LOW |
| none forecast | `clear` | LOW |

---

## 7. Where PM2.5 / AQI fits

Two different dimensions, and the dashboard needs both:

```text
                AREE
                  │
       ┌──────────┴──────────┐
       ↓                     ↓
   PM2.5 / AQ            Weather
 "how much pollution   "how capable the
  is present now"       atmosphere is of
       │                clearing it"
       │                     │
       │                PBLH + Wind
       │                     │
       │                Ventilation
       │                     │
       └──────────┬──────────┘
                  ↓
          Persistence Risk
                  ↓
        Intervention Window
```

The escalation trigger is a **conjunction**, and this is deliberate:

```
triggered = observed PM2.5 ≥ 120 µg/m³  AND  forecast sustained ventilation collapse
```

PM2.5 alone tells you an episode is *happening*, not whether it will last. Ventilation alone
is not an episode detector — it collapses every winter night. Firing on either half by
itself generates the false alarms that destroy trust in the system.

---

## 8. NASA FIRMS

FIRMS answers: **are there active fire sources that could contribute to the regional
situation?** So AREE is not looking only at one monitoring station.

```text
Fire hotspots → potential emission source → regional pollution context → AREE
```

Today it feeds the causal-attribution and transport-vector logic in
[`risk_engine.py`](backend/streaming/risk_engine.py). Turning fires into a *quantitative
forecast input* — trajectory, NCR intersection, arrival time, PM2.5 contribution — is
[Phase 1 / future work](#16-what-comes-next--phase-1-the-data-layer).

---

## 9. Gemini — explains, never decides

```text
Deterministic system → facts / evidence → Gemini → human-readable explanation
```

**Not:**

```text
Gemini → "Do GRAP Stage III"
```

Instead of showing an authority `VC = 312, threshold = 466, persistence = 8h`, Gemini turns
the structured evidence into: *"Forecasted ventilation is expected to remain below the
operating threshold for a sustained period, indicating increased potential for pollutant
accumulation."*

The LLM output never enters the escalation logic. That separation is architectural, not
stylistic.

### 🔄 Reducing the Gemini dependency (in progress)

Two teammates are making the explanation layer more deterministic and explainable —
structured evidence, rule/pathway-based explanations, explainability approaches under
evaluation, and deterministic templates where appropriate. The principle stays fixed:

> **AI explains; AI does not decide.**

---

## 10. Regulatory decision engine (built)

We do not ask an LLM "what should the government do?" There is a deterministic rule layer:

```text
Observed pollution + Forecast atmospheric condition + Persistence + Applicable framework
                                    ↓
                            Decision Engine
                                    ↓
                          Priority / Action
```

Implemented across [`predictive_engine.py`](backend/streaming/predictive_engine.py)
(`assess()` → `build_case()`) and [`state_machine.py`](backend/streaming/state_machine.py)
(GRAP stages, persistence, hysteresis). A triggered case opens as `AWAITING_APPROVAL` and
carries its evidence, its reasons, the operating point in force, the deadline (the collapse
onset), and the recommended GRAP measures.

**The authority remains in control.** Legal authority for GRAP invocation rests with CAQM
and the state pollution control boards. The system proposes; the authority disposes.

---

## 11. RAG / document knowledge layer (built)

Regulatory content is not hard-coded into the application.

```text
Regulatory documents / guidelines / frameworks
        ↓  document storage
        ↓  retrieval
   Relevant evidence → AREE
```

This exists so that when the system recommends something we can answer **"why did you
recommend this?"** and **"which rule supports it?"** — which is a far stronger position than
*"the AI said so."*

Documents live in [`backend/policies/`](backend/policies/) (GRAP schedule, HSPCB winter
action plan 2024-25, AQI methodology, pollution reference) and are indexed by
[`rag/advisory_engine.py`](backend/rag/advisory_engine.py). New documents can be uploaded at
runtime via `POST /api/policy/upload`.

⚠️ The RAG index is built on a Pathway DocumentStore, so it is **only available in streaming
mode** (see [§13](#13-two-engine-modes)). In direct mode it reports itself unavailable
rather than returning something plausible.

---

## 12. Audit trail and replay

A regulatory decision should not disappear after it happens. The target is full
traceability:

```text
What data was available? → What forecast was used? → What conditions were detected?
→ What rule fired? → What explanation was generated? → What action was recommended?
→ Who approved it?
```

**What is actually built today:**

- ✅ Every forecast, assessment and case is a plain, fully timestamped dictionary — designed
  to be serialised, logged and replayed byte-for-byte rather than a model object that has to
  be reconstructed.
- ✅ Evidence, provenance and the operating point in force are attached to every decision:
  station names, measured data age, station counts, whether an input was measured or
  supplied manually, and the threshold/hit-rate/FAR that was active.
- ✅ Escalation transitions are logged (`GET /api/escalations`).

**What is not built yet, and we should say so:**

- ❌ **Durable storage.** The escalation log lives in process memory. It does not survive a
  restart. There is no database behind it yet.
- ❌ **A replay driver.** The payloads are replay-*ready*; the harness that walks a
  historical event T-24h → T-0 and shows what AREE would have said at each step does not
  exist in this repository.

That replay demo is a high-value SIH deliverable and is explicitly on the next-work list.
It is not something to claim in a presentation today.

---

## 13. Two engine modes

`engine.load_engine()` tries Pathway first and falls back to
[`fallback_engine.py`](backend/fallback_engine.py) when the import fails. Set
`AREE_ENGINE_MODE=direct` to select it explicitly. Every state carries `mode="direct"` so
nothing can pass it off as the streaming engine.

| | streaming | direct |
|---|---|---|
| Requires Pathway | yes | **no** |
| Platform | Linux / macOS / Docker / WSL | anywhere, including Windows |
| GRAP state machine, persistence, hysteresis | same code | same code |
| Causal attribution, FIRMS | yes | yes |
| Event-time windowing | yes | **no** — 120 s interval sampling |
| Policy RAG advisories | yes | **no** — needs the DocumentStore |
| Carbon tracking | measured | deterministic estimate, flagged `measured: false` |

Direct mode exists because only `rag/advisory_engine.py` actually imports Pathway — the
state machine that decides GRAP stages is pure Python and never needed a streaming runtime.
Three tabs were dark because of one import in one module.

**`/ventilation` is independent of both engines.** It reads the weather model and the ground
network directly, so it stays up whatever the engine is doing. The forecast layer is
upstream of the streaming layer in the data flow, so it must not be downstream of it in the
dependency graph.

---

## 14. React frontend (built)

The project is in **React / Next.js 16**, not Streamlit. It is designed as an operational
dashboard, not a data-science notebook, and holds **no business logic** — every value it
renders is computed by the Python engine and served over the API.

| Route | Shows |
|---|---|
| `/` | national overview: live map, top-5 AQI/ERI, rankings, escalations, carbon |
| `/dashboard?station=…` | single-station command centre |
| `/stations/[station]` | the same, deep-linkable |
| `/ventilation` | **the PS 26082 view**: PBLH, wind, VC trajectory, threshold, collapse band, intervention window, live composite, station table, assessment |
| `/reports` | per-station PDF escalation reports |

---

## 15. The ~23 ms number — read this before you quote it

We have measured roughly **23 ms** for the decision/application-layer operation.

> ❌ **Never say:** "Our weather forecast runs in 23 ms."
>
> ✅ **Say:** "The decision/application layer responds in approximately 23 ms under our
> measured conditions."

External forecast and data retrieval obviously take far longer — Open-Meteo, CAQM and CPCB
are network calls against hourly feeds. Quoting 23 ms anywhere near the word *forecasting*
reads to an atmospheric scientist as a category error, and it will cost us credibility
faster than any missing feature.

---

## 16. Complete data flow

```text
                         REAL WORLD
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   CPCB / CAQM /        Open-Meteo            NASA FIRMS
   OpenAQ / WAQI     Weather forecast        Fire hotspots
   PM2.5 / AQ         + ERA5 archive
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
                       DATA PIPELINE
                             ▼
                  CURRENT ATMOSPHERIC STATE
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
                PM2.5               PBLH + Wind
                  │                     ▼
                  │               VENTILATION
                  │                     ▼
                  │              Threshold test
                  │                     ▼
                  │             ≥ 6 h persistence
                  └──────────┬──────────┘
                             ▼
                     FUTURE RISK STATE
                             ▼
                  INTERVENTION WINDOW
                             ▼
                     AREE RULE ENGINE
                    ┌────────┴────────┐
                    ▼                 ▼
               Regulations       Evidence / RAG
                    └────────┬────────┘
                             ▼
                       EXPLANATION
                             ▼
                     HUMAN AUTHORITY
                             ▼
                       AUDIT / REPLAY
```

---

## 17. Where the "weather coupling" currently happens

This must be phrased precisely.

```
Weather forecast → Ventilation → Pollution persistence risk
```

We take atmospheric forecast variables and use them to determine the **future dispersion
environment for pollution**.

We are **not** running a full WRF-Chem simulation. We are **not** claiming a two-way
chemistry–meteorology coupled numerical model. Either claim would be an overclaim and would
not survive one question from a domain expert.

What we have is one direction: forecast meteorology drives a dispersion-capacity estimate,
which drives a persistence risk. Say exactly that, and nothing larger.

---

## 18. What about ML?

**Currently built** — all deterministic:

✅ ventilation calculation ✅ forecast-based ventilation trajectory ✅ calibrated threshold
✅ 6-hour persistence detection ✅ collapse/onset detection ✅ intervention-window
calculation ✅ rule-based decision architecture

**Not built:** any ML forecasting model. The eventual design is:

```text
Historical atmospheric data + historical pollution + weather + fire information
        ↓
     ML model
        ↓
Better future-state prediction → ventilation → AREE
```

Do not present the ML model as built. It is not.

---

## 19. The finding the system is built on

One result, measured on five winters of Delhi NCR data, and it is the reason the threshold
and the 6-hour rule exist:

> **Ventilation over the 48 hours following an episode's onset separates episodes that lock
> in from episodes that ventilate out — AUC 0.736.**

Two consequences follow directly, and both are already in the shipped code:

- The useful question is not *"how bad is it now"* but *"will the atmosphere still be able
  to clear itself"*. That is a **forecasting** problem, which is what
  [`forecast/ventilation.py`](backend/forecast/ventilation.py) does.
- A one-to-two day forecast reproduces that ventilation closely enough to keep the skill
  (r = 0.75, RMSE 0.79 m/s on window-mean wind), so a forward forecast is a usable substitute
  for the reanalysis the finding was derived on.

### The calibrated operating point

From [`backend/config/ventilation_operating_point.json`](backend/config/ventilation_operating_point.json),
loaded at runtime so it can be re-derived without touching application code:

| Mode | Threshold | Hit rate | False alarm | Precision |
|---|---|---|---|---|
| **balanced** (default) | 465.9 m²/s | 0.606 | 0.191 | 0.488 |
| precautionary | 765.0 m²/s | 0.818 | 0.527 | 0.318 |

Training AUC 0.736 · 143 episodes, 33 locked-in · 48 h outcome window · holdout Nov 2023 +
Nov 2024 → **11 episodes, hit 0.20, FAR 0.50**.

> ⚠️ **The holdout is thin and we say so.** 64% of in-season hours rest on two or fewer PM2.5
> stations, and OpenAQ's Indian feed has a gap from Nov 2022 to Feb 2025. 466 m²/s is a
> **current operating point to be re-derived** — see [Phase 1](#22-what-comes-next--phase-1-the-data-layer) —
> not a settled constant and not an atmospheric law.
> `GET /api/ventilation/operating-point` returns this caveat alongside the number.

---

## 20. What is actually novel here

Not "we calculate AQI" — everyone does. Not "we show weather" — everyone does. Not "we
invented the ventilation coefficient" — we did not.

The novelty is the **operational chain**:

```text
REAL POLLUTION + FORECAST ATMOSPHERE
        ↓
VENTILATION DETERIORATION
        ↓
SUSTAINED CONDITION
        ↓
LEAD TIME
        ↓
REGULATORY DECISION
        ↓
TRACEABLE ACTION
```

**We connect atmospheric forecasting to an actionable, evidence-backed regulatory response.**
That is where AREE stops being a weather dashboard.

---

## 21. Status — what we have vs what we still need

| Component | Status |
|---|---|
| React operational UI | ✅ Built |
| AREE decision architecture | ✅ Built |
| Regulatory rule engine | ✅ Built (extending) |
| RAG / document knowledge layer | ✅ Built (streaming mode only) |
| Gemini explanation layer | ✅ Integrated |
| Gemini-independent explanation | 🔄 In progress |
| NASA FIRMS | ✅ Integrated (display + attribution) |
| FIRMS as a forecast input (trajectory, arrival time) | 🔄 Future |
| WAQI | ⚠️ Integration exists, real-time fetching needs fixing |
| CPCB / CAQM / OpenAQ ingestion | ✅ Built |
| Weather forecast — Open-Meteo | ✅ Built |
| PBLH + 10 m wind | ✅ Used |
| Ventilation coefficient | ✅ Built |
| 465.9 m²/s operating point | ✅ Calibrated (thin holdout) |
| 6-hour persistence | ✅ Built |
| Collapse / onset detection | ✅ Built |
| Intervention window | ✅ Built |
| Audit fields on every decision | ✅ Built |
| Durable audit storage (database) | ❌ Not built — in-memory only |
| Replay driver (T-24h → T-0 walkthrough) | ❌ Not built — payloads are replay-ready |
| ~23 ms decision/application response | ✅ Measured (**not** a forecast time) |
| Full WRF-Chem | ❌ Not built |
| Two-way chemistry–weather coupling | ❌ Not built |
| ML forecasting model | 🔄 Next layer |
| Feature store / historical backfill | ✅ Built — `backfill.py`, 5 tables, runs today |
| Historical AQ via OpenAQ | ⚠️ Blocked — key in `.env` returns 401 |
| Inversion strength / lapse rate (historical) | ⚠️ ERA5 archive has no pressure levels; recent 92 d only |
| Baseline forecasts (persistence, climatology) + scoring | ✅ Built — walk-forward across Nov 2021-2024 |
| ML forecasting model (lgbm-v1) | ⚠️ Built — on comparable folds, 1 clean win of 3. Diagnosed: L1 compression + single-monitor target, not physics |
| Experiment B — operational skill (previous-run NWP) | ✅ Done — weather-forecast cost is only 0-3 MAE; no forecast PBLH exists upstream |
| Experiment C — regime/target diagnosis | ✅ Done — target changed between folds; failure is objective-induced, not atmospheric |
| Live multi-station capture | ✅ Running — 79 stations/hour into `station_readings` |
| Objective experiment (L1 / L2 / log / q90) | ✅ Done — tail compression is objective-induced and fixable; no single objective serves both jobs |
| Experiment D — warning skill | ✅ Done — climatology has 0 warning skill; q90 calls 69% of episodes ~68 h early |
| Multi-station target construction | ✅ Built — `ncr_target`, coverage-aware; accumulating hourly |
| Single-monitor proxy error | 🔄 Machinery ready; needs winter hours to be evidence |
| Retroactive multi-station rebuild | ❌ Impossible — current OpenAQ sensors post-date the evaluation winters |
| Durable hourly capture | ✅ Windows Task Scheduler, `AREE-hourly-capture`, hourly |
| Ablation: + plume, + feedback-corrected PBLH | 🔄 Last, only if a failure survives target+objective fixes |
| Robust 72 h validation | 🔄 Needs work |

> Two rows differ from the team's working table on purpose. **Audit/replay** is split into
> what exists (fields and log) and what does not (durable storage, replay driver) — nothing
> in the repository walks a historical event today. Flag it if you disagree.

### If someone asks "what exactly have you built?"

> "We have built the operational AREE pipeline: real-data ingestion, weather-based
> ventilation forecasting, sustained poor-ventilation detection, intervention-window
> calculation, regulatory rule evaluation, document-backed evidence, AI-assisted
> explanation, and a React operational dashboard. Our next major layer is the historical
> feature store, improving the forecast itself with an ML/emulator approach, and
> strengthening validation."

---

## 22. What comes next — Phase 1, the data layer

**The first blocker is data, not ML.** Nobody starts on LightGBM until a clean historical +
live dataset exists.

```text
   CPCB/OpenAQ    Open-Meteo    FIRMS
        └─────────────┼───────────┘
                      ▼
                FEATURE STORE
                      ▼
                FORECAST CORE
                      ▼
             72-HOUR AQ FORECAST
                      ▼
                    AREE
                      ▼
        Decision / GRAP / Intervention
                      ▼
                React Dashboard
```

### The five tables

**`station_readings`** — ground truth
```
station_id · timestamp · pm25 · pm10 · o3 · no2 · so2 · co · lat · lon · source
```

**`met_hourly`** — weather / NWP
```
grid_id · timestamp · temperature_2m · relative_humidity · wind_speed_10m
wind_direction_10m · precipitation · solar_radiation · boundary_layer_height
temperature_1000 · temperature_925 · temperature_850 · …
```

**`fire_events`** — plume sources
```
timestamp · lat · lon · frp · confidence · satellite
```

**`derived_features`** — where our existing physics survives
```
timestamp · grid_id · ventilation_coefficient · inversion_strength · lapse_rate
plume_influence · sustained_low_ventilation
```

**`forecasts`** — two timestamps, and this is the important one
```
issued_at · valid_at · station_id · species · forecast_value · model_version
```

A forecast issued 25 Aug 12:00 for 26 Aug 12:00 stores both. When 26 Aug arrives we compare
forecast 280 against actual 301 → error 21. **That is how we prove whether the model works.**
Without `issued_at` we cannot.

### Target coverage

October → February, 2019 → 2025 — the winter regime that matters for this PS. Joined on
**time + location**, so one row eventually reads:

```text
2024-11-15 18:00
  ├── PM2.5 = 310 · PM10 = 480 · O3 = 28
  ├── PBLH = 180 m · Wind = 0.7 m/s · T = 17 °C
  ├── VC = 126 m²/s · inversion = strong
  └── fire influence = high
```

### One correction to the original plan

Do **not** assume OpenAQ == all CPCB data. First query OpenAQ for NCR stations and inspect:
how many stations, which pollutants, what date coverage, what gaps, which provider. We
already know its Indian feed has a **Nov 2022 – Feb 2025 gap**, present in the S3 archive
too. If OpenAQ does not give enough NCR historical depth, use **CPCB directly as the primary
source** rather than forcing OpenAQ into the architecture.

```text
OpenAQ discovery → find NCR stations → check provider coverage
→ check pollutant availability → check historical depth → ONLY THEN finalise ingestion
```

### Ownership

| Person | Builds |
|---|---|
| 1 — Data | ✅ discovery + probe built. **Get a working OpenAQ key** — the one in `.env` is rejected |
| 2 — Weather | ✅ built (`met`, `met-recent`). Next: Copernicus CDS for historical pressure levels |
| 3 — FIRMS | ✅ built. Next: turn `plume_influence` into a validated arrival-time feature |
| 4 — Database | ✅ schema + idempotent upserts on SQLite. Next: port to PostgreSQL |

### Milestone 1 — ✅ reached

[`backfill.py`](backfill.py) runs and produces the joined table. Real output, 17 Nov 2024:

```text
AREE DATASET   grid ncr_28.63_77.22
  Timestamp          PM2.5   PBLH   Wind      VC    Plume  Fire  Low
  2024-11-17 09:00     442   2115    2.1    4463    867.9     0   no
  2024-11-17 12:00     637   1765    1.7    3036    950.7     0   no
  2024-11-17 13:00     764    470    1.7     794    987.6     0   no
  2024-11-17 15:00     737    220    1.2     262    917.0     0  yes
  2024-11-17 20:00     511    135    1.3     176    940.9    34  yes
  2024-11-18 01:00     654     90    1.0      94    818.8     0  yes
```

The evening collapse is visible in one column: ventilation falls 4463 → 94 m²/s while PM2.5
stays above 500, and `Low` marks the hours inside a sustained run below threshold — the same
rule the live engine applies, so a historical label and a live alert mean the same thing.

```bash
python backfill.py probe             # coverage first — writes nothing
python backfill.py met     --start 2024-11-01 --end 2024-11-30
python backfill.py met-recent        # last ~92 d, the only path with pressure levels
python backfill.py import-research   # 29,953 h of historical NCR PM2.5
python backfill.py fires   --start 2024-11-01 --end 2024-11-30
python backfill.py derive
python backfill.py show --since 2024-11-17
```

Store: `data/aree.db` (SQLite, portable SQL, `AREE_DB_PATH` to relocate). SQLite rather than
PostgreSQL deliberately — the milestone is the table, and a server install between four
people and that table buys nothing. Every write is `INSERT … ON CONFLICT DO UPDATE` on a
natural key, so re-running is idempotent and the move to PostgreSQL is a connection swap.

**Verified in the store today:** 29,953 station-hours (2020-10-01 → 2025-03-30),
8,424 met-hours and derived rows across 9 grid points, 11,003 fire detections.

### What the build measured — three upstream findings

Each cost a debugging cycle. They are recorded so nobody pays twice.

| Finding | Consequence |
|---|---|
| **The ERA5 archive serves surface fields only.** Requesting `temperature_925hPa` returns HTTP 200 with a fully populated `hourly` block in which every pressure value is `null` — no error, no `reason`. Verified with and without `models=era5` and on the `/v1/era5` alias. | `inversion_strength` and `lapse_rate` are NULL for the historical corpus. The **forecast** endpoint does serve them but only ~92 days back (`met-recent`, verified 100% coverage). Full-period pressure levels need Copernicus CDS. |
| **FIRMS caps a request at 5 days, not 10.** The endpoint answers `400 "Invalid day range. Expects [1..5]."` | Windows are 5 days. Also measured: `VIIRS_SNPP_SP` covers 2012-01-20 → 2026-04-27 and `VIIRS_SNPP_NRT` 2026-04-28 → 2026-09-01 — they tile with no overlap, so backfill and live *must* use different products. `fire_history.availability()` re-checks rather than trusting this table. |
| **The OpenAQ key in `.env` is rejected** — `401 Invalid credentials`. | `backfill.py aq` is blocked. The historical AQ half comes from `import-research` instead. The **live** composite is unaffected: it is served by CPCB via data.gov.in (78 stations, 40 min old, verified). |

> The first two are the same failure mode this codebase already tracks in OpenAQ's `bbox`
> and CAQM's timestamp-free payload: **an endpoint that answers confidently rather than
> refusing.** The probe now raises on a rejected key instead of reporting "0 locations in
> box", which read as "the NCR has no monitors".

### Baselines — ✅ established across four winters

**Baselines before models.** The bar any forecast has to clear, written into the `forecasts`
table with a real `issued_at` and scored against actual observations. Walk-forward: each
November is forecast using only data from before that season.

```bash
for y in 2021 2022 2023 2024; do
  python backfill.py baseline --start $y-11-01 --end $y-11-27 --every 6
  python backfill.py score    --start $y-11-01 --end $y-11-30
done
```

Pooled across Nov 2021–2024, n-weighted, PM2.5 MAE in µg/m³:

| Lead | persistence | climatology | winner |
|---|---|---|---|
| 1–6 h | **49.7** | 85.6 | persistence |
| 7–12 h | 91.8 | **85.8** | climatology |
| 13–24 h | 94.3 | **86.3** | climatology |
| 25–48 h | 108.2 | **87.0** | climatology |
| 49–72 h | 118.3 | **85.6** | climatology |

**This is the bar.** A model has skill only where it beats *both* — so ~50 at 1–6 h and
~86 from 7 h out. Not a single headline MAE.

The shape is exactly what theory predicts, which is the point of running it: persistence is
strong at short lead and decays monotonically as its anchor goes stale; climatology is flat
across every lead because it has no lead dependence at all. Crossover sits between 6 and
12 hours.

#### The methodology bug this caught

The first run issued forecasts once a day at 00:00 UTC. Persistence then showed a violent
spike at 7–12 h — MAE ~100–125, bias **+86 to +103** — in all four winters. That was not a
property of persistence. Issuing at a fixed hour means "7–12 h ahead" always lands at the
same time of day, so the lead-time buckets were confounded with diurnal phase: every
forecast carried a pre-dawn peak into the following afternoon.

Issuing every 6 h de-confounds it and the spike disappears (91.8, and monotone from there).
**Any future evaluation must vary the issue hour**, or it measures the diurnal cycle and
calls it forecast skill.

#### Leakage rules enforced in code

A forecast issued at `T` reads only observations at or before `T`; persistence refuses an
anchor older than 6 h rather than passing a stale number off as current; climatology is
fitted strictly before the scoring window; and **Nov 2023 + Nov 2024 never enter any
training statistic**. Climatology uses the median, not the mean — the distribution is
heavily right-skewed and a few 800+ hours would bias the baseline high everywhere.

Climatology's bias flips sign by year (−85 in 2021, +28 in 2022, −57 in 2023 and 2024),
which says plainly that 2022 was cleaner than the historical November median and the other
three were dirtier.

### lgbm-v1 — ✅ fit, and it adds skill from 7 h out

**Experiment A, perfect prognosis.** Same walk-forward folds, same issue stride, same
holdout, same `forecasts` table, same scoring function as the baselines — all imported, not
re-implemented, because each is a place a model comparison can be quietly rigged.

```bash
python train_lgbm.py            # 4 folds, writes model_version='lgbm-v1'
```

Pooled MAE across Nov 2021–2024, PM2.5 µg/m³:

| Horizon | Persistence | Climatology | **LGBM** | Winner | Margin vs best baseline |
|---|---:|---:|---:|---|---:|
| 1–6 h | **49.7** | 85.6 | 69.8 | persistence | −40% (loses) |
| 7–12 h | 91.8 | 85.8 | **76.6** | LGBM | +10.7% |
| 13–24 h | 94.3 | 86.3 | **76.8** | LGBM | +11.0% |
| 25–48 h | 108.2 | 87.0 | **80.3** | LGBM | +7.7% |
| 49–72 h | 118.3 | 85.6 | **84.5** | LGBM | +1.3% |

Trained on 68k–222k samples per fold (the training set grows as the walk-forward window
advances), 24 features.

#### Read this honestly — the pooled table hides a serious instability

Per-year, lgbm-v1 against climatology (MAE µg/m³, lower is better):

| November | 1–6 h | 7–12 h | 13–24 h | 25–48 h | 49–72 h | verdict |
|---|---:|---:|---:|---:|---:|---|
| **2021** LGBM | 62.9 | 63.9 | 66.6 | 71.3 | 75.0 | **wins everywhere** |
| 2021 clim | 87.7 | 88.0 | 89.2 | 90.9 | 93.7 | |
| **2022** LGBM | 66.9 | 75.7 | 76.9 | 77.6 | 78.0 | wins 1–6 h only |
| 2022 clim | 71.2 | 71.3 | 71.8 | 72.9 | 68.5 | |
| **2023** LGBM | 59.8 | 71.6 | 72.8 | 79.5 | 86.7 | **wins everywhere** |
| 2023 clim | 93.7 | 94.6 | 95.4 | 95.6 | 90.8 | |
| **2024** LGBM | 90.1 | 97.3 | 92.6 | 94.0 | 98.9 | **loses everywhere** |
| 2024 clim | 88.5 | 87.9 | 87.4 | 86.9 | 86.2 | |

**The pooled +8–11% was carried by 2021 and 2023.** In 2022 the model wins only at short
lead; in **2024 — the most recent and most severe November — it loses at every horizon**.
Two clean wins, one mixed, one clean loss is not a validated forecasting system. It is a
model whose advantage does not generalise across years yet.

The correct claim today is therefore *"LightGBM shows skill over climatology in 2 of 4
held-out Novembers"*, not *"LightGBM improves 72-hour forecasting by 8–11%"*. Anyone
quoting the pooled number without this table is overstating what we have.

Persistence still owns 1–6 h in every year, which is expected and is not a defect — the
operational answer is to serve persistence at short lead and the model past the crossover.

#### What the model actually used (gain)

```
pm25_mean24                1,003,375     24-hour mean of observed PM2.5
doy_cos / doy_sin          1,089,015     season
ventilation_coefficient      203,304     <- the top meteorological feature
pm25_lag0                    175,368
hour                         164,416
surface_pressure             157,645
temperature_2m               147,910
```

Two things worth noting. The model leans hardest on pollution autocorrelation and season —
i.e. it partly rediscovered persistence and climatology, which is why it beats them but does
not annihilate them. And **the ventilation coefficient is the highest-gain meteorological
feature**, ahead of boundary-layer height and wind speed taken separately — the same
quantity the live engine already runs on.

#### Kept deliberately out of v1

No plume influence, no aerosol→PBLH feedback correction. Those are the next ablation step
and are only interpretable against a v1 that did without them.

#### Not available, and why

| Asked for | Status |
|---|---|
| PM10 / O3 / NO2 lags | The historical series is a PM2.5-only NCR composite. Empty columns would be worse than none. |
| Inversion strength, lapse rate | ERA5 archive serves no pressure levels — NULL for every training hour. |
| Station / grid identity | One PM2.5 series, NCR-wide. A constant column is not a feature. |

### Experiment B — ✅ the weather-forecast penalty is small

Same fixed lgbm-v1, driven by **real past NWP forecasts** instead of ERA5 at valid time.
The model is not retrained between variants — retraining would confound the question with a
second change.

```bash
python experiment_b.py
```

| Horizon | A: ERA5 (perfect) | B1: NWP + ERA5 PBL | B2: NWP + clim PBL | cost |
|---|---:|---:|---:|---:|
| 1–6 h | 90.1 | 90.5 | 85.5 | −4.5…+0.5 |
| 7–12 h | 97.3 | 98.0 | 93.8 | −3.5…+0.7 |
| 13–24 h | 92.6 | 95.2 | 93.0 | +0.4…+2.6 |
| 25–48 h | 94.0 | 96.2 | 93.1 | −0.9…+2.2 |
| 49–72 h | 98.9 | 101.2 | 96.2 | −2.7…+2.3 |

**The headline: replacing perfect weather with a real forecast costs roughly 0–3 MAE.**
Set that against the model's ±20 MAE swing between years and the conclusion is blunt —

> **Weather-forecast error is not our bottleneck. Year-to-year generalisation is.**

That redirects the research: the coupling layer should be aimed at why 2024 fails, not at
squeezing the meteorological inputs.

#### Why this is an interval and not a number

The previous-runs endpoint **does not serve forecast boundary-layer height**. It accepts
`boundary_layer_height_previous_day1` and answers HTTP 200 with every value null, while the
current-run PBLH in the same response is complete — verified 0/168 against 168/168 over
2024-11-01…07 for days 1 and 2. PBLH is half of the ventilation coefficient and VC is the
model's strongest meteorological feature, so a clean swap is impossible. Hence the bracket:
**B1** keeps ERA5 PBLH (optimistic — "if we forecast PBLH perfectly"), **B2** substitutes the
climatological median PBLH for that month and hour (pessimistic — "if we had no PBLH skill
at all"). The truth is between them; quoting either alone would mislead.

That B2 is often *better* than B1 is itself informative: on Nov 2024 the model does better
with a smoothed climatological PBLH than with the real one, which is consistent with it
having over-fitted the VC relationship on calmer years.

#### Scope limit, stated plainly

**Nov 2024 only.** Wind forecasts do not exist in this archive before 2024 — measured over
Nov 1–7 of each year, `temperature_2m_previous_day1` returns 168/168 for 2021–2024 but
`wind_speed_10m_previous_day1` returns **0/168** for every year before 2024. There is no
walk-forward for Experiment B, and it happens to land on the one fold where the model
already loses to climatology.

#### Lead mapping approximation

A forecast issued at `T` for lead `L` is valid at `T+L`; the nearest available past run is
`previous_day⌈L/24⌉`. Those runs are issued at a fixed daily hour, not at our `T`, so the
substituted weather can be up to 24 h staler than our nominal issue time. The error runs one
way — it makes Experiment B pessimistic, especially at 1–24 h — which is the safe direction
for a published number.

### Experiment C — why 2024 fails. It is not the atmosphere.

```bash
python diagnose.py c0    # target integrity
python diagnose.py c1    # 2023 (wins) vs 2024 (loses), paired
python diagnose.py c2    # our own modelling choices as suspects
```

#### C0 — the four folds are not the same measurement

| Nov | hours | coverage | monitors (median) | % single-monitor | PM p95 | PM max |
|---|---:|---:|---:|---:|---:|---:|
| 2021 | 651 | 90% | **32** | 4% | 411 | 864 |
| 2022 | 502 | 70% | 1 | 100% | 348 | 532 |
| 2023 | 522 | 72% | 1 | 100% | 412 | 599 |
| 2024 | 710 | 99% | 1 | 100% | 541 | 1000 |

By season the switch is unmistakable — median monitors 15 → 21 → **1, 1, 1**, exactly at
OpenAQ's Nov 2022 gap, after which only the US Embassy monitor spans the record.

**This reframes the whole result.** Nov 2021 — the model's most convincing win — is scored
against a 32-station airshed average, a smoother and easier target that no longer exists.
The only mutually comparable folds are 2022, 2023 and 2024, all single-monitor. On that
like-for-like set the record is **one clean win (2023), one mixed (2022, short lead only),
one clean loss (2024)**. Not "2 of 4". *One of three.*

#### C1 — the meteorology barely differs between 2023 and 2024

| Nov | VC p50 | VC p90 | % below 466 | wind p50 | PBLH p50 |
|---|---:|---:|---:|---:|---:|
| 2023 | 100 | 2767 | 71% | 1.90 | 50 |
| 2024 | 144 | 3078 | 69% | 1.39 | 105 |

Near-identical dispersion regimes, opposite model verdicts. **"2024 was a different
atmospheric regime" is falsified.** What differs is the target's right tail: 2024 carries
three times as many hours above 400 µg/m³ (756 vs 252) and peaks at 1000 vs 599.

Bias tells the rest:

| Nov | model | MAE | bias | \|bias\|/MAE |
|---|---|---:|---:|---:|
| 2023 | lgbm-v1 | 78.1 | −30.4 | 39% |
| 2024 | lgbm-v1 | 95.3 | **−65.1** | **68%** |

In 2024 two-thirds of the model's error is systematic **under**-forecast, and it is entirely
concentrated in the 400+ bin (MAE 394.5, bias −394.5 — every single forecast low). And
**47% of the year's total error comes from three days: 17–19 Nov 2024**, the same episode
in the dataset table above.

#### C2 — the cause is our loss function, not the physics

| Nov | training max | test max | **model's max prediction** | hours above the ceiling |
|---|---:|---:|---:|---:|
| 2023 | 926 | 599 | 413 | 4% |
| 2024 | 926 | 1000 | **341** | **17%** |

The model never predicts above 341 µg/m³ although its training data reached 926. That is not
extrapolation failure — it is the **L1 objective**, which is minimised by the conditional
*median* and therefore compresses a right-skewed target toward its middle. p99 observed 811
against p99 predicted 293. Seventeen percent of Nov 2024 was unreachable by construction.

(The 1000 µg/m³ peak was checked for a source cap: exactly one hour hits 1000.0 and only
three hours in the entire record exceed 900, so it is a real peak, not a clipped instrument.)

#### What this changes

The failure is **our target and our objective**, not missing atmospheric physics. Building a
feedback-coupling layer now would be fixing the wrong thing — and Experiment B already showed
the meteorological inputs are nearly free (0–3 MAE). The treatment order inverts:

1. **Target** — start live multi-station capture; replace the single-monitor series.
2. **Objective** — log or quantile target, directly aimed at the compression C2 measured.
3. **Physics** — feedback correction and plume, only after 1 and 2, and only if a failure
   mode survives them.

It also vindicates Experiment D. The model's weakness is peak *magnitude*, not episode
*onset* — and AREE's actual claim is lead time, not concentration. Knowing an episode is
coming does not require predicting 812 rather than 341.

### Experiment D — warning skill. The metric that inverts the ranking.

```bash
python warning_skill.py
```

Every definition frozen before the run. **Event** = observed PM2.5 ≥ 250 µg/m³ (the CPCB
*Severe* breakpoint, not a number chosen by eye) sustained ≥ 6 h — the same run-length rule
the live ventilation engine applies. **Warning** = the model's own forecast crosses the same
threshold for the same duration inside its 72 h horizon. Events < 12 h apart are merged.
13 severe episodes across Nov 2022–2024.

| model | POD | **COLD POD** | cold lead | lead med | FA | alert burden |
|---|---:|---:|---:|---:|---:|---:|
| persistence | 77% | **0/13** | — | 38 h | 51 | 30% |
| climatology | 0% | **0/13** | — | — | 0 | 0% |
| lgbm-v1 | 62% | 5/13 (38%) | 44 h | 64 h | 64 | 41% |
| lgbm-l2 | 69% | 6/13 (46%) | 56 h | 67 h | 72 | 46% |
| **lgbm-q90** | **92%** | **9/13 (69%)** | **68 h** | 68 h | 128 | 87% |

**COLD POD** counts only events warned while concentrations were still *below* threshold —
i.e. the model called an episode that had not started. It is the number an authority can act
on, and it separates skill from bookkeeping.

#### Two findings that change the project's conclusions

**1. Climatology has zero warning skill.** Its ceiling is 247 µg/m³, below the 250 threshold,
so it can never warn — POD 0/13. The baseline that *won on MAE* is operationally worthless.
Judged on MAE, lgbm-v1 "lost" to climatology in 2024; judged on warnings, climatology does
not compete at all. **The choice of metric completely inverts the ranking**, which is the
strongest argument in this repository for scoring in operational units.

**2. Persistence's 77% POD is entirely bookkeeping — COLD POD 0/13.** It never once
anticipated an episode from clean air; it only ever said "still severe" while one was already
running. The apparent hit rate is an artifact of episodes following episodes.

So the genuine anticipation skill belongs only to the learned models, and q90 has by far the
most: **69% of severe episodes called before they began, with a median 68 h of lead.**

#### The cost, stated plainly

q90 is in a warning state **87% of issue times**. A system that is nearly always warning is
not warning. Measured as cold hits per unit of alert burden, lgbm-l2 (46%/46%) is the most
efficient, q90 (69%/87%) the most sensitive, lgbm-v1 (38%/41%) the most conservative.

That is not a defect to fix — it is the same precaution/false-alarm trade-off the ventilation
threshold already exposes as `balanced` / `precautionary` operating points. **The forecast
objective is another operating point on that curve**, and the choice belongs to the
authority, not to us.

#### The microscope — 16–21 Nov 2024, peak 1000 µg/m³

| model | warning |
|---|---|
| persistence | 68 h before onset (but from already-severe air) |
| climatology | **no warning** |
| lgbm-v1 | 62 h before onset |
| lgbm-l2 | 26 h before onset |
| lgbm-q90 | 68 h before onset |

Nothing was tuned on this episode; it is reported, never selected on. Note the earlier C1/C2
analysis showed lgbm-v1 under-forecast this episode's *magnitude* badly (bias −318 µg/m³) —
and yet it still warned 62 h ahead. **Magnitude error and warning value are different
things**, which is precisely why AREE's claim is lead time rather than concentration.

### The multi-station target — construction before retraining

```bash
python capture.py loop      # 79 stations/hour, running now
python target.py build      # derive ncr_target from captured station rows
python target.py report     # target quality over time
python target.py spread     # how wrong is ONE monitor as a proxy for NCR?
```

**Three layers, never blurred.** `station_readings` holds what each instrument measured;
`ncr_target` holds the airshed estimate derived from it; the legacy single-monitor series
stays frozen and untouched as the historical benchmark every result so far was measured
against. A composite can always be rebuilt from stations — stations can never be recovered
from a composite, which is why the capture stores the network and the aggregate is derived.

An hour qualifies as a modelling target only if it clears **both** ≥20 valid stations **and**
≥6 of 16 grid cells over the NCR box. Forty monitors clustered in central Delhi describe the
airshed worse than fifteen spread across it, so spatial coverage is part of the target
definition rather than a footnote.

First captured hour: **79 stations, 13/16 cells, median 52 µg/m³, IQR 23, range 13–153.**
For contrast, the historical folds it replaces rest on a median of **one** monitor.

#### The experiment the capture makes possible

C0 raised a question it could not answer: the historical target *is* one monitor, so its
error against the airshed was unmeasurable. With the live network we can finally measure it —
treat each station as if it were the sole monitor and compare it with the network median.

| first hour | value |
|---|---:|
| median \|station − network\| | 12.0 µg/m³ |
| p90 | 36.0 µg/m³ |
| max | 101.0 µg/m³ |
| median relative error | 23% |
| **CPCB band disagreement** | **41% of station-hours** |

That last row is the one that matters: a single monitor reports a *different CPCB severity
band* than the network in 41% of station-hours — and the severity band is what reaches a
decision.

> ⚠️ **One hour, in September, and September is not November.** Concentrations now are far
> lower, and the CPCB bands are narrow at the clean end (30/60/90) and wide at the dirty end
> (250+), so band disagreement is mechanically easier to trigger today than during an
> episode. Winter also concentrates pollution locally under a shallow inversion in ways
> September does not. **This bounds the legacy target only once the capture has run through a
> winter.** Until then it is machinery, not evidence — and the tool prints that caveat itself
> rather than relying on anyone remembering it.

If it holds at winter concentrations, it implies a **floor on the MAE any model could have
achieved** against the legacy target, no matter how good the physics — which would reframe
every score in this document.

### Historical availability audit — why there is no shortcut

```bash
python audit_history.py
```

With a working OpenAQ key the probe looks encouraging: 138 NCR locations, 199 PM2.5 sensors,
location spans reaching back to 2016, 92 reporting in the last week. That raised a real
question — if multi-station winter history exists, C0 could be fixed *retroactively* instead
of waiting months for the capture to reach a winter.

It does not exist. Audited at sensor level across all 157 PM2.5 sensors at 95 active
locations:

| November | locations with any spanning sensor |
|---|---:|
| 2022 | **1** |
| 2023 | **1** |
| 2024 | **3** |

The three covering Nov 2024 are the US Embassy monitor, a rooftop sensor and a NASA
calibration unit — which *is* the single-monitor situation, not a fix for it.

**The reason is sharper than "OpenAQ has a gap".** Start dates of the sensors reporting today:

```
2016:  2      2019: 10      2024:  2
2017:  1      2020:  2      2025: 44   ############################################
2018: 19      2022:  1      2026: 12   ############
```

Forty-four began in 2025 and twelve in 2026. **The Indian feed was re-established with new
sensor ids after our evaluation winters**, so the current network cannot reconstruct the
historical NCR target at all. Waiting for winter is not a scheduling preference; it is the
only available path.

#### The methodological trap this audit walked into, twice

Worth keeping, because it nearly produced two wrong answers:

1. The first run selected stations by **location** metadata and reported a uniform **0/720**
   across every station and year — the exact signature of a broken query. It was not broken:
   the stations picked were retired, one last reporting in **2018**.
2. Re-checking with a genuinely live location *still* returned 0 for Nov 2024. The reason
   settled it — that location's current pm25 sensor has `datetimeFirst` **2025-02-18**. It did
   not exist during the fold. A location's dates span every sensor ever sited there.

Both directions are verified rather than assumed: the query returns 167 rows for the last
14 days and 1000 for the last 60, and sensors that *do* claim November coverage return
990 / 1000 / 708 / 719 / 707 hours. The negative result is real, and so is the positive one.

> **The principle, generalised:** a zero-result dataset is not evidence until the query and
> the data path have themselves been validated. This is the same failure family as OpenAQ's
> ignored `bbox`, CAQM's timestamp-free payload, the ERA5 archive's null pressure levels, the
> silent 4-of-9 grid backfill, and `capture.py` reporting 79 stations while writing 0 rows.

### Next, in order

1. **Fix the target.** Live multi-station capture from the working CAQM/CPCB path, plus a
   valid OpenAQ key. Three of four folds rest on one monitor; no modelling fixes that.
2. **Fix the objective.** Log or quantile target against the compression C2 measured
   (ceiling 341 vs peaks of 1000). Cheap, and aimed at the demonstrated failure.
3. **Accumulate.** The target machinery is built; it now needs hours. Re-run
   `target.py spread` once the capture has winter data — that is when it becomes evidence.
4. **Retrain on the multi-station target** under the identical frozen protocol, and compare
   against the legacy benchmark rather than replacing it.
5. **Physics last.** Feedback correction and plume only if a failure mode survives 1–4.

---

## 23. Repository layout

```
AREE/
├── backend/
│   ├── app.py                     Pathway streaming pipeline (Linux/macOS)
│   ├── fallback_engine.py         direct mode — same state machine, no Pathway
│   ├── config.py                  thresholds, stations, CPCB bands, freshness bands
│   ├── tests_contract.py          direct-vs-streaming key-shape contract check
│   ├── station_loader.py          pan-India station discovery (WAQI)
│   ├── report_generator.py        municipal PDF report (ReportLab)
│   ├── config/
│   │   └── ventilation_operating_point.json   ← the calibrated threshold + its skill
│   ├── forecast/
│   │   └── ventilation.py         VC series, collapse detection, intervention window
│   ├── ingestion/
│   │   ├── weather_stream.py      Open-Meteo forecast + ERA5 archive
│   │   ├── caqm_stream.py         CAQM roster + timestamped readings
│   │   ├── cpcb_stream.py         CPCB via data.gov.in — µg/m³ concentrations
│   │   ├── ncr_observations.py    NCR PM2.5 composite with provenance
│   │   ├── aqi_stream.py          WAQI polling  ⚠️ needs fixing
│   │   ├── firms_stream.py        per-station satellite fire intelligence
│   │   ├── feed_time.py           observed_at / received_at / issued_at semantics
│   │   └── micro_nodes.py         empty placeholder — not implemented
│   ├── streaming/
│   │   ├── predictive_engine.py   the conjunction, priority bands, case builder
│   │   ├── state_machine.py       GRAP stages + hysteresis + persistence
│   │   └── risk_engine.py         causal attribution + transport vector model
│   ├── rag/                       DocumentStore advisories + Gemini narrative
│   ├── policies/                  GRAP schedule, HSPCB winter plan, AQI methodology
│   └── api/                       FastAPI: main, engine bridge, schemas, 14 routers
│
├── frontend/                      Next.js 16 · React 19 · Tailwind 4 · Recharts · Leaflet
├── research/ps26082/              where the 465.9 m²/s operating point was derived
├── docs/                          architecture / pipeline / dashboard images
└── Dockerfile · docker-compose.yml · .env
```

---

## 24. Running it

Keys in `.env` at the repo root. **Open-Meteo and CAQM need no key.**

```
WAQI_TOKEN=…            aqicn.org/data-platform/token
FIRMS_API_KEY=…         firms.modaps.eosdis.nasa.gov/api
GEMINI_API_KEY=…        aistudio.google.com/apikey
DATA_GOV_API_KEY=…      data.gov.in   (CPCB concentrations)
OPENAQ_API_KEY=…        openaq.org    (NCR composite)
```

### Local — works on Windows, no Pathway needed

```bash
python -m venv venv
venv\Scripts\activate                 # Linux/macOS: source venv/bin/activate
pip install -r backend/requirements.txt
python -m uvicorn backend.api.main:api --port 8077
```

```bash
cd frontend
npm install
npx next dev --port 3077
```

→ **http://localhost:3077**. The frontend proxies `/api` to the backend through
`next.config.ts`, so the API is same-origin and no `NEXT_PUBLIC_API_URL` is needed.
Set `AREE_API_ORIGIN` only if the backend is not on `127.0.0.1:8102`.

The engine reports `mode: "direct"`; the RAG panel reports itself unavailable rather
than faking output, and the Gemini explainer reports `ready: false` — both are optional
extras, and both say so instead of failing.

### Authority (who may write)

Two endpoints write, and both require a verified access token:

| Endpoint | Capability | Held by |
|---|---|---|
| `POST /api/cases/{id}/decision` | `case:decide` | `authority` |
| `POST /api/policy/upload` | `policy:write` | `admin` |

No role holds both. An administrator curating the policy corpus should not also be
able to approve escalations against it.

The acting officer is taken from the token's subject. `actor` in a decision body is
accepted for backwards compatibility and **ignored**, and `actor_verified` is set by
the server — a client has no path to either.

```bash
# 1. hash a password (never store or transmit a plaintext one)
python -c "from backend.api.auth import hash_password; print(hash_password('CHANGE-ME'))"

# 2. configure operators:  username:role:hash;username:role:hash
export AREE_OPERATORS='ncr.officer:authority:pbkdf2_sha256$...;corpus.admin:admin:pbkdf2_sha256$...'
export AREE_JWT_SECRET='a-long-random-string'

# 3. sign in
curl -sX POST localhost:8077/api/auth/token \
     -H 'Content-Type: application/json' \
     -d '{"username":"ncr.officer","password":"CHANGE-ME"}'
```

**Leaving these unset is safe but not production.** `AREE_JWT_SECRET` unset yields a
random per-process key, so tokens stop working across a restart. `AREE_OPERATORS`
unset seeds two demo operators with **randomly generated** passwords printed once to
the startup log — random rather than default, because a shipped default password is
a backdoor that travels with the image. `GET /api/auth/config` reports
`mode: "demo-credentials"` in that state, and the approval panel repeats it, so demo
authority is never presented as real.

This is a **local HS256 issuer, not an OIDC deployment**, and does not claim to be:
there is no external identity provider in this project and nothing here has been
verified against one. Claims are OIDC-shaped (`iss`/`aud`/`sub`/`exp`/`iat`/`jti`)
and every route depends on a `Principal` from a `TokenVerifier`, so swapping in an
RS256/JWKS verifier against a real IdP is a change to `backend/api/auth.py` alone.

### Tests

```bash
pip install -r backend/requirements.txt -r backend/requirements-dev.txt
python -m pytest -m "not network"        # the offline gate — 61 tests, ~8 s
python -m pytest                         # adds 4 tests needing live feeds
python -m backend.tests_runtime_gate     # the clean-environment chain, readable output
```

**No network and no 148 MB store are required.** The suite runs in replay against
a committed 1 MB fixture (`backend/tests/fixtures/aree_test.db`) that reproduces
the golden baseline exactly. Tests needing live upstream feeds are marked
`network` and excluded from the offline gate rather than silently skipped.

| Suite | Protects |
|---|---|
| `test_golden.py` | the 3,274-field baseline across three replay moments, and its determinism |
| `test_http_chain.py` | install → import → start → HTTP → forecast → outlook → case/auth → PDF |
| `test_authority.py` | tokens, expiry, audience, separation of duties, identity injection |
| `test_claims.py` | no manufactured values; computed capability still present |
| `test_route_table.py` | each endpoint is served by the intended handler |
| `test_legacy_suites.py` | GRAP table agreement, engine shape contract, temporal integrity |

Every HTTP assertion crosses a real TCP socket — no `TestClient`, no ASGI
shortcut. A decorator once landed on the wrong function and left the primary
endpoint answering 422 while every direct-call test stayed green.

The golden baseline is **protected**: regenerate it only deliberately, and review
the diff. Rebuild the fixture store with
`python -m backend.tests.build_fixture_db`.

CI (`.github/workflows/ci.yml`) installs the runtime set into a clean virtualenv,
asserts the optional stacks are absent, checks the model filenames still carry the
`__YYYYMMDD` the leakage guard reads, then runs the suite and the runtime gate.

### Dependency sets

`backend/requirements.txt` is the **runtime** set and nothing else: what the deployed
application needs to serve the API, forecast, record a case decision and generate a
report. It is verified — a clean virtualenv with only this file installed passes the
full flow and all three test suites.

| File | Contains | Status |
|---|---|---|
| `requirements.txt` | runtime — FastAPI, uvicorn, LightGBM, NumPy, requests, dotenv, ReportLab | **verified** in a clean environment |
| `requirements-llm.txt` | Gemini narrative text | optional; absence is reported, not fatal |
| `requirements-research.txt` | backfill / offline analysis | pyarrow verified; the rest unpinned and unverified |
| `requirements-streaming.txt` | the Pathway engine | **unverified** — not installed in any working environment |
| `requirements-dev.txt` | test / lint tooling | currently empty, deliberately |

Extras compose with the runtime set:

```bash
pip install -r backend/requirements.txt -r backend/requirements-llm.txt
```

### Full streaming engine · Docker

Pathway ships Linux/macOS wheels only, and its pins have **not** been resolved against
the current environment — expect dependency-resolution work.

```bash
pip install -r backend/requirements.txt -r backend/requirements-streaming.txt
python -m uvicorn backend.api.main:api --reload --port 8000
```

```bash
docker compose up --build     # backend :8000/docs · frontend :3000
```

Contract check between the two engine modes:

```bash
python -m backend.tests_contract
```

---

## 25. API

Interactive docs at `/docs`. Everything under `/api`.

**Ventilation — the PS 26082 layer, no engine dependency:**

| Endpoint | Returns |
|---|---|
| `GET /api/ventilation/forecast` | 72 h VC series, sustained collapse, intervention window |
| `GET /api/ventilation/current` | observed VC over recent hours — analysis values only |
| `GET /api/ventilation/observed` | live NCR PM2.5 composite with provenance |
| `GET /api/ventilation/stations` | every reporting station behind the composite |
| `GET /api/ventilation/assessment` | the conjunction → assessment + case |
| `GET /api/ventilation/operating-point` | the threshold, its origin, and what it costs |

Params: `lat`/`lon` (default NCR centroid 28.63, 77.22), `hours` (6–168), `mode`
(`balanced` · `precautionary` · `conservative`), and on `/assessment` an optional `pm25=`
override — a supplied value is flagged `input_source: "manual"`, never presented as a
measurement.

**Engine-backed:** `/api/health` · `/api/system/status` · `/api/system/config` ·
`/api/dashboard` · `/api/stations[/{station}]` · `/api/aqi/{station}[/history]` ·
`/api/grap/{station}` · `/api/risk/{station}` · `/api/forecast/{station}[/health]` ·
`/api/advisory/{station}` · `/api/ai/{station}` · `/api/carbon` · `/api/escalations` ·
`/api/policy[/upload]` · `/api/reports/{station}[/pdf]` · `WS /ws/live`

**Errors** are structured JSON, never HTML: `422` invalid mode / bad payload · `424` ground
observations or upstream feed unavailable · `425` station known but no window closed yet ·
`503` engine not running, or the met feed returned nothing.

**Freshness.** CPCB and WAQI publish hourly, so a healthy feed is routinely 40–100 min old:
`current` 0–90 min, `aging` 90–120 min, `stale` > 120 min. Panels show **measured data age**,
never the poll interval. `generated_at` is the honest answer to "when was this computed".

---

## 26. Non-negotiable rules for the team

1. **AI explains; AI does not decide.**
2. **Never quote 23 ms near the word "forecasting."** It is decision/application-layer
   latency.
3. **Never claim WRF-Chem or two-way chemistry–meteorology coupling.** We have
   forecast-meteorology → ventilation → persistence risk.
4. **Never claim the ML model.** It is not built.
5. **Never say WAQI is fully live.** Integration exists; real-time retrieval needs fixing.
6. **We did not invent the ventilation coefficient.** It is a standard air-quality
   meteorology quantity. The operational chain built on it is ours.
7. **Hold out Nov 2023 and Nov 2024.** Every public number comes from episodes the fit never
   saw.
8. **Never blur observed and predicted.** Forecast rows carry `is_forecast`; analysis and
   forecast endpoints stay separate.
9. **Never score on reanalysis and call it forecast skill.** Use the previous-runs endpoint,
   at the lead time we would actually have had.
10. **Degrade visibly, never plausibly.** An unavailable subsystem says so instead of
    returning a value that looks like a measurement.

---

## Acknowledgments

**[Open-Meteo](https://open-meteo.com/)** · **[CAQM](https://caqm.nic.in/)** ·
**[CPCB](https://cpcb.nic.in/)** · **[data.gov.in](https://data.gov.in/)** ·
**[OpenAQ](https://openaq.org/)** · **[WAQI](https://aqicn.org/)** ·
**[NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)** · **[Pathway](https://pathway.com/)** ·
**[Google Gemini](https://ai.google.dev/)** · **[CodeCarbon](https://codecarbon.io/)**

Built for **SIH PS 26082** — Air Pollution–Weather Coupled Forecasting · Ministry of Earth
Sciences / NCMRWF · Disaster Management. Team **Devengers**.

<p align="center"><sub>The system proposes. The authority disposes. Every number carries its provenance.</sub></p>
