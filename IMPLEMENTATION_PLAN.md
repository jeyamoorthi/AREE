# AREE — Implementation Plan

**Goal:** make the product say exactly what the engineering report proves, and make the
screens express the validated chain rather than a prettier AQI dashboard.

**Source of truth:** `docs/AREE_Engineering_Report.pdf` + the running system.
**Audit reference:** `../AREE_SIH26082_Audit.pdf` (59/100, DEMO READY, 10 criticals).

**Target:** every screen answers one question, in the officer's order, with nothing on it
that the code cannot prove.

## The four screens — one workflow, no duplication

Each screen owns one question. If two screens answer the same question, one of them is
wrong.

```
┌────────────────────────┐
│ NATIONAL OVERVIEW      │   What is happening across NCR right now?
│ situational awareness  │   map · 71 stations · bands · freshness · worst areas
└───────────┬────────────┘   + one strip: status pill → link to Outlook
            ↓
┌────────────────────────┐
│ ATMOSPHERIC OUTLOOK ⭐ │   What happens next, and what does it do to pollution?
│ the decision story     │   status · act-by · mechanism · 72 h L1/q90 chart · timeline
└───────────┬────────────┘   THE HERO SCREEN
            ↓
┌────────────────────────┐
│ VENTILATION OUTLOOK    │   WHY will it happen?
│ deep diagnostic        │   VC = PBLH × wind · operating point · validation · evidence
└───────────┬────────────┘   NOT a second dashboard — the "why" drawer of the Outlook
            ↓
┌────────────────────────┐
│ COMMAND CENTER         │   What should we do, and who authorises it?
│ the authority screen   │   case · reasons · policy · measures · APPROVE / REJECT
└───────────┬────────────┘
            ↓
      HUMAN APPROVAL  →  AUDIT
```

**Sidebar stays at five items** (Overview, Command Center, Atmospheric Outlook,
Ventilation Outlook, Reports) — which is what exists today. Do not add "Pollution &
Plume", "Policy & Actions", "Alerts", "Data Health" or "Settings" as separate pages;
each would be a page with one real panel and a lot of dead space, which is the failure
mode the audit flagged.

**Division of labour between Outlook and Ventilation** — the rule that stops them
becoming two copies of each other:

| | Atmospheric Outlook | Ventilation Outlook |
|---|---|---|
| Question | What happens, when, what do I do | Why is dispersion failing |
| PM2.5 | central + q90 + threshold + crossing | one context line only |
| Ventilation | one summary cell in the mechanism strip | the whole page |
| Model metrics | one rule-citation line | full training vs held-out table |
| Decision | status, act-by, measures, open case | none — links back to Outlook |

---

## 0. Four corrections to the plan-as-stated, before anything is built

### 0.1 There are FOUR states, not three

`streaming/predictive_engine.py::status_for()` emits:

```python
if pm25 >= 250:        return "SEVERE_EPISODE_UNDERWAY"
if forecast_risk:      return "PREDICTIVE_WARNING"
if pm25 >= 120:        return "EPISODE_UNDERWAY"      # ← the missing one
return "MONITOR"
```

`EPISODE_UNDERWAY` is a real, reachable state: pollution is elevated (≥120 µg/m³, the
episode threshold the historical record was labelled with) but not Severe, and the
forecast does not cross. If the UI branches on three states, this one falls into the
default and renders as "conditions stable" — a false negative on the exact band where an
officer starts paying attention.

`rag/../intelligence.py::narrative()` has the same gap: it branches SEVERE →
PREDICTIVE_WARNING → `falling` → else. An `EPISODE_UNDERWAY` case with steady ventilation
gets "Conditions are stable and dispersion is adequate" at 180 µg/m³.

**Every status table in this plan carries four rows.** Fixed in Phase 1.

### 0.2 The precedence rule is already correct — and it is a talking point

`SEVERE_EPISODE_UNDERWAY` is tested *before* `forecast_risk`, so during a severe episode
the status never flips to PREDICTIVE_WARNING even though the upper tail keeps crossing.
That is exactly the "continuation is not a new warning" distinction. It is already right
in the backend; the UI must not re-derive it. **Rule: the frontend reads `risk.status`
and never computes a state from `forecast_risk`, `triggered`, or a threshold comparison.**

### 0.3 There cannot be a multi-case priority queue — there is one NCR assessment

A Command Center header reading

```
2 ACTIVE CASES   3 PREDICTIVE WARNINGS   4 INTERVENTION WINDOWS
```

or a case labelled `HIGH · FARIDABAD / NCR` **cannot be built from what the system
computes.** AREE produces exactly one assessment at any instant:

- the PM2.5 forecast is a **single point** — `lat=28.63, lon=77.22`, grid
  `ncr_28.63_77.22` (`pm25_forecast.forecast()`);
- the ventilation forecast is the **same single point**;
- `predictive_engine.assess()` returns **one** status and **one** case, jurisdiction
  `"Delhi NCR"`.

There is no per-station, per-district or per-jurisdiction forecast, and building a queue
that implies one would be the same class of error as the fabricated "Recent Events" row
the audit found — a plausible-looking screen with nothing behind it.

**What is honest and still fills the screen:**

```
COMMAND CENTER                                    Delhi NCR · one airshed

┌ NOW ─────────────────────────────────────────────────────────────┐
│ ● PREDICTIVE WARNING   1 case awaiting approval   act by 17:30    │
│ 71/71 stations reporting · last decision 14:20 by A. Sharma       │
└──────────────────────────────────────────────────────────────────┘

ACTIVE CASE      (the one open case, in full — evidence → policy → authorise)
CASE HISTORY     (table of past cases: as_of · status · officer · decided at)
```

Counts come from `SELECT status, COUNT(*) FROM cases` — real rows, not invented ones.
The **case history table is what fills the space** a queue would have filled, and it is
the audit trail, which is worth more to a judge than a fake queue.

*If we later want per-area cases*, the honest route is to run the forecast at several
grid points (the store already holds 9: `ncr_28.40…` → `ncr_28.86…`) and assess each.
That is a real feature with a real cost, and it is **out of scope for the five days**.

### 0.4 Map bands must stay CPCB, not ad-hoc

The proposed ramp — `<50 green · 50–75 yellow · 75–100 orange · 100–250 red-orange ·
>250 deep red` — is not the CPCB PM2.5 scale. CPCB is:

| Good | Satisfactory | Moderate | Poor | Very Poor | Severe |
|---|---|---|---|---|---|
| 0–30 | 30–60 | 60–90 | 90–120 | 120–250 | 250+ |

The backend already classifies with these (`intelligence.PM25_BANDS`) and ships the band
name per station, precisely so the UI never invents a scale. On a screen aimed at CAQM,
a non-standard severity ramp is a factual error an officer spots immediately — a station
at 95 µg/m³ is **Poor** under the national standard, not "orange, 75–100".

**Keep the backend's `band` string; the UI maps band → colour only.**

On radius: encoding concentration as **symbol size is fine**, encoding it as a 5–15 km
blurred halo is not — that reads as a modelled plume extent, which does not exist. Use a
proportional symbol: hard-edged circle, radius 4–14 px scaled by value, colour by CPCB
band, with the caption **"Observed spatial field — not a spatial forecast"**.

---

## Phase 0 — Stop the bleeding (0.5 day, do first, no new features)

Nothing here adds capability. All of it removes statements the code cannot support.
Until Phase 0 lands, every other improvement is decoration on a screen that says
"GRAP Stage I" at AQI 151.

| # | Change | File | Detail |
|---|---|---|---|
| 0.1 | **Commit the tree** | — | 6 modified + 3 untracked files are the entire outlook layer. A clone of `main` (`b3c775a`) does not contain the demo. Branch, commit, push. |
| 0.2 | **Fix the GRAP table** | `backend/config.py` | `GRAP_STAGES` currently maps 101–200 → "Stage I (Poor)". CAQM: Stage I = 201–300, II = 301–400, III = 401–450, IV = >450. Copy the table from `predictive_engine.GRAP_BY_AQI`, which is already correct, and import it in one place. Add `tests/test_grap_table.py` asserting the two agree. |
| 0.3 | **Delete the fabricated panels** | `components/national/NationalPanels.tsx` | Delete `RecentEventsRow`'s hard-coded array (lines ~445–495) and `DataHealthOverviewCard`'s literal Live/Active/Indexed rows (~340–380). Replace the second with the existing `NationalDataHealth` from `DataHealth.tsx`, which already reads `/api/system/status`. Delete the AQI-donut, Top-5 and AQI-range mock fallbacks in the same file. |
| 0.4 | **"Pathway pipeline · Running"** | same file | Literal string. Render `status.pipeline` + `status.mode` → "Direct engine · running". |
| 0.5 | **Footer + PDF claims** | `AppShell.tsx`, `report_generator.py::_footer` | "PATHWAY STREAMING · WAQI DIRECT · NASA FIRMS VERIFIED · LIVE POLICY INDEX" — four claims, four false in direct mode. Render from status: `Engine: direct · Observations: CAQM/CPCB · Meteorology: Open-Meteo · Policy retrieval: unavailable`. |
| 0.6 | **Ventilation self-contradiction** | `VentilationOutlook.tsx` | `collapsed = windowH <= 0` drives copy that then contradicts the number beside it ("within operating range" / "332.8 · Poor dispersion" / "above the operating point" at threshold 465.9). Compute `belowNow = ventilation_now <= threshold` once; derive all three strings from it. |
| 0.7 | **Validation rows** | `VentilationOutlook.tsx` Decision basis | "Hit rate (validation) 0.61 / FAR 0.19" are the **training** figures. Show two labelled rows: `Training (143 episodes) 0.61 / 0.19` and `Held-out (11 episodes) 0.20 / 0.50`. Add `holdout_hit_rate` / `holdout_false_alarm_rate` to `config/ventilation_operating_point.json` if absent. |
| 0.8 | **Replay meteorology label** | `VentilationOutlook.tsx` forecast-input card | Bind to `provenance.feature_source`. When it starts `store:` → "ERA5 reanalysis at valid time (perfect-prognosis replay)". Never "Numerical weather model (72 h ahead)" for a replay. |
| 0.9 | **LIVE pill during replay** | `CommandBar.tsx`, `Sidebar.tsx` | The pill reports *engine* liveness; the page may be showing 2024. Lift page mode into a small context (`OutlookModeProvider`) set by OutlookView/VentilationOutlook; when `mode === "replay"` swap to a violet `REPLAY · 02 Nov 2024 06:00 UTC`. |
| 0.10 | **Breadcrumb** | `CommandBar.tsx` | Add the `/outlook` branch — it currently reads "National Overview" on the demo page. |

**Gate:** open all five pages in live and in each replay preset. Nothing on screen may
state a fact the API did not return.

---

## Phase 1 — Contract additions (1 day)

> **STATUS: temporal integrity DONE** (1.1 exposure `as_of`, 1.2 observation contract,
> 1.3 four-state contract, 1.4 verified across live + 3 replays).
> Pinned by `backend/tests_temporal.py` — run it against a live API.
> Remaining in this phase: 1.5 limitations, 1.6 wind direction, 1.7 timeline/mechanism
> fixes, 1.8 performance. Deferred behind Phase 2 (frontend composition) by decision.

The UI the report describes needs six fields the payload does not yet carry, plus four
correctness fixes in the intelligence layer. All backend; no UI work in this phase.

### 1.1 `exposure()` must respect `as_of` — and the empty state is a feature

`api/routes/intelligence.py::exposure(conn, limit=6)` ignores `as_of` and always reads
`MAX(timestamp) WHERE source LIKE 'live:%'`. A replay of 02 Nov 2024 therefore shows the
September 2026 network. This is the single worst credibility bug in the product: the
provenance banner promises reconstruction and the panel beside it shows today.

```python
def exposure(conn, as_of: datetime, limit: int = 6) -> dict:
    rows = conn.execute(
        "SELECT station_id, pm25, latitude, longitude FROM station_readings "
        "WHERE timestamp = ? AND source LIKE 'live:%' AND pm25 IS NOT NULL "
        "ORDER BY pm25 DESC", (db.iso(as_of),)).fetchall()
    if not rows:
        composite = conn.execute(
            "SELECT pm25, n_stations FROM station_readings "
            "WHERE timestamp = ? AND source LIKE 'research:%'", (db.iso(as_of),)).fetchone()
        return {
            "available": False,
            "kind": "composite_only",
            "n_monitors": composite["n_stations"] if composite else None,
            "composite_pm25": composite["pm25"] if composite else None,
            "reason": ("Station-level record begins Sept 2026. For this hour the target "
                       "is an NCR composite from "
                       f"{composite['n_stations'] if composite else '?'} monitor(s)."),
        }
    ...
```

**Do not hide the empty state — render it.** In replay the panel becomes:

```
SPATIAL COVERAGE                                   02 Nov 2024, 11:30 IST
┌──────────────────────────────────────────────────────────────────┐
│  NCR composite · 129 µg/m³ · from 1 monitor                      │
│  [NCR outline, single point marked, airshed shaded to band]      │
│  Station-level record begins Sept 2026 — this is why AREE now    │
│  captures the full network hourly.                               │
└──────────────────────────────────────────────────────────────────┘
```

That turns the C0 target-integrity finding — the most rigorous thing in the report —
into something a judge sees rather than reads. It is a better panel than a wrong map.

### 1.2 Observed history left of "now"

The chart starts at the forecast. An officer cannot see where 129 came from. Add to
`forecast/pm25_forecast.py::forecast()`:

```python
"observed_history": [
    {"valid_at": t, "observed": v, "source": src}
    for t, (v, src) in sorted(observations.items())
    if as_of - timedelta(hours=24) <= t <= as_of
],
```

UI: solid dark line left of a vertical "now" rule; forecast lines right of it.

### 1.3 One deadline, not two clocks

Today the stat row shows "Upper-tail crosses 250 at 03 Nov 05:30" (18 h) *and*
"Intervention window 6.0 h". The officer cannot tell which is their deadline.

Add to the `decision` block in `api/routes/outlook.py`:

```python
"deadline": {
    # When the atmosphere stops clearing — after this, interventions bite less.
    "act_by": collapse["onset"] if collapse else None,
    "act_by_hours": ventilation.get("intervention_window_hours"),
    # When concentrations are forecast to go Severe.
    "severe_expected": risk["first_crossing"],
    "severe_expected_hours": risk["lead_hours"],
    "basis": "act_by = forecast sustained ventilation collapse onset; "
             "severe_expected = first sustained q90 crossing of 250 ug/m3",
},
```

UI renders **one** card: `ACT BY 17:30 IST (6 h)` with a sub-line
`Severe expected 05:30 tomorrow (18 h)`.

### 1.4 GRAP stage for the composite

`assessment["grap_stage_observed"]` is always `"None" / "No data"` because the outlook
passes `aqi=None`. Derive the CPCB PM2.5 sub-index from the composite and label it
honestly (GRAP is invoked on the max sub-index across pollutants; in winter PM2.5 leads,
but say so):

```python
from ...fallback_engine import pm25_to_aqi     # CPCB breakpoints, already correct
sub_index = pm25_to_aqi(observed["pm25"])
assessment = pe.assess({..., "aqi": sub_index}, ...)
# and in the decision block:
"grap_basis": "PM2.5 sub-index (CPCB breakpoints). GRAP is invoked on the maximum "
              "sub-index across pollutants; PM2.5 leads in the winter regime.",
```

### 1.5 `limitations[]` — generated from state, so it cannot go stale

The report's biggest credibility asset is that it records what failed. Put that on the
screen, computed rather than written:

```python
def limitations(forecast, atmosphere, plume, exposure) -> list[dict]:
    out = []
    train_end = max(datetime.strptime(v.split("__")[1], "%Y%m%d")
                    for v in forecast["provenance"]["models"].values())
    if (forecast["as_of"].date() - train_end.date()).days > 120:
        out.append({"topic": "model currency", "detail":
            f"Models were trained to {train_end:%d %b %Y}; this forecast is for "
            f"{forecast['as_of']:%d %b %Y}."})
    if forecast["mode"] == "replay":
        out.append({"topic": "replay meteorology", "detail":
            "Meteorology is ERA5 reanalysis at valid time (perfect prognosis), not the "
            "forecast a duty officer held at this hour."})
    if not atmosphere["inversion"]["available"]:
        out.append({"topic": "inversion", "detail": atmosphere["inversion"]["reason"]})
    if not plume["available"]:
        out.append({"topic": "plume", "detail":
            "No fire record for this hour; plume influence is not computed."})
    if forecast["horizon_hours"] < 72:
        out.append({"topic": "horizon", "detail":
            f"{forecast['horizon_hours']} h — the upstream model run does not reach 72 h "
            f"from this issue time."})
    if exposure.get("kind") == "composite_only":
        out.append({"topic": "target", "detail": exposure["reason"]})
    return out
```

Rendered as a collapsed **"Known limits (N)"** strip at the foot of the Outlook. Judges
open it. That is the point.

### 1.6 Wind direction into the series

`met_hourly.wind_direction_10m` is stored but not carried into `series[]`. Add
`"wind_dir_deg"` to each point in `pm25_forecast.forecast()` — needed for the map arrow
and the "upwind of Delhi" line.

### 1.7 Four correctness fixes in `intelligence.py`

| Bug | Fix |
|---|---|
| `narrative()` has no `EPISODE_UNDERWAY` branch | Add: *"An episode is under way at N µg/m³ — below the Severe band. Ventilation is {falling/steady}, so it is {likely to persist / expected to clear}."* |
| `timeline()` searches recovery after the **global minimum**, so the 14 Nov replay lists *recovers* (+6 h) before *falls below* (+13 h) | Search the first sustained run above threshold **after `collapse.onset`**, not after `worst`. Suppress any recovery mark that precedes the collapse mark. |
| Mechanism cells render red on a MONITOR day (live: red "Accumulation risk / Dispersion very poor" at 44 µg/m³) | Return `"severity": "info" \| "warn" \| "critical"` from `mechanism()`, keyed on `status`, not on the ventilation verdict alone. Red is reserved for PREDICTIVE_WARNING and SEVERE. |
| `sustained_hours` truncates when a run reaches the horizon | Return `"sustained_hours_truncated": True` when the run touches the last point; UI renders "≥ 53 h (to horizon)". |

### 1.8 Performance — the demo must survive a room

Measured: 1.0 s single, **11.5 s** per call at 12 concurrent, **21–25 s** for replay
(loads 39,624 met rows per request). Three changes:

1. **Cache** the outlook by `(as_of, lat, lon, grid, hours)`, TTL 60 s live / unbounded
   for replay (a past `as_of` is immutable). ~30 lines, no dependency.
2. **Batch predict**: `model_lgbm` currently calls `booster.predict([features])` once per
   lead — 144 single-row calls. Build the 72×24 matrix once, two `predict()` calls.
3. **Close the connection**: `outlook()` opens `db.connect()` per request and never closes
   it. Use a dependency with `try/finally`, or a module-level connection with
   `check_same_thread=False`.

**Gate:** `ab -n 50 -c 12` on `/api/aree/outlook` — p95 under 500 ms.

---

## Phase 2 — Approval, and a real policy basis (1 day)

This is the capability the product claims and does not have. `AWAITING_APPROVAL` is
currently a string with no endpoint, no record, and no approver.

### 2.1 Two tables

`backend/backfill/db.py::SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS cases (
    case_id       TEXT PRIMARY KEY,   -- deterministic, see 2.2
    as_of         TEXT NOT NULL,      -- the assessment instant
    opened_at     TEXT NOT NULL,
    mode          TEXT NOT NULL,      -- live | replay
    jurisdiction  TEXT NOT NULL,
    status        TEXT NOT NULL,      -- AWAITING_APPROVAL | APPROVED | REJECTED
    priority      TEXT,
    trigger_rule  TEXT,
    deadline      TEXT,
    evidence_json TEXT NOT NULL       -- the full assessment snapshot
);

CREATE TABLE IF NOT EXISTS case_actions (
    action_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     TEXT NOT NULL,
    at          TEXT NOT NULL,
    action      TEXT NOT NULL,        -- OPENED | APPROVED | REJECTED | NOTED
    officer     TEXT,
    note        TEXT,
    FOREIGN KEY (case_id) REFERENCES cases(case_id)
);
```

### 2.2 Deterministic case id — so replay stays idempotent

```python
case_id = hashlib.sha1(
    f"{as_of.isoformat()}|{jurisdiction}|{trigger_rule}".encode()).hexdigest()[:12]
```

Replaying 02 Nov twice addresses the same case instead of creating two. The id goes into
the outlook payload as `decision.case_id` so the UI can link without a second call.

### 2.3 Three routes — `GET` stays pure

```
GET  /api/cases                       list (filter: status, mode, since)
GET  /api/cases/{case_id}             detail + action history
POST /api/cases/{case_id}/decision    {decision, officer, note}
```

The POST handler **recomputes the assessment from `as_of`** before writing. Because the
assessment is deterministic, the stored evidence is provably the evidence that existed at
decision time — the audit record reproduces itself. That is the strongest possible answer
to "can you reproduce yesterday's decision?".

Officer identity is a self-declared name field. **Say so on the screen**
("Identity is self-declared in this build; SSO/role binding is future work") rather than
implying authentication that does not exist.

### 2.4 Measures that cite the GRAP schedule

`predictive_engine._measures_for(priority)` returns a hard-coded Python list keyed on
priority, with no stage and no citation. The GRAP schedule is sitting in
`backend/policies/` and the RAG that would retrieve it needs Pathway.

Build `backend/config/grap_measures.json` — a deterministic extract, stage → measures,
each with the responsible agency and the clause it comes from:

```json
{
  "source": "GRAP Schedule (CAQM, rev. 21.11.2025)",
  "stages": {
    "Stage I (Poor)": [
      {"measure": "Enforce dust-mitigation requirements at C&D sites",
       "agency": "DPCC / SPCBs (NCR)", "clause": "Stage I §1"},
      ...
    ],
    "Stage II (Very Poor)": [...],
    ...
  }
}
```

`_measures_for(stage)` then keys on **stage**, not priority, and each rendered measure
carries its clause. That makes "policy basis" real without Pathway, and it survives the
question "which rule supports this?".

---

## Phase 3 — The four screens (1.5 days)

### 3.0 The status contract every screen shares

| `risk.status` | Pill | Tone | Headline pattern | Primary action |
|---|---|---|---|---|
| `MONITOR` | Monitoring | neutral | "Conditions stable — dispersion adequate" | none |
| `MONITOR` + ventilation falling | Watch | soft amber | "Stable now, but dispersion is deteriorating" | none |
| `EPISODE_UNDERWAY` | Episode under way | amber | "Episode under way at N µg/m³ — below Severe" | Open case |
| `PREDICTIVE_WARNING` | **Predictive warning** | orange | "N µg/m³ now, but a severe episode is likely within H hours" | **Open case** |
| `SEVERE_EPISODE_UNDERWAY` | Severe now | red | "Severe episode under way at N µg/m³" | **Open case** |

One `<StatusBadge status={risk.status} />` component. No page re-derives state.

### 3.1 Atmospheric Outlook — the scientific screen

Restructure to the report's chain. Current order is insight → stats → chart/map/ranking →
timeline → recommendation → provenance, with the decision ~1,100 px below the fold.

```
┌─ STATUS ────────────────────────────────────────────────────────────┐
│ ● PREDICTIVE WARNING          ACT BY 17:30 IST (6 h)                │
│ Air is very poor now, but a severe episode is likely within 18 h.   │
│ Severe expected 03 Nov 05:30 IST · q90 crosses 250 µg/m³            │
│                                          [ OPEN CASE → ]            │
└─────────────────────────────────────────────────────────────────────┘

┌─ WHAT HAPPENS NEXT ─────────────────────┬─ WHY ────────────────────┐
│  PM2.5 µg/m³                            │ Wind      2.1 → 0.2 m/s  │
│  ── observed (24 h)  ── central  ▨ q90  │ PBL      1785 → 20 m     │
│  ─ ─ 250 severe threshold               │ Vent     3695 → 28 m²/s  │
│  ▲ first crossing 03 Nov 05:30          │ Plume    8.8 ↑ 1083 det. │
│  [now │ ]                               │ → Accumulation risk      │
└─────────────────────────────────────────┴──────────────────────────┘

┌─ WHEN ──────────────────────────────────────────────────────────────┐
│ now → collapse +6 h → minimum +35 h → peak risk +38 h → recovery +47│
└─────────────────────────────────────────────────────────────────────┘

┌─ SPATIAL COVERAGE ──────────────────────┬─ ACTION ─────────────────┐
│ (live: 77 stations banded)              │ HIGH PRIORITY            │
│ (replay: composite + why)               │ 5 measures · GRAP Stage  │
└─────────────────────────────────────────┴──────────────────────────┘

Known limits (4) ▸        REPLAY — reconstructed as of 02 Nov 2024 06:00 UTC
```

Specific edits:
- Headline to 18–20 px (it is 14 px and is the most valuable string on the page).
- Chart: y-domain `[0, max(300, upper_max * 1.15)]` so the 250 line is always in frame and
  the band label stops clipping to "ation window". Mark the crossing. Draw observed history.
- Legend: add model versions (`central__20241101 · upper__20241101`).
- Rule citation line under the status card, from `provenance.warning_rule.validated_by`:
  *"Rule: q90 ≥ 250 µg/m³ for ≥ 6 h — 9 of 13 episodes anticipated, median 68 h lead,
  87 % alert burden."* Show the burden. Hiding it is worse than showing it.
- Rename "Spatial outlook" → "Spatial coverage"; "Top areas at risk" → "Highest PM2.5 now".
- Translate the provenance string; keep the raw form in a tooltip.
- Delete the dead `SpatialPanel` SVG (~100 lines) and 5 unused lucide imports.

### 3.2 Ventilation Outlook — the "why" screen, not a second dashboard

Today it is a full parallel dashboard with its own status row, its own stat cards, its
own source cards and its own timeline — which is why it competes with the Outlook. Cut it
back to the one question it owns: **why is dispersion failing, and how well do we know
the line we drew?**

```
VENTILATION OUTLOOK                    why dispersion is failing · Delhi NCR

┌─ VENTILATION COEFFICIENT ───────────────────────────────────────────┐
│ PBLH × wind₁₀ₘ                                                      │
│                                                                     │
│    332.8 m²/s          465.9 m²/s          BELOW OPERATING POINT    │
│    current             operating point     18 of last 24 h below    │
└─────────────────────────────────────────────────────────────────────┘

┌─ 72-HOUR VENTILATION ───────────────────────────────────────────────┐
│  [large chart · collapse zone shaded · threshold line labelled]     │
│  adaptive y-max, so the trace is not a flat line at the axis        │
└─────────────────────────────────────────────────────────────────────┘

┌─ WHY IS DISPERSION DETERIORATING? ──────────────────────────────────┐
│ Boundary layer  1785 → 20 m     ↓   the mixed layer stops growing   │
│ Wind            2.1 → 0.2 m/s   ↓   less transport out of the box   │
│ Ventilation     3695 → 28 m²/s  ↓                                   │
│ → Expected consequence: pollutant accumulation                      │
│                                                                     │
│ Solar heating grows the mixed layer by day; after sunset it         │
│ collapses below 100 m. Tonight the daytime rise is forecast to      │
│ fail — that is the episode mechanism.                               │
└─────────────────────────────────────────────────────────────────────┘

┌─ OPERATING POINT — HOW WELL DO WE KNOW THIS LINE? ──────────────────┐
│                     hit rate    false alarm    n                    │
│ Training              0.61          0.19      143 episodes          │
│ Held-out              0.20          0.50       11 episodes          │
│ AUC (training) 0.736 · 48 h outcome window                          │
│ Derived from 5 winters in which 64 % of in-season hours rest on     │
│ two or fewer PM2.5 stations. A starting operating point, to be      │
│ re-derived once the 2022–2025 CPCB gap is closed.                   │
└─────────────────────────────────────────────────────────────────────┘

                              [ What this means for air quality → ]
```

Removed from this page (it belongs to the Outlook): the status pill, the intervention
window card, the decision/recommendation block, the spatial panel, the two source cards
(compress to one provenance line), the standalone "Interpretation" card (fold its
sentence under the chart).

The held-out row is the single most important addition. It is the number a judge who
read the report will look for, and showing it unprompted is worth more than the 0.61.

### 3.3 Command Center — the authority screen

Today: a dropdown, a Ctrl-K hint, a policy console, and ~1,300 px of empty page. Rebuild
around cases. It must not duplicate the Outlook. **One NCR case at a time** — see
correction 0.3; the space a multi-case queue would have taken is filled by case history,
which is the audit trail.

```
COMMAND CENTER                                     Delhi NCR · one airshed

┌─ NOW ───────────────────────────────────────────────────────────────┐
│ ● PREDICTIVE WARNING · 1 case awaiting approval · act by 17:30 IST  │
│ 71/71 stations reporting · last decision 14:20 by A. Sharma         │
└─────────────────────────────────────────────────────────────────────┘

┌─ ACTIVE CASE · HIGH PRIORITY ───────────── AWAITING APPROVAL ───────┐
│ Severe episode forecast · 18 h lead · act by 17:30 IST              │
│                                                                     │
│ REASONS            Observed PM2.5 129 ≥ 120 episode threshold       │
│                    Ventilation < 466 m²/s for 52 h from 12:00       │
│                    q90 crosses 250 for 53 h from 03 Nov 00:00       │
│                                                                     │
│ EVIDENCE           PM2.5 · Ventilation · Meteorology · Plume  [view]│
│ POLICY             GRAP Stage II — 5 measures, CAQM/DPCC     [cite] │
│ BASIS              Rule validated on 13 episodes · 9 anticipated    │
│                    Model central__20241101 · ERA5 replay            │
│                                                                     │
│ MEASURES           ☐ Mechanised sweeping + sprinkling  (Stage I §3) │
│                    ☐ C&D dust enforcement             (Stage I §1) │
│                    ☐ ...                                            │
│                                                                     │
│ AUTHORISATION      Officer [__________]  Note [_______________]     │
│                    [ APPROVE ]  [ REJECT ]                          │
│                    Identity is self-declared in this build.         │
└─────────────────────────────────────────────────────────────────────┘

CASE HISTORY   (table: as_of · opened · status · priority · officer · decided at)
               — the audit trail, and what fills the page instead of a fake queue
POLICY LIBRARY (collapsed — 4 documents, retrieval requires Pathway)
```

- Monitoring Control card: collapse 380 px → one 48 px row.
- Station deep-dive moves behind a link, out of the primary flow.
- Station page: hide the panels that are permanently empty in direct mode (5-min linear
  regression forecast, AI interpretation, RAG advisory, FIRMS NOT_POLLED, carbon).
  Empty panels that look broken are worse than absence.
- Remove the legacy "AQI ≥ 300 × 3 windows · 3-min sliding" persistence UI: with hourly
  CAQM data it describes six minutes of the same value, and it contradicts the 6-hour
  sustained rule the Outlook uses. **Two escalation logics on one product is the first
  question a judge asks.**
- Fix the escalation log: `fallback_engine` writes `"station"`, the API filters on
  `"city"` → blank names, empty per-station timelines. Also suppress the 16 startup
  `None → Stage I` artefacts (seed the state machine with the first reading).

### 3.4 National Overview — situational awareness only

Keep it as the "what is happening now" screen. After Phase 0 removed the fakes:
- Rename "NATIONAL ENVIRONMENTAL MAP · across India" → "Delhi NCR monitoring network";
  centre `[28.6, 77.2]` zoom 9, `maxBounds` to the NCR box. It shows 71 NCR stations.
- One legend for one encoding: markers coloured by CPCB AQI band; freshness moves to the
  ring stroke (solid / dashed / hollow) and is named in the legend.
- Proportional symbols: hard-edged circle, radius 4–14 px scaled by PM2.5, colour by the
  backend's CPCB `band` string (see correction 0.4). No blurred halo — it reads as a
  modelled plume extent that does not exist. Caption: **"Observed spatial field — not a
  spatial forecast."**
- Add a single strip at the top linking to the Outlook: status pill + headline + act-by.
  That is the only place the two screens overlap, and it is a pointer, not a duplicate.

---

## Phase 4 — Live continuity (0.5 day)

The live forecast needs PM2.5 lags at 0, 1, 3, 6, 12, 24 h. If `capture.py` is not
running it returns HTTP 424 within a day. No scheduled task is registered on the demo
machine; today's capture already has a gap at 10:00 UTC.

| # | Change | Detail |
|---|---|---|
| 4.1 | **Capture inside the API process** | Background thread in `api/main.py` lifespan: `capture.snapshot(conn)` hourly + once on boot, then `target.cmd_build`. No new dependency; survives as long as the API does. |
| 4.2 | **Belt and braces** | Also register the Windows Task Scheduler entry the README claims exists. |
| 4.3 | **Gap backfill on boot** | If the newest captured hour is > 2 h old, call `capture.cmd_bootstrap(days=2)` (OpenAQ hourly) to refill lags. |
| 4.4 | **Stale-serve for Open-Meteo** | Cache the last good forecast run with its `issued_at`; on failure serve it flagged `"stale_run": true` instead of 503. |
| 4.5 | **`forecast_days=4`** | `weather_stream.fetch_forecast` uses `(hours+23)//24 = 3`, so a 17:00 issue leaves 55 h. Request 4 days, slice to 72. |
| 4.6 | **`?at=` before the first model** | Returns HTTP 500 with a raw `RuntimeError`. Catch in `load_for()` → 404 `no_model_for_date` with the hint. |
| 4.7 | **Retrain** | `python train_forecast.py --train-end 2026-09-01` including captured live hours. Then state the train/serve target mismatch openly rather than letting a judge find it: trained on a single-monitor series, serving an 80-station median. |

---

## Phase 5 — Demo rehearsal (0.5 day)

**Hero scenario: 02 Nov 2024 06:00 replay.** It is the only preset that shows
PREDICTIVE_WARNING from clean-ish air with an 18 h lead and a full case.

Run order:
1. **Live (anchored)** — 30 s. Establishes that it is real and honest about data age
   ("issued 17:00, anchored to the latest observation at 15:00").
2. **Click 02 Nov 2024** — the hero. Status → mechanism (3695 → 28 m²/s) → chart crossing
   → act-by → measures with clauses.
3. **Open case → Approve** — with an officer name. Reload; the case persists.
4. **Paste `?at=2024-11-02T06:00:00Z` in the address bar** — same numbers, proving
   reproducibility rather than asserting it.
5. **Known limits** — open it deliberately. This is the credibility moment.

Backup: the four JSON payloads saved to disk + a recorded video. If the network is down,
replay still works (it reads the store); live does not.

**Checklist before submission**
- [ ] `python -m backend.tests_contract` passes
- [ ] New tests pass: GRAP table agreement, `find_collapse`, `sustained_runs`,
      `merge_runs`, `status_for` (all four states), `load_for` leakage guard,
      replay determinism (same `as_of` → identical payload)
- [ ] `requirements.txt` has `lightgbm`, `requests`, `pyarrow` (a fresh clone currently
      cannot run the forecast)
- [ ] Fresh clone of the branch → `pip install -r` → both processes → all five pages
- [ ] Every screen in live + all three replays; no false label
- [ ] `ab -n 50 -c 12` p95 < 500 ms

---

## Sequencing

| Phase | Work | Days | Gate |
|---|---|---|---|
| 0 | Stop the bleeding | 0.5 | No screen states an unproven fact |
| 1 | Contract additions | 1.0 | Replay is self-consistent; p95 < 500 ms |
| 2 | Approval + policy basis | 1.0 | A case can be approved and survives restart |
| 3 | Four screens | 1.5 | Officer answers all 15 questions in 60 s |
| 4 | Live continuity | 0.5 | Live forecast survives 48 h unattended |
| 5 | Rehearsal | 0.5 | Fresh clone runs the full demo |

**5 days.** If there are only two: Phase 0 + 1.1 + 1.3 + 2 (approval) — that is the
minimum that makes the existing strengths defensible.

## Explicitly out of scope

Spatial forecasting · CAMS/WRF-Chem provider · authentication beyond a name field ·
Postgres migration · live FIRMS into the store · map clustering · station-page redesign
beyond hiding dead panels · Gemini SDK migration.

Each is a real gap; none of them changes whether the product survives the panel, and
every one of them competes with the five days above.

## Claims this plan does not enable

Building all of it still does not license: WRF-Chem · two-way coupling · a validated
aerosol–PBL feedback coefficient · "72-hour accuracy X %" · real-time · spatial
forecasting · stubble attribution · a validated 466 m²/s threshold (held-out hit 0.20) ·
security controls · "autonomous".

The plan's purpose is the opposite: to make the screens say only what the report proves,
so that the things that *are* proven — 9 of 13 episodes anticipated at 68 h median lead
against 0 of 13 for both baselines, leakage-proof replay, and a falsified hypothesis
retired in writing — are believed.
