"""
Ventilation forecasting - the core of the PS 26082 application.

WHAT THIS COMPUTES AND WHY IT IS THE RIGHT THING TO COMPUTE
    Five winters of Delhi NCR data (research/ps26082) established three things
    by measurement rather than assumption:

      1. Whether a pollution episode locks in cannot be diagnosed from the
         atmospheric state at its onset. Ventilation measured BEFORE onset
         separates locked-in from ventilated episodes at AUC 0.514 - chance.

      2. It IS determined by the ventilation over the following 48 hours:
         AUC 0.736.

      3. A one-to-two day forecast reproduces that ventilation closely enough
         to retain the skill (r = 0.75, RMSE 0.79 m/s on window-mean wind).

    So the operationally useful quantity is not "what will AQI be" but "will
    the atmosphere still be able to clear itself, and for how much longer".
    That is what this module forecasts.

VENTILATION COEFFICIENT
        VC = boundary layer height (m) x 10 m wind speed (m/s)      [m2/s]

    Mixing depth times transport speed: the volume flux available to dilute
    whatever is emitted. It is a long-standing quantity in air-quality
    meteorology, which matters - it means the system rests on an established
    metric rather than one invented for a hackathon.

WHAT THIS MODULE DELIBERATELY DOES NOT DO
    It does not decide anything. It produces a forecast and a risk state. The
    deterministic rule engine decides, the operator approves, and the audit
    trail records both. That separation is the same principle the existing
    GRAP state machine already follows.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..ingestion import weather_stream

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / \
    "ventilation_operating_point.json"

# Fallback if the calibration file is missing. Deliberately the value derived
# in research/ps26082/scripts/10_calibrate_operating_point.py, not a guess, so
# behaviour degrades to the measured default rather than to an invention.
FALLBACK_THRESHOLD_M2S = 466.0
FALLBACK_MODE = "balanced"

# Sustained-collapse requirement. A single hour below threshold at 03:00 is
# just the nocturnal boundary layer doing what it does every night; it is not
# a ventilation failure. Requiring consecutive hours is the same persistence
# logic the existing escalation engine already applies to AQI, at the
# timescale the meteorology actually operates on.
MIN_COLLAPSE_HOURS = 6


def load_operating_point(mode: str | None = None) -> dict[str, Any]:
    """
    Read the calibrated threshold.

    Loaded from disk rather than hard-coded so the number can be re-derived
    when more ground data arrives without touching application code, and so
    the running system can state which calibration it is using.
    """
    try:
        cfg = json.loads(CONFIG_PATH.read_text())
    except (OSError, ValueError):
        return {
            "mode": FALLBACK_MODE,
            "threshold_m2_s": FALLBACK_THRESHOLD_M2S,
            "source": "fallback",
            "calibrated": False,
        }

    chosen = mode or cfg.get("default_mode", FALLBACK_MODE)
    point = (cfg.get("operating_points") or {}).get(chosen) or {}
    return {
        "mode": chosen,
        "threshold_m2_s": point.get("threshold_m2_s", FALLBACK_THRESHOLD_M2S),
        "hit_rate": point.get("hit_rate"),
        "false_alarm_rate": point.get("false_alarm_rate"),
        "auc_training": cfg.get("auc_training"),
        "n_train_episodes": cfg.get("n_train_episodes"),
        "outcome_window_hours": cfg.get("outcome_window_hours"),
        "available_modes": list((cfg.get("operating_points") or {}).keys()),
        "caveat": (cfg.get("provenance") or {}).get("caveat"),
        "source": str(CONFIG_PATH.name),
        "calibrated": True,
    }


def _series(rows: list[dict]) -> list[dict]:
    """Reduce raw met rows to the ventilation series the rest of this uses."""
    out = []
    for r in rows:
        blh = r.get("boundary_layer_height")
        ws = r.get("wind_speed_10m")
        if blh is None or ws is None:
            continue
        out.append({
            "time": r["observed_at"],
            "ventilation": blh * ws,
            "blh": blh,
            "wind": ws,
            "clearness": r.get("clearness"),
            "is_forecast": r.get("is_forecast", True),
        })
    return sorted(out, key=lambda x: x["time"])


def find_collapse(series: list[dict], threshold: float,
                  min_hours: int = MIN_COLLAPSE_HOURS) -> dict | None:
    """
    First sustained run below the ventilation threshold.

    Returns the onset of that run, not the first hour below threshold. The
    distinction matters operationally: an alert should describe when the
    atmosphere actually stops clearing, and a two-hour dip does not.
    """
    run_start = None
    run_len = 0
    for point in series:
        if point["ventilation"] <= threshold:
            if run_start is None:
                run_start = point["time"]
            run_len += 1
            if run_len >= min_hours:
                tail = [p for p in series if p["time"] >= run_start]
                below = [p for p in tail if p["ventilation"] <= threshold]
                return {
                    "onset": run_start,
                    "min_ventilation": min(p["ventilation"] for p in below),
                    "hours_below": len(below),
                }
        else:
            run_start, run_len = None, 0
    return None


def classify(hours_remaining: float | None, collapse: dict | None) -> str:
    """
    Turn lead time into an operational state.

    Bands are lead-time bands, not severity bands, because for a disaster
    management system the actionable quantity is how long is left to act. GRAP
    measures take time to bite; an alert with two hours of warning is
    information, one with eighteen is a decision.
    """
    if collapse is None:
        return "clear"
    if hours_remaining is None:
        return "unknown"
    if hours_remaining <= 0:
        return "collapsed"
    if hours_remaining <= 12:
        return "imminent"
    if hours_remaining <= 36:
        return "approaching"
    return "watch"


def forecast_ventilation(lat: float = weather_stream.DEFAULT_LAT,
                         lon: float = weather_stream.DEFAULT_LON,
                         hours: int = 72,
                         mode: str | None = None) -> dict[str, Any]:
    """
    Full 72-hour ventilation outlook plus the intervention window.

    This is the function the API route and the dashboard both call. It returns
    a plain dictionary rather than a model object so it can be serialised,
    logged into the audit trail, and replayed later byte-for-byte.
    """
    op = load_operating_point(mode)
    threshold = float(op["threshold_m2_s"])

    rows = weather_stream.fetch_forecast(lat, lon, hours=hours)
    series = _series(rows)
    now = datetime.now(timezone.utc)

    if not series:
        return {
            "available": False,
            "reason": "no meteorological forecast returned",
            "operating_point": op,
            "generated_at": now,
        }

    collapse = find_collapse(series, threshold)
    hours_remaining = None
    if collapse:
        hours_remaining = round(
            (collapse["onset"] - now).total_seconds() / 3600.0, 1)

    vents = [p["ventilation"] for p in series]
    return {
        "available": True,
        "generated_at": now,
        "location": {"lat": lat, "lon": lon},
        "horizon_hours": len(series),
        "operating_point": op,
        "state": classify(hours_remaining, collapse),
        "collapse": (
            {
                "onset": collapse["onset"],
                "hours_from_now": hours_remaining,
                "min_ventilation_m2_s": round(collapse["min_ventilation"], 1),
                "sustained_hours_below_threshold": collapse["hours_below"],
            } if collapse else None
        ),
        "intervention_window_hours": (
            max(0.0, hours_remaining) if hours_remaining is not None else None),
        "summary": {
            "min_ventilation_m2_s": round(min(vents), 1),
            "max_ventilation_m2_s": round(max(vents), 1),
            "mean_ventilation_m2_s": round(sum(vents) / len(vents), 1),
            "hours_below_threshold": sum(1 for v in vents if v <= threshold),
        },
        "series": [
            {
                "time": p["time"],
                "ventilation_m2_s": round(p["ventilation"], 1),
                "blh_m": round(p["blh"], 1),
                "wind_ms": round(p["wind"], 2),
                "below_threshold": p["ventilation"] <= threshold,
            }
            for p in series
        ],
    }


def recent_ventilation(lat: float = weather_stream.DEFAULT_LAT,
                       lon: float = weather_stream.DEFAULT_LON,
                       past_days: int = 2) -> dict[str, Any]:
    """
    Observed ventilation over recent hours.

    Kept separate from the forecast because these are analysis values, and the
    distinction between what was observed and what is predicted must never
    blur inside a system that issues regulatory escalations.
    """
    op = load_operating_point()
    rows = weather_stream.fetch_recent(lat, lon, past_days=past_days)
    series = _series(rows)
    now = datetime.now(timezone.utc)
    past = [p for p in series if p["time"] <= now]
    if not past:
        return {"available": False, "operating_point": op}

    vents = [p["ventilation"] for p in past]
    return {
        "available": True,
        "operating_point": op,
        "latest": {
            "time": past[-1]["time"],
            "ventilation_m2_s": round(past[-1]["ventilation"], 1),
            "blh_m": round(past[-1]["blh"], 1),
            "wind_ms": round(past[-1]["wind"], 2),
            "data_age_minutes": round(
                (now - past[-1]["time"]).total_seconds() / 60.0),
        },
        "hours_below_threshold_24h": sum(
            1 for p in past[-24:] if p["ventilation"] <= op["threshold_m2_s"]),
        "mean_24h_m2_s": round(sum(vents[-24:]) / max(len(vents[-24:]), 1), 1),
    }


if __name__ == "__main__":
    op = load_operating_point()
    print("operating point")
    for k, v in op.items():
        if k != "caveat":
            print(f"  {k:<24} {v}")

    print("\nrecent (observed)")
    rec = recent_ventilation()
    if rec.get("available"):
        for k, v in rec["latest"].items():
            print(f"  {k:<24} {v}")
        print(f"  hours below thr (24h)    {rec['hours_below_threshold_24h']}")

    print("\nforecast (72 h)")
    fc = forecast_ventilation()
    if not fc.get("available"):
        print("  ", fc.get("reason"))
    else:
        print(f"  state                    {fc['state'].upper()}")
        print(f"  horizon                  {fc['horizon_hours']} h")
        s = fc["summary"]
        print(f"  ventilation min/mean/max {s['min_ventilation_m2_s']} / "
              f"{s['mean_ventilation_m2_s']} / {s['max_ventilation_m2_s']} m2/s")
        print(f"  hours below threshold    {s['hours_below_threshold']}")
        if fc["collapse"]:
            c = fc["collapse"]
            print(f"  collapse onset           {c['onset']}")
            print(f"  hours from now           {c['hours_from_now']}")
            print(f"  sustained hours below    "
                  f"{c['sustained_hours_below_threshold']}")
            print(f"  INTERVENTION WINDOW      "
                  f"{fc['intervention_window_hours']} h")
        else:
            print("  no sustained ventilation collapse in the forecast window")
