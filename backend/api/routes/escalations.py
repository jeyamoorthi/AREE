"""GRAP escalation event history."""

from typing import Optional

from fastapi import APIRouter, Query

from .. import engine
from ..deps import require_engine
from ..schemas import EscalationEvent, EscalationsResponse
from ..serialization import to_jsonable

router = APIRouter(tags=["escalations"])


@router.get("/escalations", response_model=EscalationsResponse,
            summary="Recorded GRAP stage transitions (most recent first)")
def escalations(
    station: Optional[str] = Query(None, description="Filter to one station"),
    limit: int = Query(50, ge=1, le=200),
) -> EscalationsResponse:
    require_engine()
    events = engine.escalation_log()

    if station:
        events = [e for e in events if e.get("city") == station]

    total = len(events)
    return EscalationsResponse(
        total=total,
        events=[EscalationEvent(**to_jsonable(e)) for e in events[:limit]],
    )
