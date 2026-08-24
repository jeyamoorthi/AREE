"""JSON-safe conversion of engine state.

The engine state dicts hold datetimes, tuples, numpy scalars and deques that
FastAPI cannot serialise directly. Nothing here reshapes or recomputes values —
it only makes the existing values transportable.
"""

from collections import deque
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional


def to_jsonable(value: Any) -> Any:
    """Recursively convert engine values into JSON-serialisable primitives."""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value

    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()

    if isinstance(value, date):
        return value.isoformat()

    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}

    if isinstance(value, (list, tuple, set, frozenset, deque)):
        return [to_jsonable(v) for v in value]

    # numpy scalars / anything exposing .item()
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return to_jsonable(item())
        except Exception:  # noqa: BLE001
            pass

    if hasattr(value, "tolist"):
        try:
            return to_jsonable(value.tolist())
        except Exception:  # noqa: BLE001
            pass

    return str(value)


def station_payload(station: str, state: Optional[Dict[str, Any]],
                    meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Full JSON-safe state for one station plus its static metadata."""
    meta = meta or {}
    payload: Dict[str, Any] = {
        "station": station,
        "feed_id": meta.get("feed_id") or (state or {}).get("feed_id") or "",
        "lat": meta.get("lat"),
        "lon": meta.get("lon"),
        "city": meta.get("city"),
        "state_name": meta.get("state"),
        "api_name": meta.get("api_name"),
        "has_data": bool(state),
    }
    if state:
        payload.update(to_jsonable(state))
        payload["station"] = station
        if meta.get("feed_id"):
            payload["feed_id"] = meta["feed_id"]
        payload["lat"] = meta.get("lat")
        payload["lon"] = meta.get("lon")
        payload["city"] = meta.get("city")
        payload["has_data"] = True
    return payload


def engine_mode(aqi: Any, consecutive: Any, high_threshold: int,
                persistence_threshold: int) -> str:
    """The TRIGGERED / WATCH / NORMAL classification used across the UI."""
    try:
        aqi = int(aqi or 0)
        consecutive = int(consecutive or 0)
    except (TypeError, ValueError):
        return "NORMAL"
    if aqi >= high_threshold and consecutive >= persistence_threshold:
        return "TRIGGERED"
    if aqi >= high_threshold and consecutive > 0:
        return "WATCH"
    return "NORMAL"


def parse_advisory_sections(advisory: str) -> List[Dict[str, str]]:
    """Split the generated advisory text into titled blocks.

    Mirrors the section splitting the former Streamlit dashboard did inline so the
    frontend renders the same structure without re-implementing the rule.
    """
    sections: List[Dict[str, str]] = []
    current_name = None
    current_lines: List[str] = []

    for line in (advisory or "").split("\n"):
        stripped = line.strip()
        if stripped and all(c == "=" for c in stripped):
            continue
        is_heading = (
            stripped
            and ":" not in stripped
            and not stripped.startswith("-")
            and not stripped.startswith(" ")
            and len(stripped) < 30
            and stripped == stripped.upper()
        )
        if is_heading:
            if current_name and current_lines:
                sections.append({"title": current_name, "body": "\n".join(current_lines)})
            current_name = stripped
            current_lines = []
        elif stripped:
            current_lines.append(line)

    if current_name and current_lines:
        sections.append({"title": current_name, "body": "\n".join(current_lines)})

    return sections
