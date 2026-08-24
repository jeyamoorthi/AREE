"""System status and engine configuration."""

from datetime import datetime, timezone

from fastapi import APIRouter

from .. import engine
from ..freshness import classify
from ..deps import require_engine
from ..schemas import EngineConfig, SystemStatus

router = APIRouter(tags=["system"])


@router.get("/system/status", response_model=SystemStatus,
            summary="Engine + pipeline status for the live status bar")
def system_status() -> SystemStatus:
    st = engine.status()
    now = datetime.now(timezone.utc).isoformat()

    if not st["loaded"]:
        return SystemStatus(
            engine_loaded=False,
            engine_error=st.get("error"),
            pipeline="offline",
            active_stations=0,
            known_stations=0,
            decisions_processed=0,
            escalations_recorded=0,
            server_time=now,
        )

    rag = {}
    try:
        rag = engine.rag_state()
    except Exception:  # noqa: BLE001 - status must never fail
        rag = {}

    # Network-wide freshness, computed from live state - never hardcoded.
    # Unavailable is decided by the feed's own status, not by age.
    counts = {"current": 0, "aging": 0, "stale": 0, "unavailable": 0}
    try:
        cfg = engine.config()
        states = engine.latest_state()
        diagnostics = engine.feed_diagnostics()
        for name in engine.stations():
            st = states.get(name)
            has_data = bool(
                isinstance(st, dict)
                and st.get("aqi") is not None
                and st.get("status") != "DATA_INVALID"
            )
            age = st.get("stale_seconds") if has_data else None
            counts[classify(
                age,
                cfg.FRESH_DATA_THRESHOLD_SECONDS,
                cfg.STALE_DATA_THRESHOLD_SECONDS,
                has_data=has_data,
            )] += 1
    except Exception:  # noqa: BLE001 - status must never fail
        counts = {"current": 0, "aging": 0, "stale": 0, "unavailable": 0}

    llm = {}
    try:
        llm = engine.llm_status()
    except Exception:  # noqa: BLE001
        llm = {}

    return SystemStatus(
        engine_loaded=True,
        engine_error=None,
        pipeline="running",
        active_stations=len(engine.active_states()),
        known_stations=len(engine.stations()),
        decisions_processed=int(engine.carbon_state().get("decision_count", 0)),
        escalations_recorded=len(engine.escalation_log()),
        current_stations=counts["current"],
        aging_stations=counts["aging"],
        stale_stations=counts["stale"],
        unavailable_stations=counts["unavailable"],
        rag_status=rag.get("store_status"),
        rag_docs_indexed=rag.get("docs_indexed"),
        llm_ready=llm.get("ready"),
        llm_model=llm.get("model"),
        llm_error=llm.get("last_error"),
        server_time=now,
    )


@router.get("/system/config", response_model=EngineConfig,
            summary="Thresholds and window parameters the UI explains")
def system_config() -> EngineConfig:
    require_engine()
    c = engine.config()

    return EngineConfig(
        persistence_threshold=c.PERSISTENCE_THRESHOLD,
        high_aqi_threshold=c.HIGH_AQI_THRESHOLD,
        window_duration_minutes=c.WINDOW_DURATION_MINUTES,
        window_hop_minutes=c.WINDOW_HOP_MINUTES,
        hysteresis_confirmations=c.HYSTERESIS_CONFIRMATIONS,
        aqi_poll_interval=c.AQI_POLL_INTERVAL,
        fire_poll_interval=c.FIRE_POLL_INTERVAL,
        fresh_data_threshold_seconds=c.FRESH_DATA_THRESHOLD_SECONDS,
        stale_data_threshold_seconds=c.STALE_DATA_THRESHOLD_SECONDS,
        firms_dataset=c.FIRMS_DATASET,
        impact_radius_km=c.DEFAULT_IMPACT_RADIUS_KM,
        est_population=c.DEFAULT_EST_POPULATION,
        vulnerability_multipliers=dict(c.VULNERABILITY_MULTIPLIERS),
        cpcb_bands=[{"low": lo, "high": hi, "label": lb} for lo, hi, lb in c.CPCB_BANDS],
        grap_stages=[
            {"low": lo, "high": hi, "stage": stage, "description": desc}
            for lo, hi, stage, desc in c.GRAP_STAGES
        ],
    )
