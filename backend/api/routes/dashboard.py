"""National overview: map points, top lists and cross-station rankings."""

from datetime import datetime, timezone
from typing import Any, Callable, Dict, List

from fastapi import APIRouter

from .. import engine
from ..deps import require_engine
from ..schemas import (
    DashboardResponse, MapPoint, RankedEntry, RankingGroup,
)
from ..serialization import engine_mode, to_jsonable

router = APIRouter(tags=["dashboard"])


def _rank(active: Dict[str, Dict[str, Any]], getter: Callable[[Dict[str, Any]], Any],
          limit: int = 5) -> List[RankedEntry]:
    # Only stations that actually HAVE the metric are ranked. Sorting `None or 0`
    # produced a full "top 5" table in a mode where nothing computes ERI at all -
    # an ordering of absent values, presented with rank numbers beside it. An
    # empty ranking is the honest output when the metric does not exist.
    scored = [(name, vals) for name, vals in active.items() if getter(vals) is not None]
    ranked = sorted(scored, key=lambda kv: getter(kv[1]), reverse=True)[:limit]
    return [
        RankedEntry(
            rank=i + 1,
            station=name,
            value=to_jsonable(getter(vals)),
            aqi=vals.get("aqi"),
            eri_score=vals.get("eri_score"),
        )
        for i, (name, vals) in enumerate(ranked)
    ]


def _forecast_field(field: str) -> Callable[[Dict[str, Any]], Any]:
    def getter(vals: Dict[str, Any]):
        fc = vals.get("forecast")
        return fc.get(field, 0) if fc else 0
    return getter


@router.get("/dashboard", response_model=DashboardResponse,
            summary="National regulatory overview")
def dashboard() -> DashboardResponse:
    require_engine()
    c = engine.config()
    active = engine.active_states()
    all_stations = engine.stations()

    modes = {"TRIGGERED": 0, "WATCH": 0, "NORMAL": 0}
    map_points: List[MapPoint] = []

    for name, vals in active.items():
        mode = engine_mode(
            vals.get("aqi"), vals.get("consecutive_windows"),
            c.HIGH_AQI_THRESHOLD, c.PERSISTENCE_THRESHOLD,
        )
        modes[mode] = modes.get(mode, 0) + 1

        meta = all_stations.get(name) or c.STATIONS.get(name) or {}
        if meta.get("lat") is not None and meta.get("lon") is not None:
            map_points.append(MapPoint(
                station=name,
                lat=float(meta["lat"]),
                lon=float(meta["lon"]),
                aqi=vals.get("aqi"),
                cpcb_band=vals.get("cpcb_band"),
                grap_stage=vals.get("grap_stage"),
                eri_score=vals.get("eri_score"),
                engine_mode=mode,
                status=vals.get("ingestion_status"),
            ))

    rankings = [
        RankingGroup(key="aqi", label="Highest AQI",
                     entries=_rank(active, lambda v: v.get("aqi", 0), 3)),
        RankingGroup(key="eri", label="Highest ERI",
                     entries=_rank(active, lambda v: v.get("eri_score"), 3)),
        RankingGroup(key="rate", label="Fastest Rising",
                     entries=_rank(active, _forecast_field("rate_per_min"), 3)),
        RankingGroup(key="exposure", label="Highest Exposure",
                     entries=_rank(active, _forecast_field("exposure_score_30min"), 3)),
    ]

    return DashboardResponse(
        active_stations=len(active),
        known_stations=len(all_stations),
        triggered=modes.get("TRIGGERED", 0),
        watch=modes.get("WATCH", 0),
        normal=modes.get("NORMAL", 0),
        map_points=map_points,
        top_aqi=_rank(active, lambda v: v.get("aqi", 0), 5),
        top_eri=_rank(active, lambda v: v.get("eri_score"), 5),
        rankings=rankings,
        carbon=to_jsonable(engine.carbon_state()),
        escalations_recorded=len(engine.escalation_log()),
        server_time=datetime.now(timezone.utc).isoformat(),
    )
