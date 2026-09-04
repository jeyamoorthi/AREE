# AREE — Architecture Report

**Phase 0 (audit) complete. No files modified.**
Sections for later phases fill in as each gate closes.

**Deployment target decided:** containers primary; Vercel an optional frontend path later.
Directory structure is *not* being changed on that basis until Phase 1/2.

---

# Phase 0 — Repository audit

## Findings register

| ID | Finding | Severity |
|---|---|---|
| 0.1 | Deployment configuration does not exist | 🟠 Medium |
| 0.2 | Model artefacts + obsolete documents/assets pollute the repo | 🟠 Medium |
| 0.3 | Root scripts contain production modules | 🟠 Medium |
| 0.4 | `.gitignore` / secret history clean | 🟢 Pass |
| 0.5 | ~2,300 LOC of unreachable Pathway-path code ships in the image | 🟠 Medium |
| 0.6 | `fallback_engine` docstring claims subsystems it does not use | 🔴 High |
| 0.7 | `requirements.txt` describes a system that does not run | 🔴 High |
| 0.8 | Hot path loads 70k rows per request and discards ~99.8 % | 🔴 High |
| 0.9 | LightGBM inference is 37× slower than necessary | 🟠 Medium |
| 0.10 | No authentication on two state-changing endpoints | 🔴 High |
| 0.11 | No CI, no test runner, tests are `__main__` scripts | 🟠 Medium |

---

## 1. Architecture map

### Runtime topology (as it actually runs, not as documented)

```
┌───────────────────────────────────────────────────────────────┐
│ Next.js 16 dev server :3101                                   │
│   rewrites /api,/ws ──► FastAPI (same-origin, added in Ph.4)  │
└──────────────────────────┬────────────────────────────────────┘
                           │ HTTP
┌──────────────────────────▼────────────────────────────────────┐
│ FastAPI :8102   (backend/api/main.py)                         │
│                                                               │
│  api/engine.py ── tries `import app` (Pathway) ── ALWAYS FAILS│
│                   └─► falls back to fallback_engine.py        │
│                                                               │
│  16 routers ── 2 write endpoints, 0 authenticated             │
│  capture_scheduler ── hourly in-process thread                │
│  ws.py ── 2 s broadcast tick                                  │
└───┬─────────────┬──────────────┬──────────────┬───────────────┘
    │             │              │              │
 SQLite        LightGBM       6 external      Gemini
 147 MB        2 boosters     HTTP APIs       (explain only)
 8 tables      4.4 MB         (see below)
```

### Two engines, one of which never runs

`api/engine.py` attempts `import app` (the Pathway DAG). Pathway is **not installed in
the venv** and ships Linux/macOS wheels only, so the import fails on every tested host
and the system runs `fallback_engine.py` in direct mode. Confirmed by runtime
introspection: `backend/app.py` (750 LOC) is never imported.

### External integrations

| Service | Module | Auth | Role |
|---|---|---|---|
| CAQM `caqm.nic.in` | `ingestion/caqm_stream.py` | none | station roster + AQI (**primary**) |
| CPCB `api.data.gov.in` | `ingestion/cpcb_stream.py` | `DATA_GOV_API_KEY` | µg/m³ concentrations |
| OpenAQ v3 | `ingestion/ncr_observations.py`, `backfill/openaq_history.py` | `OPENAQ_API_KEY` | fallback + hourly bootstrap |
| Open-Meteo | `ingestion/weather_stream.py` | none | forecast + ERA5 archive |
| Open-Meteo previous-runs | `backfill/met_forecast.py` | none | Experiment B only |
| NASA FIRMS | `ingestion/firms_stream.py`, `backfill/fire_history.py` | `FIRMS_API_KEY` | fire detections |
| WAQI | `ingestion/aqi_stream.py`, `station_loader.py` | `WAQI_TOKEN` | **dead in direct mode** |
| Gemini | `rag/llm_engine.py` | `GEMINI_API_KEY` | explanation only, off the demo path |

### Configuration surface

13 backend env vars, 4 frontend. No `.env.example` exists — a new contributor cannot
discover them without reading source.

```
AREE_CAPTURE  AREE_DB_PATH  AREE_ENGINE_MODE  DATA_GOV_API_KEY  FIRMS_API_KEY
FIRMS_MAP_KEY GEMINI_API_KEY GEMINI_MAX_TOKENS GEMINI_MODEL  OPENAQ_API_KEY  WAQI_TOKEN
NEXT_PUBLIC_API_URL  NEXT_PUBLIC_CARTO_KEY  AREE_API_ORIGIN  AREE_DEV_ORIGIN
```

`FIRMS_API_KEY` and `FIRMS_MAP_KEY` are **two names for the same credential**, read by
different modules — a config-drift bug waiting to happen.

---

## 2. Dependency audit

**`requirements.txt` describes a system that does not run.** (Finding 0.7)

| Declared | Installed? | Reachable at runtime? |
|---|---|---|
| `pathway==0.29.1` | ❌ | ❌ never imports |
| `unstructured`, `pdf2image`, `tiktoken`, `docling` | ❌ | ❌ Pathway RAG only |
| `sentence-transformers==2.6.1` | ❌ | ❌ `rag/advisory_engine.py` only |
| `codecarbon==2.3.5` | ❌ | ❌ `app.py` only |
| `python-docx` | ❌ | ❌ |
| `fastapi`, `uvicorn`, `python-multipart`, `pydantic` | ✅ | ✅ |
| `numpy`, `python-dotenv`, `reportlab`, `pypdf` | ✅ | ✅ |
| `google-generativeai==0.3.2` | ✅ (0.8.6) | ✅ — **version mismatch, and deprecated upstream** |

**Used but never declared** — a fresh `pip install -r` produces a broken system:

```
lightgbm   the forecast core
requests   every ingestion module
pyarrow    research_import
scipy      (transitively, via lightgbm)
```

The declared-but-unused set pulls **torch, OCR and document-parsing machinery** — several
GB — into any image built from this file, for code paths that never execute.

Frontend (`package.json`) is lean: 7 runtime deps, all used. `leaflet` + `react-leaflet`
(maps), `recharts` (charts), `lucide-react` (icons), `next`/`react`/`react-dom`.

---

## 3. Dead-code map

Method: runtime introspection. Loaded the API, started the engine, invoked **every**
route handler including PDF generation, then diffed `sys.modules` against the file tree.
This is ground truth, not static approximation (two static attempts gave wrong answers —
they mishandled relative imports and package `__init__` files).

**49 of 66 backend modules are live. 17 are never imported.**

| Module | LOC | Verdict |
|---|---|---|
| `backend/app.py` | 750 | **Dead in every tested configuration** — Pathway DAG |
| `rag/advisory_engine.py` | 466 | Dead — needs Pathway `DocumentStore` |
| `ingestion/aqi_stream.py` | 242 | Dead — WAQI, only `app.py` uses it |
| `ingestion/firms_stream.py` | 224 | Dead — only `app.py` |
| `streaming/risk_engine.py` | 286 | Dead — only `app.py` |
| `station_loader.py` | 79 | Dead — only `app.py` / streaming branch |
| `ingestion/feed_time.py` | 81 | Dead — only `aqi_stream.py` |
| `ingestion/fire_stream.py` | 38 | Dead — only `app.py` |
| `ingestion/micro_nodes.py` | 0 | **Empty file** |
| `backfill/{features,fire_history,met_forecast,openaq_history,research_import}.py` | 900 | **Not dead** — offline pipeline, reached from root scripts. `openaq_history` is also on the live bootstrap path |
| `tests_{contract,grap,temporal}.py` | 560 | Correctly not imported |

**≈2,300 LOC of Pathway-path code ships in every image and never executes** (0.5).

### Finding 0.6 — the code documents subsystems it does not have 🔴

`fallback_engine.py`'s module docstring states, under *"Real, reusing the same code the
Pathway path uses"*:

```
* causal attribution / transport   streaming/risk_engine.py
* satellite fire intelligence      ingestion/firms_stream.py
```

It imports **neither**. Verified: `risk_engine` and `firms_stream` are imported only by
`app.py`. In direct mode `_build_state()` writes hardcoded nulls —
`firms_status: "not_polled"`, `transport_label: "unknown"`,
`pollution_cause: "unclassified"`, `confidence_score: 85`.

This is the same class of defect the last pass removed from the UI, surviving inside the
engine's own documentation. It is rated High because it is the kind of claim a reviewer
checks.

---

## 4. Database + query audit

SQLite, 147 MB, WAL. 8 tables. Every table has a natural primary key and an `ix_*_time`
index; `cases`/`case_actions` were added with purpose-built indexes.

| Table | Rows |
|---|---|
| `met_hourly` | 356,616 |
| `forecasts` | 196,200 |
| `derived_features` | 163,176 |
| `station_readings` | 37,124 |
| `fire_events` | 11,003 |
| `ncr_target` | 28 |
| `cases` / `case_actions` | 0 |

### Finding 0.8 — the hot path loads 70k rows and keeps ~150 🔴

Measured on this machine, median of 3:

| Call | Time | Rows loaded | Rows actually needed |
|---|---|---|---|
| `observation_series()` | **233 ms** | 30,068 | ~30 (6 lags + 24 h) |
| `model_lgbm.load_met()` | **345 ms** | 39,624 | 72 (the horizon) |
| `baselines.load_observations()` | 162 ms | 29,953 | ~30 |
| **`forecast()` end-to-end** | **1,267 ms** | | 72 points |

Both hot calls are `SELECT … FROM <table>` with **no time bound**, materialised into a
Python dict, then indexed by key. ~580 ms — **46 % of forecast latency** — is spent
loading rows that are immediately discarded.

The fix is a bounded query, not an index: the PKs `(station_id, timestamp)` and
`(grid_id, timestamp)` already support a range scan. Complexity goes O(N) in table size →
O(k) in horizon. This is the single highest-value optimisation in the repository, and it
explains the 11.5 s/request figure measured earlier under 12-way concurrency.

There is **no result cache** on `/api/aree/outlook`, and a replay `as_of` is immutable —
a perfect cache key.

Connections: `db.connect()` per request in `outlook.py`, never closed. `cases.py` closes
in `finally` (correct). No pooling; SQLite serialises writers.

`case_store.listing()` has no pagination — fine at 0 rows, unbounded by design.

---

## 5. Algorithmic inventory

| Algorithm | Where | Complexity | Assessment |
|---|---|---|---|
| Ventilation VC = PBLH × wind | `forecast/ventilation.py` | O(n), n=72 | Correct, trivial |
| `find_collapse` sustained run | `forecast/ventilation.py` | O(n) single pass | Correct |
| `sustained_runs` / `merge_runs` | `predictive_engine.py` | O(n log n) (sort) | Correct; shared with the scorer by import, which is the right call |
| LightGBM inference | `pm25_forecast.forecast()` | 144 single-row `predict()` | **0.9 — 37× slower than batched** |
| Feature assembly `_row()` | `backfill/model_lgbm.py` | O(1) per lead, dict lookups | Fine |
| Plume influence | `backfill/features.py` | O(hours × fires) nested, 24 h lookback | Offline batch only; acceptable |
| Exposure ranking | `intelligence.exposure()` | O(n log n), n≈80 | Fine |
| Label de-clutter (map) | `SpatialOutlookMap.tsx` | O(k·n), k≤4 | Fine |
| Station fan-out | `caqm_stream`, `ncr_observations` | `ThreadPoolExecutor`, 6–10 workers | **Already correct** — pooled, bounded, retried |

### Finding 0.9 — batching inference 🟠

Measured: 72 leads one-row-at-a-time **15.3 ms** vs single batch **0.4 ms** — **37×**.
Two models per forecast, so ~30 ms of the 1,267 ms. Smaller than the DB win but
essentially free to fix, and it compounds under concurrency.

**No algorithm was found that is wrong.** The scientific core — ventilation, sustained
runs, the warning rule — is correct and already shares one implementation between the
engine and the scorer. Nothing here needs re-derivation.

---

## 6. Security review

| Check | Result |
|---|---|
| Secrets in Git history | 🟢 **Clean** — `git log --all -- .env …` empty |
| Credential-shaped literals in tracked source | 🟢 None |
| `.gitignore` coverage | 🟢 `.env*`, `venv/`, `data/*.db`, `.next/`, `node_modules/`, `.tmp/` |
| Authentication | 🔴 **None anywhere** |
| Authorization | 🔴 None |
| CORS | 🟡 localhost allow-list + regex; correct for local, blocks foreign origins |
| Upload validation | 🟢 ext allow-list, 20 MB cap, `basename` + `commonpath` traversal guard (tested) |
| SQL injection | 🟢 Parameterised throughout; the one f-string (`load_met` column list) interpolates a module constant, not input |
| Error leakage | 🟡 Generic handler returns `f"{type(exc).__name__}: {exc}"` to the client |
| `/docs`, `/openapi.json` | 🟡 Open |
| Dependency risk | 🟠 `google-generativeai` deprecated upstream; declared set pulls torch/OCR unnecessarily |

### Finding 0.10 — unauthenticated state change 🔴

Two write endpoints, neither protected:

```
POST /api/cases/{case_id}/decision   → writes a regulatory decision to the audit trail
POST /api/policy/upload              → writes a file into the RAG corpus
```

The case endpoint is the more serious: it is the system's human-authority boundary, and
anyone who can reach the API can approve a case as any named officer. The code is honest
about this (`actor_verified = 0` on every row, an `identity` block in every response), so
it is **disclosed, not hidden** — but it is the top blocker for any deployment beyond a
laptop.

---

## 7. Testing & CI

| | |
|---|---|
| Test files | 3 (`tests_contract`, `tests_grap`, `tests_temporal`) — 560 LOC |
| Runner | None. All three are `if __name__ == "__main__"` scripts run by hand |
| Framework | None. `pytest` not installed, not declared |
| Frontend tests | **Zero** |
| CI | **None.** No `.github/` at all |
| Coverage | Unmeasured |

The three suites are genuinely good — `tests_temporal` walks every timestamp in the
payload and proved its worth by catching a real leak — but they cannot gate anything
because nothing runs them automatically. (0.11)

---

## Phase 0 gate — summary

**What is healthy:** the scientific core is correct and shares one implementation with
its scorer; ingestion is defensively written with real upstream-failure handling; secret
hygiene is clean; the decision/audit layer added last pass is sound; the frontend
dependency set is lean.

**What must change, in value order:**

1. **0.8** bounded hot-path queries — 46 % of forecast latency, measured
2. **0.7** `requirements.txt` — a fresh clone cannot run the forecast
3. **0.10** authentication on the two write endpoints
4. **0.6** remove the false subsystem claims from `fallback_engine`
5. **0.5 / 0.2** decide the fate of the Pathway path and the generated artefacts
6. **0.11** a real test runner + CI
7. **0.9** batch inference
8. **0.1 / 0.3** deployment config and the root-script boundary

**Explicitly not changing:** the forecasting model, the warning rule, the ventilation
calculation, the four-state contract, or anything else in `DECISIONS.md` — Phase 0 found
no correctness defect in the scientific architecture.

---

# Phases 1–30

Pending. Execution proceeds in the agreed STEP order, gate by gate, with the three
existing suites plus `tsc`/`eslint` as the regression net.
