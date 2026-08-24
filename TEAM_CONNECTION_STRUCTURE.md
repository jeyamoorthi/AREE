# UrbanLive AI — Team Connection Structure
> Read this before writing a single line of code.
> This document tells every teammate exactly what they consume, what they produce, and how to connect to others.

---

## 🗂️ Project Overview

```
External APIs (WAQI, NASA FIRMS, Weather)
        │
        ▼
┌─────────────────────┐
│  Part 1: Ingestion  │  ──feeds raw records──►  Part 2: Streaming + Risk
└─────────────────────┘                                    │
                                                           │ risk scores
                                                           ▼
                                               ┌─────────────────────┐
Part 3: AI + RAG + Policy  ◄──────────────────│  Part 4: FastAPI API │◄── Part 2 + Part 3
└─────────────────────┘                        └─────────────────────┘
                                                           │
                                               ┌───────────┴───────────┐
                                               ▼                       ▼
                                    Part 5: Dashboard UI    Part 6: Intelligence UI
                                    (AQI, Map, Charts)      (AI Cards, Reports, Docker)
```

---

## 🔑 THE GOLDEN RULES

1. **`backend/api/schemas.py` is owned by Part 4** — no one else edits it. It is the contract.
2. **`frontend/src/types/index.ts` is owned by Part 5** — Part 6 only imports from it, never duplicates.
3. **`frontend/src/lib/api.ts` is owned by Part 5** — Part 6 only imports from it, never duplicates.
4. **`backend/config.py` is read-only for all** — only Part 4 lead can change it after team agreement.
5. **Never import across part boundaries in Python** — parts talk to each other only through function calls defined in this document.

---

## 🌐 Part 1 — Data Ingestion

### What you own
```
backend/ingestion/
    __init__.py
    aqi_stream.py        ← WAQI polling
    firms_stream.py      ← NASA FIRMS fire/hotspot
    fire_stream.py       ← Fire event stream
    weather_stream.py    ← Weather data
    micro_nodes.py       ← Micro-sensor nodes
    feed_time.py         ← Feed timing / scheduler
backend/station_loader.py
backend/config.py        ← READ ONLY
```

### What you consume
| Source | How |
|--------|-----|
| WAQI API | `GET https://api.waqi.info/feed/{feed_id}/?token={WAQI_TOKEN}` |
| NASA FIRMS | `GET https://firms.modaps.eosdis.nasa.gov/api/area/...` |
| Weather API | HTTP fetch using config values |
| `backend/config.py` | `WAQI_TOKEN`, `FIRMS_API_KEY`, `STATIONS`, `AQI_POLL_INTERVAL`, `FIRE_POLL_INTERVAL` |

### What you must produce (your output contract)
Every ingestion module must push **normalized records** into the Pathway stream.

**AQI Record shape:**
```python
{
    "station": str,          # e.g. "Anand Vihar (Delhi) — @2553"
    "feed_id": str,          # e.g. "@2553"
    "aqi": int | None,
    "pm25": float | None,
    "pm10": float | None,
    "dominant_pollutant": str | None,
    "timestamp": str,        # ISO 8601 UTC
    "waqi_timestamp": str | None,
    "feed_last_sync": str | None,
}
```

**Fire Record shape:**
```python
{
    "station": str,
    "lat": float,
    "lon": float,
    "fire_count": int,
    "high_conf_fires": int,
    "timestamp": str,        # ISO 8601 UTC
}
```

**Weather Record shape:**
```python
{
    "station": str,
    "wind_speed": float | None,      # m/s
    "wind_direction": float | None,  # degrees
    "temperature": float | None,
    "humidity": float | None,
    "timestamp": str,
}
```

### Who depends on you
- **Part 2** consumes your Pathway stream output directly

### Env vars you need
```
WAQI_TOKEN=
FIRMS_API_KEY=
```

---

## ⚡ Part 2 — Streaming + Risk Engine

### What you own
```
backend/streaming/
    __init__.py
    risk_engine.py       ← Core ERI risk scoring
    state_machine.py     ← AQI state transitions + escalation logic
```

### What you consume
| Source | How |
|--------|-----|
| Part 1 output | Normalized AQI + Fire + Weather records from Pathway stream |
| `backend/config.py` | `PERSISTENCE_THRESHOLD`, `HIGH_AQI_THRESHOLD`, `WINDOW_DURATION_MINUTES`, `GRAP_STAGES`, `CPCB_BANDS`, `HYSTERESIS_CONFIRMATIONS`, `CAUSAL_FIRE_THRESHOLD`, `WIND_ALIGNMENT_THRESHOLD` |

### What you must produce (your output contract)
**`risk_engine.py` must expose:**
```python
def compute_risk(record: dict) -> dict:
    """
    Input: merged AQI + fire + weather record (from Part 1)
    Output:
    {
        "eri_score": int,              # 0–100
        "eri_category": str,           # "LOW READINESS" | "ELEVATED" | "HIGH" | "CRITICAL"
        "eri_factors": list[str],
        "confidence_score": int | None,
        "transport_score": int | None,
        "transport_label": str | None,
        "aligned_fires": int | None,
        "pollution_cause": str | None,
        "cause_confidence": float | None,
        "cause_factors": list[str],
        "wind_speed": float | None,
        "wind_direction": float | None,
        "wind_label": str | None,
        "transport_probability": float | None,
        "fire_centroid": list[float] | None,
        "plume_distance_km": float | None,
        "wind_alignment_deg": float | None,
    }
    """
```

**`state_machine.py` must expose:**
```python
def transition(current_state: dict, new_aqi: int) -> dict:
    """
    Input: current station state + new AQI reading
    Output:
    {
        "grap_stage": str,
        "grap_description": str,
        "previous_stage": str | None,
        "grap_transitioned": bool,
        "hysteresis_pending": str | None,
        "hysteresis_count": int,
        "consecutive_windows": int,
        "remaining_windows": int,
        "persistence_percent": int,
        "projected_trigger_time": str | None,
        "engine_mode": str,            # "TRIGGERED" | "WATCH" | "NORMAL"
        "escalation_recorded": bool,
    }
    """
```

### Who depends on you
- **Part 4** calls `compute_risk()` and `transition()` inside API routes

### Env vars you need
```
# none — reads config.py only
```

---

## 🤖 Part 3 — AI + RAG + Policy

### What you own
```
backend/rag/
    __init__.py
    llm_engine.py        ← Gemini API calls
    advisory_engine.py   ← RAG retrieval + advisory generation
backend/policies/        ← Policy document corpus (do not delete any file)
backend/report_generator.py
backend/api/routes/
    advisory.py          ← /api/advisory/{station}
    ai.py                ← /api/ai/{station}
    policy.py            ← /api/policy + /api/policy/upload
    reports.py           ← /api/reports/{station}
```

### What you consume
| Source | How |
|--------|-----|
| `backend/config.py` | `GEMINI_API_KEY`, `GEMINI_MODEL`, `POLICY_DIR`, `VULNERABILITY_MULTIPLIERS`, `GRAP_STAGES` |
| `backend/api/schemas.py` | `AdvisoryResponse`, `AIResponse`, `PolicyResponse`, `ReportMetaResponse` — import only, never edit |
| Part 4 engine state | Via `from backend.api import engine; engine.latest_state(station)` |

### What you must produce (your output contract)

**`llm_engine.py` must expose:**
```python
def generate(prompt: str, context: str, station: str) -> dict:
    """
    Returns AIResponse-compatible dict:
    {
        "summary": str,
        "model": str,
        "cached": bool,
        "timestamp": float | None,
        "risk_trajectory": str,
        "regulatory_escalation_likelihood": str,
        "public_health_risk": str,
        "anomaly_flag": bool,
        "error": str | None,
    }
    """

def get_llm_status() -> dict:
    """Returns {"configured": bool, "model": str, "ready": bool, "last_error": str|None}"""
```

**`advisory_engine.py` must expose:**
```python
def get_advisory(station: str, aqi: int, grap_stage: str) -> dict:
    """
    Returns AdvisoryResponse-compatible dict:
    {
        "station": str,
        "advisory_text": str,
        "sections": [{"title": str, "body": str}, ...],
        "governance_rule": str | None,
        "rag_policy_file": str | None,
        "rag_similarity_score": float | None,
        "rag_last_updated": str | None,
        "rag_index_type": str | None,
        "rag_docs_indexed": int | None,
        "decision_trace": dict,
    }
    """

def index_status() -> dict:
    """Returns current RAG index status for system health endpoint."""
```

**`report_generator.py` must expose:**
```python
def generate_report(station: str, engine_state: dict) -> bytes:
    """Returns PDF bytes"""

def report_meta(station: str, engine_state: dict) -> dict:
    """
    Returns ReportMetaResponse-compatible dict:
    {
        "station": str,
        "available": bool,
        "generated_for": str,
        "engine_mode": str,
        "aqi": int | None,
        "grap_stage": str | None,
        "pdf_url": str,
        "filename": str,
    }
    """
```

### Your API routes must match these exact URL paths
| Route file | Endpoint | Response schema |
|-----------|----------|-----------------|
| `advisory.py` | `GET /api/advisory/{station}` | `AdvisoryResponse` |
| `ai.py` | `GET /api/ai/{station}` | `AIResponse` |
| `policy.py` | `GET /api/policy` | `PolicyResponse` |
| `policy.py` | `POST /api/policy/upload` | `PolicyUploadResponse` |
| `reports.py` | `GET /api/reports/{station}` | `ReportMetaResponse` |
| `reports.py` | `GET /api/reports/{station}/pdf` | `bytes (PDF)` |

### Who depends on you
- **Part 4** registers your routes in `main.py`
- **Part 6** frontend calls `/api/ai/`, `/api/advisory/`, `/api/policy`, `/api/reports/`

### Env vars you need
```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite   # optional override
```

---

## 🔌 Part 4 — FastAPI Backend

### What you own
```
backend/api/
    __init__.py
    main.py              ← FastAPI app, router registration, CORS
    schemas.py           ← ALL Pydantic schemas (YOU ARE THE CONTRACT OWNER)
    deps.py              ← Dependency injection
    engine.py            ← Engine state store + accessors
    ws.py                ← WebSocket broadcaster
    freshness.py         ← Data freshness classification
    serialization.py     ← Response serializers
    routes/
        __init__.py
        aqi.py           ← /api/aqi/{station}
        dashboard.py     ← /api/dashboard
        forecast.py      ← /api/forecast/{station}
        risk.py          ← /api/risk/{station}
        stations.py      ← /api/stations
        carbon.py        ← /api/carbon
        grap.py          ← /api/grap/{station}
        escalations.py   ← /api/escalations
        system.py        ← /api/system/status + /api/system/config
backend/app.py           ← App bootstrap / lifespan
backend/config.py        ← READ ONLY (you decide when to update it)
```

### What you consume
| Source | How |
|--------|-----|
| Part 2 `risk_engine` | `from backend.streaming.risk_engine import compute_risk` |
| Part 2 `state_machine` | `from backend.streaming.state_machine import transition` |
| Part 3 `advisory_engine` | `from backend.rag.advisory_engine import get_advisory` |
| Part 3 `llm_engine` | `from backend.rag.llm_engine import generate, get_llm_status` |
| Part 3 routes | Register via `app.include_router(advisory.router)` etc. in `main.py` |

### What you must produce (your output contract)

**ALL API endpoints — complete URL list:**
```
GET  /api/health
GET  /api/system/status
GET  /api/system/config
GET  /api/dashboard
GET  /api/stations
GET  /api/stations/{station}
GET  /api/aqi/{station}
GET  /api/aqi/{station}/history
GET  /api/grap/{station}
GET  /api/risk/{station}
GET  /api/forecast/{station}
GET  /api/forecast/{station}/health
GET  /api/advisory/{station}          ← registered from Part 3
GET  /api/ai/{station}                ← registered from Part 3
GET  /api/carbon
GET  /api/escalations
GET  /api/policy                      ← registered from Part 3
POST /api/policy/upload               ← registered from Part 3
GET  /api/reports/{station}           ← registered from Part 3
GET  /api/reports/{station}/pdf       ← registered from Part 3
WS   /ws                              ← WebSocket channel
```

**WebSocket message format** (what `ws.py` sends to frontend):
```json
{
  "type": "state_update",
  "station": "Anand Vihar (Delhi) — @2553",
  "aqi": 245,
  "cpcb_band": "Poor",
  "grap_stage": "Stage II (Very Poor)",
  "consecutive_windows": 2,
  "remaining_windows": 1,
  "eri_score": 68,
  "transport_score": 45,
  "transport_label": "Moderate",
  "confidence_score": 72,
  "ingestion_status": "ok",
  "firms_status": "ok",
  "engine_mode": "WATCH",
  "server_time": "2026-08-24T05:00:00Z"
}
```

**`engine.py` internal accessors** (Parts 2 and 3 call these):
```python
def latest_state(station: str) -> dict | None: ...
def all_states() -> dict[str, dict]: ...
def config() -> config: ...
```

### CORS configuration
```python
# in main.py — frontend connects from these origins
allow_origins = ["http://localhost:3000", "http://localhost:3001"]
```

### Who depends on you
- **Part 5** frontend — all REST calls via `lib/api.ts`
- **Part 6** frontend — AI/advisory/reports calls via `lib/api.ts`

### Env vars you need
```
WAQI_TOKEN=
FIRMS_API_KEY=
GEMINI_API_KEY=
```

---

## 📊 Part 5 — Frontend Dashboard

### What you own
```
frontend/src/
    app/
        page.tsx                      ← Home page
        layout.tsx                    ← Root layout
        globals.css                   ← Global styles
        favicon.ico
        dashboard/
            page.tsx                  ← /dashboard route
    components/
        AppShell.tsx
        Header.tsx
        StatusStrip.tsx
        CommandPalette.tsx
        AQICard.tsx
        AQITrendChart.tsx
        GRAPCard.tsx
        ForecastCard.tsx
        RiskChart.tsx
        CarbonCard.tsx
        DataHealth.tsx
        StationMap.tsx
        StationMapLoader.tsx
        StationSelector.tsx
        RankingTable.tsx
        national/
            NationalPanels.tsx
        providers/
            LiveDataProvider.tsx       ← WebSocket context
        ui/
            Card.tsx
            States.tsx
    hooks/
        useLiveChannel.ts             ← WebSocket hook
        usePolling.ts                 ← REST polling hook
        useEngineConfig.ts            ← Engine config hook
    lib/
        api.ts                        ← ALL API calls (YOU ARE THE CONTRACT OWNER)
        theme.ts
        clock.ts
        duration.ts
        freshness.ts
        station.ts
    types/
        index.ts                      ← ALL TypeScript types (YOU ARE THE CONTRACT OWNER)
```

### What you consume
| Source | How |
|--------|-----|
| Part 4 REST API | Via `lib/api.ts` → `API_URL` env var |
| Part 4 WebSocket | `ws://localhost:8000/ws` via `useLiveChannel.ts` |

### API calls you make (all in `lib/api.ts`)
```typescript
api.health()
api.systemStatus()
api.systemConfig()
api.dashboard()
api.stations()
api.station(station)
api.aqi(station)
api.aqiHistory(station)
api.grap(station)
api.risk(station)
api.forecast(station)
api.healthImpact(station)
api.carbon()
api.escalations(station?)
```

### WebSocket connection (`useLiveChannel.ts`)
```typescript
// Connects to:
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws"

// Receives messages of shape (from Part 4 ws.py):
interface LiveUpdate {
  type: "state_update";
  station: string;
  aqi: number | null;
  cpcb_band: string | null;
  grap_stage: string | null;
  consecutive_windows: number;
  eri_score: number | null;
  engine_mode: "TRIGGERED" | "WATCH" | "NORMAL";
  server_time: string;
  // ... see Part 4 WebSocket message format above
}
```

### Types you own (in `types/index.ts`) — Part 6 imports these, never redefines
```typescript
// Key types Part 6 needs from you:
export interface StationSummary { ... }
export interface AQIResponse { ... }
export interface RiskResponse { ... }
export interface GRAPResponse { ... }
export interface ForecastResponse { ... }
export interface AdvisoryResponse { ... }
export interface AIResponse { ... }
export interface PolicyResponse { ... }
export interface ReportMetaResponse { ... }
export type FeedStatus = "ok" | "awaiting" | "no_aqi" | "error";
export type FreshnessStatus = "current" | "aging" | "stale" | "unavailable";
export type EngineMode = "TRIGGERED" | "WATCH" | "NORMAL";
```

### Who depends on you
- **Part 6** imports `lib/api.ts` and `types/index.ts` — never duplicates them

### Env vars you need
```
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_WS_URL=ws://localhost:8000/ws
```

---

## 📑 Part 6 — Frontend Intelligence + Reports + Deployment

### What you own
```
frontend/src/
    app/
        stations/[station]/
            page.tsx                  ← /stations/:station route
        reports/
            page.tsx                  ← /reports route
    components/
        AIAnalysis.tsx
        AdvisoryCard.tsx
        EscalationHistory.tsx
        HealthForecast.tsx
        PersistenceCard.tsx
        PolicyConsole.tsx
        ReportDownload.tsx
        SatelliteCard.tsx
        StationDashboard.tsx
        station/
            AQIHero.tsx
            RiskIntelligence.tsx
            StationHeader.tsx

# Deployment (root level)
Dockerfile                            ← Backend container
docker-compose.yml                    ← Full stack
frontend/Dockerfile                   ← Frontend container
frontend/.dockerignore
README.md
MIGRATION.md
docs/
```

### What you consume

**From Part 5 (import only, never copy):**
```typescript
import type { AIResponse, AdvisoryResponse, RiskResponse, ... } from "@/types";
import { api } from "@/lib/api";
```

**API calls you make (using Part 5's `api` object):**
```typescript
api.advisory(station)        // → /api/advisory/{station}   (Part 3 backend)
api.ai(station)              // → /api/ai/{station}          (Part 3 backend)
api.policy()                 // → /api/policy                (Part 3 backend)
api.escalations(station)     // → /api/escalations           (Part 4 backend)
api.healthImpact(station)    // → /api/forecast/{station}/health (Part 4 backend)
api.reportMeta(station)      // → /api/reports/{station}     (Part 3 backend)
api.downloadReport(station)  // → /api/reports/{station}/pdf (Part 3 backend)
api.uploadPolicy(file)       // → /api/policy/upload         (Part 3 backend)
```

### Deployment — docker-compose.yml structure
```yaml
services:
  backend:
    build: .                          # uses root Dockerfile
    ports: ["8000:8000"]
    env_file: .env
    environment:
      - WAQI_TOKEN
      - FIRMS_API_KEY
      - GEMINI_API_KEY

  frontend:
    build: ./frontend                 # uses frontend/Dockerfile
    ports: ["3000:3000"]
    environment:
      - NEXT_PUBLIC_API_URL=http://backend:8000
      - NEXT_PUBLIC_WS_URL=ws://backend:8000/ws
    depends_on: [backend]
```

### Who depends on you
- Everyone — your `docker-compose.yml` is how the whole app runs

### Env vars you need
```
# Same as Part 4 backend — passed through docker-compose
WAQI_TOKEN=
FIRMS_API_KEY=
GEMINI_API_KEY=
```

---

## 📋 Interface Quick Reference Card
> Photocopy this and pin it on your desk.

| From → To | How they connect |
|-----------|-----------------|
| Part 1 → Part 2 | Pathway stream records (AQI/Fire/Weather normalized dicts) |
| Part 2 → Part 4 | `compute_risk(record)` and `transition(state, aqi)` function calls |
| Part 3 → Part 4 | `get_advisory()`, `generate()`, `report_meta()` function calls + route registration |
| Part 4 → Part 5 | REST JSON over HTTP (`lib/api.ts`) |
| Part 4 → Part 5 | WebSocket `/ws` (`useLiveChannel.ts`) |
| Part 5 → Part 6 | TypeScript imports: `@/types`, `@/lib/api` |

---

## 🔐 .env File Template (root of project)
> Part 6 owns this file. Everyone else reads from `config.py` which loads it.
```
# .env — place at project root (same level as backend/ and frontend/)

# Data Sources
WAQI_TOKEN=your_waqi_token_here
FIRMS_API_KEY=your_nasa_firms_key_here

# AI
GEMINI_API_KEY=your_gemini_key_here
GEMINI_MODEL=gemini-3.5-flash-lite

# Frontend (Next.js public vars)
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_WS_URL=ws://localhost:8000/ws
```

---

## 🚀 How to Run Locally (all parts together)

```bash
# 1. Clone and set up env
cp .env.example .env
# fill in your API keys in .env

# 2. Backend (Parts 1–4)
cd backend
pip install -r requirements.txt
cd ..
uvicorn backend.api.main:app --reload --port 8000

# 3. Frontend (Parts 5–6)
cd frontend
npm install
npm run dev    # runs on http://localhost:3000

# OR with Docker (Part 6 owns this)
docker compose up --build
```

---

## ✅ Before You Push a PR — Checklist

**Part 1:**
- [ ] Each stream outputs records matching the exact shapes above
- [ ] No breaking changes to field names without notifying Part 2

**Part 2:**
- [ ] `compute_risk()` returns all fields in the contract dict
- [ ] `transition()` returns all fields in the contract dict
- [ ] No direct imports from Part 3 or Part 4

**Part 3:**
- [ ] Routes match the exact URL paths in this document
- [ ] Response shapes match `schemas.py` — did not edit `schemas.py`
- [ ] `policy/` folder still has all original documents

**Part 4:**
- [ ] All routes registered in `main.py`
- [ ] CORS allows `localhost:3000`
- [ ] WebSocket sends messages in the exact format above
- [ ] Any `schemas.py` change → notified all other parts

**Part 5:**
- [ ] `types/index.ts` has all types Part 6 needs
- [ ] `lib/api.ts` has all API calls (including ones Part 6 uses)
- [ ] `NEXT_PUBLIC_API_URL` env var is used everywhere (no hardcoded localhost)

**Part 6:**
- [ ] Zero duplicated types from Part 5
- [ ] `docker-compose.yml` passes all required env vars to both containers
- [ ] `docker compose up --build` runs the full stack without errors
