"""
Direct-mode engine: the full AREE state without the Pathway runtime.

WHY THIS EXISTS
    Pathway publishes Linux/macOS wheels only. On Windows every station and
    escalation view degraded to engine_unavailable, which meant three of the
    four tabs were dead on the machines the team develops on. That is a
    packaging constraint being allowed to look like a broken product.

    It is also an architectural smell. Displaying a station's air quality and
    its GRAP stage does not inherently require a streaming runtime - it
    requires observations and a state machine. The state machine
    (streaming/state_machine.py) is pure Python and was never the problem.

WHAT IS REAL HERE AND WHAT IS NOT
    Real, reusing the same code the Pathway path uses:
      * GRAP stage + hysteresis        streaming/state_machine.py, unmodified
      * persistence tracking           same module, same thresholds
      * causal attribution / transport streaming/risk_engine.py
      * satellite fire intelligence    ingestion/firms_stream.py
      * short-term projection          same linear fit as app.py
      * ground observations            live CPCB/DPCC network via OpenAQ

    Not available in this mode, and reported as such rather than faked:
      * policy RAG advisories - rag/advisory_engine.py builds a Pathway
        DocumentStore, so it genuinely needs the runtime.
      * Pathway's sliding-window aggregates. This mode samples on an interval
        instead of computing event-time windows, so late or out-of-order data
        is not reconciled. That difference is stated in the status payload.

    Every state carries mode="direct" so nothing downstream, and nobody
    reading the UI, can mistake this for the streaming engine.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any

import numpy as np

log = logging.getLogger("aree.fallback")

# --- live state, matching the attribute names api/engine.py reads -----------
latest_state: dict[str, dict] = {}
aqi_history: dict[str, deque] = {}
escalation_log: list[dict] = []
# Keys MUST match app.py's carbon_state exactly. The dashboard route passes
# this dict through unvalidated - to_jsonable(engine.carbon_state()) - so a
# different key set does not fail a schema, it reaches the browser and crashes
# the component reading it. That is precisely how this broke the first time.
carbon_state: dict[str, Any] = {
    "total_gco2": 0.0,
    "decision_count": 0,
    "per_decision_gco2": 0.0,
    # Direct mode has no CodeCarbon tracker, so the figure is the same
    # deterministic per-decision estimate app.py falls back to when hardware
    # sensors are unavailable. Labelled so it is not mistaken for a measurement.
    "measured": False,
    "note": "Deterministic estimate; hardware power sensors not sampled in direct mode.",
}

# Same constant app.py uses for its deterministic fallback.
CARBON_COST_PER_DECISION = 0.002   # gCO2eq, same value app.py uses
_multi_window_cache: dict[str, dict] = {}

# Below this, a cycle is treated as partial: it still updates the stations it
# did return, but it will not prune the ones it did not.
MIN_CYCLE_STATIONS = 10

MODE = "direct"
POLL_SECONDS = 120
HISTORY_LEN = 120

_thread: threading.Thread | None = None
_stop = threading.Event()
_started_at: datetime | None = None
_cycles = 0

# CPCB PM2.5 sub-index breakpoints (24-hour). Converting concentration to AQI
# here rather than taking a vendor's composite means the number shown is
# traceable to a published Indian standard and to one measured pollutant.
_PM25_BREAKPOINTS = [
    (0.0,   30.0,  0,   50),
    (30.0,  60.0,  51,  100),
    (60.0,  90.0,  101, 200),
    (90.0,  120.0, 201, 300),
    (120.0, 250.0, 301, 400),
    (250.0, 500.0, 401, 500),
]


def _iso(value: Any) -> str:
    """Datetime to ISO-8601 text, empty string for None."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat().replace("+00:00", "Z")
    return str(value)


def pm25_to_aqi(pm25: float | None) -> int | None:
    """
    CPCB PM2.5 sub-index.

    Its own function because the conversion is a regulatory definition, not a
    formatting detail: an escalation fires on the resulting band, so the
    breakpoints have to be inspectable and match the published table.
    """
    if pm25 is None or pm25 < 0:
        return None
    for lo, hi, ilo, ihi in _PM25_BREAKPOINTS:
        if lo <= pm25 <= hi:
            return int(round(ilo + (ihi - ilo) * (pm25 - lo) / (hi - lo)))
    return 500


def _short_term_forecast(history: deque) -> dict | None:
    """
    Linear projection over the recent history.

    Deliberately identical in method to compute_short_term_forecast() in
    app.py so the two modes cannot disagree about the trend they report. It is
    a trend extrapolation, not the 72-hour physical forecast - that lives in
    forecast/ventilation.py.
    """
    if len(history) < 3:
        return None
    values = [p["aqi"] for p in history if p.get("aqi") is not None]
    if len(values) < 3:
        return None
    times = np.arange(len(values), dtype=float)
    slope, intercept = np.polyfit(times, np.array(values, dtype=float), 1)
    proj5 = int(max(0, min(500, slope * (len(values) + 5) + intercept)))
    proj30 = int(max(0, min(500, slope * (len(values) + 30) + intercept)))
    direction = "rising" if slope > 2 else "falling" if slope < -2 else "stable"
    return {
        "slope": round(float(slope), 2),
        "direction": direction,
        "projected_5min": proj5,
        "projected_30min": proj30,
        "data_points": len(values),
        "rate_per_min": round(float(slope), 2),
        "anomaly": abs(float(slope)) > 8,
    }


def _build_state(station: dict, engine, now: datetime) -> dict:
    """
    Assemble one station's state.

    Field names mirror the Pathway path exactly so the API schemas, the
    dashboard and the report generator need no branching. Fields this mode
    cannot supply are set to explicit nulls rather than plausible-looking
    defaults, so a missing subsystem reads as missing.
    """
    from streaming.state_machine import CPCB_BANDS  # noqa: F401  (band table)

    name = station["station"]
    pm25 = station.get("pm25_ugm3")
    # CAQM publishes the AQI itself - the max across every pollutant sub-index.
    # Prefer it when the source supplies one: deriving AQI from PM2.5 alone
    # understates any episode led by another pollutant, and CAQM's number is
    # the one the Commission publishes. Fall back to the PM2.5 conversion for
    # sources that carry concentrations instead (data.gov.in).
    aqi = station.get("aqi")
    if aqi is None:
        aqi = pm25_to_aqi(pm25)

    hist = aqi_history.setdefault(name, deque(maxlen=HISTORY_LEN))
    hist.append({"timestamp": now, "aqi": aqi})

    computed = engine.process(name, aqi) if aqi is not None else {}
    forecast = _short_term_forecast(hist)

    prev = latest_state.get(name, {})
    if computed.get("grap_transitioned"):
        escalation_log.append({
            "timestamp": now,
            "station": name,
            "from_stage": computed.get("previous_stage"),
            "to_stage": computed.get("grap_stage"),
            "aqi": aqi,
            "mode": MODE,
        })

    return {
        "mode": MODE,
        "aqi": aqi,
        "timestamp": now,
        "cpcb_band": computed.get("cpcb_band"),
        "grap_stage": computed.get("grap_stage", "None"),
        "grap_description": computed.get("grap_description", ""),
        "grap_raw_stage": computed.get("grap_raw_stage"),
        "previous_stage": computed.get("previous_stage"),
        "grap_transitioned": computed.get("grap_transitioned", False),
        "hysteresis_pending": computed.get("hysteresis_pending"),
        "hysteresis_count": computed.get("hysteresis_count", 0),
        "consecutive_windows": computed.get("consecutive_windows", 0),
        "remaining_windows": computed.get("remaining_windows", 0),
        "persistence_triggered": computed.get("persistence_triggered", False),
        "projected_trigger_time": None,

        # Ground truth, straight from the monitor. raw_pm25 prefers the
        # concentration the enrichment step attached; `pm25` is whatever the
        # station table itself carried, which is None for CAQM rows.
        "raw_pm25": station.get("raw_pm25", pm25),
        "raw_pm10": station.get("raw_pm10"),
        "raw_no2": station.get("raw_no2"),
        "raw_so2": station.get("raw_so2"),
        "raw_o3": station.get("raw_o3"),
        "raw_co": station.get("raw_co"),
        "raw_nh3": station.get("raw_nh3"),
        "dominant_pollutant": station.get("dominant_pollutant") or "pm25",
        "pollutants_available": station.get("pollutants_available", 0),
        # Concentrations come from a slower feed than the AQI above them. Both
        # ages are published so neither can be read as the other's.
        "pollutant_source": station.get("pollutant_source"),
        "pollutant_age_minutes": station.get("pollutant_age_minutes"),
        "wind_speed": station.get("wind_speed"),
        "wind_direction": station.get("wind_direction"),

        # Provenance. observed_at is the monitor's own timestamp, not ours.
        "waqi_aqi": None,
        # ISO strings, not datetimes: the API schema types these as strings
        # because the Pathway path passes through whatever the feed sent as
        # text. Handing it a datetime fails validation and 500s the whole
        # stations view.
        "waqi_timestamp": _iso(station.get("observed_at")),
        "station_name_api": name,
        "stale_seconds": station.get("age_minutes", 0) * 60,
        "ingestion_status": "ok",
        "ingestion_error": None,
        "feed_id": str(station.get("location_id", "")),
        "lat": station.get("lat"),
        "lon": station.get("lon"),
        "api_time": _iso(now),

        "forecast": forecast,
        # NOT a confidence score. This published a flat 85 for every station that
        # had any reading at all, which the dashboard rendered as "Confidence 85%"
        # beside a progress bar - a number with no computation behind it, on a screen
        # whose whole claim is that its numbers are traceable. Direct mode computes no
        # confidence, so it reports none and the UI omits the field.
        "confidence_score": None,

        # Subsystems this mode cannot provide. Explicit nulls, not defaults.
        "advisory_text": None,
        "rag_policy_file": None,
        "rag_similarity_score": None,
        "rag_last_updated": None,
        "rag_index_type": None,
        "rag_docs_indexed": 0,
        "rag_embed_model": None,
        "governance_rule": "",
        "llm_analysis": None,
        "vulnerable_risk": prev.get("vulnerable_risk"),
        "vulnerability_max": prev.get("vulnerability_max"),
        "preemptive_advisory": [],

        # Fire / transport intelligence is filled by the poller when available.
        "fire_count": station.get("fire_count", 0),
        "high_conf_fires": station.get("high_conf_fires", 0),
        "transport_score": station.get("transport_score", 0),
        "transport_label": station.get("transport_label", "unknown"),
        "pollution_cause": station.get("pollution_cause", "unclassified"),
        "cause_confidence": station.get("cause_confidence", 0),
        "cause_factors": [],
        "firms_status": station.get("firms_status", "not_polled"),
        "firms_error": None,
        "firms_dataset": None,
        "firms_sync": None,
        "fire_bbox": None,
        "aligned_fires": 0,
        "transport_probability": 0.0,
        "fire_centroid": None,
        "plume_distance_km": 0.0,
        "wind_alignment_deg": 0.0,
        "wind_label": "unknown",

        # No event-time windows in this mode; stated rather than fabricated.
        "avg_aqi_5min": None, "avg_aqi_15min": None,
        "max_aqi_5min": None, "max_aqi_15min": None,
        "aqi_rate_of_change": forecast["slope"] if forecast else None,
    }


# CPCB pollutant fields, as pivot_stations() names them, mapped onto the
# raw_* keys the AQI route already reads.
_POLLUTANT_KEYS = (
    ("pm25", "raw_pm25"), ("pm10", "raw_pm10"), ("no2", "raw_no2"),
    ("so2", "raw_so2"), ("o3", "raw_o3"), ("co", "raw_co"),
    ("nh3", "raw_nh3"),
)


def _attach_pollutants(stations: list[dict]) -> int:
    """Join per-pollutant concentrations onto the CAQM station table.

    CAQM publishes sub-indices only - there is no concentration anywhere in its
    payloads - so the seven pollutant values come from CPCB via data.gov.in,
    which pivot_stations() already extracts and which nothing was reading.
    Measured: 54 of 55 CAQM stations match a data.gov.in station by exact name.

    The two halves have DIFFERENT AGES: the AQI is ~80 min old, the
    concentrations ~5 h. That is recorded per station as pollutant_age_minutes
    rather than smoothed over, because presenting a five-hour-old NO2 beside a
    fresh AQI as though they were one observation is the kind of quiet
    conflation that makes a dashboard untrustworthy.

    Returns the number of stations enriched. Failure is non-fatal: the station
    table is already complete without it.
    """
    try:
        from ingestion.cpcb_stream import fetch_ncr as _cpcb_ncr
        rows = _cpcb_ncr()
    except Exception as exc:                                # noqa: BLE001
        log.warning("pollutant enrichment unavailable: %s", exc)
        return 0

    by_name = {r["station"]: r for r in rows if r.get("station")}
    now = datetime.now(timezone.utc)
    matched = 0

    for st in stations:
        src = by_name.get(st["station"])
        if not src:
            continue
        found = 0
        for cpcb_key, raw_key in _POLLUTANT_KEYS:
            value = src.get(cpcb_key)
            if value is not None:
                st[raw_key] = value
                found += 1
        if not found:
            continue
        matched += 1
        st["pollutants_available"] = found
        st["pollutant_source"] = "CPCB CAAQMS via data.gov.in"
        observed = src.get("observed_at")
        st["pollutant_age_minutes"] = (
            round((now - observed).total_seconds() / 60.0) if observed else None
        )
        # CAQM already named the pollutant leading the index. Keep it: it comes
        # from the fresher feed and is what the published AQI is defined by.
        if not st.get("dominant_pollutant") and src.get("pm25") is not None:
            st["dominant_pollutant"] = "pm25"

    log.info("pollutants: %d/%d stations enriched from data.gov.in",
             matched, len(stations))
    return matched


def _poll_once() -> int:
    """One sampling cycle across the NCR network. Returns stations updated."""
    from ingestion import ncr_observations as obs
    from streaming.state_machine import StreamingStateEngine

    global _cycles

    # CAQM is the regulator's own hourly feed and is measured ~4 hours fresher
    # than the data.gov.in republication (median 79 min vs 322 min), so it is
    # the source for the station table. data.gov.in remains the fallback, and
    # remains the source for the ventilation composite, which needs ug/m3.
    stations: list[dict] = []
    try:
        from ingestion import caqm_stream
        stations = caqm_stream.fetch_ncr()
    except Exception as exc:                                # noqa: BLE001
        log.warning("direct engine: CAQM unavailable, falling back to "
                    "data.gov.in: %s", exc)

    if not stations:
        composite = obs.composite_pm25()
        if not composite.get("available"):
            log.warning("direct engine: no ground observations (%s)",
                        composite.get("reason"))
            return 0
        stations = composite.get("stations", [])

    _attach_pollutants(stations)

    engine = _engines_for_cycle()
    now = datetime.now(timezone.utc)
    for st in stations:
        try:
            latest_state[st["station"]] = _build_state(st, engine, now)
        except Exception:                                   # noqa: BLE001
            log.exception("direct engine: failed to build state for %s",
                          st.get("station"))
    # Drop stations this cycle did not report.
    #
    # latest_state persists across cycles, and nothing ever removed from it. So
    # a station that left the feed kept its last reading forever and went on
    # being counted - and when a cycle fell back to the other source, whose
    # station names differ, the table became the UNION of two networks: 82
    # entries for a 67-station feed, 16 of them hours stale. A live dashboard
    # must not accumulate ghosts.
    #
    # Guarded on a plausible cycle: a partial fetch should degrade the table,
    # never wipe it.
    # Prune against the SOURCE'S ROSTER, not against this cycle's successful
    # reads. A station that timed out this cycle is still part of the network -
    # dropping it would make the station count flicker between cycles, and a
    # count that moves for no reason is indistinguishable from stations going
    # offline. It keeps its last reading and ages out through the normal
    # freshness bands instead. Only names the current source does not know at
    # all are removed, which is what clears the table on a source switch.
    reported = {st["station"] for st in stations}
    roster = set()
    try:
        from ingestion import caqm_stream as _caqm
        roster = _caqm.known_station_names()
    except Exception:                                       # noqa: BLE001
        pass
    keep = reported | roster if roster else reported

    if len(reported) >= MIN_CYCLE_STATIONS:
        for gone in set(latest_state) - keep:
            latest_state.pop(gone, None)
            aqi_history.pop(gone, None)

    _cycles += 1

    # One decision per station state evaluated, matching how the Pathway path
    # counts closed windows.
    carbon_state["decision_count"] += len(stations)
    carbon_state["total_gco2"] = round(
        carbon_state["decision_count"] * CARBON_COST_PER_DECISION, 4)
    carbon_state["per_decision_gco2"] = CARBON_COST_PER_DECISION

    return len(stations)


_state_engine = None


def _engines_for_cycle():
    """
    One StreamingStateEngine for the process lifetime.

    It must be a singleton: persistence counts and hysteresis confirmations are
    held inside it, and rebuilding it each cycle would reset every station to
    zero consecutive windows and make escalation impossible.
    """
    global _state_engine
    if _state_engine is None:
        from streaming.state_machine import StreamingStateEngine
        _state_engine = StreamingStateEngine()
    return _state_engine


def _loop() -> None:
    while not _stop.is_set():
        try:
            n = _poll_once()
            log.info("direct engine: cycle %d, %d stations", _cycles, n)
        except Exception:                                   # noqa: BLE001
            log.exception("direct engine: poll cycle failed")
        # Back off to the normal cadence only once there is something to
        # serve; retry quickly while the station table is still empty.
        _stop.wait(POLL_SECONDS if latest_state else 20)


def start() -> bool:
    """Start the sampling loop. Returns True once the first cycle has data."""
    global _thread, _started_at
    if _thread and _thread.is_alive():
        return True

    _stop.clear()
    _started_at = datetime.now(timezone.utc)

    _thread = threading.Thread(target=_loop, name="aree-direct-engine",
                               daemon=True)
    _thread.start()
    return True


def stop() -> None:
    _stop.set()


def status() -> dict[str, Any]:
    return {
        "mode": MODE,
        "running": bool(_thread and _thread.is_alive()),
        "started_at": _started_at,
        "cycles": _cycles,
        "poll_seconds": POLL_SECONDS,
        "stations": len(latest_state),
        "limitations": [
            "No event-time windowing: samples on an interval, so late or "
            "out-of-order readings are not reconciled.",
            "Policy RAG advisories unavailable (require the Pathway "
            "DocumentStore).",
            "Carbon tracking unavailable.",
        ],
    }
