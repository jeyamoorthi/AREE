#!/usr/bin/env python
"""
Experiment B — what does it cost to not know the weather?

    python experiment_b.py

THE QUESTION
    lgbm-v1 scores 76-85 MAE across 7-72 h, but it was given ERA5 meteorology
    at valid time: it knew what the weather would be. Operationally we would
    have a weather FORECAST, which is wrong in its own right. The gap between
    the two is the weather-uncertainty cost, and it is the number that turns a
    capability claim into an operational one.

        perfect-prognosis MAE  -  operational MAE  =  cost of forecasting weather

    The MODEL IS NOT RETRAINED. One fixed lgbm-v1, driven by two different
    meteorologies. Retraining would confound the question with a second change.

WHY THIS IS BOUNDED RATHER THAN MEASURED EXACTLY
    The previous-runs endpoint does not serve forecast boundary-layer height -
    it returns HTTP 200 with every value null while the current-run PBLH in the
    same response is complete (verified 0/168 vs 168/168). PBLH is half of the
    ventilation coefficient, and VC is the model's strongest meteorological
    feature, so a clean swap is impossible. Instead the answer is bracketed:

      B1  forecast wind/temp/RH/pressure/cloud/precip/radiation,
          ERA5 PBLH retained.
          => OPTIMISTIC. Isolates the penalty from everything except PBLH.
          Reads as: "if we could forecast PBLH perfectly, this is the cost."

      B2  the same, but PBLH replaced by its climatological median for that
          month and hour, fitted before the test window.
          => PESSIMISTIC. Reads as: "if we had no PBLH forecast skill at all,
          this is the cost."

    The truth is between them. Quoting either alone is misleading; the honest
    output of this script is the interval.

WHAT IT RUNS ON
    Nov 2024 only. Wind forecasts do not exist in this archive before 2024
    (temperature does; wind returns 0/168 for 2021, 2022 and 2023). So there is
    no walk-forward here and the interval rests on a single November.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from statistics import median
from pathlib import Path

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env")

_TMP = _PROJECT_ROOT / ".tmp"
_TMP.mkdir(exist_ok=True)
tempfile.tempdir = str(_TMP)
os.environ["TMP"] = os.environ["TEMP"] = os.environ["TMPDIR"] = str(_TMP)

from backend.backfill import (baselines, db, met_forecast,  # noqa: E402
                              model_lgbm)

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

YEAR = 2024
V_NWP_ERA5PBLH = "lgbm-v1-nwp"
V_NWP_CLIMPBLH = "lgbm-v1-nwp-climpblh"
LEAD_ORDER = ["1-6 h", "7-12 h", "13-24 h", "25-48 h", "49-72 h"]


def _rule(width: int = 74) -> None:
    print("  " + "─" * width)


def climatological_pblh(conn, grid: str, before: datetime
                        ) -> dict[tuple[int, int], float]:
    """Median PBLH by (month, hour), fitted strictly before the test window."""
    rows = conn.execute(
        "SELECT timestamp, boundary_layer_height FROM met_hourly "
        "WHERE grid_id = ? AND boundary_layer_height IS NOT NULL", (grid,)
    ).fetchall()
    buckets = defaultdict(list)
    for r in rows:
        ts = model_lgbm._parse(r["timestamp"])
        if ts >= before:
            continue
        buckets[(ts.month, ts.hour)].append(r["boundary_layer_height"])
    return {k: median(v) for k, v in buckets.items() if v}


def make_met_for(nwp: dict, era5: dict, pblh_mode: str,
                 pblh_clim: dict | None):
    """
    Build the substitution function handed to the model.

    Everything the previous-runs endpoint serves comes from the forecast;
    PBLH comes from wherever `pblh_mode` says, and the ventilation coefficient
    is recomputed from whichever PBLH and forecast wind are in force - never
    carried over from the analysis, which would smuggle the answer back in.
    """
    def met_for(valid: datetime, lead: int):
        row = nwp.get((valid, met_forecast.lead_day_for(lead)))
        if row is None:
            return None
        analysis = era5.get(valid)
        if analysis is None:
            return None

        rec = dict(analysis)          # keeps any column the forecast lacks
        for column in met_forecast.COLUMN_MAP.values():
            if row.get(column) is not None:
                rec[column] = row[column]

        if pblh_mode == "climatology":
            rec["boundary_layer_height"] = (pblh_clim or {}).get(
                (valid.month, valid.hour))

        blh, wind = rec.get("boundary_layer_height"), rec.get("wind_speed_10m")
        rec["ventilation_coefficient"] = (
            blh * wind if blh is not None and wind is not None else None)
        return rec
    return met_for


def pooled_mae(conn, station: str, model: str) -> dict[str, float]:
    lo = datetime(YEAR, 11, 1, tzinfo=timezone.utc)
    hi = datetime(YEAR, 11, 30, tzinfo=timezone.utc)
    return {r["lead"]: r["mae"] for r in baselines.score(conn, station, lo, hi)
            if r["model"] == model}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Experiment B — operational skill")
    p.add_argument("--grid", default=model_lgbm.DEFAULT_GRID)
    p.add_argument("--station", default="")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    conn = db.connect()
    station = args.station or baselines.default_station(conn)
    start = datetime(YEAR, 11, 1, tzinfo=timezone.utc)
    end = datetime(YEAR, 11, 27, tzinfo=timezone.utc)

    print("\nExperiment B — operational skill with real past NWP forecasts")
    _rule()
    print(f"  station    {station}")
    print(f"  window     Nov {YEAR} (the only November with wind forecasts)")

    # 1. The weather as it was actually forecast.
    lat, lon = 28.63, 77.22
    rows = met_forecast.fetch(lat, lon, start,
                              datetime(YEAR, 11, 30, tzinfo=timezone.utc))
    cov = met_forecast.coverage(rows)
    print(f"  NWP rows   {len(rows)}  by lead day: "
          + ", ".join(f"day{d}={n}" for d, n in sorted(cov.items())))
    if not rows:
        print("\n  previous-runs returned nothing — cannot run Experiment B.\n",
              file=sys.stderr)
        return 1
    nwp = met_forecast.as_lookup(rows)

    # 2. One model, trained exactly as fold 2024 was.
    booster, stats = model_lgbm.train_fold(conn, station, args.grid,
                                           train_end=start)
    print(f"  model      lgbm-v1, {stats['n_samples']:,} training samples "
          f"(not retrained between variants)")

    era5 = model_lgbm.load_met(conn, args.grid)
    pblh_clim = climatological_pblh(conn, args.grid, before=start)
    print(f"  PBLH clim  {len(pblh_clim)} (month, hour) cells")

    # 3. Two variants, same model, different weather.
    for version, mode in ((V_NWP_ERA5PBLH, "era5"),
                          (V_NWP_CLIMPBLH, "climatology")):
        met_for = make_met_for(nwp, era5, mode, pblh_clim)
        preds = model_lgbm.predict_fold(
            conn, booster, station, args.grid, start, end,
            met_for=met_for, model_version=version)
        db.upsert(conn, "forecasts",
                  ("issued_at", "valid_at", "station_id", "species",
                   "model_version"), preds)
        print(f"  {version:<22} {len(preds):>6,} forecasts")

    # 4. The interval.
    perfect = pooled_mae(conn, station, model_lgbm.MODEL_VERSION)
    b1 = pooled_mae(conn, station, V_NWP_ERA5PBLH)
    b2 = pooled_mae(conn, station, V_NWP_CLIMPBLH)
    clim = pooled_mae(conn, station, "climatology-v1")
    pers = pooled_mae(conn, station, "persistence-v1")

    print(f"\n  WEATHER-UNCERTAINTY COST — Nov {YEAR}, PM2.5 MAE µg/m³")
    _rule()
    print(f"  {'Horizon':>9}{'A: ERA5':>10}{'B1: NWP':>10}{'B2: NWP':>10}"
          f"{'cost':>14}{'vs clim':>10}")
    print(f"  {'':>9}{'(perfect)':>10}{'+ERA5 PBL':>10}{'+clim PBL':>10}"
          f"{'(B1→B2)':>14}{'':>10}")
    _rule()
    for lead in LEAD_ORDER:
        a, x, y, c = perfect.get(lead), b1.get(lead), b2.get(lead), clim.get(lead)
        if a is None or x is None or y is None:
            continue
        beats = "beats" if min(x, y) < c else ("mixed" if x < c else "loses")
        lo_cost, hi_cost = sorted((x - a, y - a))
        print(f"  {lead:>9}{a:>10.1f}{x:>10.1f}{y:>10.1f}"
              f"{f'{lo_cost:+.1f}…{hi_cost:+.1f}':>14}{beats:>10}")
    _rule()
    print("  cost = MAE added by using a real weather forecast instead of")
    print("  knowing the weather. B1 optimistic (perfect PBLH), B2 pessimistic")
    print("  (no PBLH skill). The operational truth lies between them.")
    print(f"  Baseline to beat: climatology "
          f"{', '.join(f'{k}={v:.1f}' for k, v in sorted(clim.items()))}")
    print(f"  Persistence at 1-6 h: {pers.get('1-6 h', float('nan')):.1f}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
