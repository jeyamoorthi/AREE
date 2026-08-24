"""Policy-grounded regulatory advisory produced by the RAG engine."""

from fastapi import APIRouter, Path

from .. import engine
from ..deps import require_state
from ..schemas import AdvisoryResponse, AdvisorySection
from ..serialization import engine_mode, parse_advisory_sections

router = APIRouter(tags=["advisory"])


@router.get("/advisory/{station:path}", response_model=AdvisoryResponse,
            summary="Grounded advisory text with policy retrieval metadata")
def advisory(station: str = Path(...)) -> AdvisoryResponse:
    state, _ = require_state(station)
    c = engine.config()

    text = state.get("advisory_text", "") or ""
    sections = [AdvisorySection(**s) for s in parse_advisory_sections(text)]

    aqi = state.get("aqi", 0) or 0
    consec = state.get("consecutive_windows", 0) or 0
    mode = engine_mode(aqi, consec, c.HIGH_AQI_THRESHOLD, c.PERSISTENCE_THRESHOLD)

    return AdvisoryResponse(
        station=station,
        advisory_text=text,
        sections=sections,
        governance_rule=state.get("governance_rule"),
        rag_policy_file=state.get("rag_policy_file"),
        rag_similarity_score=state.get("rag_similarity_score"),
        rag_last_updated=state.get("rag_last_updated"),
        rag_index_type=state.get("rag_index_type"),
        rag_docs_indexed=state.get("rag_docs_indexed"),
        rag_embed_model=state.get("rag_embed_model"),
        decision_trace={
            "input_aqi": aqi,
            "threshold": c.HIGH_AQI_THRESHOLD,
            "persistence": f"{consec}/{c.PERSISTENCE_THRESHOLD}",
            "hysteresis": f"{c.HYSTERESIS_CONFIRMATIONS} confirmations",
            "engine_mode": mode,
            "escalation": "TRIGGERED" if consec >= c.PERSISTENCE_THRESHOLD else "Not triggered",
            "reason": (
                f"AQI {aqi} {'>=' if aqi >= c.HIGH_AQI_THRESHOLD else '<'} "
                f"{c.HIGH_AQI_THRESHOLD} for {consec} window(s)"
            ),
        },
    )
