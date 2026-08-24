"""Predictive intelligence and the public-health impact forecast (VPPE)."""

from fastapi import APIRouter, Path

from .. import engine
from ..deps import require_state
from ..schemas import (
    AQIHistoryPoint, ForecastResponse, HealthImpactResponse, VulnerableGroup,
)
from ..serialization import to_jsonable

router = APIRouter(tags=["forecast"])

GROUP_LABELS = {
    "general": "General Public",
    "elderly": "Elderly (60+)",
    "children": "Children (<14)",
    "respiratory": "Respiratory / Asthma",
}


@router.get("/forecast/{station:path}/health", response_model=HealthImpactResponse,
            summary="Public health impact forecast (vulnerable population risk)")
def health_impact(station: str = Path(...)) -> HealthImpactResponse:
    state, _ = require_state(station)
    c = engine.config()

    fc = state.get("forecast") or {}
    vuln = state.get("vulnerable_risk") or {}

    if not fc or not vuln:
        return HealthImpactResponse(
            station=station, available=False,
            impact_radius_km=c.DEFAULT_IMPACT_RADIUS_KM,
            est_population=c.DEFAULT_EST_POPULATION,
        )

    proj30 = fc.get("projected_30min", 0)
    if proj30 >= 300:
        urgency = "CRITICAL"
    elif proj30 >= 200:
        urgency = "HIGH"
    elif proj30 >= 100:
        urgency = "MODERATE"
    else:
        urgency = "LOW"

    groups = [
        VulnerableGroup(
            group=key,
            label=label,
            score=vuln.get(key, {}).get("score", 0),
            level=vuln.get(key, {}).get("level", "low"),
            multiplier=vuln.get(key, {}).get("multiplier", 1.0),
        )
        for key, label in GROUP_LABELS.items()
    ]

    return HealthImpactResponse(
        station=station,
        available=True,
        projected_30min=proj30,
        predicted_grap_30min=fc.get("predicted_grap_30min"),
        exposure_score_30min=fc.get("exposure_score_30min"),
        mitigation_urgency=urgency,
        vulnerability_max=state.get("vulnerability_max"),
        groups=groups,
        preemptive_advisory=list(state.get("preemptive_advisory", []) or []),
        impact_radius_km=c.DEFAULT_IMPACT_RADIUS_KM,
        est_population=c.DEFAULT_EST_POPULATION,
    )


@router.get("/forecast/{station:path}", response_model=ForecastResponse,
            summary="Short-term AQI projection with window history")
def forecast(station: str = Path(...)) -> ForecastResponse:
    state, _ = require_state(station)
    fc = state.get("forecast")

    history = [
        AQIHistoryPoint(timestamp=to_jsonable(p.get("timestamp")), aqi=p.get("aqi"))
        for p in engine.aqi_history(station)
    ]

    if not fc:
        return ForecastResponse(station=station, available=False, history=history)

    return ForecastResponse(
        station=station,
        available=True,
        slope=fc.get("slope"),
        direction=fc.get("direction"),
        projected_5min=fc.get("projected_5min"),
        projected_30min=fc.get("projected_30min"),
        predicted_grap=fc.get("predicted_grap"),
        predicted_grap_30min=fc.get("predicted_grap_30min"),
        exposure_score_30min=fc.get("exposure_score_30min"),
        escalation_eta=fc.get("escalation_eta"),
        anomaly=bool(fc.get("anomaly")),
        rate_per_min=fc.get("rate_per_min"),
        data_points=fc.get("data_points", 0),
        history=history,
    )
