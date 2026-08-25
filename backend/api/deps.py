"""Shared request helpers for the route modules."""

from typing import Any, Dict, Tuple

from fastapi import HTTPException

from . import engine


def require_engine():
    """Ensure the streaming engine is live, else 503 with a structured error."""
    if engine.is_loaded():
        return

    st = engine.status()
    if st.get("loading"):
        raise HTTPException(
            status_code=503,
            detail={
                "error": "engine_starting",
                "detail": "AREE engine is starting: loading the Pathway pipeline, "
                          "embedding model and policy index.",
                "hint": "Retry in a few seconds. Poll GET /api/health for readiness.",
            },
        )

    raise HTTPException(
        status_code=503,
        detail={
            "error": "engine_unavailable",
            "detail": st.get("error") or "AREE engine is not running.",
            # Tell the operator what still works. An error that only states a
            # failure leaves them assuming the whole system is down, when the
            # PS 26082 forecast layer is unaffected - it does not use Pathway.
            "hint": "The Pathway pipeline must be importable in this process "
                    "(Linux/macOS/Docker/WSL). This affects the station and "
                    "escalation views only - the Ventilation outlook does not "
                    "use the engine and remains fully available.",
        },
    )


def require_state(station: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Return (state, station_meta) for a station or raise 404/425.

    404 - the station is not known to the engine at all.
    425 - the station is known but no window has closed yet (still warming up).
    """
    require_engine()

    meta = engine.station_meta(station)
    state = engine.station_state(station)

    if state is None:
        if not meta:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "station_not_found",
                    "detail": f"Unknown station: {station}",
                    "hint": "Call GET /api/stations for the available station keys.",
                },
            )

        # Distinguish "the feed itself has nothing to give" from "the engine has
        # not produced a window yet" — they need different operator responses.
        feed = engine.feed_diagnostics(station)
        feed_status = feed.get("status")

        if feed_status == "no_aqi":
            raise HTTPException(
                status_code=424,
                detail={
                    "error": "feed_unavailable",
                    "detail": feed.get("error")
                    or "Feed publishes no aggregate AQI.",
                    "hint": (
                        "This station is dormant upstream: WAQI answers OK but "
                        "reports no AQI"
                        + (f" (last reading {feed['waqi_timestamp']})"
                           if feed.get("waqi_timestamp") else "")
                        + ". No escalation state can be computed for it."
                    ),
                },
            )

        if feed_status == "error":
            raise HTTPException(
                status_code=424,
                detail={
                    "error": "feed_error",
                    "detail": feed.get("error") or "Upstream feed error.",
                    "hint": "The WAQI feed for this station is failing. The "
                            "engine retries automatically.",
                },
            )

        raise HTTPException(
            status_code=425,
            detail={
                "error": "awaiting_telemetry",
                "detail": f"No window has closed yet for {station}.",
                "hint": "The Pathway engine emits state on the first sliding "
                        "window close. Retry shortly.",
            },
        )

    if state.get("status") == "DATA_INVALID":
        raise HTTPException(
            status_code=422,
            detail={
                "error": "data_invalid",
                "detail": state.get("reason", "Bad payload from upstream feed."),
                "hint": "The upstream WAQI payload failed validation.",
            },
        )

    return state, meta


def cfg():
    """The engine config module."""
    require_engine()
    return engine.config()
