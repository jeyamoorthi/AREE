#!/usr/bin/env python
"""
Fit and score lgbm-v1 against the established baselines.

    python train_lgbm.py                       all four folds
    python train_lgbm.py --years 2024          one fold
    python train_lgbm.py --no-store            fit and report, write nothing

EXPERIMENT A - PERFECT PROGNOSIS
    Meteorology is ERA5 at valid time: the model is told what the weather will
    be. The score is therefore an UPPER BOUND on operational skill, not a
    forecast score. See backend/backfill/model_lgbm.py for the full statement.

WHAT THIS DELIBERATELY REPEATS FROM THE BASELINE RUN
    The same walk-forward folds, the same issue stride, the same holdout, the
    same table and the same scoring function. Every one of those is a place a
    model comparison can be quietly rigged, so none of them is re-implemented
    here - they are imported.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env")

# Keep every byte on D:. Same reasoning as backfill.py.
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

FOLDS = (2021, 2022, 2023, 2024)
LEAD_ORDER = ["1-6 h", "7-12 h", "13-24 h", "25-48 h", "49-72 h"]


def _rule(width: int = 74) -> None:
    print("  " + "─" * width)


def run_fold(conn, station: str, grid: str, year: int, store: bool) -> None:
    start = datetime(year, 11, 1, tzinfo=timezone.utc)
    end = datetime(year, 11, 27, tzinfo=timezone.utc)

    booster, stats = model_lgbm.train_fold(conn, station, grid, train_end=start)
    print(f"\n  fold {year}: trained on {stats['n_samples']:,} samples "
          f"({stats['n_features']} features) from data before {start.date()}")

    rows = model_lgbm.predict_fold(conn, booster, station, grid, start, end)
    if store and rows:
        db.upsert(conn, "forecasts",
                  ("issued_at", "valid_at", "station_id", "species",
                   "model_version"), rows)
    print(f"  fold {year}: {len(rows):,} forecasts "
          f"{'written' if store else 'computed (not written)'}")

    if year == FOLDS[-1]:
        print("\n  what the final fold leaned on (gain):")
        for name, gain in model_lgbm.importances(booster):
            print(f"    {name:<26}{gain:>14,}")


def scorecard(conn, station: str) -> None:
    """Pool every model across the folds and print the comparison."""
    from collections import defaultdict

    acc: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    for year in FOLDS:
        lo = datetime(year, 11, 1, tzinfo=timezone.utc)
        hi = datetime(year, 11, 30, tzinfo=timezone.utc)
        for r in baselines.score(conn, station, lo, hi):
            acc[r["model"]][r["lead"]].append((r["mae"], r["n"]))

    def pooled(model: str, lead: str) -> float | None:
        pairs = acc.get(model, {}).get(lead, [])
        if not pairs:
            return None
        n = sum(n for _, n in pairs)
        return sum(m * n for m, n in pairs) / n

    print(f"\n  POOLED MAE — Nov {FOLDS[0]}–{FOLDS[-1]}, PM2.5 µg/m³")
    _rule()
    print(f"  {'Horizon':>9}{'Persistence':>14}{'Climatology':>14}"
          f"{'LGBM':>10}{'Winner':>16}")
    _rule()

    for lead in LEAD_ORDER:
        p = pooled("persistence-v1", lead)
        c = pooled("climatology-v1", lead)
        g = pooled(model_lgbm.MODEL_VERSION, lead)
        if p is None or c is None:
            continue
        scores = {"persistence": p, "climatology": c}
        if g is not None:
            scores["LGBM"] = g
        winner = min(scores, key=scores.get)
        gtxt = f"{g:>10.1f}" if g is not None else f"{'—':>10}"
        print(f"  {lead:>9}{p:>14.1f}{c:>14.1f}{gtxt}{winner:>16}")

    _rule()
    print("  A model has skill only where it beats BOTH baselines.")
    print("  Perfect prognosis: meteorology is known at valid time, so these")
    print("  are an UPPER BOUND on operational skill, not a forecast score.\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Fit and score lgbm-v1")
    p.add_argument("--years", type=int, nargs="*", default=list(FOLDS))
    p.add_argument("--grid", default=model_lgbm.DEFAULT_GRID)
    p.add_argument("--station", default="")
    p.add_argument("--no-store", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    conn = db.connect()
    station = args.station or baselines.default_station(conn)
    if not station:
        print("  no PM2.5 observations in the store.", file=sys.stderr)
        return 1

    print(f"\nlgbm-v1 — walk-forward, perfect prognosis")
    _rule()
    print(f"  station    {station}")
    print(f"  grid       {args.grid}")
    print(f"  folds      {', '.join(f'Nov {y}' for y in args.years)}")

    for year in args.years:
        try:
            run_fold(conn, station, args.grid, year, store=not args.no_store)
        except RuntimeError as exc:
            print(f"  fold {year}: skipped — {exc}")

    scorecard(conn, station)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
