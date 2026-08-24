"""Carbon intensity accounting for the streaming engine."""

from fastapi import APIRouter

from .. import engine
from ..deps import require_engine
from ..schemas import CarbonResponse

router = APIRouter(tags=["carbon"])


@router.get("/carbon", response_model=CarbonResponse,
            summary="Engine carbon accounting")
def carbon() -> CarbonResponse:
    require_engine()
    state = engine.carbon_state()
    return CarbonResponse(
        total_gco2=float(state.get("total_gco2", 0.0) or 0.0),
        decision_count=int(state.get("decision_count", 0) or 0),
        per_decision_gco2=float(state.get("per_decision_gco2", 0.0) or 0.0),
    )
