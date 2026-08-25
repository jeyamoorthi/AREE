"""AQI, pollutant transparency and data-source provenance."""

from fastapi import APIRouter, Path

from .. import engine
from ..freshness import classify, is_stale as _is_stale
from ..deps import require_state
from ..schemas import (
    AQIHistoryPoint, AQIHistoryResponse, AQIResponse, PollutantReading,
)
from ..serialization import to_jsonable

router = APIRouter(tags=["aqi"])

POLLUTANTS = [
    ("PM2.5", "raw_pm25"),
    ("PM10", "raw_pm10"),
    ("NO2", "raw_no2"),
    ("SO2", "raw_so2"),
    ("O3", "raw_o3"),
    ("CO", "raw_co"),
    # CPCB reports NH3 for most NCR stations and the pivot already extracts it;
    # omitting it here dropped a pollutant the feed was actually supplying.
    ("NH3", "raw_nh3"),
]


@router.get("/aqi/{station:path}/history", response_model=AQIHistoryResponse,
            summary="Rolling AQI window history for trend charts")
def aqi_history(station: str = Path(...)) -> AQIHistoryResponse:
    require_state(station)
    points = [
        AQIHistoryPoint(timestamp=to_jsonable(p.get("timestamp")), aqi=p.get("aqi"))
        for p in engine.aqi_history(station)
    ]
    return AQIHistoryResponse(station=station, points=points)


@router.get("/aqi/{station:path}", response_model=AQIResponse,
            summary="Live AQI with pollutant and feed transparency")
def aqi(station: str = Path(...)) -> AQIResponse:
    state, _ = require_state(station)
    c = engine.config()

    stale = state.get("stale_seconds")
    readings = [
        PollutantReading(
            name=name, key=key,
            value=state.get(key),
            available=state.get(key) is not None,
        )
        for name, key in POLLUTANTS
    ]

    feed = engine.feed_diagnostics(station)
    # This route is only reached for a station with usable state, so the feed
    # has data; availability is decided upstream by require_state().
    freshness = classify(
        stale, c.FRESH_DATA_THRESHOLD_SECONDS, c.STALE_DATA_THRESHOLD_SECONDS,
        has_data=True,
    )

    return AQIResponse(
        station=station,
        aqi=state.get("aqi"),
        cpcb_band=state.get("cpcb_band"),
        waqi_aqi=state.get("waqi_aqi"),
        waqi_timestamp=state.get("waqi_timestamp"),
        station_name_api=state.get("station_name_api"),
        feed_id=state.get("feed_id"),
        api_time=state.get("api_time"),
        stale_seconds=stale,
        freshness_status=freshness,
        is_stale=_is_stale(freshness),
        # Presentation of the same authoritative instant, read from the poller's
        # diagnostics so the Pathway observer state stays untouched.
        waqi_timestamp_local=feed.get("waqi_timestamp_local"),
        waqi_timestamp_utc=feed.get("waqi_timestamp_utc"),
        feed_last_sync=feed.get("feed_last_sync"),
        dominant_pollutant=state.get("dominant_pollutant"),
        pollutants_available=state.get("pollutants_available", 0),
        pollutants=readings,
        ingestion_status=state.get("ingestion_status"),
        ingestion_error=state.get("ingestion_error"),
        avg_aqi_5min=state.get("avg_aqi_5min"),
        avg_aqi_15min=state.get("avg_aqi_15min"),
        max_aqi_5min=state.get("max_aqi_5min"),
        max_aqi_15min=state.get("max_aqi_15min"),
        aqi_rate_of_change=state.get("aqi_rate_of_change"),
    )
