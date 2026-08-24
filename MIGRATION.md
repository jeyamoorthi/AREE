# AREE — Streamlit → Next.js Migration Map

This document records what moved where during the frontend migration. The
Python intelligence engine (Pathway, ingestion, risk, GRAP, RAG, Gemini,
reports) was **not rewritten** — it was relocated into `backend/` and put
behind a FastAPI layer that only reads its state.

## Architecture

```
Pathway engine (backend/app.py)   ← unchanged logic
        │  writes in-process state dicts
        │  latest_state / carbon_state / escalation_log / _rag_state
        ▼
FastAPI (backend/api)             ← reads state, serialises, no business logic
        │  REST + WebSocket
        ▼
Next.js (frontend)                ← UI, charts, maps, forms
```

The FastAPI process **imports** `app`, so the Pathway pipeline runs inside the
API process and the API reads the exact same in-memory objects the Streamlit
dashboard read. There is no second copy of the engine and no mock data.

## Feature migration map

| Streamlit section | Existing Python source | FastAPI endpoint | Next.js component |
|---|---|---|---|
| Header / branding | — | — | `Header.tsx` |
| Live status / control bar | `app.latest_state` | `GET /api/system/status` | `StatusStrip.tsx` |
| §1 Monitoring Control | `station_loader.get_all_stations` | `GET /api/stations` | `StationSelector.tsx` |
| National Overview + map | `app.latest_state` | `GET /api/dashboard`, `GET /api/stations` | `app/page.tsx`, `national/NationalPanels.tsx`, `StationMap.tsx` |
| §1 AQI panel | `ingestion.aqi_stream` → `latest_state` | `GET /api/aqi/{station}` | `station/AQIHero.tsx`, `AQICard.tsx` |
| §1 GRAP panel | `streaming.state_machine.GRAPStateMachine` | `GET /api/grap/{station}` | `GRAPCard.LiveRegulatoryState`, `GRAPCard.GRAPTimeline` |
| §2 Data Source Transparency | `aqi_stream._debug_data` | `GET /api/aqi/{station}` | `AQICard.DataSourceTransparency` |
| §3 Official Regulatory Context | `config` + `latest_state` | `GET /api/system/config` | `GRAPCard.RegulatoryContext` |
| §4 Persistence Engine | `state_machine.PersistenceTracker` | `GET /api/grap/{station}` | `PersistenceCard.tsx` |
| §5 Satellite Transport | `ingestion.firms_stream`, `streaming.risk_engine` | `GET /api/risk/{station}` | `SatelliteCard.tsx` |
| §6 Data Methodology | `config` | `GET /api/system/config` | `AdvisoryCard.MethodologyCard` |
| §7 Regulatory Advisory | `rag.advisory_engine.generate_grounded_advisory` | `GET /api/advisory/{station}` | `AdvisoryCard.tsx` |
| §7 Decision Trace | `config` + `latest_state` | `GET /api/advisory/{station}` | `AdvisoryCard.DecisionTraceCard` |
| §8 Policy Retrieval | `rag.advisory_engine.retrieve_policy_context` | `GET /api/advisory/{station}` | `AdvisoryCard.PolicyRetrievalCard` |
| §9 Escalation History | `app.escalation_log` | `GET /api/escalations` | `EscalationHistory.tsx` |
| §10 Carbon Intensity | `app.carbon_state` (CodeCarbon) | `GET /api/carbon` | `CarbonCard.tsx` |
| §11 Predictive Intelligence | `app.compute_short_term_forecast` | `GET /api/forecast/{station}` | `ForecastCard.tsx`, `AQITrendChart.tsx` |
| §12 ERI | `app` observer ERI block | `GET /api/risk/{station}` | `station/RiskIntelligence.RiskExplain`, `RiskChart.tsx` |
| §13 Ward Ranking | `app.latest_state` | `GET /api/dashboard` | `RankingTable.tsx` |
| §14 AI Risk Interpretation | `rag.llm_engine.generate_llm_analysis` | `GET /api/ai/{station}` | `AIAnalysis.tsx` |
| §15 Public Health Forecast | `app` VPPE block, `config.VULNERABILITY_MULTIPLIERS` | `GET /api/forecast/{station}/health` | `HealthForecast.tsx` |
| §16 Policy Console | `rag.advisory_engine._scan_policy_files`, `_rag_state` | `GET /api/policy` | `PolicyConsole.tsx` |
| §16 Policy upload | `st.file_uploader` → `POLICY_DIR` | `POST /api/policy/upload` | `PolicyConsole.tsx` |
| §16 PDF report | `report_generator.generate_escalation_report` | `GET /api/reports/{station}/pdf` | `ReportDownload.tsx` |
| `st.map(...)` | `config.STATIONS` lat/lon | `GET /api/stations` | `StationMap.tsx` (React Leaflet, freshness-aware markers) |
| `st_autorefresh(5000)` | — | polling + `WS /ws/live` | `usePolling`, `useLiveChannel` |

## UI redesign (Aug 2026)

The migration table above records the 1:1 Streamlit port. The interface was
subsequently reorganised around the operator's questions rather than the
Streamlit section numbering — three destinations (National Overview, Command
Center, Reports), a shared live-data provider, a freshness-aware national map,
and progressive disclosure for engine internals. No endpoint, schema or
engine behaviour changed; component names in the table point at the surfaces
that now render each feature.

## What changed in Python

Only three kinds of change were made — no logic was altered:

1. **Relocation.** `app.py`, `config.py`, `station_loader.py`,
   `report_generator.py`, `requirements.txt`, `ingestion/`, `streaming/`,
   `rag/`, `policies/` moved into `backend/`. Every existing flat import
   (`from config import ...`) still works because `backend/` is put on
   `sys.path` by `backend/api/engine.py`.
2. **`.env` resolution.** `config.py`, `ingestion/aqi_stream.py` and
   `ingestion/fire_stream.py` now resolve the project-root `.env` explicitly,
   so the engine works regardless of the process working directory. Keys are
   still read from the environment and never hardcoded.
3. **New API package.** `backend/api/` was added. It reads engine state and
   serialises it; it computes nothing the engine does not already compute.

During the migration `streamlit_app.py` gained only a `sys.path` line so it kept
working unchanged; it was removed in Phase 20 once Next.js was verified.

## Engine defects fixed during migration

Three pre-existing faults were found while verifying against the live engine.
All three were silent — the system degraded without saying so.

**1. Gemini analysis never ran.** Two independent causes:

- `gemini-2.5-flash-lite` is retired for new API keys; the API answers
  `404 ... no longer available to new users`. Now `GEMINI_MODEL`, defaulting to
  `gemini-3.5-flash-lite`.
- `MAX_TOKENS = 300` truncated the structured JSON reply mid-object, so
  `json.loads` failed and *every* station fell back even when the call
  succeeded. Now `GEMINI_MAX_TOKENS`, defaulting to 1024.

The failure reason is now recorded (`get_llm_status()`), served on
`GET /api/system/status` (`llm_ready` / `llm_model` / `llm_error`) and on
`GET /api/ai/{station}` (`error`), and shown in the UI — so a future model
retirement is visible instead of silent.

**2. Policy documents were read as plaintext regardless of format.**
`pw.io.fs.read(format="plaintext")` attempted a UTF-8 decode of every file,
flooding the log with parse errors on the PDF, and the PDF's text never reached
the index at all. The reader now uses `format="binary"` with `with_metadata=True`
and a `_parse_policy_document` UDF dispatches by extension:

| Extension | Parser |
|---|---|
| `.txt` / `.md` | UTF-8 decode |
| `.pdf` | `pypdf` |
| `.docx` | `python-docx` |

Unparseable files are recorded per file (`parse_errors`) and surfaced in the
Policy Console rather than silently missing. Chunking also improved: plaintext
mode emitted **one row per line**, so each line was embedded as its own "chunk";
documents are now chunked at 250 words like the preloader.

**3. A dormant station looked like a warming-up one.** `A568246` (NSIT Dwarka)
answers `200 / status: ok` but with `aqi: "-"` — WAQI's marker for "no aggregate
AQI" — and its last reading is months old. It was recorded as a generic error,
logged on every 30s poll, and appeared in the API as merely having no data yet.
Now it gets a distinct `no_aqi` status, is logged once per transition, is
reported as `feed_status` / `feed_error` / `feed_last_reading` on
`GET /api/stations`, and per-station routes answer **424 `feed_unavailable`**
with the reason and last reading date. The UI shows one "FEED UNAVAILABLE"
explanation instead of sixteen empty sections.

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `WAQI_TOKEN` | root `.env` (backend only) | WAQI feed access |
| `FIRMS_API_KEY` | root `.env` (backend only) | NASA FIRMS satellite data |
| `GEMINI_API_KEY` | root `.env` (backend only) | Gemini risk interpretation |
| `GEMINI_MODEL` | optional | Model id, default `gemini-3.5-flash-lite` |
| `GEMINI_MAX_TOKENS` | optional | Reply budget, default `1024` |
| `PORT` | root `.env` / container | Server port |
| `NEXT_PUBLIC_API_URL` | `frontend/.env.local` | Public API base URL |

No engine key is exposed through `NEXT_PUBLIC_*`.

## Phase 19 — comparison checklist

Run both UIs and compare section by section:

```
[ ] Monitoring Control        [ ] Carbon
[ ] Station Selector          [ ] Forecast
[ ] Live Status               [ ] ERI
[ ] AQI                       [ ] Rankings
[ ] GRAP                      [ ] AI Analysis
[ ] Persistence               [ ] Health Forecast
[ ] Satellite                 [ ] Policy Console
[ ] Advisory                  [ ] Map
[ ] Escalation History        [ ] Charts
                              [ ] PDF Reports
```

## Phase 20 — removing Streamlit  ✅ COMPLETE

The Streamlit presentation layer has been removed. What was done:

1. Deleted `streamlit_app.py`.
2. Removed `streamlit` and `streamlit-autorefresh` from `backend/requirements.txt`.
3. Dropped the Streamlit note from the `Dockerfile` comment (`CMD` was already uvicorn).
4. Updated `README.md` so Next.js is documented as the only frontend.
5. Refreshed stale comments in `backend/app.py`, `backend/api/engine.py` and
   `backend/api/serialization.py` that referred to the Streamlit dashboard.

Nothing in the engine changed: Pathway, ingestion, the risk engine, the GRAP
state machine, RAG, Gemini, policy processing, PDF generation, the WebSocket and
the freshness classification are all untouched. Streamlit was only ever a reader
of `latest_state`, never a producer.

A pre-migration snapshot of the old dashboard remains under
`backup_pre_migration/` for reference. It is excluded from the image build and
nothing imports it.
