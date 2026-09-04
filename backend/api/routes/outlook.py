"""
The AREE outlook — one endpoint, the whole vertical slice.

    GET /api/aree/outlook                      live
    GET /api/aree/outlook?at=2024-11-02T06:00Z replay

WHAT THIS ROUTE IS, AND WHAT IT IS NOT
    It is an AGGREGATION boundary. It composes the forecast service, the
    decision engine, the stored atmospheric diagnostics and the fire record
    into one coherent payload. It contains no forecasting logic, no threshold,
    and no decision of its own - every number it returns was produced by a
    component that is independently tested and independently scored. If a
    threshold ever appears in this file, something has gone wrong.

THE ONE RULE THAT MATTERS HERE
    `at` becomes `as_of` and is threaded through every downstream call
    unchanged. This route must never call datetime.now() to fill a gap,
    because that is precisely how a replay quietly turns into live data and a
    reconstruction gets presented as a prediction. The only place `now` appears
    is in deciding the mode label, and that decision belongs to the forecast
    service, not here.

    The consequence is the property the demo depends on:

        live and replay are the same code path, differing only in `as_of`.

    There is no demo mode to maintain, and nothing that works in the
    presentation can be broken in production without also breaking the
    presentation.

WHY IT IS ENGINE-INDEPENDENT
    Like the ventilation router, this one does not call require_engine().
    Pathway ships Linux/macOS wheels only, and an SIH demonstration must not be
    one import away from being dead. Everything here reads the feature store
    and the forecast service, neither of which needs the streaming runtime.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from ...backfill import db, model_lgbm
from ...forecast import pm25_forecast as fc
from ...streaming import case_store as cs
from .. import cache
from ...streaming import predictive_engine as pe
from . import intelligence as intel

router = APIRouter(tags=["aree"])

# How far ahead the atmospheric summary looks when describing the trend. One
# day, because that is the span over which the boundary layer completes a full
# cycle - a shorter window would report the time of day rather than a trend.
TREND_HOURS = 24

# Fires within this many hours before as_of count toward plume influence, which
# matches the lookback the derived plume feature itself uses.
FIRE_LOOKBACK_HOURS = 24


def _parse_at(raw: Optional[str]) -> Optional[datetime]:
    if not raw:
        return None
    try:
        moment = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_timestamp",
                    "detail": f"'{raw}' is not an ISO-8601 timestamp.",
                    "hint": "Example: ?at=2024-11-02T06:00:00Z"})
    return (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc))


def _trend(series: list[dict], key: str, hours: int = TREND_HOURS) -> dict:
    """
    Where a quantity starts and how low it gets over the next day.

    Reports the minimum rather than the endpoint because dispersion is limited
    by its worst hour, not its last one: an outlook that ends high after
    twelve trapped hours is not a good outlook.
    """
    window = [p[key] for p in series[:hours] if p.get(key) is not None]
    if not window:
        return {"available": False}
    first, low, high = window[0], min(window), max(window)
    return {
        "available": True,
        "now": round(first, 1),
        "min": round(low, 1),
        "max": round(high, 1),
        "direction": "falling" if low < first * 0.75 else (
            "rising" if high > first * 1.5 else "steady"),
    }


def _atmosphere(conn, series: list[dict], as_of: datetime,
                grid: str) -> dict[str, Any]:
    """Ventilation, boundary layer, wind and inversion, from what is stored."""
    row = conn.execute(
        "SELECT inversion_strength, lapse_rate, sustained_low_ventilation "
        "FROM derived_features WHERE grid_id = ? AND timestamp = ?",
        (grid, db.iso(as_of))).fetchone()

    threshold = None
    below = None
    try:
        from ...forecast import ventilation as vent
        threshold = float(vent.load_operating_point()["threshold_m2_s"])
        below = sum(1 for p in series
                    if p.get("ventilation_m2_s") is not None
                    and p["ventilation_m2_s"] <= threshold)
    except Exception:                                       # noqa: BLE001
        pass

    inversion: dict[str, Any] = {"available": False}
    if row is not None and row["inversion_strength"] is not None:
        strength = row["inversion_strength"]
        inversion = {
            "available": True,
            "strength_k": round(strength, 2),
            # Positive means temperature RISES with height: a capping lid.
            "capping": strength > 0,
            "lapse_rate_k_per_km": (round(row["lapse_rate"], 2)
                                    if row["lapse_rate"] is not None else None),
        }
    else:
        inversion["reason"] = (
            "no pressure-level temperature for this hour — the ERA5 archive "
            "serves surface fields only, so inversion is available for recent "
            "hours and not for the historical record")

    return {
        "ventilation": {
            **_trend(series, "ventilation_m2_s"),
            "threshold_m2_s": threshold,
            "hours_below_threshold": below,
            "sustained_low_now": (bool(row["sustained_low_ventilation"])
                                  if row is not None else None),
            "unit": "m2/s",
        },
        "pblh": {**_trend(series, "blh_m"), "unit": "m"},
        "wind": {**_trend(series, "wind_ms"), "unit": "m/s"},
        "inversion": inversion,
    }


def _ventilation_forecast(series: list[dict], as_of: datetime) -> dict[str, Any]:
    """
    Rebuild the ventilation-forecast object from the series already computed.

    WHY THIS EXISTS
        pe.assess() takes a ventilation forecast, and the obvious source -
        vent.forecast_ventilation() - fetches LIVE meteorology. Calling it
        during a replay would splice today's weather into a reconstruction of
        2024, which is the exact failure this route is written to prevent.

        The forecast service has already carried the ventilation coefficient
        for every hour, computed from whichever meteorology `as_of` selected.
        So the collapse detection is re-run over THAT series, using the same
        find_collapse() and the same calibrated operating point the live path
        uses. Same rule, same threshold, correct data for the moment in
        question.
    """
    from ...forecast import ventilation as vent

    op = vent.load_operating_point()
    threshold = float(op["threshold_m2_s"])
    points = [{"time": p["valid_at"], "ventilation": p["ventilation_m2_s"]}
              for p in series if p.get("ventilation_m2_s") is not None]
    if not points:
        return {"available": False, "reason": "no ventilation in the series"}

    collapse = vent.find_collapse(points, threshold)
    hours_remaining = (round((collapse["onset"] - as_of).total_seconds() / 3600.0, 1)
                       if collapse else None)
    return {
        "available": True,
        "operating_point": op,
        "state": vent.classify(hours_remaining, collapse),
        "collapse": ({
            "onset": collapse["onset"],
            "hours_from_now": hours_remaining,
            "min_ventilation_m2_s": round(collapse["min_ventilation"], 1),
            "sustained_hours_below_threshold": collapse["hours_below"],
        } if collapse else None),
        "intervention_window_hours": (max(0.0, hours_remaining)
                                      if hours_remaining is not None else None),
    }


def _plume(conn, as_of: datetime, grid: str) -> dict[str, Any]:
    """Fire influence at as_of, from the derived feature and the raw record."""
    row = conn.execute(
        "SELECT plume_influence FROM derived_features "
        "WHERE grid_id = ? AND timestamp = ?",
        (grid, db.iso(as_of))).fetchone()
    since = db.iso(as_of - timedelta(hours=FIRE_LOOKBACK_HOURS))
    fires = conn.execute(
        "SELECT COUNT(*) n, COALESCE(SUM(frp), 0) frp FROM fire_events "
        "WHERE timestamp > ? AND timestamp <= ?",
        (since, db.iso(as_of))).fetchone()

    influence = row["plume_influence"] if row is not None else None
    return {
        "available": influence is not None,
        "influence": influence,
        "detections_24h": fires["n"],
        "total_frp_24h": round(fires["frp"], 1),
        "source": "NASA FIRMS (VIIRS)",
        "note": ("FRP-weighted, wind-aligned and distance-decayed over the "
                 "preceding 24 h. It is a transport-plausibility index, not a "
                 "measured contribution."),
    }


def compute(conn, as_of: Optional[datetime], *, lat: float = fc.ws.DEFAULT_LAT,
            lon: float = fc.ws.DEFAULT_LON,
            grid: str = model_lgbm.DEFAULT_GRID,
            hours: int = fc.HORIZON) -> dict[str, Any]:
    """
    Forecast -> ventilation -> assessment -> case, for one moment.

    WHY THIS IS A FUNCTION AND NOT INLINE IN THE ROUTE
        Two callers need it and they must not diverge. The outlook renders it; the
        case-decision endpoint RE-DERIVES it, so that an approval is recorded against
        evidence the server computed rather than evidence a browser posted. Two
        implementations of "what did AREE conclude at time T" would eventually
        disagree, and the disagreement would live inside the audit trail.

        Because the computation is deterministic in `as_of`, both callers get the same
        answer, and so does anyone re-running it months later.
    """
    forecast = fc.forecast(conn, as_of=as_of, lat=lat, lon=lon,
                           horizon=hours, grid=grid)
    if not forecast.get("available"):
        raise HTTPException(
            status_code=424,
            detail={"error": "forecast_unavailable",
                    "detail": forecast.get("reason", "no forecast"),
                    "hint": forecast.get("hint"),
                    "as_of": str(forecast.get("as_of")),
                    "mode": forecast.get("mode")})

    resolved = forecast["as_of"]
    observed = forecast["observed_now"]
    ventilation = _ventilation_forecast(forecast["series"], resolved)
    assessment = pe.assess(
        {"station": "Delhi NCR composite", "pm25": observed["pm25"],
         "aqi": None, "observed_at": resolved},
        ventilation,
        pm25_forecast=forecast)
    case = pe.build_case(assessment)
    if case is not None:
        # Carried so the stored row records WHICH of the four states opened it.
        case["risk_status"] = assessment["status"]
    return {
        "as_of": resolved,
        "mode": forecast["mode"],
        "forecast": forecast,
        "ventilation": ventilation,
        "assessment": assessment,
        "case": case,
    }


def compute_cached(conn, as_of: Optional[datetime], *,
                   lat: float = fc.ws.DEFAULT_LAT,
                   lon: float = fc.ws.DEFAULT_LON,
                   grid: str = model_lgbm.DEFAULT_GRID,
                   hours: int = fc.HORIZON) -> dict[str, Any]:
    """
    `compute()` behind the read-through cache.

    WHY THE CACHE IS NOT KEYED ON THE URL
        Two requests for /api/aree/outlook with no `at` are the SAME url and are
        not the same question: one may be asked before the hourly capture lands
        and one after. Keying on the url would pin the live outlook to whatever
        the store held the first time anyone asked. So the key carries the
        request parameters AND a version of the inputs - the observation store
        and the model files - and any change to either produces a different key.

    WHY LIVE AND REPLAY GET DIFFERENT LIFETIMES
        A replay of 2 Nov 2024 is a statement about a fixed past, and the only
        thing that can legitimately change it is a backfill or a retrain, both of
        which move a version token. It can be held longer. A live outlook tracks
        the present and is held for a minute, so that even a token this layer
        cannot see costs at most that.

    `as_of=None` is kept distinct from an explicit timestamp in the key. They are
    different requests: one means "now", the other means one specific hour, and
    collapsing them would let a replay answer a live question.
    """
    key = (
        "outlook",
        as_of.isoformat() if as_of is not None else None,
        lat, lon, grid, hours,
        cache.data_version(conn),
        cache.model_version(fc.MODEL_DIR),
    )
    ttl = cache.REPLAY_TTL_SECONDS if as_of is not None else cache.LIVE_TTL_SECONDS
    return cache.get_or_compute(
        key, ttl,
        lambda: compute(conn, as_of, lat=lat, lon=lon, grid=grid, hours=hours))


@router.get("/aree/outlook",
            summary="The complete AREE outlook: forecast, cause, risk, decision")
def outlook(at: Optional[str] = Query(
                None, description="ISO-8601 timestamp. Omit for live; supply "
                                  "to replay that moment."),
            lat: float = Query(fc.ws.DEFAULT_LAT),
            lon: float = Query(fc.ws.DEFAULT_LON),
            grid: str = Query(model_lgbm.DEFAULT_GRID),
            hours: int = Query(fc.HORIZON, ge=6, le=72)) -> dict[str, Any]:
    """
    One coherent 72-hour outlook for the NCR.

    Everything downstream of `as_of` is derived from it, so a replay of
    2 Nov 2024 sees exactly what the system would have seen that morning.
    """
    as_of = _parse_at(at)
    conn = db.connect()

    core = compute_cached(conn, as_of, lat=lat, lon=lon, grid=grid,
                          hours=hours)
    forecast = core["forecast"]
    resolved = core["as_of"]
    series = forecast["series"]
    observed = forecast["observed_now"]
    ventilation = core["ventilation"]
    assessment = core["assessment"]
    case = core["case"]
    risk = assessment["forecast_risk"]

    # The intelligence layer. Composed here, beside the engine, so the story
    # the reader sees and the decision the system made cannot diverge.
    atmosphere = _atmosphere(conn, series, resolved, grid)
    threshold = atmosphere["ventilation"].get("threshold_m2_s")
    collapse = (ventilation.get("collapse") or None)
    # THE OBSERVATION CONTRACT.
    #
    # A number and a band are not enough for a screen that also shows a forecast: the
    # reader has to know WHICH target this is and how many instruments stand behind it,
    # because those differ by two orders of magnitude between a replay and a live hour.
    #
    #   replay 02 Nov 2024  ->  legacy composite, 1 monitor
    #   live   03 Sep 2026  ->  network median, ~78 stations
    #
    # Both are published here from the stored record. `n_stations` is null when the
    # store does not know it, and nothing downstream may substitute a current count.
    _target = observed.get("target", "legacy")
    observation = {
        "value": observed["pm25"],
        "unit": "ug/m3",
        "band": _band(observed["pm25"]),
        "observed_at": resolved,
        "target": _target,
        "target_label": ("Network median across reporting stations"
                         if _target == "network"
                         else "Legacy NCR composite (research series)"),
        "n_stations": observed.get("n_stations"),
        "source": observed["source"],
    }
    mech = intel.mechanism(series, threshold)
    # CASE IDENTITY AND ITS PERSISTED STATE.
    #
    # The id is deterministic, so it can be published from a GET without writing
    # anything: viewing an outlook must never mint a regulatory record. The row is
    # created by the decision endpoint. What IS read here is whether a decision has
    # already been taken, so a screen shows "approved by ..." instead of offering the
    # same case for approval on every reload.
    case_id = (case or {}).get("case_id")
    persisted_status = cs.status_of(conn, case_id)

    decision_block = {
        "case_id": case_id,
        # The stored status wins when there is one; otherwise the engine's proposal.
        "case_status": persisted_status or (case or {}).get("status"),
        "case_decided": persisted_status in (cs.APPROVED, cs.REJECTED),
        "grap_stage_observed": assessment["grap_stage_observed"],
        "grap_stage_description": assessment["grap_stage_description"],
        "triggered": assessment["triggered"],
        "trigger_rule": assessment["trigger_rule"],
        "priority": assessment["priority"],
        "priority_rationale": assessment["priority_rationale"],
        "reasons": assessment["reasons"],
        "intervention_window_hours": assessment["intervention_window_hours"],
        "approval_state": (case or {}).get("status", "NO_CASE"),
        "approval_required": (case or {}).get("approval_required", True),
        "recommended_measures": (case or {}).get("recommended_measures", []),
        "responsible_authority": (case or {}).get(
            "responsible_authority", "CAQM / DPCC"),
        "note": assessment["confidence_note"],
    }
    decision_block["recommendation"] = intel.recommendation(
        assessment["status"], decision_block, risk)

    return {
        "as_of": resolved,
        "mode": forecast["mode"],
        "generated_at": forecast["generated_at"],
        "location": forecast["location"],

        "observation": observation,

        "narrative": intel.narrative(assessment["status"], risk, mech,
                                     observation, collapse),
        "mechanism": mech,
        "timeline": intel.timeline(series, resolved, threshold, collapse),
        # `resolved` and never datetime.now(): this panel showed the September 2026
        # network inside a November 2024 replay until it was given the anchor.
        "exposure": intel.exposure(conn, resolved),

        "forecast": {
            "horizon_hours": forecast["horizon_hours"],
            "labels": forecast["labels"],
            "summary": forecast["summary"],
            "series": series,
        },

        "atmosphere": {
            **atmosphere,
            "ventilation_forecast": ventilation,
            "ventilation_profile": intel.ventilation_profile(
                series, threshold, resolved),
        },
        "plume": _plume(conn, resolved, grid),

        "risk": {
            "status": assessment["status"],
            "status_detail": assessment["status_detail"],
            # Label and tone are composed here so the dashboard renders a string it was
            # handed instead of deriving a state from forecast_risk - which it did, in
            # three branches, silently collapsing the four-state contract to three.
            **{f"status_{k}": v
               for k, v in intel.status_presentation(assessment["status"]).items()},
            "severe_episode_underway": assessment["severe_episode_underway"],
            **risk,
        },

        "decision": decision_block,

        "provenance": {
            **forecast["provenance"],
            "aggregated_by": "/api/aree/outlook",
            "warning_rule": {
                "threshold_ugm3": pe.SEVERE_PM25_UGM3,
                "min_sustained_hours": pe.WARNING_MIN_HOURS,
                "signal": pe.WARNING_SIGNAL,
                "validated_by": ("Experiment D: 9 of 13 severe episodes "
                                 "anticipated from clean air, median 68 h "
                                 "lead; both baselines 0 of 13"),
            },
        },
    }


# CPCB PM2.5 bands. Here rather than imported because the route reports a
# label for display only - nothing downstream branches on it.
_BANDS = [(0, 30, "Good"), (30, 60, "Satisfactory"), (60, 90, "Moderate"),
          (90, 120, "Poor"), (120, 250, "Very Poor"), (250, 1e9, "Severe")]


def _band(value: float | None) -> str | None:
    if value is None:
        return None
    for lo, hi, name in _BANDS:
        if lo <= value < hi:
            return name
    return "Severe"
