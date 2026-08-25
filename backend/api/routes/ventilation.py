"""
Ventilation forecasting and predictive escalation endpoints.

WHY THESE ROUTES DO NOT CALL require_engine()
    Every other router in this package depends on the Pathway streaming
    engine and returns 503 when it is unavailable. Pathway publishes
    Linux/macOS wheels only, so on Windows the whole API degrades to
    engine_unavailable.

    The ventilation capability has no such dependency: it reads a REST
    meteorological feed and a calibrated threshold from disk. Wiring it to the
    engine gate would make the PS 26082 deliverable un-runnable on the
    machines the team actually develops on, for no benefit. These endpoints
    therefore stand alone and remain available whether or not the streaming
    pipeline is up.

    That is a deliberate architectural choice, not an oversight: the forecast
    layer is upstream of the streaming layer in the data flow, so it should
    not be downstream of it in the dependency graph.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from ...forecast import ventilation as vent
from ...ingestion import ncr_observations as obs
from ...streaming import predictive_engine as pe

router = APIRouter(tags=["ventilation"])

VALID_MODES = ("balanced", "precautionary", "conservative")


def _check_mode(mode: Optional[str]) -> Optional[str]:
    """
    Validate the operating-point selector.

    Rejected explicitly rather than silently falling back, because the
    operating point determines the false-alarm rate a regulator is accepting.
    Quietly substituting a different one would misreport that trade-off.
    """
    if mode is None:
        return None
    if mode not in VALID_MODES:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "invalid_operating_mode",
                "detail": f"'{mode}' is not a calibrated operating point.",
                "valid": list(VALID_MODES),
            },
        )
    return mode


@router.get("/ventilation/operating-point",
            summary="The calibrated decision threshold and its measured skill")
def operating_point(mode: Optional[str] = Query(None)) -> dict[str, Any]:
    """
    Expose the threshold, where it came from, and what it costs.

    Surfaced as its own endpoint because a regulatory system should be able to
    answer "on what basis did you decide" without reading source code.
    """
    return vent.load_operating_point(_check_mode(mode))


@router.get("/ventilation/current",
            summary="Observed ventilation over recent hours")
def current(lat: float = Query(vent.weather_stream.DEFAULT_LAT),
            lon: float = Query(vent.weather_stream.DEFAULT_LON)) -> dict[str, Any]:
    """Analysis values only. Never mixed with forecast values."""
    out = vent.recent_ventilation(lat, lon)
    if not out.get("available"):
        raise HTTPException(
            status_code=503,
            detail={"error": "met_feed_unavailable",
                    "detail": "No recent meteorological analysis returned."},
        )
    return out


@router.get("/ventilation/forecast",
            summary="72-hour ventilation outlook and intervention window")
def forecast(lat: float = Query(vent.weather_stream.DEFAULT_LAT),
             lon: float = Query(vent.weather_stream.DEFAULT_LON),
             hours: int = Query(72, ge=6, le=168),
             mode: Optional[str] = Query(None)) -> dict[str, Any]:
    """
    The primary endpoint of the PS 26082 deliverable.

    Returns the ventilation series, whether a sustained collapse is forecast,
    and how many hours of effective intervention time remain before it.
    """
    out = vent.forecast_ventilation(lat, lon, hours=hours, mode=_check_mode(mode))
    if not out.get("available"):
        raise HTTPException(
            status_code=503,
            detail={"error": "met_feed_unavailable",
                    "detail": out.get("reason", "No forecast returned.")},
        )
    return out


@router.get("/ventilation/observed",
            summary="Live NCR ground PM2.5 composite, with its provenance")
def observed() -> dict[str, Any]:
    """
    What the monitoring network is actually reporting right now.

    Exposed separately from the forecast because the two halves of the
    escalation trigger come from completely different places: the forecast is
    numerical weather model output and uses no stations at all, while this is
    ground truth from the CPCB/DPCC network. Conflating them on one endpoint
    would make it impossible to tell which half failed when something breaks.
    """
    return obs.composite_pm25()


@router.get("/ventilation/stations",
            summary="Every reporting NCR station behind the composite")
def stations() -> dict[str, Any]:
    """
    The individual monitors, so the composite can be audited rather than
    trusted.

    This endpoint exists because a median with no visible constituents is not
    evidence. An operator seeing a single high station can tell it apart from
    an airshed-wide episode; a regulator reviewing an escalation needs the
    station names that appear in GRAP orders.
    """
    out = obs.composite_pm25()
    if not out.get("available"):
        raise HTTPException(
            status_code=424,
            detail={"error": "ground_observation_unavailable",
                    "detail": out.get("reason")},
        )
    return out


@router.get("/ventilation/assessment",
            summary="Predictive escalation assessment")
def assessment(pm25: Optional[float] = Query(
                   None,
                   description="Observed PM2.5 ug/m3. Omit to use the live "
                               "CPCB/DPCC composite."),
               aqi: Optional[float] = Query(None),
               station: Optional[str] = Query(None),
               lat: float = Query(vent.weather_stream.DEFAULT_LAT),
               lon: float = Query(vent.weather_stream.DEFAULT_LON),
               mode: Optional[str] = Query(None)) -> dict[str, Any]:
    """
    Combine an observed PM2.5 reading with the ventilation outlook.

    When pm25 is omitted the live network composite is used, and the response
    records how many stations stood behind it and how old they were. When it is
    supplied the value is used as given and flagged as manual - a reviewer
    probing the decision boundary must never have their input silently
    presented as a measurement.
    """
    fc = vent.forecast_ventilation(lat, lon, mode=_check_mode(mode))
    if not fc.get("available"):
        raise HTTPException(
            status_code=503,
            detail={"error": "met_feed_unavailable",
                    "detail": fc.get("reason", "No forecast returned.")},
        )

    if pm25 is None:
        live = obs.composite_pm25(include_stations=False)
        if not live.get("available"):
            raise HTTPException(
                status_code=424,
                detail={"error": "ground_observation_unavailable",
                        "detail": live.get("reason"),
                        "hint": "Pass ?pm25= to assess against a supplied value."},
            )
        observed_payload = {
            "station": station or "Delhi NCR composite",
            "pm25": live["pm25_ugm3"],
            "aqi": aqi,
            "data_age_s": live["data_age_minutes"] * 60,
        }
        provenance = {
            "input_source": "live",
            "n_stations": live["n_stations"],
            "n_stale_discarded": live["n_stale_discarded"],
            "data_age_minutes": live["data_age_minutes"],
            "p25": live["p25"],
            "p75": live["p75"],
            "source": live["source"],
        }
    else:
        observed_payload = {
            "station": station or "manual input",
            "pm25": pm25,
            "aqi": aqi,
        }
        provenance = {
            "input_source": "manual",
            "note": "PM2.5 was supplied by the caller, not measured.",
        }

    result = pe.assess(observed_payload, fc)
    result["case"] = pe.build_case(result)
    result["observation_provenance"] = provenance
    return result
