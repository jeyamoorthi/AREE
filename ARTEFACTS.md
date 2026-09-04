# AREE — artefact register

What this repository contains, why each thing is here, and what would break if it
were removed. Written so a reviewer can tell load-bearing files from output.

Measured, not estimated: the repository ships **202 tracked files, 7.38 MiB
packed**. The 528 MB `frontend/node_modules` and the 148 MB `data/aree.db` are
both gitignored and are *not* part of what is distributed.

Classification used throughout:

| Class | Meaning |
|---|---|
| **RUNTIME** | the deployed application reads it; removing it breaks a served endpoint |
| **REPRODUCIBILITY** | not read at runtime, but the published results cannot be re-derived without it |
| **RESEARCH / DEV** | supports work on the system, not the system itself |
| **REGENERABLE** | can be rebuilt from code plus upstream sources |
| **OBSOLETE** | nothing reads it and nothing would be lost |

---

## 1. Models — RUNTIME, and load-bearing *by filename*

```
backend/config/models/central__20241101.txt   2,323,625 bytes
backend/config/models/upper__20241101.txt     2,325,552 bytes
```

**These two files are the forecast.** Delete them and `/api/aree/outlook` raises
`no persisted 'central' model trained on or before …`.

### The filename is not decoration

`pm25_forecast.load_for(name, as_of)` parses `__YYYYMMDD` out of the filename and
offers only models whose `train_end <= as_of`. That is the entire leakage guard: a
replay of 2 Nov 2024 physically cannot load a model trained afterwards, because
the selection never returns one.

**Renaming these files silently changes the science.** A rename that drops or
alters the date either breaks model loading outright or — worse — makes a later
model eligible for an earlier replay, at which point every lead-time number this
project quotes becomes unsupportable. Do not rename them as tidying.

### What the artefacts themselves record

Read out of the LightGBM dumps rather than from documentation:

| | `central` | `upper` |
|---|---|---|
| objective | `regression_l1` | `quantile` |
| what it is | conditional **median** | q90 upper tail |
| features | 24, names embedded | 24, names embedded |
| `num_class` / trees per iter | 1 / 1 | 1 / 1 |
| train_end (from filename) | 2024-11-01 | 2024-11-01 |

Feature contract, in order. Read verbatim out of `central__20241101.txt` rather
than transcribed from the training code, so it stays true even if the code drifts
— a first draft of this table said `valid_hour`/`valid_month`, which the artefact
does not agree with:

```
lead_h
pm25_lag0  pm25_lag1  pm25_lag3  pm25_lag6  pm25_lag12  pm25_lag24
pm25_mean24  pm25_delta24
boundary_layer_height  wind_speed_10m  wind_dir_sin  wind_dir_cos
temperature_2m  relative_humidity  precipitation  surface_pressure
cloud_cover  solar_radiation  ventilation_coefficient
hour  doy_sin  doy_cos  month
```

The split that makes this perfect prognosis: **every pollution feature is at or
before issue time; every meteorological feature is at valid time.** See
`model_lgbm._row()`.

`upper` is a q90 quantile fit. It is an upper tail, **not a prediction** — the
warning rule fires on it precisely because it is a pessimistic bound.

### Regenerating them

```bash
python train_forecast.py --train-end 2024-11-01
```

Reads `station_readings` and `met_hourly` from `data/aree.db`. Reproducible only
if that store still holds the same rows, which is why the store is listed under
REPRODUCIBILITY below rather than as a disposable cache.

---

## 2. The store — RUNTIME + REPRODUCIBILITY, gitignored

```
data/aree.db        148 MB    gitignored (.gitignore:46-48)
data/aree.db-wal    1.9 MB
data/aree.db-shm     32 KB
```

Eight tables; `station_readings` (37k rows), `met_hourly`, `derived_features`
(163,176 rows, `plume_influence` non-null throughout), `fire_events`,
`ncr_target`, `cases`, `case_actions`, `forecasts`.

**RUNTIME**: every forecast, the ventilation assessment and the case workflow read
it. **REPRODUCIBILITY**: it is also the training input, so a model cannot be
re-derived without an equivalent store.

**REGENERABLE, with a caveat worth stating.** `capture.py bootstrap` and
`backfill.py` rebuild it from CPCB / OpenAQ / Open-Meteo ERA5 / NASA FIRMS. But
those are *live* APIs: a rebuild months later returns what they serve then, and
retrospective revisions to CPCB data are normal. So a rebuild is reproducible in
method, not guaranteed byte-identical in content.

Not committing 148 MB is right. It does mean a fresh clone must bootstrap before
the hero replay works, and the README says so.

---

## 3. Code

Classified by **runtime observation** — importing the app, exercising the request
path, and diffing `sys.modules`. Static import graphs were tried and got this
wrong three times in this project (they miss function-level imports and stop at
empty `__init__.py` files), so they are not the basis for anything here.

| Group | Files | LOC | Class |
|---|---|---|---|
| Served request path | 49 | 9,957 | **RUNTIME** |
| CLI scripts + test suites | 19 | 4,433 | **REPRODUCIBILITY / DEV** |
| Pathway-only | 5 | 1,764 | **RESEARCH** — see §4 |
| Reachable only on untaken branches | 5 | 982 | **RUNTIME (conditional)** |

**Conditional-runtime** is a real category and these are not dead:
`ingestion/cpcb_stream.py` (fallback data source, `fallback_engine:348`),
`ingestion/aqi_stream.py` + `feed_time.py` (feed diagnostics, `engine:246`),
`station_loader.py` (`engine:326`), `rag/llm_engine.py` (Gemini status,
`engine:211`, inside `try/except`). They load on a branch the standard exercise
does not take.

### Removed

`backend/ingestion/micro_nodes.py` — **0 bytes, zero importers**. An empty file
implying a subsystem that does not exist. The only OBSOLETE code found. Regression
after removal: routes / claims / GRAP / contract all pass.

### Not removed, and deliberately

No Streamlit code remains — the matches in `serialization.py`, `README.md` and
`MIGRATION.md` are historical references and a migration record, which is
documentation, not residue.

---

## 4. Pathway — RESEARCH, retained, and no longer presented as primary

| File | LOC |
|---|---|
| `backend/app.py` | 750 |
| `backend/rag/advisory_engine.py` | 466 |
| `backend/streaming/risk_engine.py` | 286 |
| `backend/ingestion/firms_stream.py` | 224 |
| `backend/ingestion/fire_stream.py` | 38 |
| | **1,764** |

The earlier estimate of ~2,300 LOC over-counted: `aqi_stream.py`, `feed_time.py`
and `station_loader.py` were included, and all three are reachable from
`api/engine.py` on the direct path.

### Only two of these actually need Pathway

Measured by what they import:

| Module | Streaming dependency |
|---|---|
| `app.py` | `pathway`, `codecarbon` |
| `rag/advisory_engine.py` | `pathway`, `sentence_transformers` |
| `streaming/risk_engine.py` | **none — pure Python** |
| `ingestion/firms_stream.py` | **none — pure Python** |
| `ingestion/fire_stream.py` | **none — pure Python** |

This matters, and it corrects how the previous phase described things. Causal
attribution (`CausalAttributionEngine`, `TransportVectorModel`) and satellite fire
intelligence are **548 LOC of ordinary Python needing only `requests` and
stdlib**. They are not Pathway capabilities. They are simply wired only into
`app.py`.

So the accurate statement is: *Pathway holds event-time windowing and the policy
RAG DocumentStore. It does not hold the fire or attribution capability — that is
unwired, not unavailable.*

### Cost of retaining it

Zero at runtime: nothing on the served path imports it, and its packages sit in
`backend/requirements-streaming.txt`, which is separated and labelled unverified.
The cost is comprehension — a reader has to be told which engine is real, which
§5 now does in code.

### Wiring FIRMS into direct mode is a capability decision, not cleanup

It is genuinely available: three pure-Python modules, one `requests`-backed API,
a `FIRMS_API_KEY` already in `.env`. **It has deliberately not been done here.**
Phase 4 was about not claiming uncomputed things; adding a new computation is
feature work and belongs in a phase that says so.

---

## 5. Which engine is authoritative — now stated in code

`api/engine.load_engine()` previously attempted `import app` (Pathway) **first**
and reached the direct engine only by catching the failure.

That misdescribed the system. The attempt never succeeded — Pathway is not
installed in any verified environment — so every start paid for a heavyweight
import guaranteed to raise, and the engine actually serving traffic was chosen by
an exception handler. A reader would conclude streaming was the system and direct
the safety net, when the reverse is what runs and what every gate in this project
measures.

The default is now **direct**. Streaming is opt-in:

```
AREE_ENGINE_MODE unset | "direct"        direct engine   (default, production)
AREE_ENGINE_MODE "streaming" | "pathway" Pathway, falling back to direct on failure
```

Nothing is removed: ask for streaming and it loads; if it fails it still falls
back with the real reason reported. Verified across all three settings:

| `AREE_ENGINE_MODE` | result |
|---|---|
| unset | `mode=direct`, `pathway_error=None`, `engine_selection="direct engine (default; production path)"` |
| `direct` | `mode=direct` |
| `streaming` | attempts Pathway, falls back, records `pathway_error="No module named 'pathway'"` |

The runtime gate now asserts the first row specifically — including that
`pathway_error` is **None**, which is what distinguishes "chosen by default" from
"fell back after a failure". Before this change that assertion would have failed.

`degraded: true` was **not** flipped off for direct mode. Direct really does
provide less — no event-time windowing, no policy retrieval, no FIRMS poll — and
turning the flag off because direct is now the default would increase a claim
without gaining a capability. What changed is `pathway_error`, which no longer
reports a phantom failure for a path that was never attempted; a new
`engine_selection` field distinguishes "chosen by default" from "fell back".

---

## 6. Documentation and research artefacts

| Path | Size | Class |
|---|---|---|
| `docs/architecture_diagram.png` | 599 KB | RESEARCH / DEV — REGENERABLE via `docs/build_engineering_report.py` |
| `docs/pipeline_flow.png` | 426 KB | same |
| `docs/dashboard_preview.png` | 157 KB | same |
| `docs/AREE_Engineering_Report.pdf` | 39 KB | REGENERABLE from the same script |
| `research/ps26082/docs/*.pdf` (3) | 697 KB | REPRODUCIBILITY — the PS26082 findings, architecture and journal |
| `research/ps26082/data/{raw,interim,processed}` | 4.3 MB | REPRODUCIBILITY — experiment inputs |
| `AREE_Demo.html` | 158 KB | DEV — the single-file offline snapshot |
| `backend/policies/*.txt` | 150 KB | RUNTIME (streaming only) — the RAG corpus |
| `ARCHITECTURE_REPORT.md`, `DECISIONS.md`, `IMPLEMENTATION_PLAN.md`, `MIGRATION.md`, `TEAM_*.md` | 190 KB | REPRODUCIBILITY — the engineering record |

The four PDFs are **not duplicates**; they are different documents (engineering
report, architecture, journal, findings).

Nothing here was deleted. 1.2 MB of PNGs are regenerable, but they are also the
figures the written record refers to, and regenerating a diagram is not free — the
saving does not justify the risk of a broken reference.

---

## 7. What the repository ships

```
AREE
├── backend/api/            served application: routes, auth boundary, cache
├── backend/forecast/       the forecast contract + leakage-guarded model loading
├── backend/backfill/       store schema, features, model training
├── backend/ingestion/      upstream feeds (CPCB, CAQM, OpenAQ, Open-Meteo, FIRMS)
├── backend/streaming/      GRAP state machine, case store, risk engine
├── backend/config/models/  ← the two LightGBM artefacts, load-bearing by filename
├── backend/app.py + rag/   optional Pathway engine (opt-in, unverified deps)
├── backend/tests_*.py      seven suites, four of them over real HTTP
├── frontend/               Next.js console
├── research/ps26082/       the experimental record behind the quoted numbers
└── docs/                   figures and the engineering report
```

Data and models are the two things a clone does not get for free: the models are
committed (4.5 MB), the store is not (148 MB) and must be bootstrapped.
