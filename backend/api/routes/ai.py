"""Gemini structured risk interpretation (explanation layer only)."""

from fastapi import APIRouter, Path

from ..deps import require_state
from ..schemas import AIResponse

router = APIRouter(tags=["ai"])


@router.get("/ai/{station:path}", response_model=AIResponse,
            summary="LLM risk interpretation produced by the engine")
def ai(station: str = Path(...)) -> AIResponse:
    state, _ = require_state(station)
    llm = state.get("llm_analysis") or {}

    return AIResponse(
        station=station,
        summary=llm.get("summary", ""),
        model=llm.get("model"),
        cached=bool(llm.get("cached")),
        timestamp=llm.get("timestamp"),
        risk_trajectory=llm.get("risk_trajectory", "unknown"),
        regulatory_escalation_likelihood=llm.get("regulatory_escalation_likelihood", "unknown"),
        public_health_risk=llm.get("public_health_risk", "unknown"),
        anomaly_flag=bool(llm.get("anomaly_flag")),
        error=llm.get("error"),
    )
