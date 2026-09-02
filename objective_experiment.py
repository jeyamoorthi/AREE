#!/usr/bin/env python
"""
Experiment C-fix — can the learning objective recover the severe tail?

    python objective_experiment.py
    python objective_experiment.py --years 2024

THE QUESTION, AND WHY IT IS WORTH A WHOLE EXPERIMENT
    C2 measured that lgbm-v1 never predicts above 341 ug/m3 although its
    training data reached 926, and that 17% of Nov 2024 sat above that ceiling.
    The suspect is the objective: L1 is minimised by the conditional MEDIAN,
    and the median of a right-skewed conditional distribution sits far below
    its peaks. So the question is precise:

        Can changing ONLY the learning objective recover severe-event
        magnitude without sacrificing normal-regime performance?

    Everything except the objective is frozen - identical features, folds,
    issue times, training windows, holdout and scoring function - so any
    difference in the scorecard can only have come from the objective.

WHAT THEORY PREDICTS, WRITTEN DOWN BEFORE THE RUN
    Committing to predictions first is what makes this a test rather than a
    fishing trip:

      q90     conditional 90th percentile          highest predictions
      L2      conditional MEAN; for a right-skewed target the mean sits
              above the median, so it should raise peaks relative to L1
      L1      conditional MEDIAN                   the control (= lgbm-v1)
      log-L1  median is equivariant under a monotonic transform, so this
              should land almost exactly on L1. If it does not, something in
              the pipeline is wrong - it is an internal validity check, not a
              candidate.
      log-L2  mean of log = geometric mean, which is BELOW the arithmetic
              mean, so this may compress the tail even harder than L1.

    Expected ordering of peak magnitude: q90 > L2 > L1 ~ log-L1 > log-L2.

WHAT IS NOT BEING OPTIMISED
    Not overall MAE. A variant that improves overall MAE while still refusing
    to reach 800 ug/m3 has not fixed the failure C2 identified. The metrics
    that matter here are bias, the 400+ bin, the predicted upper percentiles,
    and the 17-19 Nov 2024 episode - which is the MICROSCOPE, not a tuning
    target. Nothing is selected on it.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean

import numpy as np
from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env")

_TMP = _PROJECT_ROOT / ".tmp"
_TMP.mkdir(exist_ok=True)
tempfile.tempdir = str(_TMP)
os.environ["TMP"] = os.environ["TEMP"] = os.environ["TMPDIR"] = str(_TMP)

from backend.backfill import baselines, db, model_lgbm  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Only the single-monitor folds are mutually comparable (C0). 2021 is scored
# too, but against a 32-station composite, so it is reported separately.
COMPARABLE = (2022, 2023, 2024)
EPISODE = ("2024-11-17", "2024-11-19")     # the microscope. Never a target.

_BASE = {k: v for k, v in model_lgbm.PARAMS.items()
         if k not in ("objective", "metric", "alpha")}


def _variant(objective: str, **extra) -> dict:
    return {**_BASE, "objective": objective, **extra}


# name -> (lgbm params, forward transform on y, inverse on predictions)
VARIANTS: dict[str, tuple[dict, object, object]] = {
    "lgbm-v1":     (_variant("regression_l1"), None, None),
    "lgbm-l2":     (_variant("regression"), None, None),
    "lgbm-log-l1": (_variant("regression_l1"), np.log1p, np.expm1),
    "lgbm-log-l2": (_variant("regression"), np.log1p, np.expm1),
    "lgbm-q90":    (_variant("quantile", alpha=0.9, metric="quantile"),
                    None, None),
}


def _rule(width: int = 92) -> None:
    print("  " + "─" * width)


def _pct(values, q: float) -> float:
    if len(values) == 0:
        return float("nan")
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


def _pairs(conn, station: str, model: str, year: int) -> list[dict]:
    """Forecast/actual pairs for one model and November. Same join as diagnose."""
    observations = baselines.load_observations(conn, station)
    rows = conn.execute(
        "SELECT valid_at, forecast_value FROM forecasts "
        "WHERE station_id = ? AND species = ? AND model_version = ? "
        "AND valid_at >= ? AND valid_at <= ?",
        (station, baselines.SPECIES, model,
         f"{year}-11-01T00:00:00Z", f"{year}-11-30T23:00:00Z")).fetchall()
    out = []
    for r in rows:
        valid = datetime.strptime(r["valid_at"], "%Y-%m-%dT%H:00:00Z").replace(
            tzinfo=timezone.utc)
        actual = observations.get(valid)
        if actual is None:
            continue
        out.append({"valid": valid, "pred": r["forecast_value"],
                    "actual": actual, "err": r["forecast_value"] - actual})
    return out


def _stats(rows: list[dict]) -> dict:
    if not rows:
        return {}
    high = [r for r in rows if r["actual"] >= 400]
    ep = [r for r in rows
          if EPISODE[0] <= r["valid"].strftime("%Y-%m-%d") <= EPISODE[1]]
    preds = [r["pred"] for r in rows]
    return {
        "n": len(rows),
        "mae": fmean(abs(r["err"]) for r in rows),
        "bias": fmean(r["err"] for r in rows),
        "max_pred": max(preds),
        "p99_pred": _pct(preds, 0.99),
        "p99_obs": _pct([r["actual"] for r in rows], 0.99),
        "high_n": len(high),
        "high_mae": fmean(abs(r["err"]) for r in high) if high else float("nan"),
        "high_bias": fmean(r["err"] for r in high) if high else float("nan"),
        "ep_mae": fmean(abs(r["err"]) for r in ep) if ep else float("nan"),
        "ep_bias": fmean(r["err"] for r in ep) if ep else float("nan"),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Objective experiment")
    p.add_argument("--years", type=int, nargs="*",
                   default=[2021, *COMPARABLE])
    p.add_argument("--grid", default=model_lgbm.DEFAULT_GRID)
    p.add_argument("--station", default="")
    p.add_argument("--skip-train", action="store_true",
                   help="score already-stored variants without refitting")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.ERROR,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    conn = db.connect()
    station = args.station or baselines.default_station(conn)

    print("\nOBJECTIVE EXPERIMENT — can the loss function recover the tail?")
    _rule()
    print(f"  station   {station}")
    print(f"  frozen    features, folds, issue times, holdout, scoring")
    print(f"  varying   ONLY the objective and the target transform")
    print(f"  predicted ordering of peaks:  q90 > L2 > L1 ≈ log-L1 > log-L2\n")

    if not args.skip_train:
        for name, (params, fwd, inv) in VARIANTS.items():
            if name == "lgbm-v1":
                continue                       # control already in the store
            for year in args.years:
                start = datetime(year, 11, 1, tzinfo=timezone.utc)
                end = datetime(year, 11, 27, tzinfo=timezone.utc)
                try:
                    booster, st = model_lgbm.train_fold(
                        conn, station, args.grid, train_end=start,
                        params=params, forward=fwd)
                except RuntimeError as exc:
                    print(f"  {name} {year}: skipped — {exc}")
                    continue
                preds = model_lgbm.predict_fold(
                    conn, booster, station, args.grid, start, end,
                    model_version=name, inverse=inv)
                db.upsert(conn, "forecasts",
                          ("issued_at", "valid_at", "station_id", "species",
                           "model_version"), preds)
                print(f"  fitted {name:<12} Nov {year}  "
                      f"{st['n_samples']:>7,} samples  "
                      f"{len(preds):>6,} forecasts")

    # ---- scorecard --------------------------------------------------------
    print(f"\n  COMPARABLE FOLDS ONLY (Nov {COMPARABLE[0]}–{COMPARABLE[-1]}, "
          f"single-monitor target)")
    _rule()
    print(f"  {'variant':<13}{'MAE':>8}{'bias':>9}{'400+ MAE':>10}"
          f"{'400+ bias':>11}{'max pred':>10}{'p99 pred':>10}"
          f"{'ep MAE':>9}{'ep bias':>10}")
    _rule()

    obs_p99 = None
    for name in ("climatology-v1", *VARIANTS):
        rows = []
        for year in COMPARABLE:
            rows.extend(_pairs(conn, station, name, year))
        st = _stats(rows)
        if not st:
            continue
        obs_p99 = st["p99_obs"]
        print(f"  {name:<13}{st['mae']:>8.1f}{st['bias']:>+9.1f}"
              f"{st['high_mae']:>10.1f}{st['high_bias']:>+11.1f}"
              f"{st['max_pred']:>10.0f}{st['p99_pred']:>10.0f}"
              f"{st['ep_mae']:>9.1f}{st['ep_bias']:>+10.1f}")
    _rule()
    if obs_p99:
        print(f"  observed p99 across these folds: {obs_p99:.0f} µg/m³   "
              f"(ep = 17–19 Nov 2024 episode)")

    # ---- per-year, because pooling is what misled us the first time -------
    print(f"\n  PER YEAR — MAE (bias)")
    _rule()
    years = [y for y in args.years]
    print(f"  {'variant':<13}" + "".join(f"{f'Nov {y}':>19}" for y in years))
    _rule()
    for name in ("climatology-v1", *VARIANTS):
        cells = []
        for year in years:
            st = _stats(_pairs(conn, station, name, year))
            cells.append(f"{st['mae']:.0f} ({st['bias']:+.0f})" if st else "—")
        print(f"  {name:<13}" + "".join(f"{c:>19}" for c in cells))
    _rule()
    print("  Nov 2021 is scored against a 32-station composite; the other")
    print("  three against a single monitor. They are not interchangeable.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
