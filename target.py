#!/usr/bin/env python
"""
The multi-station NCR target — construction and quality, before any modelling.

    python target.py build      derive ncr_target from captured station rows
    python target.py report     target quality over time
    python target.py spread     how wrong is ONE monitor as a proxy for NCR?

WHY THE TARGET IS BUILT BEFORE ANYTHING IS RETRAINED
    C0 established that three of four evaluation folds rest on a single
    monitor. The fix is not a better model, it is a better target. But
    "79 stations" is not automatically a better target either - it is better
    only if the stations are numerous, spatially spread, and consistently
    reporting. So this module measures the target before anyone trains on it.
    Retraining first and reporting a lower MAE would tell us nothing about
    which of the two changes produced it.

WHAT IS KEPT SEPARATE, AND WHY THAT MATTERS
    The legacy single-monitor series stays exactly where it is, untouched, in
    station_readings. It is the frozen historical benchmark that every result
    so far was measured against. The new multi-station target lives in its own
    table, derived from station rows that are themselves retained. Three
    layers, never blurred:

        station_readings   what each instrument measured        (measured)
        ncr_target         the airshed estimate derived from it (computed)
        legacy series      the historical single-monitor record (frozen)

    A composite can always be rebuilt from stations. Stations can never be
    recovered from a composite. That asymmetry is why capture.py stores the
    network and this module derives the aggregate, rather than the reverse.

SPATIAL COVERAGE IS PART OF THE TARGET, NOT A FOOTNOTE
    Forty stations clustered in central Delhi describe the airshed worse than
    fifteen spread across it. So every hour records how many cells of a coarse
    grid over the NCR box actually contain a reporting station. An hour with a
    high station count and poor spatial coverage is flagged rather than
    trusted.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean, median

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env")

_TMP = _PROJECT_ROOT / ".tmp"
_TMP.mkdir(exist_ok=True)
tempfile.tempdir = str(_TMP)
os.environ["TMP"] = os.environ["TEMP"] = os.environ["TMPDIR"] = str(_TMP)

from backend.backfill import db  # noqa: E402
from backend.ingestion import ncr_observations as obs  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Coarse grid over the NCR box for the coverage measure. 4x4 = 16 cells across
# roughly 1.4 deg x 1.4 deg, so each cell is ~35 km - about the scale over
# which an urban PM2.5 field is meaningfully correlated.
GRID_N = 4

# An hour qualifies as a modelling target only if it clears both. Station count
# alone is not enough; see the docstring.
MIN_VALID_STATIONS = 20
MIN_COVERAGE_CELLS = 6

# CPCB PM2.5 breakpoints, used to ask whether a single monitor would have
# reported a different SEVERITY BAND than the network - which is the form the
# error actually takes when it reaches a decision.
CPCB_BANDS = [
    (0, 30, "Good"), (30, 60, "Satisfactory"), (60, 90, "Moderate"),
    (90, 120, "Poor"), (120, 250, "Very Poor"), (250, 10_000, "Severe"),
]


def _rule(width: int = 82) -> None:
    print("  " + "─" * width)


def band(value: float) -> str:
    for lo, hi, name in CPCB_BANDS:
        if lo <= value < hi:
            return name
    return "Severe"


def _pct(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


def _cell(lat: float, lon: float) -> tuple[int, int] | None:
    minx, miny, maxx, maxy = obs.NCR_BBOX
    if not (minx <= lon <= maxx and miny <= lat <= maxy):
        return None
    return (min(GRID_N - 1, int((lon - minx) / (maxx - minx) * GRID_N)),
            min(GRID_N - 1, int((lat - miny) / (maxy - miny) * GRID_N)))


def captured_hours(conn) -> dict[str, list[dict]]:
    """Station rows from the live capture, grouped by hour."""
    rows = conn.execute(
        "SELECT timestamp, station_id, pm25, latitude, longitude, source "
        "FROM station_readings WHERE source LIKE 'live:%'").fetchall()
    by_hour: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_hour[r["timestamp"]].append(dict(r))
    return by_hour


def cmd_build(conn, args) -> int:
    by_hour = captured_hours(conn)
    print("\nBuilding the multi-station NCR target")
    _rule()
    if not by_hour:
        print("  no captured station rows yet — run `python capture.py once`")
        print("  or leave `python capture.py loop` running.\n")
        return 1

    out = []
    for hour, rows in by_hour.items():
        values = [r["pm25"] for r in rows if r["pm25"] is not None]
        cells = {c for c in (_cell(r["latitude"], r["longitude"])
                             for r in rows
                             if r["latitude"] is not None) if c}
        if not values:
            continue
        usable = (len(values) >= MIN_VALID_STATIONS
                  and len(cells) >= MIN_COVERAGE_CELLS)
        out.append({
            "timestamp": hour,
            "n_reporting": len(rows),
            "n_valid": len(values),
            "coverage_cells": len(cells),
            "coverage_fraction": len(cells) / (GRID_N * GRID_N),
            "pm25_mean": round(fmean(values), 2),
            # The median is the headline: an airshed estimate should not be
            # moved by one instrument sitting beside a construction site.
            "pm25_median": round(median(values), 2),
            "pm25_p90": round(_pct(values, 0.90), 2),
            "pm25_p95": round(_pct(values, 0.95), 2),
            "pm25_min": round(min(values), 2),
            "pm25_max": round(max(values), 2),
            "pm25_iqr": round(_pct(values, 0.75) - _pct(values, 0.25), 2),
            "usable": int(usable),
            "source": rows[0]["source"],
        })

    n = db.upsert(conn, "ncr_target", ("timestamp",), out)
    usable = sum(r["usable"] for r in out)
    print(f"  {n} hours written to ncr_target")
    print(f"  {usable} of {n} meet the target criteria "
          f"(>= {MIN_VALID_STATIONS} valid stations and "
          f">= {MIN_COVERAGE_CELLS}/{GRID_N * GRID_N} grid cells)\n")
    return 0


def cmd_report(conn, args) -> int:
    rows = conn.execute("SELECT * FROM ncr_target ORDER BY timestamp").fetchall()
    print("\nMulti-station NCR target — quality")
    _rule()
    if not rows:
        print("  empty — run `python target.py build`.\n")
        return 1

    print(f"  {'hour (UTC)':<16}{'valid':>7}{'cells':>7}{'median':>9}"
          f"{'IQR':>8}{'min':>7}{'max':>7}{'usable':>8}")
    for r in rows[-24:]:
        print(f"  {r['timestamp'][:13]:<16}{r['n_valid']:>7}"
              f"{r['coverage_cells']:>4}/{GRID_N * GRID_N:<2}"
              f"{r['pm25_median']:>9.0f}{r['pm25_iqr']:>8.0f}"
              f"{r['pm25_min']:>7.0f}{r['pm25_max']:>7.0f}"
              f"{('yes' if r['usable'] else 'NO'):>8}")
    _rule()

    valid = [r["n_valid"] for r in rows]
    print(f"  hours captured        {len(rows)}")
    print(f"  stations per hour     median {median(valid):.0f}, "
          f"min {min(valid)}, max {max(valid)}")
    print(f"  usable hours          {sum(r['usable'] for r in rows)}")
    print("\n  For contrast, the historical folds this replaces: median ONE")
    print("  monitor per hour across Nov 2022, 2023 and 2024 (see C0).\n")
    return 0


def cmd_spread(conn, args) -> int:
    """
    How wrong is a single monitor as a proxy for the airshed?

    This is the question C0 raised and could not answer: the historical target
    IS one monitor, so its error against the network was unmeasurable. The
    live capture makes it measurable now, and the answer applies retroactively
    as a bound on how much the historical folds can be trusted.

    For every captured hour, each station is treated as if it were the sole
    monitor and compared with the network median.
    """
    by_hour = captured_hours(conn)
    print("\nSingle-monitor proxy error — what the legacy target cost us")
    _rule()
    if not by_hour:
        print("  no captured hours yet.\n")
        return 1

    deviations, rel, band_mismatch, per_station = [], [], 0, defaultdict(list)
    total = 0
    for hour, rows in by_hour.items():
        values = [r["pm25"] for r in rows if r["pm25"] is not None]
        if len(values) < 5:
            continue
        network = median(values)
        net_band = band(network)
        for r in rows:
            if r["pm25"] is None:
                continue
            total += 1
            dev = r["pm25"] - network
            deviations.append(abs(dev))
            if network > 0:
                rel.append(abs(dev) / network)
            if band(r["pm25"]) != net_band:
                band_mismatch += 1
            per_station[r["station_id"]].append(dev)

    if not deviations:
        print("  not enough stations per hour yet to measure spread.\n")
        return 1

    print(f"  hours analysed              {len(by_hour)}")
    print(f"  station-hours               {total}")
    print(f"  median |station − network|  {median(deviations):.1f} µg/m³")
    print(f"  p90 |station − network|     {_pct(deviations, 0.90):.1f} µg/m³")
    print(f"  max |station − network|     {max(deviations):.1f} µg/m³")
    print(f"  median relative error       {median(rel):.0%}")
    print(f"  CPCB band disagreement      {band_mismatch / total:.0%} "
          f"of station-hours")
    _rule()
    print("  Read this as the uncertainty the single-monitor historical target")
    print("  carried and nobody could see. A model scored against one station")
    print("  was scored against a value that differs from the airshed by the")
    print("  amounts above — which is a floor on the MAE any model could have")
    print("  achieved, no matter how good the physics.")

    months = {h[5:7] for h in by_hour}
    if not months & {"10", "11", "12", "01", "02"}:
        print("\n  ⚠ SEASONAL CAVEAT — READ BEFORE QUOTING ANY OF THE ABOVE")
        print(f"    Captured months so far: {', '.join(sorted(months))}. The")
        print("    historical folds are NOVEMBER, and this is not November.")
        print("    Two reasons today's figure does not yet transfer:")
        print("      * concentrations are far lower now, and the CPCB bands are")
        print("        narrow at the clean end (0-30-60-90) and wide at the")
        print("        dirty end (250+), so band disagreement is mechanically")
        print("        easier to trigger today than during an episode;")
        print("      * winter spatial structure differs - a shallow inversion")
        print("        concentrates pollution locally in ways September does not.")
        print("    This number bounds the legacy target only once the capture")
        print("    has run through a winter. Until then it is machinery, not")
        print("    evidence.")

    if len(by_hour) >= 6:
        worst = sorted(per_station.items(),
                       key=lambda kv: -abs(fmean(kv[1])))[:5]
        print("\n  most biased individual monitors (mean signed deviation):")
        for name, devs in worst:
            print(f"    {name[:46]:<48}{fmean(devs):>+8.1f} µg/m³")
    else:
        print("\n  (per-station bias needs more hours; it will fill in as the")
        print("   capture loop runs)")
    print()
    return 0


COMMANDS = {"build": cmd_build, "report": cmd_report, "spread": cmd_spread}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Multi-station NCR target")
    p.add_argument("command", choices=sorted(COMMANDS))
    args = p.parse_args(argv)
    return COMMANDS[args.command](db.connect(), args)


if __name__ == "__main__":
    raise SystemExit(main())
