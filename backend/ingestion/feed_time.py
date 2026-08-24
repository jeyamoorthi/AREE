"""Presentation helpers for WAQI feed timestamps.

Display-only. Nothing here participates in staleness calculation, AQI
computation or escalation logic — `stale_seconds` is still derived from
`time.iso` in aqi_stream.py and is not touched by this module.

WAQI's `time.v` (Unix) field is deliberately ignored everywhere: it encodes the
station's local wall-clock as if it were UTC, contradicting the payload's own
`tz` field. `time.iso` is authoritative.
"""

from datetime import datetime, timezone

# Offsets we can name. Anything else falls back to a numeric UTC±HH:MM label,
# so an unknown region is never mislabelled.
_OFFSET_LABELS = {
    19800: "IST",     # +05:30
    0: "UTC",
}


def _offset_label(dt: datetime) -> str:
    offset = dt.utcoffset()
    if offset is None:
        return ""
    seconds = int(offset.total_seconds())
    if seconds in _OFFSET_LABELS:
        return _OFFSET_LABELS[seconds]
    sign = "+" if seconds >= 0 else "-"
    seconds = abs(seconds)
    return f"UTC{sign}{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}"


def parse_iso(value):
    """Parse an ISO-8601 timestamp, tolerating a trailing Z. None on failure."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def local_display(iso_value):
    """'2026-08-21T21:00:00+05:30' -> '2026-08-21 21:00 IST'."""
    dt = parse_iso(iso_value)
    if dt is None:
        return None
    label = _offset_label(dt)
    return f"{dt.strftime('%Y-%m-%d %H:%M')}{f' {label}' if label else ''}"


def utc_display(iso_value):
    """'2026-08-21T21:00:00+05:30' -> '2026-08-21 15:30 UTC'."""
    dt = parse_iso(iso_value)
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def to_utc_iso(iso_value):
    """Normalise any offset to a UTC ISO string: '2026-08-21T16:06:49Z'."""
    dt = parse_iso(iso_value)
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def extract_sync(payload):
    """Pull WAQI's `debug.sync` — when it reports last ingesting the station.

    Returns None when WAQI does not provide it; never fabricated.
    """
    debug = payload.get("debug") if isinstance(payload, dict) else None
    if not isinstance(debug, dict):
        return None
    return to_utc_iso(debug.get("sync"))
