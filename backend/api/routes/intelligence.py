"""
The intelligence layer — turning quantities into a story the reader can follow.

WHY THIS IS BACKEND CODE AND NOT A FRONTEND CONCERN
    The obvious place to assemble a headline sentence, a causal chain and a
    list of milestones is the React component that displays them. That would be
    a mistake, and a specific one: the moment the UI decides that ventilation
    "collapsing" means a 45% fall, or that a station is "highest exposure", the
    interface and the validated engine can disagree. Two descriptions of the
    same atmosphere, differing by a refactor nobody noticed.

    So every judgement lives here, beside the engine, and the frontend renders
    sentences it was handed. The rule stays intact: the backend owns the
    decision, the frontend owns the pixels.

WHAT THIS MODULE ADDS, AND WHY EACH ONE EARNS ITS PLACE
    narrative   One headline and one supporting sentence. A reader should know
                what is happening before they read a single number.
    mechanism   The causal chain, wind -> boundary layer -> ventilation ->
                dispersion -> accumulation. This is the actual product: not
                "here is the wind speed" but "here is how the atmosphere turns
                weather into pollution".
    timeline    Explicit milestones. A chart requires interpretation; a list of
                "at 21:30 the collapse begins, at 06:00 it is worst" does not.
    exposure    Where the problem is. A station table is operations; a ranked
                list of the worst-affected places is intelligence.

NOTHING HERE INVENTS A THRESHOLD
    Every comparison uses the operating point and the warning rule already
    defined elsewhere. This module describes; it does not decide.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ...backfill import db

# A fall of this fraction or more is described as a collapse rather than a
# decline. Chosen to match how the ventilation trend already labels direction,
# so the words and the arrows cannot disagree.
COLLAPSE_FRACTION = 0.5

# Hours above threshold required before ventilation is called "recovered". The
# same sustained-run logic the warning rule uses, for the same reason: one hour
# above the line at midday is not a recovery.
RECOVERY_HOURS = 6

TREND_HOURS = 24


def _pct_change(start: float | None, end: float | None) -> int | None:
    if start in (None, 0) or end is None:
        return None
    return round((end - start) / start * 100)


def mechanism(series: list[dict], threshold: float | None) -> dict[str, Any]:
    """
    The causal chain, as a chain rather than four separate readings.

    Each link reports where it starts and where it gets to over the next day,
    because the story is the CHANGE. A boundary layer of 250 m means little on
    its own; 250 m falling to 165 m while the wind halves is the whole point.
    """
    window = series[:TREND_HOURS] or series
    if not window:
        return {"available": False}

    def link(key: str, unit: str, label: str, better: str) -> dict:
        values = [p[key] for p in window if p.get(key) is not None]
        if not values:
            return {"available": False, "label": label}
        now, low = values[0], min(values)
        return {
            "available": True,
            "label": label,
            "unit": unit,
            "now": round(now, 1),
            "low": round(low, 1),
            "change_pct": _pct_change(now, low),
            "direction": "falling" if low < now * 0.75 else "steady",
            "better_when": better,
        }

    wind = link("wind_ms", "m/s", "Wind", "higher")
    blh = link("blh_m", "m", "Boundary layer", "higher")
    vent = link("ventilation_m2_s", "m²/s", "Ventilation", "higher")

    verdict = "unknown"
    if vent.get("available") and threshold:
        low = vent["low"]
        if low <= threshold * 0.5:
            verdict = "very poor"
        elif low <= threshold:
            verdict = "poor"
        elif low <= threshold * 2:
            verdict = "moderate"
        else:
            verdict = "good"

    return {
        "available": True,
        "links": [wind, blh, vent],
        "dispersion": {
            "verdict": verdict,
            "threshold_m2_s": threshold,
        },
        # The consequence, phrased as a tendency rather than a prediction -
        # the concentration forecast is a separate, scored quantity.
        "consequence": (
            "Pollutants disperse more slowly, so emissions accumulate"
            if verdict in ("poor", "very poor")
            else "The atmosphere continues to disperse emissions normally"),
    }


def timeline(series: list[dict], as_of: datetime, threshold: float | None,
             collapse: dict | None) -> list[dict[str, Any]]:
    """
    Named moments, so the chart does not have to be interpreted.

    Only milestones that actually occur are emitted. A timeline padded with
    "nothing happens" rows trains the reader to skip it.
    """
    if not series or not threshold:
        return []

    marks: list[dict] = [{
        "at": as_of,
        "kind": "now",
        "state": "Now",
        "consequence": _state_for(series[0].get("ventilation_m2_s"), threshold),
    }]

    if collapse and collapse.get("onset"):
        onset = collapse["onset"]
        marks.append({
            "at": onset,
            "kind": "collapse",
            "state": "Ventilation falls below threshold",
            "consequence": "Accumulation risk rises",
        })

    vented = [p for p in series if p.get("ventilation_m2_s") is not None]
    if vented:
        worst = min(vented, key=lambda p: p["ventilation_m2_s"])
        marks.append({
            "at": worst["valid_at"],
            "kind": "minimum",
            "state": f"Minimum ventilation "
                     f"{worst['ventilation_m2_s']:.0f} m²/s",
            "consequence": "Worst dispersion of the period",
        })

        # Recovery: the first sustained run back above the threshold after the
        # worst hour. Sustained, because a single midday spike is the diurnal
        # cycle rather than the episode ending.
        after = [p for p in vented if p["valid_at"] > worst["valid_at"]]
        run = 0
        for point in after:
            if point["ventilation_m2_s"] > threshold:
                run += 1
                if run >= RECOVERY_HOURS:
                    start = after[after.index(point) - RECOVERY_HOURS + 1]
                    marks.append({
                        "at": start["valid_at"],
                        "kind": "recovery",
                        "state": "Ventilation recovers above threshold",
                        "consequence": "Dispersion improves",
                    })
                    break
            else:
                run = 0

    peak = max(series, key=lambda p: p.get("upper") or 0)
    if peak.get("upper"):
        marks.append({
            "at": peak["valid_at"],
            "kind": "peak_risk",
            "state": f"Highest upper-tail risk {peak['upper']:.0f} µg/m³",
            "consequence": "Peak of the forecast risk envelope",
        })

    marks.sort(key=lambda m: m["at"])
    for mark in marks:
        delta = (mark["at"] - as_of).total_seconds() / 3600.0
        mark["hours_from_now"] = round(delta, 1)
    return marks


def _state_for(ventilation: float | None, threshold: float) -> str:
    if ventilation is None:
        return "Unknown"
    if ventilation <= threshold * 0.5:
        return "Very poor dispersion"
    if ventilation <= threshold:
        return "Poor dispersion"
    if ventilation <= threshold * 2:
        return "Moderate dispersion"
    return "Good dispersion"


# CPCB PM2.5 bands. The SEVERITY CLASSIFICATION is a policy judgement and so
# belongs here, with the engine - not in the map component. The frontend picks
# a colour and a halo size from the band it is handed; it does not decide what
# "Severe" means. Boundaries match the national standard, not our taste.
PM25_BANDS = [
    (0, 30, "Good"),
    (30, 60, "Satisfactory"),
    (60, 90, "Moderate"),
    (90, 120, "Poor"),
    (120, 250, "Very Poor"),
    (250, float("inf"), "Severe"),
]


def pm25_band(value: float | None) -> str | None:
    if value is None:
        return None
    for lo, hi, name in PM25_BANDS:
        if lo <= value < hi:
            return name
    return "Severe"


# How far before `as_of` the spatial panel may reach for a station hour.
#
# Three hours is not arbitrary: ncr_observations.MAX_READING_AGE_HOURS uses the same
# bound to decide that a station has stopped reporting, on the reasoning that the
# network publishes hourly. A field older than that is not "where it is worst now", it
# is a stale picture, and presenting it beside a current assessment is the same
# conflation this function was rewritten to remove.
EXPOSURE_MAX_AGE_HOURS = 3


def _exposure_composite_only(conn, as_of: datetime) -> dict[str, Any]:
    """
    What the target rests on when no station-level record exists for this hour.

    For every hour before September 2026 this is the whole answer, and it is worth
    stating rather than hiding: the historical NCR target is a composite, and for
    Nov 2022-2024 it is a composite of ONE monitor. That is the target-integrity
    finding the engineering report is built on (C0), and a panel that says so is
    better evidence than a map that quietly shows the wrong year.

    n_monitors is read from the stored row, never assumed. Where the store does not
    record it, it stays null - a fabricated station count in a panel whose entire
    purpose is provenance would be self-defeating.
    """
    row = conn.execute(
        "SELECT pm25, n_stations, station_id, source FROM station_readings "
        "WHERE timestamp = ? AND pm25 IS NOT NULL "
        "ORDER BY (n_stations IS NULL), n_stations DESC LIMIT 1",
        (db.iso(as_of),)).fetchone()

    if row is None:
        return {
            "available": False,
            "kind": "none",
            "as_of": db.iso(as_of),
            "reason": f"no observation of any kind stored for {as_of:%Y-%m-%d %H:%M} UTC",
        }

    n = row["n_stations"]
    return {
        "available": False,
        "kind": "composite_only",
        "as_of": db.iso(as_of),
        "observed_at": db.iso(as_of),
        "composite_pm25": row["pm25"],
        "n_monitors": n,
        "series": row["station_id"],
        "source": row["source"],
        "reason": (
            f"No station-level record for {as_of:%d %b %Y %H:%M} UTC. The target for "
            f"this hour is an NCR composite"
            + (f" of {n} monitor{'s' if n != 1 else ''}." if n else ".")
            + " Station-level capture begins Sept 2026."
        ),
    }


def exposure(conn, as_of: datetime, limit: int = 6) -> dict[str, Any]:
    """
    Where the problem is, AT `as_of` — never later.

    THE BUG THIS SIGNATURE EXISTS TO KILL
        This function used to read MAX(timestamp) from the live capture and return it
        regardless of which moment the caller was describing. A replay of
        02 November 2024 therefore rendered its spatial panel and its "worst places"
        ranking from the September 2026 network: a reconstruction with tomorrow's map
        beside it, under a banner promising the opposite.

        The forecast layer was already leakage-proof by construction - models are
        selected by train_end <= as_of - and this one function undid the guarantee at
        the presentation boundary, which is exactly where an evaluator looks.

    THE RULE
        Every row returned describes an hour at or before `as_of`, and the hour is
        reported so the reader can check. When no station-level record exists for that
        moment, the honest answer is the composite the target actually rests on, said
        plainly - not the nearest data that happens to exist.
    """
    cutoff = as_of - timedelta(hours=EXPOSURE_MAX_AGE_HOURS)

    # The newest station hour AT OR BEFORE as_of. Both source families count: they are
    # the same instruments, differing only in how the row was delivered.
    latest = conn.execute(
        "SELECT MAX(timestamp) t FROM station_readings "
        "WHERE (source LIKE 'live:%' OR source LIKE 'openaq:%') "
        "AND pm25 IS NOT NULL AND timestamp <= ? AND timestamp >= ?",
        (db.iso(as_of), db.iso(cutoff))).fetchone()["t"]

    if not latest:
        return _exposure_composite_only(conn, as_of)

    rows = conn.execute(
        # `source` is selected because the map tooltip has to name where a reading came
        # from. The alternative is a frontend that prints "CPCB / CAQM" as a constant,
        # which is inventing provenance on the one surface whose job is provenance.
        "SELECT station_id, pm25, latitude, longitude, source FROM station_readings "
        "WHERE (source LIKE 'live:%' OR source LIKE 'openaq:%') "
        "AND timestamp = ? AND pm25 IS NOT NULL "
        "ORDER BY pm25 DESC", (latest,)).fetchall()
    if not rows:
        return _exposure_composite_only(conn, as_of)

    def place(name: str) -> str:
        # "Sector 11, Faridabad - HSPCB" -> "Faridabad". The agency suffix and
        # the sub-locality are noise when ranking places.
        head = name.split(" - ")[0]
        return head.split(",")[-1].strip() if "," in head else head.strip()

    ranked = [{
        "station": r["station_id"],
        "place": place(r["station_id"]),
        "pm25": r["pm25"],
        "band": pm25_band(r["pm25"]),
        "latitude": r["latitude"],
        "longitude": r["longitude"],
        # "live:CPCB CAAQMS via data.gov.in" -> "CPCB CAAQMS via data.gov.in".
        # The prefix says how the row was delivered; the tooltip wants who measured it.
        "source": (r["source"] or "").split(":", 1)[-1] or None,
    } for r in rows]

    return {
        "available": True,
        # "network" = a real station-level field. The frontend must not assume this;
        # `kind` tells it which of the two shapes it received.
        "kind": "network",
        "observed_at": latest,
        "as_of": db.iso(as_of),
        "age_hours": round(
            (as_of - datetime.strptime(latest, "%Y-%m-%dT%H:00:00Z")
             .replace(tzinfo=timezone.utc)).total_seconds() / 3600.0, 1),
        "n_stations": len(ranked),
        "worst": ranked[:limit],
        # The whole network, for the spatial panel. `worst` is the ranked list
        # for reading; a map drawn from six points is not a map, it is six
        # points - the shape of the airshed only appears with all of them.
        "points": [r for r in ranked
                   if r["latitude"] is not None and r["longitude"] is not None],
        "median_pm25": sorted(r["pm25"] for r in ranked)[len(ranked) // 2],
        "spread_pm25": round(ranked[0]["pm25"] - ranked[-1]["pm25"], 1),
    }


# THE FOUR STATES, AND HOW EACH IS NAMED ON A SCREEN.
#
# predictive_engine.status_for() emits exactly these four, in this precedence:
#
#   SEVERE_EPISODE_UNDERWAY   observed PM2.5 >= 250          (tested FIRST, so a
#                                                             continuing episode never
#                                                             re-reports as a new warning)
#   PREDICTIVE_WARNING        q90 crosses 250 for >= 6 h
#   EPISODE_UNDERWAY          observed PM2.5 >= 120, below Severe, nothing forecast
#   MONITOR                   neither
#
# The presentation lives here rather than in the frontend for the reason the whole
# intelligence layer exists: a UI that derives the state from `forecast_risk` or from a
# PM2.5 comparison can disagree with the engine that made the decision. It did - the
# outlook rendered three branches keyed on forecast_risk, so EPISODE_UNDERWAY (a real,
# reachable state at 120-250 ug/m3) fell through to the calm one.
#
# `tone` is a four-value vocabulary, not the three used by recommendation.tone: an
# episode that is under way but below Severe is genuinely a different signal from a
# warning about one that has not started.
STATUS_PRESENTATION: dict[str, dict[str, str]] = {
    "SEVERE_EPISODE_UNDERWAY": {
        "label": "Severe episode under way",
        "short": "Severe now",
        "tone": "critical",
    },
    "PREDICTIVE_WARNING": {
        "label": "Predictive warning",
        "short": "Severe likely",
        "tone": "warning",
    },
    "EPISODE_UNDERWAY": {
        "label": "Episode under way",
        "short": "Episode",
        "tone": "elevated",
    },
    "MONITOR": {
        "label": "Monitoring",
        "short": "Monitoring",
        "tone": "calm",
    },
}


def status_presentation(status: str) -> dict[str, str]:
    """Name a status for display. Unknown states are surfaced, never defaulted.

    Falling back to the calm branch would hide a new state behind a green pill, which
    is the failure this table was written to prevent.
    """
    known = STATUS_PRESENTATION.get(status)
    if known:
        return dict(known)
    return {"label": status.replace("_", " ").title(), "short": status,
            "tone": "warning"}


def narrative(status: str, risk: dict, mech: dict, observation: dict,
              collapse: dict | None) -> dict[str, str]:
    """
    One headline, one supporting sentence.

    Composed from the same fields the panels below it show, so the summary can
    never say something the evidence does not. Written as statements about the
    atmosphere rather than about the model, because that is what the reader is
    responsible for.
    """
    band = observation.get("band") or "unknown"
    value = observation.get("value")
    vent = next((l for l in mech.get("links", [])
                 if l.get("label") == "Ventilation"), {})
    falling = vent.get("direction") == "falling"
    drop = vent.get("change_pct")

    if status == "SEVERE_EPISODE_UNDERWAY":
        headline = "A severe pollution episode is under way."
        detail = (f"Concentrations are already in the CPCB Severe band at "
                  f"{value:.0f} µg/m³.")
        if collapse:
            detail += (" Ventilation remains below the operating threshold, so "
                       "the episode is unlikely to clear on its own.")
    elif status == "PREDICTIVE_WARNING":
        lead = risk.get("lead_hours")
        headline = (f"Air is {band.lower()} now, but a severe episode is "
                    f"likely within {lead:.0f} hours."
                    if lead is not None else
                    "A severe episode is likely ahead.")
        detail = ("Falling ventilation is expected to let pollution accumulate "
                  "faster than it disperses.")
        if drop is not None and falling:
            detail = (f"Ventilation is expected to fall {abs(drop)}%, letting "
                      f"pollution accumulate faster than it disperses.")
    elif status == "EPISODE_UNDERWAY":
        # The branch that did not exist. Without it an episode at 120-250 ug/m3 with
        # steady ventilation fell through to "Conditions are stable and dispersion is
        # adequate" - a calm sentence over Very Poor air.
        headline = (f"An episode is under way at {value:.0f} µg/m³, "
                    f"below the Severe band.")
        if falling:
            detail = ("Ventilation is deteriorating"
                      + (f", expected to fall {abs(drop)}%" if drop is not None else "")
                      + ", so the episode is more likely to persist than to clear.")
        else:
            detail = ("Ventilation is holding, so the atmosphere is still able to "
                      "clear emissions. No severe episode is forecast.")
    elif falling:
        headline = ("Air is stable now, but dispersion is deteriorating.")
        detail = (f"PM2.5 is {band.lower()} at {value:.0f} µg/m³, and "
                  f"ventilation is expected to fall {abs(drop)}%"
                  if drop is not None else
                  f"PM2.5 is {band.lower()} at {value:.0f} µg/m³, and "
                  f"ventilation is weakening")
        detail += (". No episode is forecast, but accumulation conditions are "
                   "building.")
    else:
        headline = "Conditions are stable and dispersion is adequate."
        detail = (f"PM2.5 is {band.lower()} at {value:.0f} µg/m³ and the "
                  f"atmosphere continues to clear emissions normally.")

    return {"headline": headline, "detail": detail}


def recommendation(status: str, decision: dict, risk: dict) -> dict[str, Any]:
    """
    The decision, phrased as a decision.

    "LOW / NO CASE" is a correct answer to a question nobody asked. What a duty
    officer needs is the call, the reason, and what to do next - in that order.
    """
    triggered = decision.get("triggered")
    if triggered:
        return {
            "call": "ESCALATION RECOMMENDED",
            "tone": "critical",
            "because": decision.get("priority_rationale", ""),
            "next_step": ("Review the measures below and authorise. Legal "
                          "authority rests with CAQM and the state boards."),
        }
    if status == "PREDICTIVE_WARNING":
        lead = risk.get("lead_hours")
        return {
            "call": "PREPARE — NO ESCALATION YET",
            "tone": "warning",
            "because": ("The validated episode trigger has not fired, but the "
                        "upper-tail forecast crosses the Severe threshold"
                        + (f" in about {lead:.0f} hours." if lead is not None
                           else ".")),
            "next_step": ("Pre-position resources and re-check as the window "
                          "closes. No intervention is warranted yet."),
        }
    if status == "SEVERE_EPISODE_UNDERWAY":
        return {
            "call": "EPISODE UNDER WAY — MONITOR CLOSELY",
            "tone": "critical",
            "because": ("Concentrations are in the Severe band but the "
                        "validated conjunction has not fired."),
            "next_step": "Verify against station readings and reassess hourly.",
        }
    return {
        "call": "NO ESCALATION",
        "tone": "calm",
        "because": ("Current conditions do not meet the validated episode "
                    "trigger."),
        "next_step": ("Continue monitoring. Prepare for deterioration if "
                      "ventilation continues to fall."),
    }

def ventilation_profile(series: list[dict], threshold: float | None,
                        as_of: datetime) -> dict[str, Any]:
    """
    Statistics and a banded distribution for the ventilation diagnostic page.

    The distribution is the honest way to answer "how bad is this period" -
    a mean hides a night at 19 m2/s inside a day that peaked at 1990. Bands are
    anchored on the calibrated threshold rather than on round numbers, so the
    picture and the decision use the same boundary.
    """
    values = [p["ventilation_m2_s"] for p in series
              if p.get("ventilation_m2_s") is not None]
    if not values or not threshold:
        return {"available": False}

    # The first 24 hours of the outlook, which is the window the page labels.
    day = values[:24]
    bands = [
        ("< 250", 0, 250, "#c0392b"),
        (f"250-{threshold:.0f}", 250, threshold, "#e07a3f"),
        (f"{threshold:.0f}-800", threshold, 800, "#e8b04b"),
        ("> 800", 800, float("inf"), "#3f7a4e"),
    ]
    distribution = []
    for label, lo, hi, colour in bands:
        n = sum(1 for v in day if lo <= v < hi)
        distribution.append({
            "label": label, "hours": n, "colour": colour,
            "share": round(n / len(day), 3) if day else 0,
        })

    below = sum(1 for v in day if v <= threshold)
    return {
        "available": True,
        "statistics": {
            "min": round(min(values), 1),
            "mean": round(sum(values) / len(values), 1),
            "max": round(max(values), 1),
            "hours": len(values),
        },
        "distribution": distribution,
        "hours_below_24h": below,
        "share_below_24h": round(below / len(day), 3) if day else 0,
        "components": {
            "blh_m": series[0].get("blh_m"),
            "wind_ms": series[0].get("wind_ms"),
            "ventilation_m2_s": series[0].get("ventilation_m2_s"),
        },
    }
