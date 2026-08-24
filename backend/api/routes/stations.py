"""Station discovery and full per-station state."""

from typing import Any, Dict, List

from fastapi import APIRouter, Path

from .. import engine
from ..freshness import classify, is_stale as _is_stale
from ..deps import require_engine, require_state
from ..schemas import StationDetail, StationListResponse, StationSummary
from ..serialization import engine_mode, station_payload, to_jsonable

router = APIRouter(tags=["stations"])


@router.get("/stations", response_model=StationListResponse,
            summary="All known monitoring nodes with their live headline state")
def list_stations() -> StationListResponse:
    require_engine()
    c = engine.config()
    all_stations: Dict[str, Any] = engine.stations()
    states = engine.latest_state()

    diagnostics = engine.feed_diagnostics()

    summaries: List[StationSummary] = []
    active = 0
    unavailable = 0
    counts = {"current": 0, "aging": 0, "stale": 0, "unavailable": 0}
    fresh_threshold = c.FRESH_DATA_THRESHOLD_SECONDS
    stale_threshold = c.STALE_DATA_THRESHOLD_SECONDS

    for name, meta in all_stations.items():
        state = states.get(name)
        has_data = bool(
            state
            and state.get("aqi") is not None
            and state.get("status") != "DATA_INVALID"
        )
        if has_data:
            active += 1

        # Why a station has no data matters: dormant upstream feed, feed error,
        # or simply no closed window yet.
        feed = diagnostics.get(name, {})
        feed_status = feed.get("status") or ("ok" if has_data else "awaiting")
        if not has_data and feed_status in ("no_aqi", "error"):
            unavailable += 1

        # Freshness and availability are independent: a feed with no usable AQI
        # is unavailable regardless of age, never merely stale.
        station_stale = state.get("stale_seconds") if has_data else None
        freshness = classify(
            station_stale, fresh_threshold, stale_threshold, has_data=has_data,
        )
        counts[freshness] += 1

        summaries.append(StationSummary(
            feed_status=feed_status,
            feed_error=feed.get("error") if not has_data else None,
            feed_last_reading=feed.get("waqi_timestamp") or None,
            stale_seconds=station_stale,
            freshness_status=freshness,
            is_stale=_is_stale(freshness),
            feed_last_sync=feed.get("feed_last_sync"),
            station=name,
            feed_id=meta.get("feed_id", ""),
            lat=meta.get("lat"),
            lon=meta.get("lon"),
            city=meta.get("city"),
            has_data=has_data,
            aqi=state.get("aqi") if has_data else None,
            cpcb_band=state.get("cpcb_band") if has_data else None,
            grap_stage=state.get("grap_stage") if has_data else None,
            eri_score=state.get("eri_score") if has_data else None,
            eri_category=state.get("eri_category") if has_data else None,
            engine_mode=engine_mode(
                state.get("aqi"), state.get("consecutive_windows"),
                c.HIGH_AQI_THRESHOLD, c.PERSISTENCE_THRESHOLD,
            ) if has_data else None,
            transport_label=state.get("transport_label") if has_data else None,
            consecutive_windows=state.get("consecutive_windows") if has_data else None,
            confidence_score=state.get("confidence_score") if has_data else None,
            ingestion_status=state.get("ingestion_status") if has_data else None,
        ))

    summaries.sort(key=lambda s: (-(s.aqi or -1), s.station))
    return StationListResponse(
        total=len(summaries),
        active=active,
        unavailable=unavailable,
        current=counts["current"],
        aging=counts["aging"],
        stale=counts["stale"],
        stations=summaries,
    )


@router.get("/stations/{station:path}", response_model=StationDetail,
            summary="Complete engine state for one station")
def station_detail(station: str = Path(..., description="Station key")) -> StationDetail:
    state, meta = require_state(station)
    c = engine.config()

    payload = station_payload(station, state, meta)
    payload["engine_mode"] = engine_mode(
        state.get("aqi"), state.get("consecutive_windows"),
        c.HIGH_AQI_THRESHOLD, c.PERSISTENCE_THRESHOLD,
    )
    detail_freshness = classify(
        state.get("stale_seconds"),
        c.FRESH_DATA_THRESHOLD_SECONDS, c.STALE_DATA_THRESHOLD_SECONDS,
        has_data=True,
    )
    payload["freshness_status"] = detail_freshness
    payload["is_stale"] = _is_stale(detail_freshness)
    payload["history"] = to_jsonable(engine.aqi_history(station))
    feed = engine.feed_diagnostics(station)
    payload.setdefault("waqi_timestamp_local", feed.get("waqi_timestamp_local"))
    payload.setdefault("waqi_timestamp_utc", feed.get("waqi_timestamp_utc"))
    payload.setdefault("feed_last_sync", feed.get("feed_last_sync"))

    return StationDetail(**payload)
