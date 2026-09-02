"""
The forecast service: 72 hours of PM2.5, central and upper-tail, with provenance.

WHAT THIS IS
    The single entry point behind AREE's outlook. One function, one contract:

        forecast(as_of) -> 72 hourly points, each carrying a central estimate,
                           an upper-tail estimate, and a full record of where
                           every input came from.

    It is also the boundary a WRF-Chem core would later satisfy. Nothing above
    this module knows which engine produced the numbers, which is the point:
    the decision layer, the API and the dashboard are written against the
    contract, not against LightGBM.

TWO OUTPUTS, NOT ONE. THIS IS A MEASURED CHOICE, NOT A PREFERENCE.
    central  L1 objective, the conditional median. Best overall accuracy
             (MAE 83.9 pooled) and the line a forecast should show.
    upper    q90 objective, the conditional 90th percentile. It is the only
             variant whose ceiling reaches observed episode peaks (714 vs an
             observed p99 of 629; L1 tops out at 413), and the only one with
             real anticipation skill - 9 of 13 severe episodes called before
             onset, median 68 h of lead, against 0 of 13 for both baselines.

    `upper` is UPPER-TAIL RISK, never a prediction. It over-forecasts ordinary
    conditions by design (+52 bias) and sits in a warning state 87% of the
    time. Presenting it as "the forecast" would be dishonest and would also be
    a worse product. The warning triggers off it; the line shown is `central`.

HOW REPLAY IS MADE LEAKAGE-PROOF BY CONSTRUCTION
    Persisted models are named with the last date they were allowed to see, and
    forecast() loads the newest model whose train_end is at or before `as_of`.
    A replay of 16 Nov 2024 therefore CANNOT load a model trained afterwards -
    not by convention or by remembering, but because the file that would allow
    it is never selected. The holdout months are excluded from every fit
    regardless, as they are everywhere else in this project.

WHY REPLAY EXISTS AT ALL
    A demonstration that depends on whatever the atmosphere happens to be doing
    that afternoon is not a demonstration. Replay reconstructs a real episode
    from the data that was genuinely available at the time, and every point
    says so in its provenance, so a reconstruction can never be mistaken for a
    live prediction.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import fmean, median
from typing import Any

from ..backfill import baselines, met_history, model_lgbm
from ..ingestion import weather_stream as ws

log = logging.getLogger("aree.forecast.pm25")

MODEL_DIR = Path(__file__).resolve().parent.parent / "config" / "models"

# name -> (lightgbm params, human label). The params are the ones the
# objective experiment measured; they are not re-tuned here.
OUTPUTS = {
    "central": (
        {k: v for k, v in model_lgbm.PARAMS.items()},
        "Central forecast (conditional median)",
    ),
    "upper": (
        {**{k: v for k, v in model_lgbm.PARAMS.items()
            if k not in ("objective", "metric")},
         "objective": "quantile", "alpha": 0.9, "metric": "quantile"},
        "Upper-tail risk (90th percentile) — NOT a prediction",
    ),
}

HORIZON = 72
LIVE_WINDOW_HOURS = 6      # as_of within this of now is treated as live
LEGACY_STATION = "Delhi NCR composite (research)"

# How far back a LIVE forecast may step to find a complete set of lags.
#
# The current hour is never observed: CPCB and CAQM publish hourly and arrive
# 40-100 minutes late, so at 07:00 the newest reading is 06:00 or 05:00. A
# forecast anchored to the wall clock therefore always fails on lag 0, which is
# not a data problem - it is the wrong question. Operational forecasts are
# issued FROM the latest observation, and say so: "issued 07:00, based on
# observations to 06:00".
#
# Bounded, because stepping back indefinitely would silently serve a forecast
# anchored to yesterday and present it as current.
MAX_ANCHOR_BACKOFF_HOURS = 6


# --- observations ----------------------------------------------------------

def observation_series(conn) -> dict[datetime, tuple[float, str]]:
    """
    One PM2.5 history, assembled from every source, each hour tagged.

    Priority is capture over legacy: where the live network has an hour, that
    hour is an airshed median across ~80 instruments, which is a better
    quantity than the single-monitor legacy series (see C0). Where it does not,
    the legacy series is used and says so. Nothing is silently blended - the
    caller can see, per hour, which target it is standing on.
    """
    out: dict[datetime, tuple[float, str]] = {}

    for row in conn.execute(
            "SELECT timestamp, pm25 FROM station_readings "
            "WHERE station_id = ? AND pm25 IS NOT NULL", (LEGACY_STATION,)):
        out[model_lgbm._parse(row["timestamp"])] = (row["pm25"], "legacy")

    # Any per-station row counts as network observation, whether it arrived
    # from the hourly capture or was retrieved from OpenAQ. Both are the same
    # instruments; only the delivery differs, and the tag records which.
    network: dict[datetime, list[float]] = {}
    tags: dict[datetime, set] = {}
    for row in conn.execute(
            "SELECT timestamp, pm25, source FROM station_readings "
            "WHERE (source LIKE 'live:%' OR source LIKE 'openaq:%') "
            "AND pm25 IS NOT NULL"):
        hour = model_lgbm._parse(row["timestamp"])
        network.setdefault(hour, []).append(row["pm25"])
        tags.setdefault(hour, set()).add(row["source"].split(":")[0])
    for hour, values in network.items():
        out[hour] = (median(values),
                     f"{'+'.join(sorted(tags[hour]))}:{len(values)}st")

    return out


# --- meteorology -----------------------------------------------------------

def _met_from_store(conn, grid: str) -> dict[datetime, dict]:
    return model_lgbm.load_met(conn, grid)


def _met_from_live_forecast(lat: float, lon: float,
                            hours: int) -> dict[datetime, dict]:
    """
    Open-Meteo's forward forecast, mapped onto the columns the model expects.

    Reuses met_history.COLUMN_MAP so a live row and a stored row are the same
    shape. Two mappings would eventually disagree, and the failure would look
    like a model problem rather than a plumbing one.
    """
    out: dict[datetime, dict] = {}
    for row in ws.fetch_forecast(lat, lon, hours=hours):
        rec = {column: row.get(upstream)
               for upstream, column in met_history.COLUMN_MAP.items()}
        blh, wind = rec.get("boundary_layer_height"), rec.get("wind_speed_10m")
        rec["ventilation_coefficient"] = (
            blh * wind if blh is not None and wind is not None else None)
        out[row["observed_at"]] = rec
    return out


# --- models ----------------------------------------------------------------

def model_path(name: str, train_end: datetime) -> Path:
    return MODEL_DIR / f"{name}__{train_end:%Y%m%d}.txt"


def train_and_persist(conn, train_end: datetime, station: str | None = None,
                      grid: str = model_lgbm.DEFAULT_GRID) -> dict[str, Any]:
    """Fit both outputs on data before train_end and write them to disk."""
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    station = station or baselines.default_station(conn)
    written = {}

    for name, (params, _label) in OUTPUTS.items():
        booster, stats = model_lgbm.train_fold(
            conn, station, grid, train_end=train_end, params=params)
        path = model_path(name, train_end)
        booster.save_model(str(path))
        written[name] = {"path": str(path), "samples": stats["n_samples"]}
        log.info("%s trained on %d samples, saved to %s",
                 name, stats["n_samples"], path.name)

    return {"train_end": train_end, "station": station, "grid": grid,
            "models": written}


def available_models(name: str) -> list[tuple[datetime, Path]]:
    if not MODEL_DIR.exists():
        return []
    out = []
    for path in MODEL_DIR.glob(f"{name}__*.txt"):
        stamp = path.stem.split("__")[-1]
        try:
            out.append((datetime.strptime(stamp, "%Y%m%d").replace(
                tzinfo=timezone.utc), path))
        except ValueError:
            continue
    return sorted(out)


def load_for(name: str, as_of: datetime):
    """
    The newest model that was not allowed to see anything after `as_of`.

    This is the leakage guard. A replay cannot load a later model because the
    selection never offers one.
    """
    import lightgbm as lgb

    candidates = [(end, p) for end, p in available_models(name) if end <= as_of]
    if not candidates:
        raise RuntimeError(
            f"no persisted '{name}' model trained on or before "
            f"{as_of:%Y-%m-%d}. Run: python train_forecast.py "
            f"--train-end {as_of:%Y-%m-%d}")
    train_end, path = candidates[-1]
    return lgb.Booster(model_file=str(path)), train_end


# --- the contract ----------------------------------------------------------

def forecast(conn, as_of: datetime | None = None,
             lat: float = ws.DEFAULT_LAT, lon: float = ws.DEFAULT_LON,
             horizon: int = HORIZON,
             grid: str = model_lgbm.DEFAULT_GRID) -> dict[str, Any]:
    """
    AtmosphericForecast(as_of). The one call the rest of AREE is written against.

    Returns a plain dictionary so it can be serialised, logged into the audit
    trail and replayed later byte for byte - the same discipline the ventilation
    layer already follows.
    """
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    at_was_omitted = as_of is None
    as_of = (as_of or now).replace(minute=0, second=0, microsecond=0)
    mode = "live" if abs((now - as_of).total_seconds()) <= LIVE_WINDOW_HOURS * 3600 \
        else "replay"

    observations = observation_series(conn)
    met = (_met_from_live_forecast(lat, lon, horizon) if mode == "live"
           else _met_from_store(conn, grid))
    met_source = ("openmeteo:forecast" if mode == "live"
                  else f"store:{grid} (era5)")

    def _missing(anchor: datetime) -> list[int]:
        return [h for h in model_lgbm.PM_LAGS
                if (anchor - timedelta(hours=h)) not in observations]

    # In LIVE mode, step back to the newest hour that actually has a complete
    # set of lags. An explicitly supplied `at` is never moved - a replay must
    # reconstruct the moment it was asked for, exactly.
    anchored_from = None
    if at_was_omitted:
        for back in range(MAX_ANCHOR_BACKOFF_HOURS + 1):
            candidate = as_of - timedelta(hours=back)
            if not _missing(candidate):
                if back:
                    anchored_from, as_of = as_of, candidate
                break

    # Lags first: without them there is no forecast, and saying so precisely is
    # more useful than an empty series.
    missing = _missing(as_of)
    if missing:
        return {
            "available": False,
            "reason": (f"observed PM2.5 missing at lag(s) {missing} h before "
                       f"{as_of:%Y-%m-%d %H:%M} UTC"),
            "as_of": as_of, "mode": mode,
            "hint": ("live forecasting needs ~24 h of recent NCR observations; "
                     "the capture accumulates them hourly"),
        }

    lag_sources = sorted({observations[as_of - timedelta(hours=h)][1]
                          for h in model_lgbm.PM_LAGS})
    plain = {t: v for t, (v, _src) in observations.items()}

    boosters = {}
    for name in OUTPUTS:
        boosters[name] = load_for(name, as_of)

    series: list[dict[str, Any]] = []
    for lead in range(1, horizon + 1):
        valid = as_of + timedelta(hours=lead)
        features = model_lgbm._row(as_of, lead, plain, met)
        if features is None:
            continue
        point: dict[str, Any] = {
            "valid_at": valid,
            "lead_hours": lead,
            "as_of": as_of,
            "mode": mode,
            "target_source": "+".join(lag_sources),
            "feature_source": met_source,
        }
        for name, (booster, train_end) in boosters.items():
            point[name] = round(max(0.0, float(booster.predict([features])[0])), 1)
            point[f"{name}_model"] = f"{name}__{train_end:%Y%m%d}"
        m = met.get(valid) or {}
        point["ventilation_m2_s"] = (
            round(m["ventilation_coefficient"], 1)
            if m.get("ventilation_coefficient") is not None else None)
        point["blh_m"] = m.get("boundary_layer_height")
        point["wind_ms"] = m.get("wind_speed_10m")
        series.append(point)

    if not series:
        return {"available": False, "as_of": as_of, "mode": mode,
                "reason": f"no meteorology available after {as_of:%Y-%m-%d %H:%M}"}

    return {
        "available": True,
        "as_of": as_of,
        "mode": mode,
        "generated_at": datetime.now(timezone.utc),
        "horizon_hours": len(series),
        "location": {"lat": lat, "lon": lon, "grid": grid},
        "observed_now": {
            "pm25": plain[as_of],
            "source": observations[as_of][1],
        },
        # Present only when a live forecast had to step back for a complete set
        # of lags. Reported rather than hidden, because "issued now, based on
        # observations to 06:00" is a materially different statement from
        # "issued now, based on observations to now".
        "anchored": ({"requested": anchored_from, "used": as_of,
                      "hours_back": round((anchored_from - as_of)
                                          .total_seconds() / 3600)}
                     if anchored_from else None),
        "provenance": {
            "target_source": "+".join(lag_sources),
            "feature_source": met_source,
            "models": {n: f"{n}__{b[1]:%Y%m%d}" for n, b in boosters.items()},
            "note": (f"REPLAY — reconstructed from data available as of "
                     f"{as_of:%Y-%m-%d %H:%M} UTC" if mode == "replay"
                     else (f"LIVE — issued {now:%H:%M} UTC, anchored to the "
                           f"latest observation at {as_of:%H:%M} UTC"
                           if anchored_from else "LIVE")),
        },
        "labels": {name: label for name, (_p, label) in OUTPUTS.items()},
        "summary": {
            "central_max": max(p["central"] for p in series),
            "upper_max": max(p["upper"] for p in series),
            "central_mean": round(fmean(p["central"] for p in series), 1),
        },
        "series": series,
    }
