"""GRAP regulatory stage, persistence engine state and decision trace."""

from fastapi import APIRouter, Path

from .. import engine
from ..deps import require_state
from ..schemas import GRAPResponse
from ..serialization import engine_mode

router = APIRouter(tags=["grap"])


@router.get("/grap/{station:path}", response_model=GRAPResponse,
            summary="GRAP stage, persistence progress and decision trace")
def grap(station: str = Path(...)) -> GRAPResponse:
    state, _ = require_state(station)
    c = engine.config()

    aqi = state.get("aqi", 0) or 0
    consec = state.get("consecutive_windows", 0) or 0
    mode = engine_mode(aqi, consec, c.HIGH_AQI_THRESHOLD, c.PERSISTENCE_THRESHOLD)
    pct = min(100, int((consec / max(c.PERSISTENCE_THRESHOLD, 1)) * 100))
    triggered = consec >= c.PERSISTENCE_THRESHOLD

    trace = {
        "input_aqi": aqi,
        "threshold": c.HIGH_AQI_THRESHOLD,
        "persistence": f"{consec}/{c.PERSISTENCE_THRESHOLD}",
        "hysteresis": f"{c.HYSTERESIS_CONFIRMATIONS} confirmations",
        "engine_mode": mode,
        "escalation": "TRIGGERED" if triggered else "Not triggered",
        "reason": (
            f"AQI {aqi} {'>=' if aqi >= c.HIGH_AQI_THRESHOLD else '<'} "
            f"{c.HIGH_AQI_THRESHOLD} for {consec} window(s)"
        ),
        "stage": state.get("grap_stage"),
    }

    return GRAPResponse(
        station=station,
        aqi=aqi,
        cpcb_band=state.get("cpcb_band"),
        grap_stage=state.get("grap_stage"),
        grap_raw_stage=state.get("grap_raw_stage"),
        grap_description=state.get("grap_description"),
        previous_stage=state.get("previous_stage"),
        grap_transitioned=state.get("grap_transitioned"),
        hysteresis_pending=state.get("hysteresis_pending"),
        hysteresis_count=state.get("hysteresis_count", 0) or 0,
        consecutive_windows=consec,
        remaining_windows=state.get("remaining_windows", c.PERSISTENCE_THRESHOLD) or 0,
        persistence_percent=pct,
        projected_trigger_time=state.get("projected_trigger_time"),
        engine_mode=mode,
        governance_rule=state.get("governance_rule"),
        decision_trace=trace,
    )
