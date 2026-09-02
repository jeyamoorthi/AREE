"""
Baseline forecasts. The bar any model has to clear before it is worth having.

WHY BASELINES COME BEFORE THE MODEL
    A LightGBM that reports MAE 38 ug/m3 sounds like a result until you learn
    that repeating the last observed value scores 35. Without baselines there
    is no way to tell a model that learned something from one that learned the
    autocorrelation of PM2.5, and the second is the usual outcome. So these are
    written first, into the same table, scored by the same function.

    Two of them, because they fail differently:

      persistence   carries the current value forward. Very strong at short
                    lead times, and it is the honest short-horizon competitor.
                    It cannot anticipate anything - a persistence forecast of
                    an episode's onset is always late.

      climatology   the seasonal-diurnal average for that month and hour. It
                    knows nothing about today, so it is weak everywhere, but it
                    degrades gracefully and is the long-horizon floor. A model
                    that cannot beat climatology at 48 h has no skill at 48 h.

THE RULE THIS MODULE EXISTS TO ENFORCE
    A forecast issued at time T may use ONLY data timestamped at or before T.
    That sounds obvious and is the single easiest thing to get wrong in a
    backfilled dataset, because the whole history is sitting in one table and a
    careless query will happily read the future. Every read here is bounded by
    issued_at, and the climatology is fitted on a training window that ends
    before the scoring window begins.

HOLDOUT
    Nov 2023 and Nov 2024 never enter any training statistic. That is the rule
    the whole project runs under: every public number comes from episodes the
    fit never saw.
"""

from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from statistics import fmean, median
from typing import Any

log = logging.getLogger("aree.backfill.baselines")

SPECIES = "pm25"
PERSISTENCE_VERSION = "persistence-v1"
CLIMATOLOGY_VERSION = "climatology-v1"

# Months held out of every training statistic. See the module docstring.
HOLDOUT = {(2023, 11), (2024, 11)}

# Lead-time buckets for the scorecard. Chosen to match how the forecast is
# actually used: the first bucket is inside a single intervention window, the
# last is the edge of the 72 h horizon.
LEAD_BUCKETS = [(1, 6), (7, 12), (13, 24), (25, 48), (49, 72)]


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")


def _parse(raw: str) -> datetime:
    return datetime.strptime(raw, "%Y-%m-%dT%H:00:00Z").replace(
        tzinfo=timezone.utc)


def load_observations(conn: sqlite3.Connection, station: str
                      ) -> dict[datetime, float]:
    """Every observed hour for one station, as a lookup."""
    rows = conn.execute(
        "SELECT timestamp, pm25 FROM station_readings "
        "WHERE station_id = ? AND pm25 IS NOT NULL", (station,)).fetchall()
    return {_parse(r["timestamp"]): r["pm25"] for r in rows}


def default_station(conn: sqlite3.Connection) -> str | None:
    """The station with the most observations - the one worth scoring on."""
    row = conn.execute(
        "SELECT station_id, COUNT(*) n FROM station_readings "
        "WHERE pm25 IS NOT NULL GROUP BY station_id ORDER BY n DESC LIMIT 1"
    ).fetchone()
    return row["station_id"] if row else None


def fit_climatology(observations: dict[datetime, float],
                    train_end: datetime) -> dict[tuple[int, int], float]:
    """
    Median PM2.5 by (month, hour of day), from data strictly before train_end.

    Median rather than mean: the distribution is heavily right-skewed - a
    handful of severe hours above 800 would drag a mean well above the value
    a typical hour takes, making the baseline artificially hard to beat in the
    wrong direction (too high everywhere, rather than typical).
    """
    buckets: dict[tuple[int, int], list[float]] = defaultdict(list)
    for ts, value in observations.items():
        if ts >= train_end or (ts.year, ts.month) in HOLDOUT:
            continue
        buckets[(ts.month, ts.hour)].append(value)

    table = {key: median(vals) for key, vals in buckets.items() if vals}
    log.info("climatology fitted on %d (month, hour) cells from data before %s",
             len(table), train_end.date())
    return table


def _latest_at_or_before(observations: dict[datetime, float],
                         issued_at: datetime,
                         max_age_hours: int = 6) -> float | None:
    """
    The most recent observation available at issue time.

    Bounded by max_age_hours because persistence carried from a reading two
    days old is not persistence, it is a stale number wearing a forecast's
    label. Returning None instead lets the run record a gap honestly.
    """
    for back in range(max_age_hours + 1):
        value = observations.get(issued_at - timedelta(hours=back))
        if value is not None:
            return value
    return None


def generate(conn: sqlite3.Connection, station: str,
             start: datetime, end: datetime,
             horizon_hours: int = 72, issue_every_hours: int = 24
             ) -> list[dict[str, Any]]:
    """
    Produce both baselines for every issue time in the window.

    One issue per day by default: 72 forecasts per issue, and issuing hourly
    would multiply the table by 24 for correlated information. The scorer
    treats each (issued_at, valid_at) pair independently either way.
    """
    observations = load_observations(conn, station)
    if not observations:
        raise RuntimeError(f"no PM2.5 observations for station {station!r}")

    climatology = fit_climatology(observations, train_end=start)
    rows: list[dict[str, Any]] = []
    issued = start
    n_gaps = 0

    while issued <= end:
        anchor = _latest_at_or_before(observations, issued)
        for lead in range(1, horizon_hours + 1):
            valid = issued + timedelta(hours=lead)
            base = {
                "issued_at": _iso(issued),
                "valid_at": _iso(valid),
                "station_id": station,
                "species": SPECIES,
            }
            if anchor is not None:
                rows.append({**base, "forecast_value": anchor,
                             "model_version": PERSISTENCE_VERSION})
            clim = climatology.get((valid.month, valid.hour))
            if clim is not None:
                rows.append({**base, "forecast_value": clim,
                             "model_version": CLIMATOLOGY_VERSION})
        if anchor is None:
            n_gaps += 1
        issued += timedelta(hours=issue_every_hours)

    if n_gaps:
        log.warning("%d issue times had no observation within 6 h — "
                    "persistence skipped for those", n_gaps)
    return rows


def score(conn: sqlite3.Connection, station: str,
          start: datetime, end: datetime) -> list[dict[str, Any]]:
    """
    Compare every stored forecast against what actually happened.

    Joins on valid_at, so a forecast with no matching observation is dropped
    rather than counted as a perfect hit - which is what a LEFT JOIN and a
    COALESCE would quietly do.
    """
    observations = load_observations(conn, station)
    rows = conn.execute(
        "SELECT issued_at, valid_at, forecast_value, model_version "
        "FROM forecasts WHERE station_id = ? AND species = ? "
        "AND valid_at >= ? AND valid_at <= ?",
        (station, SPECIES, _iso(start), _iso(end))).fetchall()

    # model -> bucket -> list of (error, actual)
    acc: dict[str, dict[tuple[int, int], list[tuple[float, float]]]] = \
        defaultdict(lambda: defaultdict(list))

    for row in rows:
        actual = observations.get(_parse(row["valid_at"]))
        if actual is None:
            continue
        lead = int((_parse(row["valid_at"]) - _parse(row["issued_at"])
                    ).total_seconds() // 3600)
        for lo, hi in LEAD_BUCKETS:
            if lo <= lead <= hi:
                acc[row["model_version"]][(lo, hi)].append(
                    (row["forecast_value"] - actual, actual))
                break

    out = []
    for model, buckets in sorted(acc.items()):
        for bucket, pairs in sorted(buckets.items()):
            errors = [e for e, _ in pairs]
            out.append({
                "model": model,
                "lead": f"{bucket[0]}-{bucket[1]} h",
                "n": len(errors),
                "mae": fmean(abs(e) for e in errors),
                "rmse": (fmean(e * e for e in errors)) ** 0.5,
                "bias": fmean(errors),
            })
    return out
