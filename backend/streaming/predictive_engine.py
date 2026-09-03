"""
Predictive escalation - converts a ventilation forecast into a regulatory case.

THE TRIGGER LOGIC, AND WHY IT IS A CONJUNCTION
    The research in research/ps26082 measured two things that together dictate
    this design:

      * Current air quality tells you an episode is HAPPENING. It does not
        tell you whether it will last: peak PM2.5 barely separates a 16-hour
        spike from a 10-day event.

      * Forecast ventilation tells you whether an episode would PERSIST. On
        its own it is not an episode detector - ventilation collapses every
        winter night without a severe episode following.

    So neither is sufficient alone, and the escalation trigger is the
    conjunction: elevated observed pollution AND a forecast ventilation
    collapse. Firing on either one separately is precisely how a system
    generates the false alarms that get it switched off.

WHAT THIS MODULE DOES NOT DO
    It does not issue orders. It produces a recommendation with its evidence,
    its confidence, and the operating point that was in force. Legal authority
    stays with CAQM and the state boards. Every field below exists so that a
    human can approve or reject the recommendation and so the decision can be
    replayed months later from the audit record.

RELATIONSHIP TO THE EXISTING ENGINE
    state_machine.py handles the OBSERVED path: persistence-confirmed high AQI
    driving a GRAP stage with hysteresis. That code is correct and is not
    touched. This module adds the PREDICTED path alongside it, and both feed
    the same case-management and audit layers.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

# GRAP stage boundaries on the CPCB AQI scale, as used by the existing engine.
GRAP_BY_AQI = [
    (0, 200, "None", "No GRAP action required"),
    (201, 300, "Stage I (Poor)", "Actions under GRAP Stage I"),
    (301, 400, "Stage II (Very Poor)", "Actions under GRAP Stage II"),
    (401, 450, "Stage III (Severe)", "Actions under GRAP Stage III"),
    (451, 10_000, "Stage IV (Severe+)", "Emergency actions under GRAP Stage IV"),
]

# PM2.5 above which an episode is considered under way. Matches the episode
# entry threshold used to label the historical record, so the operational
# definition and the evidence base agree.
EPISODE_PM25_UGM3 = 120.0

# Lead-time bands, in hours, that map an intervention window to a priority.
# These are lead-time bands rather than severity bands because for disaster
# management the actionable quantity is how long is left to act.
PRIORITY_BANDS = [
    (0, "CRITICAL", "Window closing or closed. Act now."),
    (12, "HIGH", "Under 12 hours of effective intervention time."),
    (36, "MEDIUM", "Under 36 hours. Prepare and pre-position."),
    (10_000, "LOW", "Monitoring. Time available."),
]


# --- the severe-event warning rule ------------------------------------------
#
# These three constants ARE the rule Experiment D scored, and warning_skill.py
# imports them from here rather than keeping its own copy. That is deliberate:
# the rule running in production must be the same object that was validated,
# not a second implementation that agrees with it today and drifts next month.
#
# 250 ug/m3 is the CPCB "Severe" breakpoint for PM2.5 (121-250 is Very Poor),
# so it is a published boundary rather than a number chosen by eye. Six hours
# mirrors the sustained-run requirement the ventilation layer already applies.
SEVERE_PM25_UGM3 = 250.0
WARNING_MIN_HOURS = 6
WARNING_MERGE_GAP_HOURS = 12

# The upper-tail series is what triggers a warning, never the central one.
# Measured in Experiment D across 13 severe episodes: the q90 upper tail
# anticipated 9 of them from clean air with a median 68 h of lead, while
# persistence and climatology anticipated 0 of 13. The central forecast is the
# expected concentration and answers a different question.
WARNING_SIGNAL = "upper"


def sustained_runs(series: list[tuple[datetime, float]], threshold: float,
                   min_hours: int) -> list[tuple[datetime, datetime]]:
    """
    Runs of at least min_hours consecutive hours at or above threshold.

    Used for BOTH observed episodes and forecast warnings so that the thing
    predicted has the same shape as the thing scored. A single hour above the
    threshold is not an episode and is not a warning.
    """
    runs: list[list[datetime]] = []
    start = last = None
    length = 0
    for moment, value in sorted(series):
        contiguous = last is not None and (moment - last) == timedelta(hours=1)
        if value >= threshold:
            if start is None or not contiguous:
                start, length = moment, 1
            else:
                length += 1
            if length == min_hours:
                runs.append([start, moment])
            elif length > min_hours and runs:
                runs[-1][1] = moment
        else:
            start, length = None, 0
        last = moment
    return [(a, b) for a, b in runs]


def merge_runs(runs: list[tuple[datetime, datetime]],
               gap_hours: int) -> list[tuple[datetime, datetime]]:
    """Fuse runs separated by less than gap_hours into one episode."""
    if not runs:
        return []
    out = [list(runs[0])]
    for start, end in runs[1:]:
        if (start - out[-1][1]) <= timedelta(hours=gap_hours):
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return [(a, b) for a, b in out]


def assess_forecast_risk(pm25_forecast: dict[str, Any] | None,
                         threshold: float = SEVERE_PM25_UGM3,
                         min_hours: int = WARNING_MIN_HOURS,
                         signal: str = WARNING_SIGNAL) -> dict[str, Any]:
    """
    Does the forecast cross the severe threshold, and how long do we have?

    Reads the UPPER-TAIL series, not the central one. The central forecast
    answers "what concentration do we expect"; the upper tail answers "how bad
    could this plausibly get", and only the second is a risk signal. The
    distinction is carried into the output so a caller cannot present one as
    the other: `central_at_crossing` and `upper_at_crossing` are both reported,
    and `trigger_source` names which one fired.

    Returns a dict with forecast_risk False rather than None when there is no
    crossing, so callers never have to test for absence before reading it.
    """
    empty = {
        "forecast_risk": False,
        "first_crossing": None,
        "lead_hours": None,
        "threshold_ugm3": threshold,
        "min_sustained_hours": min_hours,
        "trigger_source": f"{signal}_tail_q90" if signal == "upper" else signal,
        "central_at_crossing": None,
        "upper_at_crossing": None,
        "sustained_hours": None,
        "supporting_points": [],
    }

    if not pm25_forecast or not pm25_forecast.get("available"):
        empty["reason"] = "no PM2.5 forecast available"
        return empty

    series = pm25_forecast.get("series") or []
    points = [(p["valid_at"], p[signal]) for p in series if p.get(signal) is not None]
    runs = merge_runs(sustained_runs(points, threshold, min_hours),
                      WARNING_MERGE_GAP_HOURS)
    if not runs:
        empty["reason"] = (
            f"{signal} forecast stays below {threshold:.0f} ug/m3, or does not "
            f"hold above it for {min_hours} consecutive hours")
        return empty

    onset, end = runs[0]
    as_of = pm25_forecast.get("as_of")
    at_onset = next((p for p in series if p["valid_at"] == onset), {})
    window = [p for p in series if onset <= p["valid_at"] <= end]

    return {
        "forecast_risk": True,
        "first_crossing": onset,
        "lead_hours": (round((onset - as_of).total_seconds() / 3600.0, 1)
                       if as_of else None),
        "threshold_ugm3": threshold,
        "min_sustained_hours": min_hours,
        "trigger_source": "upper_tail_q90" if signal == "upper" else signal,
        "central_at_crossing": at_onset.get("central"),
        "upper_at_crossing": at_onset.get("upper"),
        "sustained_hours": len(window),
        "peak_upper_ugm3": max((p["upper"] for p in window), default=None),
        "peak_central_ugm3": max((p["central"] for p in window), default=None),
        "supporting_points": [
            {"valid_at": p["valid_at"], "central": p["central"],
             "upper": p["upper"], "ventilation_m2_s": p.get("ventilation_m2_s")}
            for p in window[:12]
        ],
    }


def grap_stage_for(aqi: float | None) -> tuple[str, str]:
    """Map an AQI value to its GRAP stage, or None when there is no reading."""
    if aqi is None:
        return "None", "No data"
    for lo, hi, stage, desc in GRAP_BY_AQI:
        if lo <= aqi <= hi:
            return stage, desc
    return "Stage IV (Severe+)", "Emergency actions under GRAP Stage IV"


def priority_for(window_hours: float | None) -> tuple[str, str]:
    """
    Turn remaining intervention time into a priority label.

    Its own function so the bands are defined in exactly one place: the API,
    the dashboard and the escalation record must never disagree about what
    CRITICAL means.
    """
    if window_hours is None:
        return "LOW", "No forecast ventilation collapse."
    for limit, label, rationale in PRIORITY_BANDS:
        if window_hours <= limit:
            return label, rationale
    return "LOW", "Time available."


def status_for(pm25: float | None, forecast_risk: bool) -> tuple[str, str]:
    """
    The one distinction that is AREE's actual wedge.

    "A severe episode is under way" and "no severe episode, but the forecast
    indicates severe risk in 42 hours" are different operational situations
    demanding different responses, and a system that collapses them into one
    RED light is not telling an authority anything they could not see from a
    current-conditions dashboard.
    """
    if pm25 is not None and pm25 >= SEVERE_PM25_UGM3:
        return ("SEVERE_EPISODE_UNDERWAY",
                "Observed concentrations are already in the CPCB Severe band.")
    if forecast_risk:
        return ("PREDICTIVE_WARNING",
                "No severe episode under way, but the upper-tail forecast "
                "indicates elevated severe-event risk ahead.")
    if pm25 is not None and pm25 >= EPISODE_PM25_UGM3:
        return ("EPISODE_UNDERWAY",
                "An episode is under way below the Severe band.")
    return ("MONITOR", "No episode under way and none forecast.")


def assess(observed: dict[str, Any],
           ventilation_forecast: dict[str, Any],
           pm25_forecast: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Combine observed air quality with the ventilation outlook.

    `observed` is expected to carry pm25 and optionally aqi plus provenance
    (station, observed_at, data_age_s) - the shape cpcb_stream.fetch_ncr
    produces. Provenance is carried through rather than dropped because an
    escalation record has to state how stale its evidence was.
    """
    now = datetime.now(timezone.utc)
    pm25 = observed.get("pm25")
    aqi = observed.get("aqi")

    episode_active = pm25 is not None and pm25 >= EPISODE_PM25_UGM3
    collapse = (ventilation_forecast or {}).get("collapse")
    window = (ventilation_forecast or {}).get("intervention_window_hours")
    vent_state = (ventilation_forecast or {}).get("state", "unknown")

    # The conjunction. Both conditions, or no predictive escalation.
    triggered = bool(episode_active and collapse)

    stage, stage_desc = grap_stage_for(aqi)
    priority, priority_rationale = priority_for(window if triggered else None)

    reasons = []
    if episode_active:
        reasons.append(
            f"Observed PM2.5 {pm25:.0f} ug/m3 is at or above the "
            f"{EPISODE_PM25_UGM3:.0f} ug/m3 episode threshold.")
    else:
        reasons.append(
            f"Observed PM2.5 {'unavailable' if pm25 is None else f'{pm25:.0f} ug/m3'} "
            f"is below the episode threshold.")

    if collapse:
        reasons.append(
            f"Forecast ventilation falls below "
            f"{ventilation_forecast['operating_point']['threshold_m2_s']:.0f} m2/s "
            f"for {collapse['sustained_hours_below_threshold']} sustained hours "
            f"from {collapse['onset']:%Y-%m-%d %H:%M} UTC.")
    else:
        reasons.append("No sustained ventilation collapse in the forecast window.")

    op = (ventilation_forecast or {}).get("operating_point", {})

    # The predictive layer sits BESIDE the existing conjunction, it does not
    # replace it. `triggered` keeps its original meaning (observed episode AND
    # forecast ventilation collapse) so every existing caller, case record and
    # audit entry means exactly what it meant before.
    forecast_risk = assess_forecast_risk(pm25_forecast)
    status, status_detail = status_for(pm25, forecast_risk["forecast_risk"])

    if forecast_risk["forecast_risk"]:
        reasons.append(
            f"Upper-tail PM2.5 forecast crosses "
            f"{forecast_risk['threshold_ugm3']:.0f} ug/m3 for "
            f"{forecast_risk['sustained_hours']} sustained hours from "
            f"{forecast_risk['first_crossing']:%Y-%m-%d %H:%M} UTC "
            f"({forecast_risk['lead_hours']:.0f} h of lead time).")

    return {
        "assessed_at": now,
        "status": status,
        "status_detail": status_detail,
        "severe_episode_underway": bool(
            pm25 is not None and pm25 >= SEVERE_PM25_UGM3),
        "forecast_risk": forecast_risk,
        "triggered": triggered,
        "trigger_rule": (
            "observed PM2.5 >= episode threshold AND forecast sustained "
            "ventilation collapse"),
        "priority": priority,
        "priority_rationale": priority_rationale,
        "intervention_window_hours": window if triggered else None,
        "ventilation_state": vent_state,
        "grap_stage_observed": stage,
        "grap_stage_description": stage_desc,
        "evidence": {
            "pm25_ugm3": pm25,
            "aqi": aqi,
            "station": observed.get("station"),
            "observed_at": observed.get("observed_at"),
            "data_age_seconds": observed.get("data_age_s"),
            "collapse": collapse,
        },
        "reasons": reasons,
        "operating_point": {
            "mode": op.get("mode"),
            "threshold_m2_s": op.get("threshold_m2_s"),
            "hit_rate": op.get("hit_rate"),
            "false_alarm_rate": op.get("false_alarm_rate"),
            "auc_training": op.get("auc_training"),
        },
        "confidence_note": (
            "Skill estimated on 143 historical episodes, 33 locked-in, with a "
            "held-out sample of 11. Treat the false-alarm rate as indicative. "
            "This recommendation is advisory: legal authority for GRAP "
            "invocation rests with CAQM and the state pollution control boards."
        ),
    }


def case_id_for(forecast_as_of: datetime, jurisdiction: str,
                trigger_rule: str) -> str:
    """
    A case's identity, derived rather than minted.

    WHY NOT A UUID
        A replay of 02 November 2024 is reproducible by construction: the same as_of
        yields the same assessment every time. If the case that assessment opens were
        given a fresh random id on every request, then demonstrating replay twice
        would create two cases for one moment, and "reproduce yesterday's decision"
        would produce a different record each time it was asked.

        Deriving the id from the moment, the jurisdiction and the rule means the case
        for a given decision point IS one row, no matter how often it is recomputed.
        That is also what lets the approval endpoint be create-or-update without
        needing the caller to have opened anything first.
    """
    import hashlib
    seed = f"{forecast_as_of.isoformat()}|{jurisdiction}|{trigger_rule}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]


def build_case(assessment: dict[str, Any], jurisdiction: str = "Delhi NCR",
               authority: str = "CAQM / DPCC") -> dict[str, Any] | None:
    """
    Turn a triggered assessment into an escalation case.

    Returns None when the assessment did not trigger, so a caller cannot
    accidentally create an empty case. The deadline is derived from the
    intervention window rather than a fixed SLA, because the window IS the
    deadline - after ventilation collapses, intervention effectiveness drops.
    """
    if not assessment.get("triggered"):
        return None

    window = assessment.get("intervention_window_hours") or 0.0
    collapse = (assessment.get("evidence") or {}).get("collapse") or {}

    # The case is keyed on the FORECAST moment, not on when it happened to be built:
    # two requests for the same replay must address one case.
    forecast_as_of = (assessment.get("evidence") or {}).get("observed_at") \
        or assessment["assessed_at"]

    return {
        "case_id": case_id_for(forecast_as_of, jurisdiction,
                               assessment["trigger_rule"]),
        "forecast_as_of": forecast_as_of,
        "opened_at": assessment["assessed_at"],
        "jurisdiction": jurisdiction,
        "responsible_authority": authority,
        "priority": assessment["priority"],
        "basis": "predicted",
        "trigger_rule": assessment["trigger_rule"],
        "deadline": collapse.get("onset"),
        "intervention_window_hours": window,
        "recommended_measures": _measures_for(assessment["priority"]),
        "evidence": assessment["evidence"],
        "reasons": assessment["reasons"],
        "operating_point": assessment["operating_point"],
        "status": "AWAITING_APPROVAL",
        "approval_required": True,
        "note": assessment["confidence_note"],
    }


def _measures_for(priority: str) -> list[str]:
    """
    Measures to place before the operator, by priority.

    Drawn from the GRAP action categories. Presented as a recommendation for a
    human to approve - the system proposes, the authority disposes.
    """
    base = [
        "Intensify mechanised road sweeping and water sprinkling",
        "Enforce dust-control requirements at construction sites",
    ]
    if priority in ("HIGH", "CRITICAL"):
        base += [
            "Prepare suspension of non-essential construction and demolition",
            "Issue public health advisory for sensitive groups",
            "Increase enforcement against open waste burning",
        ]
    if priority == "CRITICAL":
        base += [
            "Consider vehicle restrictions in the affected jurisdiction",
            "Alert schools to prepare for closure guidance",
        ]
    return base


if __name__ == "__main__":
    import json
    from ..forecast import ventilation as vent

    fc = vent.forecast_ventilation()
    # Demo observation. In the running system this comes from cpcb_stream.
    observed = {
        "station": "Anand Vihar, Delhi - DPCC",
        "pm25": 168.0,
        "aqi": 342,
        "observed_at": datetime.now(timezone.utc),
        "data_age_s": 1800,
    }

    a = assess(observed, fc)
    print("ASSESSMENT")
    print(f"  triggered            {a['triggered']}")
    print(f"  priority             {a['priority']}  - {a['priority_rationale']}")
    print(f"  ventilation state    {a['ventilation_state']}")
    print(f"  window (h)           {a['intervention_window_hours']}")
    print(f"  GRAP (observed AQI)  {a['grap_stage_observed']}")
    print("  reasons:")
    for r in a["reasons"]:
        print(f"    - {r}")

    case = build_case(a)
    print("\nCASE")
    if case is None:
        print("  no case opened (assessment did not trigger)")
    else:
        print(json.dumps({k: str(v) for k, v in case.items()
                          if k not in ("evidence", "reasons")}, indent=2))
        print("  measures:")
        for m in case["recommended_measures"]:
            print(f"    - {m}")
