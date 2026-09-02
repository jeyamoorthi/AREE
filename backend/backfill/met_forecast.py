"""
Real past NWP forecasts, for Experiment B.

WHAT THIS IS FOR
    lgbm-v1 is scored with ERA5 meteorology at valid time - it is told what the
    weather will actually be. That is perfect prognosis, and its score is an
    upper bound. This module supplies the other half of the experiment: the
    weather as it was ACTUALLY FORECAST, at the lead time we would really have
    had. The difference between the two scores is the cost of not knowing the
    weather.

THE ENDPOINT
    previous-runs-api.open-meteo.com serves, for each valid hour, the value
    from the model run issued N days earlier, as `<var>_previous_dayN`.

TWO MEASURED LIMITATIONS THAT SHAPE THE WHOLE EXPERIMENT
    1. THERE IS NO FORECAST BOUNDARY LAYER HEIGHT. The endpoint accepts
       boundary_layer_height_previous_day1 and answers HTTP 200 with every
       value null, while the current-run boundary_layer_height in the same
       response is fully populated (verified 168/168 vs 0/168 over
       2024-11-01..07, days 1 and 2). No error, no `reason` - the same
       "answers confidently rather than refusing" failure this codebase keeps
       meeting.

       This matters more here than anywhere else, because PBLH is half of the
       ventilation coefficient and VC is the model's top meteorological
       feature. Experiment B therefore cannot be run as a clean swap; see
       PBLH_STRATEGIES below for how it is bounded instead.

    2. WIND FORECASTS ONLY EXIST FROM 2024. Measured over Nov 1-7 of each
       year: temperature_2m_previous_day1 returns 168/168 for 2021, 2022, 2023
       and 2024, but wind_speed_10m_previous_day1 returns 0/168 for every year
       before 2024. Wind is not optional here, so Experiment B runs on the
       Nov 2024 fold only. Four-fold walk-forward is not available for it, and
       any figure it produces rests on one November.

LEAD MAPPING, AND THE APPROXIMATION IN IT
    A forecast we issue at T for lead L is valid at V = T + L. The nearest
    available past run is previous_day ceil(L / 24). That is an approximation:
    previous_dayN is issued at a fixed daily run hour, not at our T, so the
    substituted weather can be up to 24 h older than our nominal issue time.
    The error runs one way - it makes Experiment B pessimistic rather than
    optimistic, especially in the 1-24 h bucket - which is the safe direction
    for a number we intend to publish.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import requests

log = logging.getLogger("aree.backfill.met_forecast")

BASE = "https://previous-runs-api.open-meteo.com/v1/forecast"

# Everything the model needs that this endpoint actually serves.
# boundary_layer_height is deliberately absent - see the module docstring.
FORECAST_VARS = (
    "wind_speed_10m",
    "wind_direction_10m",
    "temperature_2m",
    "relative_humidity_2m",
    "surface_pressure",
    "cloud_cover",
    "precipitation",
    "shortwave_radiation",
)

# Upstream name -> our met_hourly column name, so a row from here is
# interchangeable with a row from the archive everywhere downstream.
COLUMN_MAP = {
    "wind_speed_10m": "wind_speed_10m",
    "wind_direction_10m": "wind_direction_10m",
    "temperature_2m": "temperature_2m",
    "relative_humidity_2m": "relative_humidity",
    "surface_pressure": "surface_pressure",
    "cloud_cover": "cloud_cover",
    "precipitation": "precipitation",
    "shortwave_radiation": "solar_radiation",
}

LEAD_DAYS = (1, 2, 3)
REQUEST_SPACING_S = 2.0


def lead_day_for(lead_hours: int) -> int:
    """Which previous_dayN run covers a forecast at this lead."""
    return min(max(1, -(-lead_hours // 24)), max(LEAD_DAYS))


def fetch(lat: float, lon: float, start: datetime, end: datetime,
          lead_days: tuple[int, ...] = LEAD_DAYS) -> list[dict]:
    """
    Past forecasts for a date range, one row per (valid hour, lead day).

    Returns [] rather than raising, but logs per-variable coverage: a silent
    all-null column is the specific failure this endpoint produces, so the
    caller is given the numbers rather than a boolean.
    """
    names = [f"{v}_previous_day{d}" for d in lead_days for v in FORECAST_VARS]
    params = {
        "latitude": lat, "longitude": lon,
        "hourly": ",".join(names),
        "start_date": start.strftime("%Y-%m-%d"),
        "end_date": end.strftime("%Y-%m-%d"),
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }

    try:
        r = requests.get(BASE, params=params, timeout=120)
        r.raise_for_status()
        payload = r.json()
    except Exception as exc:                                # noqa: BLE001
        log.warning("previous-runs fetch failed: %s", exc)
        return []

    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        log.warning("previous-runs returned no hours for %s..%s",
                    params["start_date"], params["end_date"])
        return []

    out: list[dict] = []
    for day in lead_days:
        present = 0
        for i, raw in enumerate(times):
            valid = datetime.fromisoformat(raw).replace(tzinfo=timezone.utc)
            rec = {"valid_at": valid, "lead_day": day}
            usable = False
            for upstream, column in COLUMN_MAP.items():
                series = hourly.get(f"{upstream}_previous_day{day}")
                value = series[i] if series and i < len(series) else None
                rec[column] = value
                if value is not None:
                    usable = True
            if usable:
                out.append(rec)
                present += 1
        log.info("  previous_day%d: %d/%d hours carry data",
                 day, present, len(times))
        if present == 0:
            log.warning("  previous_day%d returned nothing usable — this "
                        "endpoint answers 200 with nulls rather than "
                        "erroring, so treat it as missing, not as zero", day)
    time.sleep(REQUEST_SPACING_S)
    return out


def as_lookup(rows: list[dict]) -> dict[tuple[datetime, int], dict]:
    """Index by (valid_at, lead_day) for O(1) substitution during prediction."""
    return {(r["valid_at"], r["lead_day"]): r for r in rows}


def coverage(rows: list[dict]) -> dict[int, int]:
    """Rows per lead day, so a caller can assert before scoring."""
    out: dict[int, int] = {}
    for r in rows:
        out[r["lead_day"]] = out.get(r["lead_day"], 0) + 1
    return out
