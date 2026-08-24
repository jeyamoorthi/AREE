"""Feed freshness classification.

Classification only. The age itself (`stale_seconds`) is computed in
ingestion/aqi_stream.py as `now - time.iso` and is not recomputed, adjusted or
re-derived here. WAQI's `time.v` is never used anywhere.

Availability and freshness are independent axes: a station with no usable AQI is
UNAVAILABLE regardless of how old its last reading was, and is never reported as
merely stale.
"""

from typing import Optional

CURRENT = "current"
AGING = "aging"
STALE = "stale"
UNAVAILABLE = "unavailable"


def classify(
    stale_seconds: Optional[float],
    fresh_threshold: float,
    stale_threshold: float,
    *,
    has_data: bool = True,
) -> str:
    """Map a reading age onto a freshness band.

    `has_data` False means the feed carries no usable AQI, which is decided by
    the ingestion layer's feed status - never inferred from age.
    """
    if not has_data:
        return UNAVAILABLE
    if stale_seconds is None:
        # Reporting normally but no timestamp to judge; treat as current rather
        # than inventing staleness.
        return CURRENT
    if stale_seconds <= fresh_threshold:
        return CURRENT
    if stale_seconds <= stale_threshold:
        return AGING
    return STALE


def is_stale(freshness_status: str) -> bool:
    """Backwards-compatible flag for existing consumers."""
    return freshness_status == STALE
