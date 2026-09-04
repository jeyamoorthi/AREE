"""
lgbm-v1 — the first learned forecast. Deliberately boring.

EXPERIMENT A: PERFECT PROGNOSIS. READ THIS BEFORE QUOTING ANY NUMBER.
    This model is trained and scored with ERA5 meteorology AT VALID TIME. That
    is, it is told what the weather will actually be, and asked only to map
    weather plus recent pollution onto pollution.

    That is a legitimate and standard experiment - it isolates whether the
    pollution/meteorology relationship carries predictive information at all,
    separately from whether the weather itself can be predicted. It is NOT
    operational forecast skill, and its score is an UPPER BOUND on what the
    deployed system could achieve.

    The honest sentence, which belongs in any report or slide:

        "Perfect-prognosis experiment: meteorological inputs are treated as
         known at forecast time, therefore the resulting score is an upper
         bound on operational performance."

    Experiment B - substituting real previous-run NWP forecasts for ERA5 at
    valid time, via previous-runs-api.open-meteo.com - measures the
    degradation. It is not implemented here and must not be conflated with
    this.

WHY THE FEATURE SET IS SMALL ON PURPOSE
    The question v1 answers is "does ML add anything over persistence and
    climatology". A large feature set answers that question less clearly, not
    more: if it wins, we do not know what won, and if it loses we do not know
    what to remove. So there is no plume influence and no aerosol-PBLH
    feedback correction in this model. Those are the next ablation step, and
    they are only interpretable against a v1 that did without them.

WHAT IS AVAILABLE, AND WHAT THE PLAN ASKED FOR THAT IS NOT
    Asked for and included:  PM2.5 lags, PBLH, wind, temperature, RH,
                             precipitation, ventilation coefficient, hour,
                             day-of-year, month.
    Asked for and NOT available, with the reason:
      * PM10 / O3 / NO2 lags - the historical series is the NCR PM2.5
        composite from the research pipeline. It carries no other pollutant.
        Adding empty columns would be worse than omitting them.
      * inversion strength / lapse rate - the ERA5 archive serves no
        pressure levels (see weather_stream.ARCHIVE_PRESSURE_VARS), so these
        are NULL for every training hour. Coverage is reported rather than
        assumed; they enter the model only if actually populated.
      * station / grid identity - there is exactly one PM2.5 series and it is
        an NCR-wide composite. A constant column is not a feature.

WALK-FORWARD, IDENTICAL TO THE BASELINES
    One fold per test November, trained only on data before that season, with
    the Nov 2023 and Nov 2024 holdout months excluded from every training set
    regardless of fold. Predictions land in the same `forecasts` table and are
    read by the same score() function, so the comparison is like for like.
"""

from __future__ import annotations

import logging
import math
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np

from . import baselines

log = logging.getLogger("aree.backfill.lgbm")

MODEL_VERSION = "lgbm-v1"
DEFAULT_GRID = "ncr_28.63_77.22"

# Lags of observed PM2.5, in hours before issue time. All known at issue.
PM_LAGS = (0, 1, 3, 6, 12, 24)

# Issue every 6 h in training too, matching the evaluation. Denser sampling
# mostly adds near-duplicate rows: consecutive issue times share their lag
# window almost entirely.
TRAIN_ISSUE_STRIDE_H = 6

MET_COLUMNS = (
    "boundary_layer_height", "wind_speed_10m", "wind_direction_10m",
    "temperature_2m", "relative_humidity", "precipitation",
    "surface_pressure", "cloud_cover", "solar_radiation",
)

PARAMS = {
    # L1 because the metric is MAE. Optimising squared error and reporting MAE
    # would tune the model for a target nobody scores it on.
    "objective": "regression_l1",
    "metric": "l1",
    "learning_rate": 0.05,
    "num_leaves": 63,
    "min_data_in_leaf": 100,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "verbosity": -1,
    "seed": 26082,
}
NUM_ROUNDS = 400


def _parse(raw: str) -> datetime:
    return datetime.strptime(raw, "%Y-%m-%dT%H:00:00Z").replace(
        tzinfo=timezone.utc)


def load_met(conn: sqlite3.Connection, grid: str,
             since: datetime | None = None,
             until: datetime | None = None) -> dict[datetime, dict]:
    """
    Meteorology by hour for one grid point, plus the ventilation coefficient.

    WHY THE WINDOW IS OPTIONAL RATHER THAN MANDATORY
        Training reads the whole history for a grid and legitimately wants every row.
        A forecast reads 72 hours. Before the window existed both paths took the same
        unbounded query, so serving one 72-hour outlook materialised 39,624 rows -
        measured at 345 ms - to keep 72 of them, and the cost was paid on every request.

        Bounding it is a range scan on the existing (grid_id, timestamp) primary key,
        so this needs no new index. Callers that want everything simply pass nothing,
        which keeps the training path byte-identical.

    Timestamps are ISO-8601 UTC text that sorts lexicographically in chronological
    order (see db.iso), so BETWEEN on the raw column is correct without conversion.
    """
    cols = ", ".join(MET_COLUMNS)
    sql = f"SELECT timestamp, {cols} FROM met_hourly WHERE grid_id = ?"
    params: list = [grid]
    if since is not None:
        sql += " AND timestamp >= ?"
        params.append(since.strftime("%Y-%m-%dT%H:00:00Z"))
    if until is not None:
        sql += " AND timestamp <= ?"
        params.append(until.strftime("%Y-%m-%dT%H:00:00Z"))
    rows = conn.execute(sql, params).fetchall()
    out = {}
    for r in rows:
        rec = {c: r[c] for c in MET_COLUMNS}
        blh, wind = rec["boundary_layer_height"], rec["wind_speed_10m"]
        rec["ventilation_coefficient"] = (
            blh * wind if blh is not None and wind is not None else None)
        out[_parse(r["timestamp"])] = rec
    return out


FEATURE_NAMES = (
    ["lead_h"]
    + [f"pm25_lag{h}" for h in PM_LAGS]
    + ["pm25_mean24", "pm25_delta24"]
    + list(MET_COLUMNS[:2]) + ["wind_dir_sin", "wind_dir_cos"]
    + list(MET_COLUMNS[3:]) + ["ventilation_coefficient"]
    + ["hour", "doy_sin", "doy_cos", "month"]
)


def _row(issued: datetime, lead: int, observations: dict, met: dict,
         met_for=None) -> list[float] | None:
    """
    One feature vector, or None when the inputs for it are not all present.

    Every pollution value read here is at or before `issued`; every
    meteorological value is at valid time. That split is the whole design and
    is why the docstring calls this perfect prognosis.
    """
    valid = issued + timedelta(hours=lead)
    # met_for lets a caller swap the meteorology WITHOUT retraining or touching
    # the feature order - which is the whole mechanism of Experiment B: one
    # fixed model, driven by analysis weather or by real past forecasts.
    m = met_for(valid, lead) if met_for else met.get(valid)
    if m is None or m.get("ventilation_coefficient") is None:
        return None

    lags = []
    for back in PM_LAGS:
        value = observations.get(issued - timedelta(hours=back))
        if value is None:
            return None
        lags.append(value)

    window = [observations[t] for t in
              (issued - timedelta(hours=h) for h in range(24))
              if t in observations]
    if not window:
        return None
    mean24 = sum(window) / len(window)

    wind_dir = m["wind_direction_10m"]
    rad = math.radians(wind_dir) if wind_dir is not None else 0.0
    doy = valid.timetuple().tm_yday

    return (
        [float(lead)]
        + lags
        + [mean24, lags[0] - lags[-1]]
        + [m["boundary_layer_height"], m["wind_speed_10m"],
           math.sin(rad), math.cos(rad)]
        + [m["temperature_2m"], m["relative_humidity"], m["precipitation"],
           m["surface_pressure"], m["cloud_cover"], m["solar_radiation"]]
        + [m["ventilation_coefficient"]]
        + [float(valid.hour),
           math.sin(2 * math.pi * doy / 365.25),
           math.cos(2 * math.pi * doy / 365.25),
           float(valid.month)]
    )


def build_matrix(observations: dict, met: dict, issue_times: list[datetime],
                 horizon: int, with_target: bool, met_for=None
                 ) -> tuple[np.ndarray, np.ndarray, list[tuple]]:
    """Assemble (X, y, index) for a set of issue times."""
    X, y, index = [], [], []
    for issued in issue_times:
        for lead in range(1, horizon + 1):
            features = _row(issued, lead, observations, met, met_for)
            if features is None:
                continue
            valid = issued + timedelta(hours=lead)
            if with_target:
                target = observations.get(valid)
                if target is None:
                    continue
                y.append(target)
            X.append(features)
            index.append((issued, valid, lead))
    return (np.asarray(X, dtype=np.float64),
            np.asarray(y, dtype=np.float64) if with_target else np.empty(0),
            index)


def _issue_times(lo: datetime, hi: datetime, stride_h: int) -> list[datetime]:
    out, cur = [], lo
    while cur <= hi:
        out.append(cur)
        cur += timedelta(hours=stride_h)
    return out


def train_fold(conn: sqlite3.Connection, station: str, grid: str,
               train_end: datetime, horizon: int = 72,
               params: dict | None = None, forward=None) -> tuple[Any, dict]:
    """
    Fit on everything before train_end, minus the holdout months.

    The holdout exclusion is unconditional rather than a function of the fold:
    Nov 2023 must stay out of the model that predicts Nov 2024, or the number
    the project quotes came from a fit that had seen a holdout season.
    """
    import lightgbm as lgb

    observations = baselines.load_observations(conn, station)
    met = load_met(conn, grid)
    if not observations or not met:
        raise RuntimeError("no observations or meteorology in the store")

    first = min(observations)
    issues = [t for t in _issue_times(first, train_end, TRAIN_ISSUE_STRIDE_H)
              if (t.year, t.month) not in baselines.HOLDOUT]

    X, y, _ = build_matrix(observations, met, issues, horizon, with_target=True)
    if len(y) < 1000:
        raise RuntimeError(f"only {len(y)} training samples before "
                           f"{train_end.date()} — not enough to fit")

    # `forward` transforms the TARGET only. Everything else - features, folds,
    # issue times, holdout - stays byte-identical across variants, so a
    # difference in the scorecard can only come from the objective.
    y_fit = forward(y) if forward else y
    booster = lgb.train(params or PARAMS,
                        lgb.Dataset(X, label=y_fit,
                                    feature_name=FEATURE_NAMES),
                        num_boost_round=NUM_ROUNDS)
    stats = {"n_samples": len(y), "n_features": X.shape[1],
             "train_end": train_end, "n_issues": len(issues)}
    log.info("fold trained: %d samples, %d features, data before %s",
             len(y), X.shape[1], train_end.date())
    return booster, stats


def predict_fold(conn: sqlite3.Connection, booster: Any, station: str,
                 grid: str, start: datetime, end: datetime,
                 horizon: int = 72, stride_h: int = 6, met_for=None,
                 model_version: str | None = None, inverse=None) -> list[dict]:
    """Forecast rows for one test window, shaped for the forecasts table."""
    observations = baselines.load_observations(conn, station)
    met = load_met(conn, grid)
    issues = _issue_times(start, end, stride_h)

    X, _, index = build_matrix(observations, met, issues, horizon,
                               with_target=False, met_for=met_for)
    if not len(X):
        return []

    predictions = booster.predict(X)
    if inverse:
        predictions = inverse(predictions)
    return [
        {
            "issued_at": issued.strftime("%Y-%m-%dT%H:00:00Z"),
            "valid_at": valid.strftime("%Y-%m-%dT%H:00:00Z"),
            "station_id": station,
            "species": baselines.SPECIES,
            # PM2.5 cannot be negative; an L1 objective will occasionally
            # predict slightly below zero near clean hours.
            "forecast_value": float(max(0.0, value)),
            "model_version": model_version or MODEL_VERSION,
        }
        for (issued, valid, _lead), value in zip(index, predictions)
    ]


def importances(booster: Any, top: int = 12) -> list[tuple[str, int]]:
    """Gain-based importance, for reading what the model actually used."""
    gains = booster.feature_importance(importance_type="gain")
    names = booster.feature_name()
    ranked = sorted(zip(names, gains), key=lambda kv: -kv[1])[:top]
    return [(n, int(g)) for n, g in ranked]
