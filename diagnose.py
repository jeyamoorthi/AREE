#!/usr/bin/env python
"""
Experiment C — why does lgbm-v1 win 2021 and 2023 but lose 2024?

    python diagnose.py c0      target integrity: are the four folds comparable?
    python diagnose.py c1      2023 vs 2024 autopsy
    python diagnose.py c2      support / truncation / L1-median bias
    python diagnose.py all

WHY C0 COMES BEFORE ANY SCIENCE
    Before concluding "the atmosphere behaved differently in 2024" we have to
    rule out "the measurement behaved differently in 2024". Our target is an
    NCR composite in which 67% of hours rest on a single monitor, and OpenAQ's
    Indian feed has a gap from Nov 2022 to Feb 2025 that only the US Embassy
    monitor spans. If the target is not the same quantity across folds, then
    part of the "generalisation gap" is a data artifact, and building a physics
    correction to fix a data artifact would be the most expensive mistake
    available to us.

WHY 2023 IS THE CONTROL, NOT "EVERYTHING ELSE"
    2023 and 2024 were both severe Novembers. The model won 2023 at every
    horizon and lost 2024 at every horizon. So "extreme conditions break the
    model" is already falsified as a complete explanation. A paired comparison
    of those two years isolates what actually differs; a lineup of one year
    against three does not.

ONE DISCIPLINE THAT IS NOT NEGOTIABLE
    Atmospheric REGIMES are defined from meteorology only - ventilation
    coefficient, wind, boundary layer. Never from PM2.5. Binning by the target
    and then measuring error against the target is circular, and it is the
    first thing a reviewer will catch.

    Error is also reported against PM2.5 LEVEL, which is a different question
    (does the model break down at high concentrations?) and is NOT called a
    regime. That analysis is mechanically biased - absolute error grows with
    magnitude for any model - so it is always shown alongside climatology's
    error in the same bins. The comparison is meaningful; the level alone is
    not.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import fmean, median

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

YEARS = (2021, 2022, 2023, 2024)
GRID = model_lgbm.DEFAULT_GRID


def _rule(width: int = 78) -> None:
    print("  " + "─" * width)


def _pct(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    idx = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[idx]


# ---------------------------------------------------------------- C0 --------

def cmd_c0(conn) -> int:
    """Are the four folds measuring the same thing?"""
    station = baselines.default_station(conn)
    print("\nC0 — TARGET INTEGRITY")
    _rule()
    print(f"  station    {station}")
    print("  question   are Nov 2021-2024 comparable measurements?\n")

    rows = conn.execute(
        "SELECT timestamp, pm25, n_stations, source FROM station_readings "
        "WHERE station_id = ? AND pm25 IS NOT NULL", (station,)).fetchall()

    by_nov: dict[int, list] = defaultdict(list)
    by_month: dict[tuple[int, int], list] = defaultdict(list)
    for r in rows:
        ts = datetime.strptime(r["timestamp"], "%Y-%m-%dT%H:00:00Z")
        by_month[(ts.year, ts.month)].append((r["pm25"], r["n_stations"]))
        if ts.month == 11:
            by_nov[ts.year].append((r["pm25"], r["n_stations"]))

    print(f"  {'Nov':>5}{'hours':>8}{'cover':>8}{'n_st med':>10}{'n_st max':>10}"
          f"{'%single':>9}{'PM med':>9}{'PM p95':>9}{'PM max':>9}")
    _rule()
    for year in YEARS:
        data = by_nov.get(year, [])
        if not data:
            print(f"  {year:>5}{'—':>8}")
            continue
        pm = [p for p, _ in data]
        ns = [n for _, n in data if n is not None]
        single = sum(1 for n in ns if n <= 1) / max(len(ns), 1)
        print(f"  {year:>5}{len(data):>8}{len(data) / 720:>7.0%}"
              f"{median(ns) if ns else float('nan'):>10.0f}"
              f"{max(ns) if ns else 0:>10.0f}{single:>9.0%}"
              f"{median(pm):>9.0f}{_pct(pm, 0.95):>9.0f}{max(pm):>9.0f}")
    _rule()

    # The monitor count over the whole record is where a source switch shows up.
    print("\n  monitor count by season (median n_stations, Oct-Feb):")
    _rule()
    seasons: dict[str, list] = defaultdict(list)
    for (year, month), data in by_month.items():
        if month not in (10, 11, 12, 1, 2):
            continue
        label = f"{year}-{year + 1}" if month >= 10 else f"{year - 1}-{year}"
        seasons[label].extend(n for _, n in data if n is not None)
    for label in sorted(seasons):
        ns = seasons[label]
        if not ns:
            continue
        single = sum(1 for n in ns if n <= 1) / len(ns)
        bar = "█" * min(40, int(median(ns)))
        print(f"    {label:<10}{len(ns):>7} h  median {median(ns):>4.0f}  "
              f"single {single:>4.0%}  {bar}")
    _rule()

    meds = {y: median([n for _, n in by_nov[y] if n is not None])
            for y in YEARS if by_nov.get(y)}
    if meds and max(meds.values()) / max(min(meds.values()), 1) >= 3:
        print("\n  ⚠ VERDICT: the folds are NOT the same measurement.")
        print("    Median monitor count differs by more than 3x between")
        print("    Novembers. Part of any 'generalisation gap' is a change in")
        print("    ground truth, not in the atmosphere. Interpret C1 with this")
        print("    in mind, and treat cross-year MAE comparisons as suspect.")
    else:
        print("\n  VERDICT: monitor counts are broadly comparable across folds.")
    print()
    return 0


# ---------------------------------------------------------------- C1 --------

def _pairs(conn, station: str, model: str, year: int) -> list[dict]:
    """Raw (valid, lead, forecast, actual) rows for one model and November."""
    observations = baselines.load_observations(conn, station)
    lo = f"{year}-11-01T00:00:00Z"
    hi = f"{year}-11-30T23:00:00Z"
    rows = conn.execute(
        "SELECT issued_at, valid_at, forecast_value FROM forecasts "
        "WHERE station_id = ? AND species = ? AND model_version = ? "
        "AND valid_at >= ? AND valid_at <= ?",
        (station, baselines.SPECIES, model, lo, hi)).fetchall()

    out = []
    for r in rows:
        valid = datetime.strptime(r["valid_at"], "%Y-%m-%dT%H:00:00Z").replace(
            tzinfo=timezone.utc)
        actual = observations.get(valid)
        if actual is None:
            continue
        issued = datetime.strptime(r["issued_at"], "%Y-%m-%dT%H:00:00Z").replace(
            tzinfo=timezone.utc)
        out.append({
            "valid": valid,
            "lead": int((valid - issued).total_seconds() // 3600),
            "pred": r["forecast_value"],
            "actual": actual,
            "err": r["forecast_value"] - actual,
        })
    return out


def _met_by_hour(conn, grid: str) -> dict[datetime, dict]:
    return model_lgbm.load_met(conn, grid)


def cmd_c1(conn) -> int:
    """2023 (model wins) vs 2024 (model loses), paired."""
    station = baselines.default_station(conn)
    print("\nC1 — 2023 vs 2024 AUTOPSY")
    _rule()
    print("  2023: lgbm-v1 beat climatology at every horizon")
    print("  2024: lgbm-v1 lost to climatology at every horizon")
    print("  both were severe Novembers, so 'extreme breaks it' is already")
    print("  falsified as a complete explanation. What else differs?\n")

    met = _met_by_hour(conn, GRID)

    # --- 1. target distribution -------------------------------------------
    print("  1. TARGET DISTRIBUTION (observed PM2.5, µg/m³)")
    _rule()
    print(f"  {'Nov':>5}{'n':>7}{'p10':>8}{'p50':>8}{'p90':>8}{'p95':>8}"
          f"{'p99':>8}{'max':>8}")
    observations = baselines.load_observations(conn, station)
    for year in (2023, 2024):
        pm = [v for t, v in observations.items()
              if t.year == year and t.month == 11]
        if not pm:
            continue
        print(f"  {year:>5}{len(pm):>7}{_pct(pm, .10):>8.0f}{_pct(pm, .50):>8.0f}"
              f"{_pct(pm, .90):>8.0f}{_pct(pm, .95):>8.0f}"
              f"{_pct(pm, .99):>8.0f}{max(pm):>8.0f}")
    _rule()

    # --- 2. meteorological regime, PM never used --------------------------
    print("\n  2. METEOROLOGICAL REGIME (ventilation coefficient, m²/s)")
    print("     defined from meteorology ONLY — never from PM2.5")
    _rule()
    print(f"  {'Nov':>5}{'n':>7}{'p10':>9}{'p50':>9}{'p90':>9}"
          f"{'%<466':>8}{'wind p50':>10}{'PBLH p50':>10}")
    for year in (2023, 2024):
        vcs, winds, blhs = [], [], []
        for t, m in met.items():
            if t.year != year or t.month != 11:
                continue
            if m.get("ventilation_coefficient") is not None:
                vcs.append(m["ventilation_coefficient"])
                winds.append(m["wind_speed_10m"])
                blhs.append(m["boundary_layer_height"])
        if not vcs:
            continue
        below = sum(1 for v in vcs if v <= 466) / len(vcs)
        print(f"  {year:>5}{len(vcs):>7}{_pct(vcs, .10):>9.0f}"
              f"{_pct(vcs, .50):>9.0f}{_pct(vcs, .90):>9.0f}"
              f"{below:>8.0%}{_pct(winds, .50):>10.2f}{_pct(blhs, .50):>10.0f}")
    _rule()

    # --- 3. bias, the decisive number -------------------------------------
    print("\n  3. MODEL BIAS  (mean signed error; negative = under-forecast)")
    _rule()
    print(f"  {'Nov':>5}{'model':>16}{'MAE':>8}{'bias':>9}{'|bias|/MAE':>12}")
    for year in (2023, 2024):
        for model in ("lgbm-v1", "climatology-v1"):
            rows = _pairs(conn, station, model, year)
            if not rows:
                continue
            mae = fmean(abs(r["err"]) for r in rows)
            bias = fmean(r["err"] for r in rows)
            print(f"  {year:>5}{model:>16}{mae:>8.1f}{bias:>+9.1f}"
                  f"{abs(bias) / mae:>12.0%}")
    _rule()

    # --- 4. error vs concentration ----------------------------------------
    print("\n  4. ERROR vs OBSERVED LEVEL — lgbm-v1 against climatology")
    print("     absolute error grows with magnitude for ANY model, so the")
    print("     comparison against climatology in the same bin is the signal")
    _rule()
    bins = [(0, 100), (100, 200), (200, 300), (300, 400), (400, 10_000)]
    for year in (2023, 2024):
        lg = _pairs(conn, station, "lgbm-v1", year)
        cl = _pairs(conn, station, "climatology-v1", year)
        print(f"\n    Nov {year}")
        print(f"    {'PM2.5 bin':>14}{'n':>7}{'LGBM MAE':>11}{'LGBM bias':>11}"
              f"{'clim MAE':>11}{'winner':>10}")
        for lo, hi in bins:
            l = [r for r in lg if lo <= r["actual"] < hi]
            c = [r for r in cl if lo <= r["actual"] < hi]
            if not l or not c:
                continue
            lmae = fmean(abs(r["err"]) for r in l)
            lbias = fmean(r["err"] for r in l)
            cmae = fmean(abs(r["err"]) for r in c)
            label = f"{lo}-{hi if hi < 10_000 else '+'}"
            print(f"    {label:>14}{len(l):>7}{lmae:>11.1f}{lbias:>+11.1f}"
                  f"{cmae:>11.1f}{('LGBM' if lmae < cmae else 'clim'):>10}")
    _rule()

    # --- 5. is the error a few bad days? ----------------------------------
    print("\n  5. ERROR CONCENTRATION — is 2024 broken, or are a few days?")
    _rule()
    for year in (2023, 2024):
        rows = _pairs(conn, station, "lgbm-v1", year)
        if not rows:
            continue
        by_day: dict[str, list] = defaultdict(list)
        for r in rows:
            by_day[r["valid"].strftime("%Y-%m-%d")].append(abs(r["err"]))
        totals = sorted(((fmean(v) * len(v), d, len(v))
                         for d, v in by_day.items()), reverse=True)
        grand = sum(t for t, _, _ in totals)
        top3 = sum(t for t, _, _ in totals[:3]) / grand
        top5 = sum(t for t, _, _ in totals[:5]) / grand
        print(f"    Nov {year}: {len(by_day)} days, worst 3 = {top3:.0%} of "
              f"total error, worst 5 = {top5:.0%}")
        for total, day, n in totals[:3]:
            print(f"      {day}  mean |err| {total / n:>6.1f}  ({n} forecasts)")
    _rule()
    print()
    return 0


# ---------------------------------------------------------------- C2 --------

def cmd_c2(conn) -> int:
    """Our own modelling choices as suspects: tree ceiling and L1 median."""
    station = baselines.default_station(conn)
    observations = baselines.load_observations(conn, station)

    print("\nC2 — SUPPORT, TRUNCATION AND THE L1 MEDIAN")
    _rule()
    print("  Two mechanisms that would under-forecast a severe month without")
    print("  any atmospheric explanation at all:")
    print("    (a) a gradient-boosted tree cannot predict outside the range of")
    print("        its training leaves — it structurally cannot reach a new high")
    print("    (b) an L1 objective predicts the conditional MEDIAN, which")
    print("        lowballs a right-skewed distribution by construction\n")

    for year in (2023, 2024):
        train_max = max((v for t, v in observations.items()
                         if t < datetime(year, 11, 1, tzinfo=timezone.utc)),
                        default=float("nan"))
        rows = _pairs(conn, station, "lgbm-v1", year)
        if not rows:
            continue
        preds = [r["pred"] for r in rows]
        actuals = [r["actual"] for r in rows]
        over = sum(1 for a in actuals if a > max(preds))
        print(f"  Nov {year}")
        print(f"    training max observed      {train_max:>8.0f}")
        print(f"    test max observed          {max(actuals):>8.0f}")
        print(f"    model max prediction       {max(preds):>8.0f}   "
              f"<- the ceiling it actually used")
        print(f"    test hours above ceiling   {over:>8}  "
              f"({over / len(actuals):.0%} of forecasts unreachable)")
        print(f"    p99 observed / p99 predicted "
              f"{_pct(actuals, .99):>6.0f} / {_pct(preds, .99):<6.0f}")
        print()
    _rule()
    print("  If the model's ceiling sits well below the observed peaks, the")
    print("  2024 failure is partly extrapolation, not physics — and the first")
    print("  treatments are a log or quantile target, not a coupling layer.")
    print()
    return 0


COMMANDS = {"c0": cmd_c0, "c1": cmd_c1, "c2": cmd_c2}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Experiment C — regime diagnosis")
    p.add_argument("command", choices=[*COMMANDS, "all"])
    args = p.parse_args(argv)

    conn = db.connect()
    if args.command == "all":
        for fn in COMMANDS.values():
            fn(conn)
        return 0
    return COMMANDS[args.command](conn)


if __name__ == "__main__":
    raise SystemExit(main())
