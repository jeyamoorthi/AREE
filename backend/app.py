# Autonomous Regulatory Escalation Engine
# Pathway-native streaming pipeline
# Multi-source ingestion → sliding windows → stateful persistence
# → GRAP state machine → causal attribution → transport vector model

import os
import time
import threading
import numpy as np
from datetime import datetime, timedelta, timezone
from collections import deque

import pathway as pw
from dotenv import load_dotenv
from codecarbon import EmissionsTracker

from config import (
    STATIONS, CITY_NAMES, AQI_POLL_INTERVAL, FIRE_POLL_INTERVAL,
    PERSISTENCE_THRESHOLD, HIGH_AQI_THRESHOLD,
    WINDOW_DURATION_MINUTES, WINDOW_HOP_MINUTES,
    WINDOW_5MIN_DURATION, WINDOW_15MIN_DURATION,
    HYSTERESIS_CONFIRMATIONS, CPCB_BANDS, GRAP_STAGES,
    VULNERABILITY_MULTIPLIERS, GEMINI_MODEL,
)
from ingestion.aqi_stream import fetch_aqi, _debug_data
from ingestion.fire_stream import fetch_fire_count
from ingestion.firms_stream import (
    get_firms_data, compute_transport_score, FIRMSConnectorSubject,
)
from streaming.state_machine import StreamingStateEngine
from streaming.risk_engine import (
    CausalAttributionEngine, TransportVectorModel,
    compute_environmental_intelligence,
)
from rag.advisory_engine import generate_grounded_advisory, _rag_state
from rag.llm_engine import generate_llm_analysis

load_dotenv()

# shared state dicts (read by the FastAPI layer via backend/api/engine.py)
latest_state = {}
carbon_state = {"total_gco2": 0.0, "decision_count": 0, "per_decision_gco2": 0.0}
escalation_log = deque(maxlen=50)

# rolling buffer for trend prediction
aqi_history = {}

# Pathway-native state engines (used inside DAG via pw.apply)
_state_engine = StreamingStateEngine()


def compute_short_term_forecast(history):
    """5-min and 30-min AQI projection via linear regression."""
    if len(history) < 3:
        return None

    times = np.arange(len(history))
    values = np.array([h["aqi"] for h in history])

    slope, intercept = np.polyfit(times, values, 1)
    projected_5min = max(0, min(500, int(slope * (len(history) + 5) + intercept)))
    projected_30min = max(0, min(500, int(slope * (len(history) + 30) + intercept)))
    current_aqi = values[-1]

    if slope > 2:
        direction = "rising"
    elif slope < -2:
        direction = "falling"
    else:
        direction = "stable"

    # how long until we hit the threshold
    escalation_eta = None
    if slope > 0 and current_aqi < HIGH_AQI_THRESHOLD:
        windows_to_threshold = (HIGH_AQI_THRESHOLD - current_aqi) / slope
        escalation_eta = round(windows_to_threshold * (AQI_POLL_INTERVAL / 60), 1)

    # z-score anomaly check
    mean_aqi = np.mean(values)
    std_aqi = np.std(values)
    anomaly = bool(std_aqi > 0 and abs(current_aqi - mean_aqi) > 2 * std_aqi)

    def _grap_for_aqi(a):
        for lo, hi, stage, _ in GRAP_STAGES:
            if lo <= a <= hi:
                return stage
        return "Stage IV (Severe+)" if a > 500 else "None"

    return {
        "slope": round(float(slope), 2),
        "direction": direction,
        "projected_5min": projected_5min,
        "projected_30min": projected_30min,
        "predicted_grap": _grap_for_aqi(projected_5min),
        "predicted_grap_30min": _grap_for_aqi(projected_30min),
        "exposure_score_30min": int(projected_30min * 0.6),
        "escalation_eta": escalation_eta,
        "anomaly": anomaly,
        "rate_per_min": round(float(slope) * (60 / AQI_POLL_INTERVAL), 2),
        "data_points": len(history),
    }


# carbon tracking
tracker = EmissionsTracker(project_name="UrbanLive-AI", log_level="error", save_to_file=False)
tracker.start()
_last_carbon_flush = time.time()
_CARBON_FLUSH_INTERVAL = 30
# deterministic fallback when hardware sensors unavailable (WSL/containers)
_CARBON_COST_PER_DECISION = 0.002  # gCO2eq per streaming decision


# --- Pathway Schemas (Enriched) ---

class AQISchema(pw.Schema):
    timestamp: pw.DateTimeUtc
    aqi: int
    city: str
    pm25: float
    pm10: float
    no2: float
    so2: float
    o3: float
    co: float
    wind_speed: float
    wind_direction: float

class FireSchema(pw.Schema):
    timestamp: pw.DateTimeUtc
    fire_count: int

class FireSatelliteSchema(pw.Schema):
    timestamp: pw.DateTimeUtc
    city: str
    fire_count: int
    high_confidence: int
    transport_status: str


# --- Pathway Connectors (Multi-Source Streaming Ingestion) ---

class AQIConnector(pw.io.python.ConnectorSubject):
    def run(self):
        from station_loader import get_all_stations
        stations = get_all_stations(STATIONS, limit=30)
        while True:
            for name, info in stations.items():
                record = fetch_aqi(name, info["feed_id"])
                if record:
                    if record["timestamp"].tzinfo is None:
                        record["timestamp"] = record["timestamp"].replace(tzinfo=timezone.utc)
                    # ensure numeric fields have defaults for Pathway schema
                    for field in ["pm25", "pm10", "no2", "so2", "o3", "co",
                                  "wind_speed", "wind_direction"]:
                        if record.get(field) is None:
                            record[field] = 0.0
                        else:
                            record[field] = float(record[field])
                    self.next(**record)
            time.sleep(AQI_POLL_INTERVAL)

class FireConnector(pw.io.python.ConnectorSubject):
    def run(self):
        while True:
            record = fetch_fire_count()
            if record:
                if record["timestamp"].tzinfo is None:
                    record["timestamp"] = record["timestamp"].replace(tzinfo=timezone.utc)
                self.next(**record)
            time.sleep(FIRE_POLL_INTERVAL)

class FireSatelliteConnector(pw.io.python.ConnectorSubject):
    """
    Pathway ConnectorSubject for per-station satellite fire data.
    Wraps FIRMS polling cache, emits fire intelligence per station.
    """
    def run(self):
        time.sleep(10)  # wait for FIRMS initial data
        while True:
            for city in STATIONS:
                data = get_firms_data(city)
                record = {
                    "timestamp": datetime.now(timezone.utc),
                    "city": city,
                    "fire_count": data["fire_count"],
                    "high_confidence": data["high_confidence"],
                    "transport_status": data["status"],
                }
                self.next(**record)
            time.sleep(FIRE_POLL_INTERVAL)


# --- Pathway DAG (Full Streaming Pipeline) ---

# Stream 1: AQI (enriched with pollutants + wind)
aqi_table = pw.io.python.read(AQIConnector(), schema=AQISchema)

# Stream 2: Fire count (legacy, simple)
fire_table = pw.io.python.read(FireConnector(), schema=FireSchema)

# Stream 3: Per-station satellite fire intelligence
fire_satellite_table = pw.io.python.read(
    FireSatelliteConnector(), schema=FireSatelliteSchema
)

# --- Multi-Window Sliding Computation ---

# Primary window: 3min duration, 1min hop (existing behavior)
windowed_primary = (
    aqi_table
    .windowby(
        pw.this.timestamp,
        window=pw.temporal.sliding(
            duration=pw.Duration(minutes=WINDOW_DURATION_MINUTES),
            hop=pw.Duration(minutes=WINDOW_HOP_MINUTES),
        ),
        instance=pw.this.city,
    )
    .reduce(
        timestamp=pw.reducers.max(pw.this.timestamp),
        city=pw.reducers.any(pw.this.city),
        aqi=pw.reducers.max(pw.this.aqi),
        avg_aqi=pw.reducers.avg(pw.this.aqi),
        pm25=pw.reducers.avg(pw.this.pm25),
        pm10=pw.reducers.avg(pw.this.pm10),
        wind_speed=pw.reducers.avg(pw.this.wind_speed),
        wind_direction=pw.reducers.avg(pw.this.wind_direction),
    )
)

# 5-minute window: broader trend detection
windowed_5min = (
    aqi_table
    .windowby(
        pw.this.timestamp,
        window=pw.temporal.sliding(
            duration=pw.Duration(minutes=WINDOW_5MIN_DURATION),
            hop=pw.Duration(minutes=WINDOW_HOP_MINUTES),
        ),
        instance=pw.this.city,
    )
    .reduce(
        timestamp=pw.reducers.max(pw.this.timestamp),
        city=pw.reducers.any(pw.this.city),
        avg_aqi_5min=pw.reducers.avg(pw.this.aqi),
        max_aqi_5min=pw.reducers.max(pw.this.aqi),
        min_aqi_5min=pw.reducers.min(pw.this.aqi),
    )
)

# 15-minute window: macro trend
windowed_15min = (
    aqi_table
    .windowby(
        pw.this.timestamp,
        window=pw.temporal.sliding(
            duration=pw.Duration(minutes=WINDOW_15MIN_DURATION),
            hop=pw.Duration(minutes=WINDOW_HOP_MINUTES),
        ),
        instance=pw.this.city,
    )
    .reduce(
        timestamp=pw.reducers.max(pw.this.timestamp),
        city=pw.reducers.any(pw.this.city),
        avg_aqi_15min=pw.reducers.avg(pw.this.aqi),
        max_aqi_15min=pw.reducers.max(pw.this.aqi),
    )
)


# --- Pathway Stateful Transforms via pw.apply ---

# Persistence detection + GRAP state machine (applied on primary window)
@pw.udf
def pathway_state_engine(city: str, aqi: int) -> str:
    """
    Stateful UDF: runs PersistenceTracker + GRAPStateMachine
    inside the Pathway DAG. Returns JSON string of state.
    """
    import json
    result = _state_engine.process(city, aqi)
    return json.dumps(result)

# Causal attribution (applied on primary window)
@pw.udf
def pathway_causal_analysis(
    city: str, aqi: int, wind_speed: float, wind_direction: float,
    pm10: float, pm25: float,
) -> str:
    """
    Stateful UDF: runs CausalAttributionEngine + TransportVectorModel
    inside the Pathway DAG. Returns JSON string.
    """
    import json

    # get fire data and transport score from cache
    firms = get_firms_data(city)
    debug = _debug_data.get(city, {})
    ws = wind_speed if wind_speed > 0 else debug.get("wind_speed")
    wd = wind_direction if wind_direction > 0 else debug.get("wind_direction")

    transport_score, aligned_fires, transport_label = compute_transport_score(
        city, wd, ws
    )

    # determine AQI trend from history
    hist = aqi_history.get(city)
    if hist and len(hist) >= 2:
        recent = [h["aqi"] for h in list(hist)[-3:]]
        diff = recent[-1] - recent[0]
        if diff > 10:
            trend = "rising"
        elif diff < -10:
            trend = "falling"
        else:
            trend = "stable"
    else:
        trend = "unknown"

    # full intelligence computation
    intel = compute_environmental_intelligence(
        station=city, aqi=aqi, aqi_trend=trend,
        fire_count=firms["fire_count"], fires=firms.get("fires", []),
        wind_speed=ws, wind_direction=wd,
        transport_score=transport_score,
        pm10=pm10 if pm10 > 0 else None,
        pm25=pm25 if pm25 > 0 else None,
    )

    # attach transport info
    intel["transport_score"] = transport_score
    intel["aligned_fires"] = aligned_fires
    intel["transport_label"] = transport_label

    return json.dumps(intel, default=str)

# AQI rate of change (computed from 5min window spread)
@pw.udf
def compute_aqi_rate(max_aqi: float, min_aqi: float) -> float:
    """Rate of change within a 5-minute window."""
    if max_aqi is not None and min_aqi is not None:
        return round(float(max_aqi - min_aqi) / 5.0, 2)
    return 0.0


# --- Apply transforms to windowed data ---

enriched_primary = windowed_primary.select(
    timestamp=pw.this.timestamp,
    city=pw.this.city,
    aqi=pw.this.aqi,
    avg_aqi=pw.this.avg_aqi,
    pm25=pw.this.pm25,
    pm10=pw.this.pm10,
    wind_speed=pw.this.wind_speed,
    wind_direction=pw.this.wind_direction,
    # Stateful DAG transforms
    state_json=pathway_state_engine(pw.this.city, pw.this.aqi),
    causal_json=pathway_causal_analysis(
        pw.this.city, pw.this.aqi,
        pw.this.wind_speed, pw.this.wind_direction,
        pw.this.pm10, pw.this.pm25,
    ),
)

enriched_5min = windowed_5min.select(
    timestamp=pw.this.timestamp,
    city=pw.this.city,
    avg_aqi_5min=pw.this.avg_aqi_5min,
    max_aqi_5min=pw.this.max_aqi_5min,
    min_aqi_5min=pw.this.min_aqi_5min,
    aqi_rate_of_change=compute_aqi_rate(
        pw.this.max_aqi_5min, pw.this.min_aqi_5min
    ),
)

enriched_15min = windowed_15min.select(
    timestamp=pw.this.timestamp,
    city=pw.this.city,
    avg_aqi_15min=pw.this.avg_aqi_15min,
    max_aqi_15min=pw.this.max_aqi_15min,
)


# --- Observer: reads enriched Pathway output, handles external I/O ---

# Track multi-window data per station (populated by secondary observers)
_multi_window_cache = {}


class PrimaryObserver(pw.io.python.ConnectorObserver):
    """
    Primary observer on enriched windowed data.
    All computation already done in Pathway DAG.
    Observer handles only: advisory, LLM, carbon, state dict.
    """
    def on_change(self, key, row, time, is_addition):
        global _last_carbon_flush

        if not is_addition:
            return

        import json

        city = row["city"]
        aqi = row["aqi"]
        window_ts = row["timestamp"]

        # validate payload
        try:
            aqi = int(aqi) if aqi is not None else -1
        except (ValueError, TypeError):
            aqi = -1
        if aqi < 0 or window_ts is None:
            latest_state[city] = {
                "status": "DATA_INVALID",
                "reason": "Bad payload",
                "aqi": 0, "timestamp": window_ts,
            }
            return

        # parse Pathway DAG outputs
        state_data = json.loads(row["state_json"])
        causal_data = json.loads(row["causal_json"])

        consec = state_data["consecutive_windows"]
        remaining = state_data["remaining_windows"]
        effective_stage = state_data["grap_stage"]
        grap_desc = state_data["grap_description"]
        band = state_data["cpcb_band"]
        previous_stage = state_data["previous_stage"]
        transitioned = state_data["grap_transitioned"]

        # projected trigger time
        if consec >= PERSISTENCE_THRESHOLD:
            projected = "ACTIVE NOW"
        else:
            mins = remaining * WINDOW_HOP_MINUTES
            if isinstance(window_ts, datetime):
                projected = (window_ts + timedelta(minutes=mins)).strftime("%H:%M:%S")
            else:
                projected = "Calculating..."

        # escalation event log
        if transitioned:
            escalation_log.appendleft({
                "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
                "city": city, "aqi": aqi,
                "from_stage": previous_stage, "to_stage": effective_stage,
                "trigger": f"AQI {aqi} sustained for {consec} consecutive windows",
                "band": band,
            })

        # transport data from causal engine
        transport_score = causal_data.get("transport_score", 0)
        aligned_fires = causal_data.get("aligned_fires", 0)
        transport_label = causal_data.get("transport_label", "none")
        pollution_cause = causal_data.get("pollution_cause", "undetermined")
        cause_confidence = causal_data.get("cause_confidence", 0.0)
        transport_probability = causal_data.get("transport_probability", 0.0)

        # FIRMS data for advisory
        firms = get_firms_data(city)
        debug = _debug_data.get(city, {})
        wind_speed = row.get("wind_speed") or debug.get("wind_speed")
        wind_dir = row.get("wind_direction") or debug.get("wind_direction")
        if wind_speed and wind_speed == 0:
            wind_speed = debug.get("wind_speed")
        if wind_dir and wind_dir == 0:
            wind_dir = debug.get("wind_direction")

        # advisory (requires RAG retrieval — external I/O)
        advisory_result = generate_grounded_advisory(
            aqi=aqi, level=effective_stage, grap_description=grap_desc,
            band=band, fire_count=firms["fire_count"],
            high_count=consec, remaining_windows=remaining,
            projected_time=projected,
            transport_score=transport_score, transport_label=transport_label,
            wind_speed=wind_speed, wind_dir=wind_dir,
        )

        # trend prediction
        if city not in aqi_history:
            aqi_history[city] = deque(maxlen=10)
        aqi_history[city].append({"timestamp": window_ts, "aqi": aqi})
        forecast = compute_short_term_forecast(aqi_history[city])

        # vulnerable population risk
        vulnerable_risk = {}
        preemptive_advisory = []
        vulnerability_max = "low"
        if forecast:
            proj_30 = forecast["projected_30min"]
            for group, multiplier in VULNERABILITY_MULTIPLIERS.items():
                risk_score = int(proj_30 * multiplier)
                if risk_score >= 300:
                    level = "severe"
                elif risk_score >= 200:
                    level = "high"
                elif risk_score >= 100:
                    level = "moderate"
                else:
                    level = "low"
                vulnerable_risk[group] = {
                    "score": risk_score, "level": level, "multiplier": multiplier,
                }

            risk_levels = [v["level"] for v in vulnerable_risk.values()]
            if "severe" in risk_levels:
                vulnerability_max = "severe"
            elif "high" in risk_levels:
                vulnerability_max = "high"
            elif "moderate" in risk_levels:
                vulnerability_max = "moderate"

            # pre-emptive advisory triggers
            if forecast["direction"] == "rising" and proj_30 >= 200 and transport_score >= 40:
                preemptive_advisory = [
                    "Advise suspension of outdoor school activities",
                    "Increase dust suppression enforcement",
                    "Public health SMS advisory recommended",
                    "Traffic enforcement readiness advised",
                ]
            elif forecast["direction"] == "rising" and proj_30 >= 200:
                preemptive_advisory = [
                    "Outdoor activity caution advisory recommended",
                    "Construction dust suppression measures advised",
                ]
            elif forecast["direction"] == "rising" and proj_30 >= 150:
                preemptive_advisory = [
                    "Sensitive groups should reduce outdoor exposure",
                ]

        # gemini analysis (explanation only — external I/O)
        llm_result = {"summary": "Initializing...", "model": GEMINI_MODEL,
                      "cached": False, "timestamp": None, "risk_trajectory": "unknown",
                      "regulatory_escalation_likelihood": "unknown",
                      "public_health_risk": "unknown", "anomaly_flag": False}
        try:
            trend_dir = forecast["direction"] if forecast else "insufficient_data"
            proj_5 = forecast["projected_5min"] if forecast else aqi
            proj_30 = forecast["projected_30min"] if forecast else aqi
            anom = forecast["anomaly"] if forecast else False
            llm_result = generate_llm_analysis(
                station=city, aqi=aqi, trend_direction=trend_dir,
                projected_5min=proj_5, transport_score=transport_score,
                policy_context=advisory_result.get("advisory", "")[:500],
                band=band, grap_stage=effective_stage, anomaly=anom,
                projected_30min=proj_30, vulnerability_max=vulnerability_max,
            )
        except Exception as e:
            llm_result["summary"] = f"LLM unavailable: {str(e)[:80]}"

        # confidence score (deterministic, min 50%)
        confidence_score = 50
        if debug.get("api_time"):
            confidence_score += 20
        if debug.get("pollutants_available", 0) >= 2:
            confidence_score += 10
        if firms["fire_count"] > 0 and wind_speed is not None:
            confidence_score += 20
        confidence_score = min(max(confidence_score, 50), 100)

        # multi-window data from secondary observers
        mw = _multi_window_cache.get(city, {})

        # build state (enriched with Pathway DAG outputs)
        latest_state[city] = {
            "aqi": aqi,
            "timestamp": window_ts,
            "cpcb_band": band,
            "grap_stage": effective_stage,
            "grap_description": grap_desc,
            "consecutive_windows": consec,
            "remaining_windows": remaining,
            "projected_trigger_time": projected,
            "advisory_text": advisory_result["advisory"],
            "rag_policy_file": advisory_result["policy_file"],
            "rag_similarity_score": advisory_result["similarity_score"],
            "rag_last_updated": advisory_result["policy_last_updated"],
            "rag_index_type": advisory_result.get("index_type", "Embedded Vector Index"),
            "rag_docs_indexed": advisory_result.get("docs_indexed", 0),
            "rag_embed_model": advisory_result.get("embed_model", "all-MiniLM-L6-v2"),
            "governance_rule": advisory_result.get("governance_rule", ""),
            "raw_pm25": debug.get("raw_pm25"),
            "raw_pm10": debug.get("raw_pm10"),
            "raw_no2": debug.get("raw_no2"),
            "raw_so2": debug.get("raw_so2"),
            "raw_o3": debug.get("raw_o3"),
            "raw_co": debug.get("raw_co"),
            "dominant_pollutant": debug.get("dominant_pollutant", "pm25"),
            "pollutants_available": debug.get("pollutants_available", 0),
            "wind_speed": wind_speed,
            "wind_direction": wind_dir,
            "waqi_aqi": debug.get("waqi_aqi"),
            "waqi_timestamp": debug.get("waqi_timestamp", ""),
            "station_name_api": debug.get("station_name_api", ""),
            "stale_seconds": debug.get("stale_seconds"),
            "ingestion_status": debug.get("status", "ok"),
            "ingestion_error": debug.get("error"),
            "feed_id": debug.get("feed_id", ""),
            "api_time": debug.get("api_time", ""),
            "fire_count": firms["fire_count"],
            "high_conf_fires": firms["high_confidence"],
            "fire_bbox": firms["bbox"],
            "firms_sync": firms["last_sync"],
            "firms_status": firms["status"],
            "firms_error": firms.get("error"),
            "firms_dataset": firms["dataset"],
            "transport_score": transport_score,
            "aligned_fires": aligned_fires,
            "transport_label": transport_label,
            "confidence_score": confidence_score,
            "forecast": forecast,
            "vulnerable_risk": vulnerable_risk,
            "vulnerability_max": vulnerability_max,
            "preemptive_advisory": preemptive_advisory,
            "llm_analysis": llm_result,
            # --- NEW: Pathway DAG enriched fields ---
            "pollution_cause": pollution_cause,
            "cause_confidence": cause_confidence,
            "cause_factors": causal_data.get("cause_factors", []),
            "transport_probability": transport_probability,
            "fire_centroid": causal_data.get("fire_centroid"),
            "plume_distance_km": causal_data.get("plume_distance_km", 0.0),
            "wind_alignment_deg": causal_data.get("wind_alignment_deg", 0.0),
            "wind_label": causal_data.get("wind_label", "unknown"),
            "avg_aqi_5min": mw.get("avg_aqi_5min"),
            "avg_aqi_15min": mw.get("avg_aqi_15min"),
            "max_aqi_5min": mw.get("max_aqi_5min"),
            "max_aqi_15min": mw.get("max_aqi_15min"),
            "aqi_rate_of_change": mw.get("aqi_rate_of_change"),
            "grap_raw_stage": state_data.get("grap_raw_stage"),
            "previous_stage": previous_stage,
            "grap_transitioned": transitioned,
            "hysteresis_pending": state_data.get("hysteresis_pending"),
            "hysteresis_count": state_data.get("hysteresis_count", 0),
        }

        # ERI (advisory only, does not affect GRAP)
        eri_score = 0
        eri_factors = []
        if aqi >= 200:
            eri_score += 40
            eri_factors.append(f"AQI >= 200 (+40)")
        if forecast and forecast.get("rate_per_min", 0) > 0.5:
            eri_score += 20
            eri_factors.append(f"Slope > 0.5 AQI/min (+20)")
        if consec >= 1:
            eri_score += 20
            eri_factors.append(f"Persistence >= 1 window (+20)")
        if transport_score > 50:
            eri_score += 10
            eri_factors.append(f"Transport score > 50 (+10)")
        exp_score = forecast.get("exposure_score_30min", 0) if forecast else 0
        if exp_score > 150:
            eri_score += 10
            eri_factors.append(f"Exposure score > 150 (+10)")
        eri_score = min(100, max(0, eri_score))

        if eri_score >= 76:
            eri_category = "HIGH READINESS"
        elif eri_score >= 51:
            eri_category = "PRE-ESCALATION"
        elif eri_score >= 26:
            eri_category = "MONITOR"
        else:
            eri_category = "LOW READINESS"

        latest_state[city]["eri_score"] = eri_score
        latest_state[city]["eri_category"] = eri_category
        latest_state[city]["eri_factors"] = eri_factors

        # carbon flush (periodic)
        carbon_state["decision_count"] += 1
        try:
            now = time.time()
            if now - _last_carbon_flush >= _CARBON_FLUSH_INTERVAL:
                kg = tracker.flush()
                _last_carbon_flush = now
                if kg and kg > 0:
                    carbon_state["total_gco2"] = round(kg * 1000, 4)
                else:
                    # deterministic fallback (hardware sensors unavailable)
                    carbon_state["total_gco2"] = round(
                        carbon_state["decision_count"] * _CARBON_COST_PER_DECISION, 4
                    )
                if carbon_state["decision_count"] > 0:
                    carbon_state["per_decision_gco2"] = round(
                        carbon_state["total_gco2"] / carbon_state["decision_count"], 6
                    )
        except Exception:
            # always compute deterministic fallback
            carbon_state["total_gco2"] = round(
                carbon_state["decision_count"] * _CARBON_COST_PER_DECISION, 4
            )
            if carbon_state["decision_count"] > 0:
                carbon_state["per_decision_gco2"] = round(
                    carbon_state["total_gco2"] / carbon_state["decision_count"], 6
                )


class Window5MinObserver(pw.io.python.ConnectorObserver):
    """Observer for 5-min window: caches multi-window metrics."""
    def on_change(self, key, row, time, is_addition):
        if not is_addition:
            return
        city = row["city"]
        if city not in _multi_window_cache:
            _multi_window_cache[city] = {}
        _multi_window_cache[city]["avg_aqi_5min"] = row.get("avg_aqi_5min")
        _multi_window_cache[city]["max_aqi_5min"] = row.get("max_aqi_5min")
        _multi_window_cache[city]["min_aqi_5min"] = row.get("min_aqi_5min")
        _multi_window_cache[city]["aqi_rate_of_change"] = row.get("aqi_rate_of_change")


class Window15MinObserver(pw.io.python.ConnectorObserver):
    """Observer for 15-min window: caches macro trend metrics."""
    def on_change(self, key, row, time, is_addition):
        if not is_addition:
            return
        city = row["city"]
        if city not in _multi_window_cache:
            _multi_window_cache[city] = {}
        _multi_window_cache[city]["avg_aqi_15min"] = row.get("avg_aqi_15min")
        _multi_window_cache[city]["max_aqi_15min"] = row.get("max_aqi_15min")


class FireSatelliteObserver(pw.io.python.ConnectorObserver):
    """Observer for satellite fire data: logs fire events."""
    def on_change(self, key, row, time, is_addition):
        if not is_addition:
            return
        # fire data is primarily consumed via get_firms_data cache
        # this observer enables Pathway to track fire table changes
        pass


# --- Wire up Pathway outputs to observers ---

pw.io.python.write(enriched_primary, PrimaryObserver())
pw.io.python.write(enriched_5min, Window5MinObserver())
pw.io.python.write(enriched_15min, Window15MinObserver())
pw.io.python.write(fire_satellite_table, FireSatelliteObserver())


def _run():
    pw.run(monitoring_level=pw.MonitoringLevel.NONE)

threading.Thread(target=_run, daemon=True).start()