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

from datetime import datetime, timezone
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


def assess(observed: dict[str, Any],
           ventilation_forecast: dict[str, Any]) -> dict[str, Any]:
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

    return {
        "assessed_at": now,
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

    return {
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
