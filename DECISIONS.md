# AREE — Engineering Decision Record

Every change made in the hardening pass, why it was made, and what it cost.
Reference document: read this before changing anything it describes.

**Scope:** commits `768c46d` (Refactored backend) and `1194cd1` (MVP Completed).
**Inputs:** `../AREE_SIH26082_Audit.pdf` (external audit, 59/100) and
`IMPLEMENTATION_PLAN.md` (the plan those findings produced).

**The single organising principle**

> The product must say only what the code can prove.

Almost every decision below follows from it. AREE's differentiator is lead time backed
by evidence; the moment a screen states something the engine cannot support, the
evidence claim collapses and the differentiator goes with it. That is why a
disproportionate share of this work was *deletion and relabelling* rather than features.

---

## 0. What the audit found

Score 59/100, DEMO READY, ten criticals. Condensed:

| # | Finding | Where |
|---|---|---|
| 1 | GRAP stage table off by one stage on every station screen | `config.GRAP_STAGES` |
| 2 | Landing page carried fabricated events and hard-coded health rows | `NationalPanels.tsx` |
| 3 | Replay leaked the present — 2026 stations inside a 2024 reconstruction | `intelligence.exposure()` |
| 4 | No approval workflow — `AWAITING_APPROVAL` was a string | decision layer |
| 5 | Live forecast dies within 24 h without a manual capture run | `capture.py` |
| 6 | Replay meteorology is ERA5 reanalysis, labelled as forecast | `pm25_forecast` |
| 7 | Training skill labelled "validation" | Ventilation page |
| 8 | The demo layer was uncommitted | git |
| 9 | Ventilation page contradicted itself in its first row | `VentilationOutlook.tsx` |
| 10 | "WAQI / Pathway / FIRMS verified / live policy index" false in the running mode | everywhere |

---

## 1. Two corrections to the plan, made before building

### 1.1 There are four states, not three

`streaming/predictive_engine.py::status_for()` emits, in this precedence:

```python
if pm25 >= 250:    return "SEVERE_EPISODE_UNDERWAY"
if forecast_risk:  return "PREDICTIVE_WARNING"
if pm25 >= 120:    return "EPISODE_UNDERWAY"      # the one the UI had no branch for
return "MONITOR"
```

`EPISODE_UNDERWAY` is reachable and operationally meaningful — elevated but not Severe,
nothing forecast. The dashboard branched on three, so this case fell into the calm
default and rendered *"Conditions are stable and dispersion is adequate"* over Very Poor
air. **Every status table in the system now carries four rows.**

Naming note: the fourth value is `MONITOR`. `"NO ESCALATION"` is
`recommendation.call`, a different field — they were being conflated.

### 1.2 The precedence rule was already right

`SEVERE_EPISODE_UNDERWAY` is tested *before* `forecast_risk`, so a continuing episode
never re-reports as a new warning. That is the "continuation is not a new warning"
distinction, already correct in the engine. The consequence for the UI is a rule:

> **The frontend reads `risk.status`. It never derives a state from `forecast_risk`,
> `triggered`, or a threshold comparison.**

A UI that re-derives will eventually disagree with the decision it is displaying.

---

## 2. Temporal integrity

The forecast layer was already leakage-proof by construction — models are named for the
last date they were allowed to see and `load_for()` only offers files with
`train_end <= as_of`. **The presentation layer undid that guarantee**, which is exactly
where a reviewer looks.

### 2.1 `exposure()` respects `as_of`

`api/routes/intelligence.py`

| | |
|---|---|
| Was | `exposure(conn, limit)` read `MAX(timestamp)` from the live capture, ignoring which moment the caller described |
| Now | `exposure(conn, as_of, limit)` reads the newest station hour **at or before** `as_of` |
| Bound | `EXPOSURE_MAX_AGE_HOURS = 3`, reusing `ncr_observations.MAX_READING_AGE_HOURS`' reasoning — beyond that it is not "where it is worst now" |
| Fallback | `_exposure_composite_only()` returns `kind: "composite_only"` with the monitor count **read from `station_readings.n_stations`**, never assumed |

**The empty state was made a feature, not hidden.** A 2024 replay now says:

> *No station-level record for 02 Nov 2024 06:00 UTC. The target for this hour is an NCR
> composite of 1 monitor. Station-level capture begins Sept 2026.*

That puts C0 — the target-integrity finding, the most rigorous thing in the engineering
report — on screen instead of in a PDF, and it is a better panel than a wrong map.

### 2.2 The observation contract

`forecast/pm25_forecast.py::observation_series()` returned `(value, tag)` per hour. The
tag said which family the data came from but not how many instruments stood behind it,
so the API had nothing honest to publish and the dashboard filled the gap with whatever
count happened to be current.

Now returns `{pm25, source, target, n_stations}`:

| Scene | target | n_stations | label |
|---|---|---|---|
| Replay 02 Nov 2024 | `legacy` | **1** | Legacy NCR composite (research series) |
| Live | `network` | 78 | Network median across reporting stations |

`n_stations` is **null** where the store does not record it. A null station count is a
true statement; a plausible one would not be. `VentilationOutlook` was reading
`exposure.n_stations` — today's network size — beside a 2024 value; it now reads
`observation.n_stations`.

### 2.3 Status presentation moved to the backend

`STATUS_PRESENTATION` + `status_presentation()` in `intelligence.py` compose
`status_label` / `status_short` / `status_tone`. Four tones:
`critical | warning | elevated | calm` — deliberately four, not the three used by
`recommendation.tone`, because an episode under way is a different signal from a warning
about one that has not started.

Unknown states surface rather than default: falling back to the calm branch would hide a
new state behind a green pill.

`narrative()` also gained its missing `EPISODE_UNDERWAY` branch.

### 2.4 The test that pins it

`backend/tests_temporal.py` — walks **every timestamp in the payload** and asserts
nothing observed postdates `as_of`; that live and replay carry identical top-level shapes
(proving one code path); that replay is byte-identical when repeated; and that all four
states are presentable.

It immediately caught one thing — **a test bug, not a product one**:
`risk.supporting_points[].valid_at` are forecast valid-times, legitimately ahead of the
anchor. The exclusion is now any `valid_at`, since observed instants use different key
names (`observed_at`, `as_of`, `checked_at`).

---

## 3. Information hierarchy

The Atmospheric Outlook was reordered into the officer's question sequence. The decision
used to sit ~1,100 px below the fold.

```
01  WHAT IS HAPPENING?              observation · status · where
02  WHAT HAPPENS NEXT?              72 h central + upper-tail
03  WHY?                            wind → boundary layer → ventilation → plume
04  WHEN DOES RISK CROSS?           crossing · lead · sustained · intervention window
05  WHAT SHOULD THE AUTHORITY DO?   measures · priority · approval
```

The section numbers are the only numbered thing on the page, because it is the only
thing that is genuinely a sequence — each step depends on the one above.

**One status → one UI state.** `STATUS_STYLE` in `OutlookView.tsx` is the single place
that maps a backend tone to ink. `MechanismCell` takes the page tone instead of
hardcoding red — a MONITOR day at 44 µg/m³ was rendering "Deteriorating" in alarm colour
beside "Conditions are stable", which trains a reader to ignore the page. The boundary
layer collapses every winter night; if that is red every night, red stops meaning
anything.

### Colour ordering — a deliberate call worth knowing about

`EPISODE_UNDERWAY` (orange) reads **hotter** than `PREDICTIVE_WARNING` (amber).

Rationale: an episode already under way is certain harm now; a predictive warning is
forecast harm. And q90 sits in a warning state 87 % of issue times — making it the
loudest colour would have the page shouting most of the winter.

The predictive case earns prominence **structurally** instead: the lead-time chip, the
18 px headline, and the crossing sentence. Colour ranks certainty; layout ranks
actionability. This is a one-line change in `STATUS_STYLE` if the trade is ever revisited.

---

## 4. Spatial

### 4.1 Proportional symbols replaced kilometre halos

`SpatialOutlookMap.tsx` drew a 5–15 km translucent `Circle` around every station, sized
by band. On screen that reads as a measured plume — *"pollution extends fifteen
kilometres around Anand Vihar"* — which AREE has not modelled and cannot support.

Now: hard-edged `CircleMarker`, radius in **pixels**, `3 + √pm25 × 0.78` clamped
4.5–19. Square-root so **area** is proportional to concentration; linear radius would
make a 3× reading look 9× heavier. Caption on the card:

> *Colour = CPCB band · symbol area ∝ concentration. Size is a reading, not a modelled
> extent.*

### 4.2 One encoding per channel

Severity keeps colour; freshness moved to **border style** (solid / dashed / dotted) with
its own legend row. Previously `freshness === "unavailable"` overrode the fill to grey,
so a reader could not tell a clean station from a dead feed — and the legend listed
freshness bands while the markers were coloured by AQI. An ageing reading of 380 now
stays red and merely looks provisional.

### 4.3 `lib/cpcb.ts`

The CPCB band table moved out of the map component. It could not stay there: that module
imports `leaflet/dist/leaflet.css` and react-leaflet, which need the DOM, which is why it
is only ever reached through `SpatialOutlookMapLoader` with `ssr:false`. Importing the
table from it would have dragged Leaflet into a server render.

The table supplies **colour and range for a band name only**. Which band a station is in
always arrives from the backend. Two classifiers would eventually disagree, and the one
on screen would be the one nobody validated.

### 4.4 Framing

Both maps pinned to the NCR box (matching `ncr_observations.NCR_BBOX`) with `maxBounds`.
The National Overview was titled *"across India"* over 71 NCR stations at zoom 5.

Two bugs found only by looking at the rendered output:

- **`zoomSnap={0.25}`** — Leaflet snaps `fitBounds` to whole zoom levels, so a 1.4° box
  in a short wide card jumped a level out and framed Karnal→Alwar, twice the NCR, with
  the stations as a dot.
- **Label de-clutter** — labelling by rank alone stacked four captions on top of each
  other whenever stations clustered. A label is now skipped if an already-labelled
  station sits within ~9 km.

Marker size on the National Overview dropped 20–28 px → 14–22 px; ~30 monitors within
20 km of central Delhi were merging into one blob.

---

## 5. Charts

| Bug | Fix |
|---|---|
| Recharts' auto domain left the 250 threshold and the band label outside the plot, clipping it to *"ation window"* | y-domain covers every mark drawn — observation, both forecast lines, threshold — plus 15 % headroom |
| The accumulation band was keyed on `ist()` (`"02 Nov, 17:30 IST"`) while the X axis keys on `short` (no comma), so no category matched and Recharts collapsed the band against the left edge | Both bounds taken from the same field the axis uses |
| Mount animation meant the series had not settled | `isAnimationActive={false}` — correct anyway for a page that re-polls |

The threshold label now sits **inside** the plotting region, and the first crossing is
marked with a vertical rule.

---

## 6. Anchor selection

`pm25_forecast.forecast()` took the first hour with complete lags. That landed on an hour
served by 6 OpenAQ sensors while a full CAQM sweep of ~78 instruments sat two hours
earlier. Both are valid observations; they are not equally good targets, and the model is
asked to forecast the airshed.

Now: among anchorable hours, one whose target rests on a qualifying network is preferred.
The bar is `QUALIFYING_STATIONS = 20`, mirroring `target.MIN_VALID_STATIONS` — the count
the multi-station NCR target already has to clear — rather than a number invented here.
The trade is reported in `anchored.reason`, not hidden.

Result: live went from 6 sensors to **78 stations**.

---

## 7. The approval slice

This is the capability the architecture claimed and did not have.

### 7.1 Schema — `backfill/db.py`

```sql
cases         case_id PK · created_at · status · risk_status · priority · trigger
              jurisdiction · mode · forecast_as_of · crossing_at · recommendation_snapshot
case_actions  action_id PK · case_id FK · action · actor · actor_role
              actor_verified · timestamp · reason
```

`case_actions` is append-only. Rows are never updated or deleted: the history of a
decision is the decision.

### 7.2 Deterministic case id

```python
case_id = sha1(f"{forecast_as_of}|{jurisdiction}|{trigger_rule}")[:12]
```

Not a UUID. A replay is reproducible by construction; if its case got a fresh random id
on every request, demonstrating replay twice would create two cases for one moment and
"reproduce yesterday's decision" would produce a different record each time. Deterministic
identity also lets the decision endpoint be create-or-update without the caller having
opened anything first.

### 7.3 The endpoint recomputes rather than trusting the client

```
GET  /api/cases                     queue + counts
GET  /api/cases/{id}                case + full action history
POST /api/cases/{id}/decision       { decision, as_of, actor, actor_role, reason }
```

The body carries **who and why, never the evidence**. The server re-derives the whole
assessment from `as_of` via `outlook.compute()` and refuses if the case id that falls out
differs from the one in the path (`400 case_id_mismatch`). A caller cannot approve case X
while supplying the evidence of case Y.

Because the computation is deterministic, the snapshot stored against a decision is
provably the evidence that existed when the decision was taken — not whatever a browser
was displaying. That is the difference between an audit trail and a log of what a browser
said, and it is the strongest available answer to *"can you reproduce yesterday's
decision?"*.

### 7.4 `outlook.compute()` extracted

Two callers need forecast → ventilation → assessment → case and **must not diverge**. Two
implementations of "what did AREE conclude at time T" would eventually disagree, and the
disagreement would live inside the audit trail.

### 7.5 Terminal states

```
AWAITING_APPROVAL ──approve──> APPROVED
                  └─reject───> REJECTED
```

A decided case refuses a second decision with `409` and the current state. An audit trail
whose last write wins is not an audit trail. Reopening is deliberately absent: it is a
real workflow need *and* a real design question (who may reopen, on what grounds), and
inventing an answer would add surface without adding evidence.

### 7.6 Identity, said out loud

There is no authentication. `actor` is whatever the caller typed. Every stored action
carries `actor_verified = 0`, the API repeats it in an `identity` block, and the UI prints
*"identity self-declared, not authenticated"* beside the decision. A demo showing a name
beside a regulatory decision without that caveat would be claiming an access control that
does not exist.

### 7.7 GET stays pure

A case is opened by the decision endpoint, never as a side effect of viewing the outlook.
Reloading a page must not mint regulatory records.

---

## 8. Removing what the code could not support

| Claim | Reality | Action |
|---|---|---|
| GRAP Stage I at AQI 101–200 | CAQM: Stage I = 201–300 | Table corrected; `tests_grap.py` asserts it against `predictive_engine.GRAP_BY_AQI`. Upper bound `9999` not `500` — AQI is uncapped above 450 and a 500 bound silently returned "None" for 501 |
| "Recent Events · 09:15 Data Stale Alert" | Hard-coded array | Deleted |
| "NASA FIRMS Live · RAG Active · Policy Indexed" | API said `not_polled` / `unavailable` | Bound to `/api/system/status` |
| "Pathway pipeline · Running" | Literal string; Pathway not running | Renders `status.mode` + `degraded` |
| Footer + PDF: "Pathway streaming · WAQI direct · FIRMS verified · live policy index" | Four claims, four false in direct mode | Rendered from live status |
| "Hit rate (validation) 0.61 / FAR 0.19" | **Training** figures. Held-out is 0.20 / 0.50 (n=11) | Both rows shown, labelled; `holdout_*` added to the operating-point config |
| "WAQI sub-index" under a PM10 value of 151 | CPCB concentration in µg/m³ — a units error, not just a label | Unit from `pollutant_source`; CO called out as mg/m³ |
| "Real-time short window" | Hourly feed, 40–100 min late | *"Hourly observation, age reported per station"* |
| Replay: "Numerical weather model (72 h ahead)" | ERA5 reanalysis at valid time | *"perfect-prognosis replay"* |
| Green LIVE pill above a 2024 reconstruction | Engine liveness ≠ page mode | `OutlookModeProvider`; violet REPLAY pill with the as-of stamp |

**Not removed, deliberately:** the honest limitations. Replay meteorology is stated as
reanalysis; q90 is labelled *"upper-tail risk — NOT a prediction"*; the warning rule
carries its own validation string including the **87 % alert burden**. Hiding the burden
would be worse than showing it.

---

## 9. Live continuity

`backend/api/capture_scheduler.py` — hourly NCR capture inside the API process. No new
dependency, no service manager, no scheduled task, and it lives exactly as long as the
thing that needs it.

On boot it **measures the gap first**. A gap wider than the lag window cannot be filled by
waiting, so it triggers an OpenAQ bootstrap. Observed in practice: after the machine was
off overnight the store was 3.1 h behind and live returned `424`; the bootstrap restored
3,743 station-hours across 72 hours.

---

## 10. Sharing without deploying

### 10.1 `build_share.py` → `AREE_Demo.html`

One 158 KB file, four scenes embedded, chart and map as inline SVG, no CDN, works
offline. Hash routing (`#nov02`) so a specific moment can be linked.

**It is a snapshot and says so on every screen** — a fixed banner naming the capture time,
*"Captured live"* rather than *"Live"* on the first tab, and no clock anywhere. Shipping
the live/replay confusion back in the most shareable possible form would have undone the
whole hardening pass.

The approve control is **deliberately absent**: approval writes to an audit trail, which
needs a server. A button that appeared to record a regulatory decision into a file on
someone's laptop would be theatre.

### 10.2 Tunnel path

`next.config.ts` rewrites `/api` and `/ws` to the backend. `NEXT_PUBLIC_API_URL` is baked
into the client bundle, so it names a host the **viewer's** browser must resolve —
tunnelling the frontend alone sends every request to the visitor's own loopback.
Same-origin removes that and never exposes the API separately.

### 10.3 The bug that invalidated an earlier verification

```ts
// was
export const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "")
                       ?? "http://localhost:8000";
```

Next inlines an **empty** env var as `undefined`, so setting it blank still hit the
fallback. Every visitor's browser fetched *their own* `localhost:8000`.

**This looked correct from the developer's chair** — my test browser was on the same
machine, where a local API exists — and I reported it as verified. It was not. A remote
viewer would have seen an infinite *"Loading outlook…"* while every check the developer
ran returned 200.

Fixed: the default is now same-origin (`""`). An explicit absolute URL is still honoured.

**The lesson, recorded because it generalises:** a default that only works where the
server happens to be is worse than no default, and *verification from the machine that
runs the service is not verification.*

Related: `allowedDevOrigins` in `next.config.ts` — Next dev blocks cross-origin dev
resources, so over a tunnel the HTML arrives and every JS chunk is refused. The page
renders its shell, never hydrates, and sits on "Loading outlook…" **with the API
answering 200 the whole time**, which makes an asset problem look like a data problem.

---

## 11. API error responses

`api/main.py` forwarded only `error` / `detail` / `hint`, dropping the useful half of
every structured error: `valid` on a rejected enum, `expected` / `received` on a case-id
mismatch, `status` on a conflict. A caller was told something was wrong but not what
would be right. All extra keys are now carried through.

---

## 12. Verification

Four gates, all passing:

| Gate | Command |
|---|---|
| GRAP table agreement | `python -m backend.tests_grap` |
| Engine contract (direct vs streaming key shapes) | `python -m backend.tests_contract` |
| Temporal integrity (needs a running API) | `python -m backend.tests_temporal` |
| Types + lint | `npx tsc --noEmit` · `npx eslint src` |

Three pre-existing lint errors remain, all `react-hooks` warnings in
`OutlookView`/`VentilationOutlook` — known, unrelated to this work.

**Verification methodology, learned the hard way:** headless screenshots with
`--virtual-time-budget` dump the DOM before fetches resolve and produce false negatives.
Several "Loading outlook" failures were capture artefacts. The backend access log settled
each one — requests were arriving and returning 200 throughout. *When a UI check and a
server log disagree, believe the log and fix the check.*

---

## 13. Known debt

Carried deliberately, in rough priority order:

1. **No authentication.** Anyone reaching the API can approve cases and upload policy
   documents. Acceptable for a laptop demo; blocking for anything else.
2. **Live model is stale** — trained to 2024-11-01 on a single-monitor target, serving an
   80-station median. The train/serve target mismatch is unmeasured.
3. **q90 is uncalibrated.** It is a name, not a verified quantile.
4. **No spatial forecast.** The PM2.5 forecast is one point at the NCR centroid; the map
   is observation only, and says so.
5. **Live plume always "None"** — `fire_events` stops at 30 Nov 2024; live FIRMS is never
   written to the store.
6. **Inversion effectively unavailable** — the ERA5 archive serves surface fields only;
   pressure levels exist for ~92 days.
7. **Two escalation logics** — the legacy 3-minute-window persistence engine still runs
   beside the 6-hour rule and appears on station pages.
8. **Measures are priority-indexed**, not GRAP-stage mapped and not cited to the schedule.
   `grap_measures.json` was planned and not built.
9. `requirements.txt` is missing `lightgbm`, `requests`, `pyarrow` — a fresh clone cannot
   run the forecast.
10. SQLite with a per-request connection; no case pagination.

---

## 14. Claims this work does **not** license

Building all of the above still does not support:

**WRF-Chem · two-way coupling · a validated aerosol–PBL feedback coefficient ·
"72-hour accuracy X %" · real-time · spatial forecasting · stubble attribution ·
a validated 466 m²/s threshold (held-out hit 0.20) · security controls · "autonomous"**

The purpose throughout was the inverse: make the screens say only what the report proves,
so that what *is* proven — 9 of 13 severe episodes anticipated at 68 h median lead against
0 of 13 for both baselines, leakage-proof replay, and a falsified hypothesis retired in
writing — gets believed.

---

# 15. Phase 1 — hot-path bounding and the outlook cache

Scope discipline for this phase, as set: no model changes, no warning-rule
changes, no UI redesign, no new features. Everything below is storage-access and
caching. The scientific output is byte-identical, and that was verified rather
than assumed.

## 15.1 The problem, restated from measurement

Phase 0 measured three queries that loaded the whole table to use a handful of
rows. They were not slow because SQLite is slow; they were slow because they had
no reason to stop reading.

| Query | Rows loaded | Rows actually needed |
|---|---|---|
| `observation_series()` | 30,068 | ~31 |
| `load_met()` | 39,624 | 80 |
| `baselines.load_observations()` | 29,953 | ~31 |

The cost was paid on every request, and it grows with the store. At the scale
this repository is being prepared for, that is the difference between a system
that gets slower as it collects more evidence and one that does not.

## 15.2 Correction to the Phase 0 report

`baselines.load_observations()` was listed in the findings register as a hot-path
query. **It is not on the request path.** No module reachable from a route calls
it; the callers are scoring, diagnostics and training. Phase 0 measured it
because the benchmark called it directly, and the report did not check
reachability before listing it.

It has still been given an optional window, because a slice-reader should not be
forced to load 29,953 rows, but that is hygiene for the offline path and **not**
a request-path improvement. The before/after table below states this rather than
quietly counting it as a win.

## 15.3 The window is derived, not chosen

    OBSERVATION_WINDOW_HOURS = MAX_ANCHOR_BACKOFF_HOURS + max(PM_LAGS) + 1

Written as an expression over the two constants that actually determine it, not
as a literal. A literal would have been correct on the day it was written and
silently wrong the first time either constant moved — the failure mode being a
forecast that reports missing lags for hours it could previously serve.

The three reads a forecast performs, and the exact span each needs:

| Read | Window | Why that span |
|---|---|---|
| observations | `[as_of - 31 h, as_of]` | live anchoring may step back 6 h, and every candidate hour needs its own lags out to 24 h |
| meteorology (replay) | `[as_of - 6 h, as_of + 73 h]` | read at **valid** time; leads run 1..72 from an anchor that may have stepped back |
| meteorology (live) | n/a | comes from Open-Meteo, not the store |

All three are index-backed range scans on structures that already existed — the
`(station_id, timestamp)` and `(grid_id, timestamp)` primary keys and
`ix_readings_time`. **No index was added.**

## 15.4 The bound is a restatement of the temporal contract

`until=as_of` is not a performance parameter. The rule that an `as_of` forecast
may not see an observation newer than `as_of` was previously upheld by every
downstream lookup happening to be keyed at or before `as_of` — true, but a
property of the arithmetic rather than of the data access. It is now enforced at
the point of reading.

Meteorology is the deliberate exception and reads **forward**, to `as_of + 73 h`.
That is perfect prognosis and is the one place where reading ahead is correct:
pollution features are at or before issue time, meteorological features are at
valid time. The asymmetry is the design.

Verified, not asserted — for each replay case: newest observation returned is
`<= as_of`; `forecast.as_of` is unmoved; every `valid_at` is strictly ahead of
`as_of`; every per-point `as_of` matches the requested moment.

## 15.5 Every window is optional, defaulting to unbounded

Training and scoring legitimately walk the entire record. Both callers pass
nothing and get exactly the previous behaviour, byte for byte. Confirmed by
running the unbounded path afterwards: still 30,068 rows.

## 15.6 The cache: what it does and does not cover

`backend/api/cache.py`, wrapping `outlook.compute()` — the only expensive pure
function in the request path.

**Cached:** forecast → ventilation → assessment → case proposal. Pure in
`(as_of, lat, lon, grid, hours)` and the store contents. It writes nothing:
viewing an outlook must never mint a regulatory record.

**Deliberately not cached — the persisted case status.** It is read fresh by
`case_store.status_of()` in the route, after the cache returns. Folding it in
would let an officer who just approved a case keep seeing "awaiting approval"
until the entry expired. A cache that turns a decided case back into an open one
is a correctness failure, not a performance detail. This split is the reason
`compute()` was the right cache boundary and the route was not.

**Deliberately not cached — the case-decision endpoint.** `cases.py` calls the
uncached `compute()`. That call decides what an approval is recorded against; a
cached value is a claim that nothing relevant changed, and an audit trail should
not rest on that claim when being certain costs one recomputation on a rare POST.
Annotated in the source so it is not "optimised" later.

## 15.7 Not keyed by URL

Two requests to `/api/aree/outlook` with no `at` are the same URL and not the
same question — one may be asked before the hourly capture lands and one after.
Keying on the URL would pin the live outlook to whatever the store held the first
time anyone asked.

The key is `(as_of, lat, lon, grid, hours, data_version, model_version)`.
`as_of=None` is kept distinct from any explicit timestamp: collapsing them would
let a replay answer a live question.

- **data version** — `MAX(timestamp)` over `station_readings`, plus size and
  mtime of the database file **and its WAL sidecar**. Under `journal_mode=WAL` a
  commit lands in the sidecar first, so the main file's mtime alone can lag.
- **model version** — file count and newest mtime of the model directory, so a
  retrain invalidates every replay answer computed with the old booster.

TTL is a backstop only: 60 s live, 600 s replay. Replay is a statement about a
fixed past, and the only things that can legitimately change it move a token.

### Rejected: COUNT(*) in the version token

The first implementation used `(MAX(timestamp), COUNT(*))`, COUNT being there to
catch a backfill inserting purely historical rows that MAX cannot see. SQLite
keeps no stored row count, so that scans an index — **3.24 ms at 37k rows, and
linear from there.** Putting an O(n) scan on the hot path to protect a cache is
precisely the mistake this phase exists to remove; it would simply have
reappeared at a larger row count.

Two `stat()` calls answer the same question in O(1) and are strictly *more*
sensitive — they move on any write, including one that changes neither the max
nor the count. Measured: **3.24 ms → 0.23 ms**, and it stops growing.

The token errs toward over-invalidation. Being too sensitive costs a
recomputation; being not sensitive enough means serving an outlook that ignores
data that has arrived. Those are not symmetric.

## 15.8 Concurrency

The producer runs **outside** the lock. Holding it across a computation would
serialise every concurrent request behind the first, turning a cache into a
queue. The cost is that simultaneous misses on one key may compute twice; both
produce the same value, so the duplicate is wasted work and never a wrong answer.

Every value crossing the boundary is deep-copied, in both directions. Handing out
the stored object would let one request's downstream mutation corrupt what the
next request sees — the classic way a cache starts inventing data. Measured at
26 ms cumulative across 145 calls; irrelevant beside an 80 ms recomputation.

`AREE_OUTLOOK_CACHE=off` disables it entirely, and cache-off output was verified
identical to cache-on.

## 15.9 Results

Same benchmark as Phase 0, same machine, median of repeated runs.

| Component | Before | After | Note |
|---|---|---|---|
| `observation_series()` | 233 ms / 30,068 rows | **0.3 ms / 30 rows** | request path |
| `load_met()` | 345 ms / 39,624 rows | **0.9 ms / 80 rows** | request path |
| `baselines.load_observations()` | 162 ms / 29,953 rows | **0.4 ms / 30 rows** | *not* on the request path |
| `forecast()` end to end | 1,267 ms | **77 ms** | |
| outlook compute, cold | — | **80 ms** | |
| outlook compute, warm | — | **1.9 ms** | |
| 12 concurrent, cold cache | ~11,500 ms/req | **650–2,000 ms/req** | high variance, see below |
| 12 concurrent, warm cache | — | **108 ms/req** | |

Unbounded reads still return 30,068 rows, so the training path is untouched.

### Honesty about the concurrency number

Cold 12-way concurrency measured 648, 1,168 and 2,016 ms/request across three
identical runs. That spread is real and is reported as a range rather than as its
best member. The cause is visible in the profile: with the cache cold, twelve
threads each perform 144 individual Python-level `booster.predict()` calls and
contend on the GIL.

## 15.10 What the profile now says is next

A cold compute, profiled:

| Cost | Time | Share |
|---|---|---|
| 144 single-row `booster.predict()` calls (72 leads × 2 models) | 244 ms | ~66% |
| Loading 2 boosters from disk (`load_for`) | 91 ms | ~25% |
| SQL | absent from the profile | — |

SQL has left the top of the profile entirely, which is the result this phase was
after. The next performance lever is **finding 0.9 — batch inference**: one
`predict()` over a 72-row matrix instead of 72 calls per model. That is scheduled
for Phase 7 and is not being done here, because this phase changes no model code.
Booster caching is the second lever and belongs with it.

## 15.11 Verification performed

| Check | Result |
|---|---|
| Scientific output vs pre-change golden, 3 replay cases | 3,274 fields **identical** |
| Cache hit vs cache miss | identical, all 3 cases |
| Cache off vs cache on | identical |
| Wall-clock stamps (`assessed_at`/`opened_at`/`generated_at`) | differ, as they must — excluded by name, not by loosening the diff |
| Temporal guard: newest observation `<= as_of` | holds, 3/3 |
| `as_of` / `valid_at` / per-point `as_of` unmoved | holds, 3/3 |
| Cache invalidates on a real write from a second connection | verified — recomputed, did not serve stale |
| Request-path SQL against a growing table | 10 statements, **0 unbounded** |
| Training path (unbounded reads) | unchanged, 30,068 rows |
| `tests_grap` / `tests_contract` / `tests_temporal` | PASS / PASS / PASS |
| `tsc --noEmit` | PASS |
| `eslint` | same 3 pre-existing `react-hooks` errors, no new ones |

The first golden comparison reported a regression. It was comparing
`assessed_at` and `opened_at`, which are `datetime.now()` and must differ between
runs. The comparator was wrong, not the code — but the fix was to exclude those
three fields **by name** and diff everything else field by field, rather than to
loosen the comparison until it passed.

---

# 16. Phase 1 postscript — a regression the Phase 1 gate did not catch

Before Phase 2's own findings, an honest correction.

**The Phase 1 cache change broke `/api/aree/outlook` over HTTP, and the Phase 1
gate reported PASS anyway.**

`compute_cached()` was inserted immediately above `def outlook(...)` — which put
it *between* `@router.get("/aree/outlook")` and the function that decorator was
meant to apply to. Python duly decorated the helper. The result:

- `/api/aree/outlook` was served by `compute_cached(conn, as_of, ...)`, so FastAPI
  tried to read a database connection from the query string and answered
  **422 `query.conn: Field required`** to every request.
- `outlook()` became an ordinary function that no URL reached.

## 16.1 Why every check missed it

`tests_grap`, `tests_contract`, `tests_temporal`, the 3,274-field golden
comparison, the cache hit/miss equivalence, the concurrency benchmark — all of
them called `O.outlook(...)` and `O.compute_cached(...)` **as Python functions**,
where both behave perfectly. Not one opened a socket.

The bug surfaced only in Phase 2, when the fresh-environment gate finally issued
a real HTTP request.

The lesson is narrow and worth stating plainly: **calling the handler is not
calling the endpoint.** A test that imports the module and invokes the function
verifies the function. It says nothing about whether any URL reaches it.

## 16.2 What was done about it

1. **Fixed** — the decorator moved back onto `outlook()`, `compute_cached()` above
   it. Verified over HTTP: 200, `mode=replay`, correct case id.
2. **Re-verified** — the 3,274-field golden comparison still identical, all four
   suites pass. The Phase 1 performance results stand; only the wiring was wrong.
3. **Guarded** — `backend/tests_routes.py`, new. It asserts each critical path is
   served *by the intended handler*, not merely that the path exists, because the
   path did exist — it was bound to the wrong function. It also fails if any
   endpoint exposes an internal name (`conn`, `state`, `engine`) as a request
   parameter.

   Proven against the defect rather than assumed: the bug was reintroduced
   deliberately, the guard failed on both checks
   (`served by 'compute_cached_api_aree_outlook_get'` and `exposes 'conn' as a
   query parameter`), and the tree was restored.

   A note in that file records why it reads `api.openapi()` rather than walking
   `api.routes`: this FastAPI version stores included routers as lazy
   `_IncludedRouter` wrappers, so the obvious implementation sees 2 routes out of
   30 and passes by accident — the same failure mode it exists to prevent. The
   first version of the guard made exactly that mistake.
4. **Closed the gap in the gate** — the runtime gate now makes real HTTP requests
   over a socket as its final step.

---

# 17. Phase 2 — dependencies and a reproducible runtime

## 17.1 What the declared set actually described

`backend/requirements.txt` declared 15 packages. Measured against the environment
where the application demonstrably runs and passes its tests:

| Declared | Installed in the working environment |
|---|---|
| `pathway==0.29.1` | **not installed** |
| `sentence-transformers==2.6.1` | **not installed** |
| `unstructured~=0.18.1` | **not installed** |
| `docling` | **not installed** |
| `tiktoken>=0.5` | **not installed** |
| `pdf2image` | **not installed** |
| `codecarbon==2.3.5` | **not installed** |
| `python-docx>=1.1` | **not installed** |
| `torch` (added by the Dockerfile) | **not installed** |
| `numpy==1.26.4` | 2.5.2 |
| `reportlab==4.2.2` | 5.0.1 |
| `google-generativeai==0.3.2` | 0.8.6 |

So the file did not describe this system. It described a heavier one that was
never realised — and anyone building from it received several GB of OCR and
embedding machinery the request path never touches, plus three version
conflicts, plus a Linux-only constraint from Pathway's wheels.

Meanwhile the README's hand-written install line omitted **lightgbm**. Following
the documented instructions produced an environment in which the forecast — the
central feature — could not run.

## 17.2 How the classification was decided

Not by reading the file and guessing. Two independent methods, cross-checked:

1. **Runtime introspection** — import the API as uvicorn does, exercise the
   request path, diff `sys.modules`, map modules to distributions.
2. **Static AST scan** — every `import` in the repository, grouped by area, to
   catch anything reached only on a branch that introspection did not take.

Where they disagreed, the code was read. Three findings came out of that:

- **`rag`, `llm_engine` and `report_generator` are imported lazily**, inside
  functions in `api/engine.py`, so they are absent from startup.
- **In direct mode the Pathway path is never reached at all.** `rag_state()` and
  `scan_policy_files()` return early with "Policy RAG requires the Pathway
  runtime", listing policy files without embedding them.
- **`llm_status()` wraps its import in `try/except`**, returning
  `{"ready": False, "error": ...}` on failure.

## 17.3 Gemini is optional, and that is a finding, not a preference

The brief asked specifically whether Gemini is required. It is not.

Its only entry point is exception-guarded, so a missing package is reported
through the same channel as a bad API key. Nothing in the decision chain depends
on it: the forecast, the ventilation assessment, the four-state status, the GRAP
mapping and the case workflow are all computed without it. It writes prose about
a conclusion already reached.

Making it mandatory would let a third-party LLM outage stop a regulatory system
that does not need the LLM to function. It is `requirements-llm.txt`.

## 17.4 Why requirements files and not pyproject.toml

The brief suggested `pyproject.toml` and said not to choose it merely because it
was suggested. It was not chosen, for a concrete reason.

The backend is **not an installable package**. `api/engine.py` inserts
`backend/` onto `sys.path` at import time so that flat imports like
`from config import ...` resolve, and it is run as
`uvicorn backend.api.main:api` from the repository root. A `[project]` table
would declare dependencies for a distribution that is never built or installed —
correct-looking metadata describing something that does not exist.

Making it real means restructuring imports, which is explicitly out of scope
("don't change the directory structure for deployment yet"). Requirements files
describe exactly what they claim: sets of packages to install. They are also
what the Dockerfile already consumes.

Revisit when the backend becomes a real package; that is a structural decision,
not a dependency one.

## 17.5 The split

All five live in `backend/`, so the existing Dockerfile path stays valid and no
directory structure changes.

| File | Contents | Evidence |
|---|---|---|
| `requirements.txt` | fastapi, uvicorn[standard], python-multipart, pydantic, lightgbm, numpy, requests, urllib3, python-dotenv, reportlab | **verified in a clean environment** |
| `requirements-llm.txt` | google-generativeai | optional; absence reported, not fatal |
| `requirements-research.txt` | pyarrow *(verified)*; pandas, matplotlib, xarray, cdsapi, python-docx *(unverified, unpinned)* | partly verified |
| `requirements-streaming.txt` | pathway and its stack | **UNVERIFIED — never installed anywhere** |
| `requirements-dev.txt` | nothing yet | honest placeholder |

Three judgements worth recording:

- **`scipy` is deliberately left transitive.** LightGBM requires it; no AREE
  module imports it. Declaring it would assert a direct dependency that does not
  exist.
- **`urllib3` is declared even though `requests` brings it**, because
  `backend/ingestion` imports it directly for retry configuration. A module that
  imports a package depends on it regardless of who else installs it.
- **`uvicorn[standard]` — the extra is load-bearing**, not cosmetic. It supplies
  the websockets implementation behind `/ws`; the bare package would leave those
  routes unserved.

**Unverified sets are labelled unverified.** The streaming pins were carried
forward verbatim and marked as never having been installed. The research extras
that are not installed are left **unpinned**, because a pin would be a guess
presented as a fact. Version numbers in the verified files come from the working
environment, not judgement.

## 17.6 The gate is the application running, not pip exiting 0

`backend/tests_runtime_gate.py`, new and permanent. A clean virtualenv is built
from `backend/requirements.txt` alone, and then the gate asks whether the
*application* works in it — against a `VACUUM INTO` copy of the store, because
the case step writes a decision and a gate must not mutate the evidence base.

Two steps deserve their reasoning recorded:

- **Engine startup deliberately unsets `AREE_ENGINE_MODE`.** The default path
  imports Pathway first; in a runtime-only environment that raises ImportError
  and the loader must fall back to direct mode rather than leave the API dead.
  That fallback is *why* the runtime set is sufficient, so it is asserted rather
  than assumed. Observed: `mode=direct`, reason `No module named 'pathway'`.
- **The final step makes real HTTP requests** over a socket — added because its
  absence is precisely what let §16's defect through.

## 17.7 Results

```
Fresh environment (29 packages, no torch, no Pathway, no OCR stack):
  install .......... PASS    29 packages
  backend import ... PASS    23 routes registered
  engine startup ... PASS    mode=direct (pathway absent, fell back)
  forecast ......... PASS    72 points, peak upper 713.6 ug/m3
  outlook route .... PASS    AWAITING_APPROVAL, case 9de99f8d8332
  case workflow .... PASS    APPROVED, 2 actions, actor_verified=False
  PDF report ....... PASS    9,828 bytes, valid %PDF header
  optional degrade . PASS    8/8 optional packages absent, nothing crashed
  HTTP endpoints ... PASS    3 endpoints answered 200 over TCP

Runtime dependency audit:
  undeclared imports ..... 0     (63 backend modules imported cleanly)
  unnecessary runtime .... 0     (all 10 entries evidenced in use)
  version conflicts ...... 0     (was 3)
  optional research ...... separated
  optional streaming ..... separated, and labelled unverified

Regression (both environments):
  routes ......... PASS   (new)
  GRAP ........... PASS
  contract ....... PASS
  temporal ....... PASS
  typecheck ...... PASS
  lint ........... same 3 pre-existing react-hooks errors
  golden output .. 3,274/3,274 fields identical
```

### A correction inside this phase

The dependency audit first reported `lightgbm` as an **unnecessary** runtime
entry. That was wrong, and the method was wrong: it checked `sys.modules` after
importing each module, and `import lightgbm as lgb` sits *inside* `load_for()`
and `train_fold()` as a deliberate deferred import. Function-level imports are
structurally invisible to that technique.

The corrected check exercises the flows first and then inspects `sys.modules`.
Under it every declared runtime package is evidenced in use. Recorded because the
first answer was stated with the same confidence as the second.

## 17.8 Deferred to the deployment phase, deliberately not touched

Both are real and both are dependency-adjacent, but changing them is deployment
work, which is explicitly later:

1. **`Dockerfile` installs `torch` unconditionally** (line 30) for
   sentence-transformers, which is no longer in the runtime set. The image will
   now carry roughly 800 MB that nothing imports. Not broken — wasteful.
2. **`docker-compose.yml` bakes `NEXT_PUBLIC_API_URL: http://localhost:8000`**
   into the frontend build (line 35). This is the same class of defect as the
   `API_URL` fallback fixed earlier: the value is compiled into the client bundle,
   so every visitor's browser resolves *their own* localhost. It works only for
   someone browsing on the Docker host. The frontend now defaults to same-origin
   and proxies through `next.config.ts`, so this argument should simply be
   removed — in the deployment phase, together with the compose file's other
   choices.

---

# 18. Phase 3 — the authority boundary

## 18.1 What was actually wrong

`POST /api/cases/{id}/decision` accepted a body carrying `actor: "A. Sharma"` and
wrote it into the audit trail. The build was honest about it — every stored action
carried `actor_verified = 0` and the API said so — but **honesty is not
authorisation**. Anyone who could reach the endpoint could record a regulatory
approval under any name.

`POST /api/policy/upload` was worse in one respect and better in another: it wrote
no identity at all, but it accepted a document into the corpus that later
advisories are grounded on, from anyone.

## 18.2 The decision taken before implementation

Two options were put up and both recommendations were accepted:

- **Backend-issued JWT**, not offline-minted tokens and not a live external IdP.
- **PyJWT**, not fifty lines of `hmac`.

### Why not a real OIDC provider now

There is no identity provider in this project, and wiring one needs a client
registration, redirect URIs and a provider choice that only the owner can make.
There is also a standing instruction in this project that no Google sign-in be
set up without asking first. So OIDC was deferred *as a deployment decision*, not
dismissed as an architecture.

**What this is, stated precisely: a local HS256 issuer. It is not an OIDC
deployment and the code says so in as many words.** Nothing here has been
verified against a real IdP, and no compliance is claimed.

What was built instead is the *shape* that lets one drop in. Claims are
OIDC-shaped (`iss`, `aud`, `sub`, `exp`, `iat`, `jti`) and every protected route
depends on a `Principal` produced by a `TokenVerifier` protocol, so replacing
`LocalHS256Verifier` with an RS256/JWKS verifier is a change to
`backend/api/auth.py` and nothing else. Choosing the claim shape now is what stops
that swap from also being a claims migration.

### Why PyJWT and not hand-rolled HMAC

Checking a signature is the easy part. The parts that are routinely got wrong are
algorithm confusion (`alg: none`; an HS256 token verified against an RS256 public
key), constant-time comparison, and the `exp`/`nbf`/`aud`/`iss` checks people
forget. `algorithms=[ALGORITHM]` is pinned to a single value so a token cannot
nominate how it is verified — the classic forgery route.

The cost was one dependency added to the runtime set, which meant rebuilding the
clean environment and re-running the whole runtime gate against it. Done, not
assumed: 31 packages, all steps pass.

## 18.3 Separation of duties

Roles map to capabilities, held as data rather than `if role == "admin"` scattered
through routes:

```
authority -> case:decide      regulatory decisions
admin     -> policy:write     policy corpus management
```

**No role holds both.** An administrator who can load the corpus an advisory is
grounded on should not also be able to approve escalations against it. This is
cheap to define now and expensive to retrofit once decisions exist in the trail.

Consequently `authority` gets **403** on the upload and `admin` gets **403** on the
decision — both tested.

## 18.4 Identity cannot come from the request

The decision route takes `principal: Principal = Depends(requires("case:decide"))`
and writes `principal.subject` / `principal.role`. `body.actor` and
`body.actor_role` are still accepted by the schema for backwards compatibility and
are **ignored**.

`case_store.decide()` gained `actor_verified` as a **keyword-only** parameter
defaulting to **False**. Both properties are deliberate: keyword-only means no
caller can set it positionally while meaning something else; defaulting to False
means a caller that has not thought about identity records an unverified action
rather than silently asserting a verified one.

The header is read from the raw `Request`, so there is no code path by which a
body reaches `current_principal`.

Tested adversarially — a request carrying
`actor="Someone Else Entirely", actor_role="Chief Secretary", actor_verified=true,
subject="attacker", role="admin"` alongside a valid `authority` token was accepted,
and the stored action reads `actor="ncr.officer"`, `actor_role="authority"`,
`actor_verified=true`.

## 18.5 Choices worth recording

**Unconfigured instances get random demo credentials, not defaults.**
`AREE_OPERATORS` unset seeds two demo operators with randomly generated passwords
printed once to the startup log. Random rather than a default, because a shipped
default password is a backdoor that travels with the image; seeded rather than
empty, because an unconfigured deployment that silently refuses every decision is
indistinguishable from a broken one. `GET /api/auth/config` reports
`mode: "demo-credentials"`, the decision response repeats it, and the approval
panel shows it — so demo authority is never presented as real. A verified identity
against a register that is not real is a *different claim* from a verified
identity, and the UI makes that distinction rather than blurring it.

**An unset `AREE_JWT_SECRET` yields a random per-process key**, not a baked-in
one. The consequence is stated: tokens do not survive a restart. That is a far
better failure than every deployment of an image sharing a signing key visible in
the source.

**Login failures are indistinguishable and equal-time.** Unknown user and wrong
password return the same body, and `authenticate()` verifies a hash against a dummy
record when the user does not exist, so response timing does not enumerate valid
operator names.

**The two case GETs stay open.** They read; they mint nothing. A token in front of
viewing the queue would not protect anything that protecting the writes does not
already cover.

**Tokens live 15 minutes.** A decision takes seconds.

## 18.6 Frontend

The free-text "Officer" field is **gone**, because it had no effect worth offering
once the server stopped reading it. In its place: sign in, or a panel that says the
server will refuse. Approve/Reject are disabled without a session.

Tokens are held in `sessionStorage`, not `localStorage` — a regulatory approval
should not be one reopened tab away. That is a convenience boundary; the security
boundary is the server, which validates signature, audience, issuer and expiry
regardless of what any client holds.

### A lint regression, found and fixed properly

The first implementation read the session with `useState` + a `useEffect` that
called `setSession(auth.session())`. That added a fourth `react-hooks` error
(`set-state-in-effect`) to the three pre-existing ones.

It was not suppressed. The session is external browser state, so it is now read
through `useSyncExternalStore` with a subscribable store in `api.ts` — which is
also what avoids the hydration mismatch that reading storage during render would
cause (server: always null; client: possibly signed in). `getSnapshot` caches on
the raw stored string so it stays referentially stable, and it checks expiry
*without* clearing storage, because a snapshot getter that mutates as React reads
it is a bug waiting for a re-render.

Lint is back to exactly the same 3 pre-existing errors.

## 18.7 A gate step that failed, and why that was the right failure

After Phase 3 the runtime gate's case-workflow step failed:

```
case workflow ..... FAIL   AttributeError: 'Depends' object has no attribute 'subject'
```

It was calling `cases.decide(case_id, body)` **as a Python function**, so the
`principal` parameter arrived as the raw `Depends` marker. Not a product defect —
the same anti-pattern that hid the decorator bug in §16, showing up again in the
gate's own code.

Fixed by making that step authenticate and decide **over HTTP**, which also turned
it into a stronger check: it now asserts 401 without a token, then 200 with one,
then reads the stored action back and verifies the actor is the token subject.

## 18.8 Results

```
Authority boundary (backend/tests_auth.py, all over real HTTP)   41/41 PASS

  Credentials         wrong password 401 - unknown user 401 - indistinguishable
                      valid credentials issue a token - role reported
  Token integrity     no token 401 - malformed 401 - wrong signing key 401
                      expired 401 (reported distinctly) - wrong audience 401
                      unknown role in a validly signed token 401
  Decision endpoint   unauthenticated 401 - admin 403 (names case:decide)
                      expired token 401 - authenticated 200
                      actor = token subject, NOT the body's actor
                      actor_role could not be injected - actor_verified = true
                      reason recorded verbatim
  Transitions         second decision 409 already_decided
                      case id still checked against recomputed evidence
                      unknown case 404 - invalid verb 422
  Policy upload       unauthenticated 401 - authority 403 (names policy:write)
                      admin accepted
  GET purity          viewing outlooks minted no case - outlook needs no token
                      decided status reflected

Regression
  routes / auth / GRAP / contract .... PASS in BOTH environments
  temporal .......................... PASS
  runtime gate (fresh venv, 31 pkgs) . 8/8 PASS
  typecheck ......................... PASS
  lint .............................. same 3 pre-existing
  golden output ..................... 3,274/3,274 identical
```

Against the acceptance criteria: unauthenticated rejected (1), authenticated
accepted (2), identity from the server context (3), client cannot force
`actor_verified` (4), bad/expired credentials rejected (5), case id still
recomputed (6), `as_of` still recomputed through the shared path (7), 409 on a
second decision (8), audit records identity/action/reason (9), upload needs its own
authority (10), GET still side-effect free (11), existing suites and golden
unchanged (12), fresh environment still boots (13), and every one of these
exercised over HTTP (14).

## 18.9 Not done, and deliberately

- **No OIDC against a live provider.** Needs a provider decision and credentials.
  The seam exists; the deployment does not.
- **No refresh tokens, no revocation list.** 15-minute expiry is the whole
  revocation story today. A `jti` is minted on every token so a deny-list has
  somewhere to hang, but building one without an operational need would be
  inventing a requirement.
- **No login UI beyond the approval panel.** There is no separate sign-in page or
  global session header; authority is requested where it is exercised. Whether the
  console needs a persistent identity chrome is a UI decision, not a security one.
- **No rate limiting on `/api/auth/token`.** Genuinely missing, and worth naming
  rather than leaving implied: equal-time responses stop username enumeration but
  do nothing against online password guessing. It belongs with the deployment
  phase, where the reverse proxy is chosen.
- **The Docker items from §17.8 remain open** and untouched.

---

# 19. Phase 4 — the truthfulness boundary

The test applied to every claim, exactly as set: **does the running engine compute
it?** Yes → keep it, with provenance. No → make it absent. And in neither case
invent a replacement claim.

## 19.1 Correction to finding 0.6 before acting on it

The audit recorded four defaults: `firms_status "not_polled"`,
`transport_label "unknown"`, `pollution_cause "unclassified"`,
`confidence_score 85`.

**`confidence_score` was already fixed** in the earlier UI pass — it reads `None`
with a comment explaining why. That part of 0.6 was stale. The docstring claim and
the fire/transport defaults were live, and the audit understated the blast radius:
the same defect existed in three places it had not looked at.

## 19.2 The literal 0.6 fix

`fallback_engine.py`'s docstring listed, under *"Real, reusing the same code the
Pathway path uses"*:

```
* causal attribution / transport   streaming/risk_engine.py
* satellite fire intelligence      ingestion/firms_stream.py
```

Verified: this module imports neither, and never did. Both are imported by
`app.py` alone. They are now listed under *"Not available in this mode"*, beside
policy RAG, with a note recording what the false claim was and what it caused.

## 19.3 The real damage was not the docstring

A docstring misleads a developer. The defaults misled the product.

With FIRMS never polled, the station payload published `fire_count: 0`,
`high_conf_fires: 0`, `aligned_fires: 0`, `transport_score: 0`,
`transport_probability: 0.0`, `cause_confidence: 0`, `plume_distance_km: 0.0`,
`wind_alignment_deg: 0.0`, `transport_label: "unknown"`,
`pollution_cause: "unclassified"`.

**Zero is not a missing value. It is a measurement**, and every consumer read it
as one:

| Where | What it rendered |
|---|---|
| `SatelliteCard.tsx` | `fireCount > 5 ? red : fireCount > 0 ? yellow : **green**` — a never-polled satellite feed coloured **GREEN**, the all-clear |
| `SatelliteCard.tsx` | "0 fire detections", "0 aligned detections", "0/100 transport score" |
| `RiskChart.tsx` | solid 0 bars for ERI, Transport, Cause conf., Transport prob. |
| `report_generator.py` | **"No upwind thermal anomalies detected. Local emission dominant."** |

The PDF line is the worst of them and was found by reading the code rather than
the screen. It asserts two things at once: a satellite search that never happened,
and a causal attribution nothing computed. It printed on a signed escalation
report — the artefact that outlives the screen and gets forwarded.

In a product whose entire claim is that its numbers are traceable, an unmeasured
quantity that renders as an all-clear is the most damaging default available.

## 19.4 Two more layers the audit had not reached

Found by tracing rather than by grepping for the four known names:

**`/api/risk/{station}` manufactured a verdict.** `risk.py` had
`eri_score=state.get("eri_score", 0) or 0` and
`eri_category=state.get("eri_category", "LOW READINESS")`. ERI is computed in
`app.py` (lines 662-671) and nowhere else, so in direct mode the API served a
readiness **score** and a readiness **verdict** for a station whose readiness had
never been calculated. The verdict is the worse half: a reader can discount a
suspicious 0, but "LOW READINESS" reads as an assessment.

**The schema required the fabrication.** `RiskResponse` typed these
`eri_score: int = 0` and `eri_category: str = "LOW READINESS"`. A non-optional
field with a default does not merely permit an invented value — it leaves the
route no way to say "not computed" while satisfying the schema. Now `Optional`.

**The dashboard ranked absences.** `top_eri` called
`_rank(active, lambda v: v.get("eri_score", 0), 5)`, and `_rank` sorted on
`getter(v) or 0`, producing a numbered top-five table in a mode where nothing
computes ERI at all. `_rank` now includes only stations that hold the metric.

## 19.5 What was KEPT, and why

The rule cuts both ways, and most of the system passed it.

- **`plume_influence` in the outlook — kept, untouched.** It is genuinely
  computed (163,176 rows in `derived_features`, all non-null, range 0–2468),
  `_plume()` reports `available` honestly, names its source as NASA FIRMS
  (VIIRS), and its note already says it is *"a transport-plausibility index, not a
  measured contribution."* That is the standard the rest of the system is now held
  to, not something to remove.
- **`firms_status: "not_polled"` — kept deliberately.** It is the one field in
  that block that was always true, and it is the flag consumers key their
  unavailable state off. Removing it would have destroyed the provenance signal
  while cleaning up the values it described.
- **`cause_factors: []` — kept as an empty list.** "No factors supplied" is
  accurate, and consumers can iterate without a guard.
- **Wind on the satellite card — kept.** It comes from the weather stream, which
  direct mode does read.
- **No claim was replaced with a different claim.** Where FIRMS was not polled the
  UI now says so and makes no attribution "either way"; the PDF says the section
  "makes no finding either way — it is neither evidence of transport nor evidence
  of its absence."

## 19.6 A distinction the PDF now draws

The report branched on `fire_count > 0` alone, so "not polled" and "polled, found
nothing" printed identically. They are different facts and now print differently:

1. **Not polled** — states that no thermal-anomaly search was performed and makes
   no finding.
2. **Polled, fires found** — the evidence table, unchanged.
3. **Polled, nothing found** — "FIRMS was polled and returned no upwind thermal
   anomalies… This rules out detected fire transport as a contributor; it does not
   by itself attribute the episode to local emission." The absence is a real
   result and is reported as one; the causal conclusion this pipeline does not
   draw is not asserted.

All three verified to render valid PDFs (9,971 / 9,934 / 9,996 bytes).

## 19.7 A break this change would have caused

`report_generator.py` did `fire_count = s.get("fire_count", 0)` then
`if fire_count > 0:`. With the value now `None`, that raises `TypeError` and the
PDF endpoint 500s. Note that `.get(key, 0)` does **not** help here — the key
*exists* with a `None` value, so the default never applies. Every read in that
section is now explicitly None-aware.

Caught by tracing consumers before making the change, not by the tests afterwards.

## 19.8 The guard

`backend/tests_claims.py`, new, over live HTTP as required.

It holds a register of retired claims — field plus the value it must not carry —
and scans real `/api/stations/{id}`, `/api/risk/{id}` and `/api/dashboard`
responses. It is written as *forbidden values* rather than "must be null" so that
a future direct-mode FIRMS poll can populate them for real without editing the
register: a genuine measurement of zero fires arrives with `firms_status: "ok"`,
which the scan accounts for.

It also asserts the **positive** half — that the plume block still carries a
computed influence, names FIRMS as its source, keeps its "not a measured
contribution" qualifier, and reports its own availability; and that the forecast
still returns 72 points with model provenance and the warning rule. A truthfulness
pass that quietly deleted real capability would fail this file.

### Two failures on the first run

- **`top_eri` still ranked 5 stations with no ERI.** A real bug *in my own fix*:
  the getter was `lambda v: v.get("eri_score", 0)`, so it manufactured the very
  value the new `is not None` filter looked for. The filter was correct and
  useless. Fixed at the getter.
- **`forecast.provenance.models` empty.** My test was wrong, not the product:
  `provenance` sits at the **top level** of the outlook payload, not inside the
  forecast block — the route reshapes what `compute()` returns. Same class as the
  `valid_at` mistake in `tests_temporal`. Corrected the path and added a check for
  `warning_rule` while there.

### A flaky gate, fixed rather than tolerated

`tests_auth` printed **ALL 41 CHECKS PASS** and then exited non-zero:

```
Fatal Python error: _enter_buffered_busy: could not acquire lock for
<_io.BufferedWriter name='<stderr>'> at interpreter shutdown, possibly due to
daemon threads
```

The engine's daemon poller was mid-write to stderr when CPython began finalising.
Not a product defect — but a gate that fails at random trains you to rerun until
it is green, which is worse than having no gate. The three HTTP suites now flush
and `os._exit()`, skipping finalisation they have no reason to wait for. Verified
stable over three consecutive rounds each.

## 19.9 Results

```
Truthfulness boundary (backend/tests_claims.py, live HTTP)   42/42 PASS

  Station payloads   fire_count / high_conf_fires / aligned_fires /
                     transport_score / transport_probability / cause_confidence /
                     plume_distance_km / wind_alignment_deg / transport_label /
                     pollution_cause / wind_label / confidence_score
                     - none manufactured
  Risk endpoint      the same twelve, plus eri_score and eri_category
  Dashboard          top_eri no longer ranks stations lacking the metric
  Outlook (KEPT)     plume influence computed, source named, qualifier intact,
                     availability reported; 72-point series; model provenance;
                     warning rule published

Regression
  claims / routes / auth / GRAP / contract ... PASS in BOTH environments
  temporal ................................... PASS
  runtime gate (fresh venv) .................. 8/8 PASS
  PDF, all three FIRMS states ................ valid %PDF, no TypeError
  typecheck .................................. PASS
  lint ....................................... same 3 pre-existing
  golden output .............................. 3,274/3,274 identical
```

Nothing in the forecast model, the L1/q90 objective, the warning operating point,
the 465.9 m²/s threshold, the four-state contract, the GRAP mapping, the case
workflow, authentication or the dependency split was touched. The golden
comparison is the evidence.

## 19.10 Still open

- **Pathway is not deleted**, as agreed. Its modules remain the *only* place
  `risk_engine` and `firms_stream` are used, so the streaming path retains a real
  capability the direct path does not have — which is now stated accurately
  instead of borrowed.
- **Direct mode still does not poll FIRMS.** This phase made that visible; it did
  not implement it. Whether to add a direct-mode FIRMS poll is a capability
  decision, not a truthfulness one.
- **Rate limiting on `/api/auth/token`** (from §18.9) and the **two Docker
  blockers** (§17.8) remain open and untouched.

---

# 20. Phase 5 — Pathway and artefact strategy

Rule observed: **inventory → classify → prove → then remove.** One file was
removed. The output of this phase is mostly knowledge and one architectural
correction, and that is the honest result — the repository was already lean.

Full register: `ARTEFACTS.md`.

## 20.1 Inventory, and a method note that matters

Classification is by **runtime observation** — import the app, exercise the
request path, diff `sys.modules` — not by static import graphs.

Static analysis was attempted here and was wrong twice more, bringing its record
in this project to **four failures**. This time it reported
`backend/forecast/pm25_forecast.py` as an ORPHAN — a module that runs on every
single request. The cause: `from ...forecast import pm25_forecast` resolves to the
empty `forecast/__init__.py`, and the walk stops there because the submodule is
never followed. A second run reported `PATHWAY-ONLY: 0 files`, because `app.py` is
statically reachable from `api/engine.py` (which imports it inside a function),
so subtracting the two sets annihilated the category.

Recording it plainly: **static import graphs do not work on this codebase.** It
uses `sys.path` injection, flat imports, and function-level imports as a deliberate
performance choice. Runtime introspection is the method; anything else needs a
result cross-checked against it before being believed.

| Group | Files | LOC |
|---|---|---|
| Served request path | 49 | 9,957 |
| CLI scripts + test suites | 19 | 4,433 |
| Pathway-only | 5 | 1,764 |
| Conditional-runtime (untaken branches) | 5 | 982 |

**Conditional-runtime** turned out to be a real and necessary category:
`cpcb_stream.py` (fallback data source), `aqi_stream.py` + `feed_time.py` (feed
diagnostics), `station_loader.py`, `rag/llm_engine.py` (Gemini status). None are
dead; all load on a branch the standard exercise does not take. A naive sweep
would have deleted 982 LOC of working code.

## 20.2 Q1 — is Pathway worth keeping, and what does it actually hold?

**Measured, and it changes the answer.**

The Pathway-only set is 1,764 LOC, not ~2,300. The earlier figure counted
`aqi_stream.py`, `feed_time.py` and `station_loader.py`, all three reachable from
`api/engine.py` on the direct path.

More importantly — of those five modules, **only two import Pathway**:

| Module | Streaming dependency |
|---|---|
| `app.py` | `pathway`, `codecarbon` |
| `rag/advisory_engine.py` | `pathway`, `sentence_transformers` |
| `streaming/risk_engine.py` | **none — pure Python** |
| `ingestion/firms_stream.py` | **none — pure Python** |
| `ingestion/fire_stream.py` | **none — pure Python** |

So causal attribution (`CausalAttributionEngine`, `TransportVectorModel`) and
satellite fire intelligence are **548 LOC of ordinary Python needing only
`requests` and stdlib**.

**This corrects §19.10.** Phase 4 said Pathway "retains a real capability the
direct path does not have". True of the *wiring*, wrong about the *dependency*.
The accurate statement is: Pathway holds event-time windowing and the policy RAG
DocumentStore. It does not hold the fire or attribution capability — that is
**unwired, not unavailable**.

**Verdict: keep.** Runtime cost is zero (nothing on the served path imports it),
dependency cost is already isolated in `requirements-streaming.txt` and labelled
unverified, and it is the only implementation of event-time windowing. The cost is
comprehension, which §20.4 addresses in code rather than prose.

**Not done, deliberately:** wiring FIRMS into direct mode. It is genuinely
available — three pure-Python modules, one `requests`-backed API, a
`FIRMS_API_KEY` already in `.env`. But Phase 4 was about not claiming uncomputed
things; *adding* a computation is feature work and belongs in a phase that says
so. Flagged, not smuggled in.

## 20.3 Q3 — artefacts

Repository ships **202 tracked files, 7.38 MiB packed**. The 528 MB
`node_modules` and 148 MB `data/aree.db` are both gitignored. Nothing improper is
tracked — no `.next/`, no `__pycache__`, no `tsbuildinfo`.

**The models are the one genuinely delicate artefact.**
`backend/config/models/{central,upper}__20241101.txt`, 4.5 MB, git-tracked, and
**load-bearing by filename**: `load_for()` parses `__YYYYMMDD` and offers only
models with `train_end <= as_of`. That *is* the leakage guard. A rename that alters
the date either breaks loading or — worse — makes a later model eligible for an
earlier replay, at which point every lead-time number this project quotes becomes
unsupportable.

Rather than assert the model contract from the training code, it was **read out of
the artefacts**: `regression_l1` (central, conditional median) and `quantile`
(upper, q90 tail), 24 named features, `num_class=1`. A first draft of that table
said `valid_hour`/`valid_month`; the artefact says `hour`/`month`. Checking caught
it — publishing a wrong feature contract would have been exactly the Phase 4 class
of error, in the document meant to prevent it.

`data/aree.db` is REGENERABLE with a caveat now written down: `capture.py
bootstrap` and `backfill.py` rebuild it from live APIs, so a rebuild is
reproducible in *method*, not guaranteed byte-identical in *content* — CPCB
revises retrospectively.

**Removed: one file.** `backend/ingestion/micro_nodes.py` — 0 bytes, zero
importers, an empty file implying a subsystem that does not exist. The only
OBSOLETE item found. Regression after removal: routes / claims / GRAP / contract
all pass.

**Not removed:** the "old Streamlit assets" hypothesis does not hold — no
Streamlit code remains, only historical references and `MIGRATION.md`, which is a
migration record. The four PDFs are not duplicates but four different documents.
The 1.2 MB of PNGs are regenerable, but they are the figures the written record
refers to and the saving does not justify a broken reference.

## 20.4 Q2 — the authoritative engine, now stated in code

This is the one architectural change of the phase.

`load_engine()` attempted `import app` (Pathway) **first** and reached the direct
engine only by catching the failure. Two things were wrong:

- **Practically**, the attempt never succeeded. Pathway is not installed in any
  verified environment, so every start paid for a heavyweight import guaranteed to
  raise, and the engine actually serving traffic was chosen by an exception
  handler.
- **Structurally**, it made the repository misdescribe itself. A reader would
  conclude streaming is the system and direct is the safety net, when the reverse
  is what runs, what is tested, and what every gate in this project measures.

The default is now **direct**; streaming is opt-in via
`AREE_ENGINE_MODE=streaming`, and still falls back with the real reason if it
fails. Verified across all three settings:

| `AREE_ENGINE_MODE` | result |
|---|---|
| unset | `mode=direct`, `pathway_error=None`, `engine_selection="direct engine (default; production path)"` |
| `direct` | `mode=direct` |
| `streaming` | attempts Pathway, falls back, records `pathway_error="No module named 'pathway'"` |

The runtime gate now asserts the first row *including* `pathway_error is None`,
which is what distinguishes "chosen by default" from "fell back after a failure".
Before this change that assertion would have failed.

### What was deliberately NOT changed

`degraded: true` stays set for direct mode. Direct really does provide less — no
event-time windowing, no policy retrieval, no FIRMS poll — and flipping the flag
off because direct is now the default would **increase a claim without gaining a
capability**, which is precisely the move Phase 4 removed. What changed is
`pathway_error`, which no longer reports a phantom failure for a path that was
never attempted.

## 20.5 Results

```
Phase 5 gate

  Inventory      49 live / 19 offline / 5 Pathway-only / 5 conditional
                 202 tracked files, 7.38 MiB packed
  Removed        1 file (micro_nodes.py, 0 bytes, 0 importers)
  Architecture   direct is the default and says so; all 3 modes verified

Regression
  routes / claims / auth / GRAP / contract ... PASS in BOTH environments
  temporal ................................... PASS
  runtime gate (fresh venv) .................. 8/8 PASS
  typecheck .................................. PASS
  lint ....................................... same 3 pre-existing
  golden output .............................. 3,274/3,274 identical
```

## 20.6 Still open

- **Rate limiting on `/api/auth/token`** (§18.9) — the most significant deferred
  security item.
- **Two Docker blockers** (§17.8) — the unnecessary `torch` install, and
  `NEXT_PUBLIC_API_URL` baked into the frontend build.
- **Direct-mode FIRMS wiring** — available, deliberately not built here.
- **Pathway's pins remain unverified.** Nothing in
  `requirements-streaming.txt` has been resolved or installed. Keeping the engine
  is not the same as being able to run it, and the file says so.

---

# 21. Tunnel outage — two independent faults, one of them a bad verification

Reported as "the cloudflare tunnel is not working". Two separate causes, and the
second had been present, undetected, since the tunnel was first declared working.

## 21.1 Fault one: the quick tunnel had died

`cloudflared` was still running but had **zero established connections to the
Cloudflare edge**, looping since 08:54Z on:

```
ERR failed to serve tunnel connection error="control stream encountered a failure while serving"
INF Retrying connection in up to 1m4s
```

1,345 errors in the log. The published URL
(`fitted-speeds-ebony-hammer.trycloudflare.com`) returned `HTTP 000`.

Nothing to fix in AREE. Quick tunnels are account-less and, as cloudflared's own
startup banner states, **have no uptime guarantee**. This one lasted about seven
hours. Restarting produced a new hostname; that is the expected lifecycle, and it
means the URL is disposable by design.

## 21.2 Fault two: Next was blocking the JS, and curl could not see it

The dev server was refusing its own chunks over the tunnel:

```
⚠ Blocked cross-origin request to Next.js dev resource
  /_next/static/chunks/src_107srhz._.js from "seat-fairy-reading-shares.trycloudflare.com"
```

`next.config.ts` had `allowedDevOrigins: [..., ".trycloudflare.com"]`. **That
pattern never matched anything.** Next matches with `matchWildcardDomain`
(`server/app-render/csrf-protection`), which splits the pattern on `.` and
compares segment by segment; a leading dot yields an empty first segment, and an
empty segment is explicitly rejected. The correct form is a glob —
`**.trycloudflare.com` — which is also what Next uses for its own built-in
`**.localhost` default.

Fixed. Now matches any future tunnel hostname, so a restarted tunnel needs no
config change.

### Why this survived being "verified" twice

**Next only blocks when the request carries a cross-site `Origin` or `Referer`.
curl sends neither.** Every command-line check of a chunk returned 200 while a
real browser got **403 on the same URL**. Demonstrated directly:

```
same chunk, no Origin header      -> HTTP 200
same chunk, Origin: <tunnel host> -> HTTP 403
```

The user-visible result is the failure mode recorded once before in §10: HTML
arrives, JS is refused, the page renders its shell, never hydrates, and sits on
"Loading outlook…" — with the API answering 200 the whole time, so it looks like a
data problem rather than an asset one.

The lesson is sharper than "test over HTTP", which this project already learned in
§16. **A check that cannot fail is not a check.** Without the `Origin` header
there was no input under which the chunk request could have been refused, so the
green result carried no information. Verification has to reproduce the condition
that triggers the behaviour, not merely reach the same URL.

Correct form:

```bash
curl -H "Origin: https://<tunnel-host>" -H "Referer: https://<tunnel-host>/" <url>
```

After the fix, with browser headers: **24/24 assets on `/outlook` load, 0
blocked**, and the dev server logs zero blocked requests.

## 21.3 A write I caused, and removed

While checking whether the write endpoints were protected, a no-token
`POST /api/cases/{id}/decision` returned **200**. The backend on :8102 had been
running since before Phase 3 and was serving pre-auth code.

That POST **wrote to the real store**: it opened and approved case `9de99f8d8332`
at 08:56:43Z with `actor='Demo Authority'`, `actor_verified=0`, no reason. A
spurious regulatory record, created by a test rather than by a decision.

Removed — the two rows (`cases`, `case_actions`) for that id, identifiable beyond
doubt as the only case in the store, opened and approved in the same 2 ms by an
unauthenticated request. The store is back to 0 cases, so the replay presents its
intended `AWAITING_APPROVAL` state.

Restarting the backend on current code confirmed the boundary holds over the
tunnel: `POST .../decision` without a token now returns **401**, and
`/api/auth/config` reports `mode: "demo-credentials"`.

**The operational rule this produces:** a long-running dev server is not the code
in the working tree. Before testing anything about behaviour that recent phases
changed, restart it — otherwise the result describes an older build, and in this
case a test wrote to a production table because of it.

## 21.4 "Atmospheric outlook and ventilation outlook not working"

Both pages default to preset 0, **"Live (anchored)"**, so opening either one calls
`/api/aree/outlook` with no `at`. That call was returning **424**:

```
observed PM2.5 missing at lag(s) [0, 1, 3] h before 2026-09-04 09:00 UTC
```

### Why the anchor backoff could not rescue it

The store had holes at hours 0, 1, 3, 7 and 8, and the feature vector needs lags
`[0, 1, 3, 6, 12, 24]`. Every candidate in the six-hour backoff window failed on
some lag:

| candidate | missing lag |
|---|---|
| 09:00 | 0, 1, 3 |
| 08:00 | 0 |
| 07:00 | 1 |
| 06:00 | 0 |
| 05:00 | 3 |
| 04:00 | 3 |
| 03:00 | 1 |

The holes come from the API being stopped and restarted repeatedly during this
engineering work — **capture only writes while the process runs**, so every
restart costs an hour. The scheduler's own check said "store is 2.0 h behind, no
backfill needed", which is true of the *newest* row and says nothing about gaps
behind it. Contiguity is what the lag set needs, not recency.

Fixed with `python capture.py bootstrap --days 2`: 1,109 station-hours across 48
distinct hours. Only hour 0 remains absent, which is correct and permanent — the
upstream CAQM feed publishes ~90 minutes late, so the current hour is never
available and the anchor legitimately steps back one hour. Live now returns 200,
anchored to 08:00 across 76 stations.

### A third origin fault: 127.0.0.1 is not localhost

Separately, `http://127.0.0.1:3101` had its dev chunks blocked while
`http://localhost:3101` worked — same server, same port. Next allows `localhost`
and `**.localhost` plus the hostname it was started with; the loopback *IP*
matches none of those. Added `127.0.0.1` to `allowedDevOrigins`. A LAN address
needs `AREE_DEV_ORIGIN=192.168.x.x`, since a bare IP cannot be globbed.

### The harness lied twice before the product was cleared

Two false failures came from the checking method, not the application:

1. **`--virtual-time-budget` again.** It dumps the DOM when the virtual clock
   expires and does not reliably wait for real network. Over the tunnel each
   request costs 0.4-1.6 s of wall time, so pages that render fine locally
   reported as "stuck". This is the third time this artefact has produced a false
   negative in this project. Replaced with a DevTools-Protocol harness
   (`.tmp/render_check.mjs`) that polls the live DOM against a **real** deadline.
2. **A case-sensitive needle.** `document.body.innerText` applies CSS
   `text-transform`, so the heading arrives as `VENTILATION STATUS`. Searching for
   `Ventilation status` failed on a page that was fully rendered. The giveaway was
   the character count — 3,131 over the tunnel against 3,217 locally, far too
   close for a page that had loaded nothing.

Verified after both corrections — every path, real waits, case-insensitive:

| path | /ventilation | /outlook |
|---|---|---|
| tunnel | 1.6 s | 1.7 s |
| 127.0.0.1 | 0.6 s | 0.7 s |
| localhost | 0.6 s | 0.6 s |

Content confirmed present, not just a non-empty DOM: *VENTILATION STATUS ·
Imminent · 11.0 h intervention window · 1227.6 m²/s · BLH 660 m · wind 1.86 m/s ·
operating point 465.9*, and *INTERVENTION WINDOW 11 h · Collapse 05 Sept 00:30 IST
· 35 h sustained*.

### The standing lesson, restated

A green result from a harness that cannot distinguish "not loaded" from "not
waited for" is not evidence. Both false failures here, and the 403-versus-200
chunk result in §21.2, share one cause: **the check did not reproduce the
conditions under which the behaviour occurs.** Real browser, real Origin header,
real clock — or the result means nothing.

---

# 22. Phase 6 — pytest and CI

Scope held: test infrastructure only. No Docker changes, no rate limiting, no
FIRMS work, no Pathway dependency resolution, no model changes, no deployment.

## 22.1 The problem CI had to solve first

`data/aree.db` is 148 MB and gitignored, so a CI runner has no store at all.
Without one, every test touching a forecast, the outlook, a case or the golden
baseline could only be skipped — and a pipeline that skips the things it exists to
protect is decoration.

**`backend/tests/fixtures/aree_test.db`, 1.00 MB, committed.** Built by
`backend/tests/build_fixture_db.py`, which extracts the exact slice the three
replay moments need, with the windows derived from the same constants the
forecast reads:

| Table | Rows | Window |
|---|---|---|
| `station_readings` | 94 | `[as_of - OBSERVATION_WINDOW_HOURS, as_of]` |
| `met_hourly` | 2,160 | `[as_of - MAX_ANCHOR_BACKOFF_HOURS, as_of + HORIZON + 1]` |
| `derived_features` | 2,160 | same |
| `fire_events` | 1,628 | the 24 h before `as_of` |

Verified before being relied on: the 1 MB fixture reproduces **all 3,274 golden
fields identically**. Because the windows come from `fc.OBSERVATION_WINDOW_HOURS`
and friends rather than from literals, it cannot silently drift out of step with
what the code reads.

## 22.2 The baseline is now version-controlled

The golden files lived in `.tmp/golden/`, which is **gitignored** — a "protected
baseline" that no clone had. Moved to `backend/tests/golden/*.json` and committed.

Regenerated without the wall-clock fields rather than storing and then ignoring
them. A baseline containing values no test may compare is a trap for the next
reader.

`test_baseline_covers_the_whole_payload` asserts the field count is 3,274, so a
truncated baseline fails instead of passing while proving nothing. Changing that
number requires changing it in the same commit as the diff that justifies it.

## 22.3 Migration, and what it cost

| Was | Now | Treatment |
|---|---|---|
| `tests_auth.py` (41 checks, 1 pass/fail) | `test_authority.py` (22 tests) | converted |
| `tests_claims.py` (42 checks) | `test_claims.py` (5 tests, register-driven) | converted |
| `tests_routes.py` | `test_route_table.py` (14 tests) | converted |
| `tests_grap.py` | `test_legacy_suites.py` | **wrapped** |
| `tests_contract.py` | `test_legacy_suites.py` | **wrapped** |
| `tests_temporal.py` | `test_legacy_suites.py` | **wrapped** |
| `tests_runtime_gate.py` | unchanged | kept, distinct purpose |

**Three suites were wrapped rather than rewritten, deliberately.** GRAP band
boundaries, the two-engine shape contract and the temporal rules with their
exclusions encode domain judgement; rewriting that risks dropping the one
assertion the suite existed for. The GRAP suite exists because two stage tables
once disagreed and 71 stations advertised a stage CAQM had not invoked — nothing
about that is worth re-deriving for tidier output.

**The cost is stated rather than hidden:** granularity. A wrapped failure says
"the temporal suite failed" and then prints which internal check broke, instead
of pytest naming it directly. Acceptable during a test-infrastructure phase; not
acceptable to pretend it is equivalent.

**Three modules were removed, after proving coverage** (Phase 5's rule):
`tests_auth.py`, `tests_claims.py`, `tests_routes.py`. Evidence: every one of the
41 auth check strings has lexical traces in the replacement; the retired-claim
register is 14/14 with none missing; asserted endpoints went 11 to 12. The limit
of that proof is stated: lexical tracing shows nothing was *obviously* dropped, it
is not a formal mapping. The stronger evidence is that the replacements were
written directly from the originals and pass in a clean environment.

## 22.4 What CI actually asserts

`.github/workflows/ci.yml`. Not "pytest went green" — the chain:

```
clean venv -> install runtime+dev ONLY -> import -> start backend
           -> real HTTP -> forecast -> outlook -> case/auth -> PDF
```

Two steps exist purely to catch drift this project has already suffered:

- **Optional stacks must be ABSENT.** If `pathway`, `torch`,
  `sentence_transformers`, `unstructured`, `docling`, `google.generativeai`,
  `codecarbon` or `pyarrow` appears in a runtime install, something moved from
  optional to mandatory. Verified: a clean install is 37 packages with none of
  them present.
- **Model filenames must still carry `__YYYYMMDD`.** `load_for()` parses that date
  and offers only models with `train_end <= as_of`; that IS the leakage guard. A
  rename is not tidying.

The lint step **asserts the error count is exactly 3**, so a fourth fails the
build *and* fixing one of the three also fails it — which forces the expected
number to be updated in the same commit rather than drifting.

## 22.5 Proven, not assumed

The pipeline was executed locally before being written down as working:

```
clean venv (37 packages, zero optional stacks)
  pytest -m "not network" ......... 61 passed, 4 deselected, 8.5 s
  runtime gate .................... 8/8 PASS
  tsc ............................. PASS
  eslint .......................... 3 errors (the count CI asserts)
```

And the case CI actually faces — **no development store at all**. `data/aree.db`
was moved aside and the gate re-run against the committed fixture alone:

```
(using the committed test fixture: aree_test.db)
  backend import / engine startup / forecast / outlook route /
  case workflow / PDF report / optional degrade / HTTP endpoints ... 8/8 PASS
```

That required fixing the gate, which did `sqlite3.connect(data/aree.db)` with no
existence check — SQLite would have happily **created an empty database**, and the
gate would have failed at "forecast" with a misleading reason instead of saying
the store was missing.

## 22.6 A test that asserted the environment, not the application

The gate's `optional degrade` step failed in the development environment with:

```
llm_status should report not-ready, got {'ready': True, ...}
```

The step asserted the optional packages were *absent* — true in a clean runtime
environment, false wherever the extras are installed. That is an assertion about
the machine wearing the costume of an assertion about the code.

Rewritten to be conditional: `llm_status()` must never raise, and must report
`ready=False` **only when the SDK is actually absent**. The RAG check stays
unconditional because it is mode-based, not package-based — direct mode has no
policy retrieval whether or not Pathway is importable.

## 22.7 Coverage gaps, named

- **Live-mode shape checks do not run offline.** `tests_temporal` compares live and
  replay payload shapes; against the fixture, live returns 424 (its data is
  Nov 2024) and that half is skipped. Real, inherent to having no network, and
  not papered over — the four `network` tests are listed by the CI summary step
  rather than silently dropped.
- **Wrapped suites report at suite granularity**, per 22.3.
- **No Python linter.** Adding one would produce a large diff of unrelated style
  changes across ~18,000 lines, which is not what a test phase is for.
- **The suite is fast (~8 s) partly because the fixture is small.** That is a
  genuine benefit, but it also means the tests exercise less data than production
  carries. The golden baseline is what makes the small slice sufficient: it pins
  the numbers, not merely the absence of exceptions.

## 22.8 Still open, unchanged by this phase

Rate limiting on `/api/auth/token`; the two Docker blockers (unnecessary `torch`
install, `NEXT_PUBLIC_API_URL` baked into the frontend build); direct-mode FIRMS
wiring; Pathway's unverified pins.
