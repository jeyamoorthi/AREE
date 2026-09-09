"""System status, store continuity and engine configuration."""

from datetime import datetime, timezone

from fastapi import APIRouter

from .. import capture_scheduler, engine
from ..freshness import classify
from ..deps import require_engine
from ..schemas import CaptureStatus, EngineConfig, SystemStatus

router = APIRouter(tags=["system"])


@router.get("/system/capture", response_model=CaptureStatus,
            summary="Observation-store continuity and the capture thread")
def capture_status() -> CaptureStatus:
    """Can the live forecast be served, and if not, why not?

    Deliberately engine-independent and deliberately incapable of failing: a
    diagnostic that 500s when the thing it diagnoses is broken is worse than no
    diagnostic. Every store field degrades to null rather than raising.
    """
    st = dict(capture_scheduler.status())

    newest = gap = holes = oldest = None
    window = 0
    continuous = False
    try:
        from ...backfill import db                            # noqa: PLC0415
        from ...forecast import pm25_forecast as fc           # noqa: PLC0415

        conn = db.connect()
        window = fc.OBSERVATION_WINDOW_HOURS
        newest_dt = capture_scheduler.newest_captured_hour(conn)
        newest = newest_dt.isoformat() if newest_dt else None
        gap = capture_scheduler.gap_hours(conn)
        missing = capture_scheduler.missing_hours(conn)
        holes = len(missing)
        oldest = min(missing).isoformat() if missing else None
        # Continuous means the forecast's lag window is intact. It is NOT the
        # same as "recently captured": a store can be one hour behind and still
        # be missing an hour from yesterday, which is the failure this exists
        # to make visible.
        continuous = holes == 0
    except Exception:                                          # noqa: BLE001
        pass

    return CaptureStatus(
        enabled=bool(st.get("enabled")),
        running=bool(st.get("running")),
        cycles=int(st.get("cycles") or 0),
        last_snapshot_at=st.get("last_snapshot_at"),
        last_written=st.get("last_written"),
        last_error=st.get("last_error"),
        bootstrapped=bool(st.get("bootstrapped")),
        newest_hour=newest,
        trailing_gap_hours=round(gap, 2) if gap is not None else None,
        holes=holes or 0,
        oldest_hole=oldest,
        continuous=continuous,
        observation_window_hours=window,
    )


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
            mode=st.get("mode"),
            degraded=True,
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
            # Named `station_state`, not `st`: `st` above holds the ENGINE status and
            # this loop used to shadow it, so every field read from `st` after this
            # point was silently reading a station payload instead.
            station_state = states.get(name)
            has_data = bool(
                isinstance(station_state, dict)
                and station_state.get("aqi") is not None
                and station_state.get("status") != "DATA_INVALID"
            )
            age = station_state.get("stale_seconds") if has_data else None
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
        mode=engine.status().get("mode"),
        degraded=bool(engine.status().get("degraded")),
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
