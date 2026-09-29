"""GRAP escalation event history."""

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Query

from .. import engine
from ..deps import require_engine
from ..schemas import EscalationEvent, EscalationsResponse
from ..serialization import to_jsonable

router = APIRouter(tags=["escalations"])

_EPOCH = datetime.min.replace(tzinfo=timezone.utc)


def _event_station(event: Dict[str, Any]) -> Optional[str]:
    # app.py records the station under "city"; the direct engine under "station".
    return event.get("city") or event.get("station")


def _event_time(event: Dict[str, Any]) -> datetime:
    """Sort key. The two engines write different timestamp shapes (a datetime,
    or a "YYYY-MM-DD HH:MM:SS UTC" string); unparseable ones sort last."""
    ts = event.get("timestamp")
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    if isinstance(ts, str):
        for parse in (lambda v: datetime.strptime(v, "%Y-%m-%d %H:%M:%S UTC"),
                      lambda v: datetime.fromisoformat(v.replace("Z", "+00:00"))):
            try:
                dt = parse(ts)
                return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    return _EPOCH


@router.get("/escalations", response_model=EscalationsResponse,
            summary="Recorded GRAP stage transitions (most recent first)")
def escalations(
    station: Optional[str] = Query(None, description="Filter to one station"),
    limit: int = Query(50, ge=1, le=200),
) -> EscalationsResponse:
    require_engine()
    events = engine.escalation_log()

    if station:
        events = [e for e in events if _event_station(e) == station]

    # Both engines log newest-first, but the contract is enforced here rather
    # than trusted, so the slice below always keeps the most recent events.
    events = sorted(events, key=_event_time, reverse=True)

    total = len(events)
    out = []
    for e in events[:limit]:
        payload = to_jsonable(e)
        name = _event_station(e)
        # Carry both keys so a client reading either works against either engine.
        payload["city"] = name
        payload["station"] = name
        out.append(EscalationEvent(**payload))
    return EscalationsResponse(total=total, events=out)
