"""ERI, satellite transport intelligence and causal attribution."""

from fastapi import APIRouter, Path

from ..deps import require_state
from ..schemas import RiskResponse
from ..serialization import to_jsonable

router = APIRouter(tags=["risk"])


@router.get("/risk/{station:path}", response_model=RiskResponse,
            summary="Escalation Readiness Index and satellite attribution")
def risk(station: str = Path(...)) -> RiskResponse:
    state, _ = require_state(station)

    centroid = state.get("fire_centroid")
    if centroid is not None:
        centroid = to_jsonable(centroid)

    return RiskResponse(
        station=station,
        # ERI is computed in app.py (the Pathway path) and nowhere else. These
        # used to default to 0 / "LOW READINESS", so a station whose readiness had
        # never been computed was served a score AND a verbal verdict. The verdict
        # is the worse half: a reader can discount a suspicious 0, but
        # "LOW READINESS" reads as an assessment. Both are now null in a mode that
        # does not compute them.
        eri_score=state.get("eri_score"),
        eri_category=state.get("eri_category"),
        eri_factors=list(state.get("eri_factors", []) or []),
        confidence_score=state.get("confidence_score"),
        transport_score=state.get("transport_score"),
        transport_label=state.get("transport_label"),
        aligned_fires=state.get("aligned_fires"),
        fire_count=state.get("fire_count"),
        high_conf_fires=state.get("high_conf_fires"),
        fire_bbox=state.get("fire_bbox"),
        firms_sync=state.get("firms_sync"),
        firms_status=state.get("firms_status"),
        firms_error=state.get("firms_error"),
        firms_dataset=state.get("firms_dataset"),
        wind_speed=state.get("wind_speed"),
        wind_direction=state.get("wind_direction"),
        wind_label=state.get("wind_label"),
        pollution_cause=state.get("pollution_cause"),
        cause_confidence=state.get("cause_confidence"),
        cause_factors=list(state.get("cause_factors", []) or []),
        transport_probability=state.get("transport_probability"),
        fire_centroid=centroid,
        plume_distance_km=state.get("plume_distance_km"),
        wind_alignment_deg=state.get("wind_alignment_deg"),
    )
