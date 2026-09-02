#!/usr/bin/env python
"""
AREE historical backfill - Milestone 1.

    python backfill.py probe          what data actually exists. DO THIS FIRST.
    python backfill.py met            ERA5 meteorology  -> met_hourly
    python backfill.py met-recent     last ~92 d, incl. pressure levels
    python backfill.py aq             ground PM2.5 etc. -> station_readings
    python backfill.py import-research historical NCR PM2.5 already on disk
    python backfill.py fires          satellite fires   -> fire_events
    python backfill.py derive         computed columns  -> derived_features
    python backfill.py all            met, aq, fires, derive
    python backfill.py baseline       persistence + climatology -> forecasts
    python backfill.py score          score every stored forecast
    python backfill.py show           print the joined dataset

Common options:
    --start 2019-10-01 --end 2025-02-28      range (default: six winters)
    --all-months                             ignore the Oct-Feb season filter
    --limit-stations N                       cap the AQ pull while testing

WHY probe COMES FIRST AND IS NOT OPTIONAL
    We already know OpenAQ's Indian feed has a gap from Nov 2022 to Feb 2025.
    A backfill that runs to completion and produces a thin dataset is worse
    than one that refuses, because the thinness resurfaces months later as a
    model that "just doesn't work". probe answers how many stations, which
    providers, which pollutants and what span - and then a human decides
    whether OpenAQ can carry this or whether we go to CPCB directly.

WHAT SUCCESS LOOKS LIKE
    `python backfill.py show` prints one row per hour with pollution,
    meteorology, ventilation and fire influence side by side. That table is the
    milestone. Until it exists there is no forecasting model to build.
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

# Keep every byte this tool writes on D:.
#
# The venv, the store and the pip cache already live beside this file, but
# tempfile still defaults to %LOCALAPPDATA%\Temp on C:, and a library that
# spools to disk - pyarrow reading a parquet, requests buffering a large CSV -
# would land there without anyone noticing. Redirecting the process default is
# a guarantee rather than an assumption, and it is set before the ingestion
# modules are imported so nothing can capture the old value first.
_TMP = _PROJECT_ROOT / ".tmp"
_TMP.mkdir(exist_ok=True)
tempfile.tempdir = str(_TMP)
os.environ["TMP"] = os.environ["TEMP"] = os.environ["TMPDIR"] = str(_TMP)

from backend.backfill import db, features, fire_history, met_history  # noqa: E402
from backend.backfill import openaq_history as aq                     # noqa: E402
from backend.backfill import research_import                           # noqa: E402
from backend.backfill import baselines                                 # noqa: E402

log = logging.getLogger("aree.backfill")

# A Windows console defaults to cp1252, which cannot encode the box-drawing and
# em-dash characters in this report and raises UnicodeEncodeError mid-print -
# after the network work is done and before anything is shown. Reconfiguring is
# cheaper than restricting the output to ASCII, and errors="replace" means a
# terminal that still cannot cope degrades a glyph instead of the whole run.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):                    # noqa: PERF203
        pass

# Six winters. October to February is the regime this problem statement is
# about; the rest of the year contains no episode worth training on and would
# be most of the request budget.
DEFAULT_START = "2019-10-01"
DEFAULT_END = "2025-02-28"
SEASON_MONTHS = {10, 11, 12, 1, 2}


def _dt(raw: str) -> datetime:
    return datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def _rule(char: str = "─", width: int = 78) -> None:
    print(char * width)


# --- commands --------------------------------------------------------------

def cmd_probe(args) -> int:
    """Report coverage. Writes nothing."""
    print("\nOpenAQ coverage probe — Delhi NCR")
    _rule()
    report = aq.probe()

    print(f"  domain                {report['domain']}  bbox={report['bbox']}")
    print(f"  locations in box      {report['n_stations']}")
    print(f"  with a PM2.5 sensor   {report['n_pm25_stations']}")
    print(f"  reporting last 7 d    {report['reporting_last_7d']}")
    print(f"  earliest reading      {report['earliest']}")
    print(f"  latest reading        {report['latest']}")

    print("\n  by provider")
    for name, n in report["by_provider"].items():
        print(f"    {name:<40} {n:>4}")

    print("\n  by pollutant (sensor count)")
    for name, n in report["by_pollutant"].items():
        print(f"    {name:<40} {n:>4}")

    print("\n  stations")
    for st in sorted(report["stations"], key=lambda s: s["station"] or "")[:40]:
        span = (f"{st['first']:%Y-%m}..{st['last']:%Y-%m}"
                if st["first"] and st["last"] else "unknown span")
        params = ",".join(sorted(s["parameter"] for s in st["sensors"]))
        print(f"    {(st['station'] or '?')[:38]:<38} {span:<18} {params}")
    if len(report["stations"]) > 40:
        print(f"    … and {len(report['stations']) - 40} more")

    _rule()
    print("READ THIS BEFORE INGESTING")
    print("  OpenAQ's Indian feed is known to have a gap from Nov 2022 to")
    print("  Feb 2025. Check the spans above against the winters you need.")
    print("  If they do not cover them, use CPCB directly as the primary")
    print("  source rather than forcing OpenAQ into the architecture.\n")
    return 0


def cmd_met(args) -> int:
    conn = db.connect()
    start, end = _dt(args.start), _dt(args.end)
    points = met_history.grid_points()
    print(f"\nERA5 meteorology  {args.start} .. {args.end}  "
          f"({len(points)} grid points)")
    _rule()

    rows = met_history.fetch_grid(start, end, points)
    coverage = met_history.pressure_coverage(rows)
    for r in rows:
        r["timestamp"] = db.iso(r["timestamp"])
    n = db.upsert(conn, "met_hourly", ("grid_id", "timestamp"), rows)
    print(f"  wrote {n} rows to met_hourly "
          f"({len(points) - len(met_history.failed)}/{len(points)} grid points)")
    print(f"  pressure-level coverage {coverage:.0%}")
    if met_history.failed:
        print(f"  INCOMPLETE {len(met_history.failed)} grid point(s) returned "
              f"nothing: {', '.join(met_history.failed)}")
        print("             re-run to fill them; the upsert makes that safe.")
    if coverage == 0.0:
        print("  NOTE the ERA5 archive serves surface fields only — it returns")
        print("       HTTP 200 with null pressure levels rather than refusing.")
        print("       inversion_strength and lapse_rate stay NULL for this")
        print("       range. `met-recent` covers the last ~92 days; the full")
        print("       period needs Copernicus CDS.")
    return 0


def cmd_met_recent(args) -> int:
    """The only Open-Meteo path that returns pressure-level temperature."""
    conn = db.connect()
    points = met_history.grid_points()
    print(f"\nRecent analysis  last {args.days} days  "
          f"({len(points)} grid points, with pressure levels)")
    _rule()

    rows = met_history.fetch_recent_grid(args.days, points)
    coverage = met_history.pressure_coverage(rows)
    for r in rows:
        r["timestamp"] = db.iso(r["timestamp"])
    n = db.upsert(conn, "met_hourly", ("grid_id", "timestamp"), rows)
    print(f"  wrote {n} rows to met_hourly")
    print(f"  pressure-level coverage {coverage:.0%}")
    return 0


def cmd_import_research(args) -> int:
    """Load the historical NCR PM2.5 composite the research pipeline built."""
    conn = db.connect()
    print("\nImport historical ground PM2.5 (research series)")
    _rule()

    rows = research_import.load()
    thin = sum(1 for r in rows if (r["n_stations"] or 0) <= 1)
    span = (min(r["timestamp"] for r in rows), max(r["timestamp"] for r in rows))
    for r in rows:
        r["timestamp"] = db.iso(r["timestamp"])
    n = db.upsert(conn, "station_readings", ("station_id", "timestamp"), rows)

    print(f"  wrote {n} hours to station_readings")
    print(f"  span  {span[0]:%Y-%m-%d} .. {span[1]:%Y-%m-%d}")
    print(f"  {thin} of {n} hours ({thin / max(n, 1):.0%}) rest on a single")
    print("  monitor — carried per row in n_stations so a model can see it.")
    return 0


def cmd_aq(args) -> int:
    conn = db.connect()
    start, end = _dt(args.start), _dt(args.end)
    months = None if args.all_months else SEASON_MONTHS

    stations = aq.discover_stations()
    if args.limit_stations:
        stations = stations[:args.limit_stations]
    print(f"\nGround observations  {args.start} .. {args.end}  "
          f"({len(stations)} stations"
          f"{'' if months is None else ', Oct-Feb only'})")
    _rule()

    rows = aq.fetch_history(stations, start, end, months)
    for r in rows:
        r["timestamp"] = db.iso(r["timestamp"])
    n = db.upsert(conn, "station_readings", ("station_id", "timestamp"), rows)
    print(f"  wrote {n} station-hours to station_readings")
    return 0


def cmd_fires(args) -> int:
    conn = db.connect()
    start, end = _dt(args.start), _dt(args.end)
    months = None if args.all_months else SEASON_MONTHS
    print(f"\nSatellite fires  {args.start} .. {args.end}  "
          f"bbox={fire_history.SOURCE_BBOX}")
    _rule()

    rows = fire_history.fetch_history(start, end, months=months)
    for r in rows:
        r["timestamp"] = db.iso(r["timestamp"])
    n = db.upsert(conn, "fire_events", ("event_id",), rows)
    print(f"  wrote {n} detections to fire_events")
    return 0


def cmd_derive(args) -> int:
    conn = db.connect()
    print("\nDerived features")
    _rule()
    rows = features.build(conn)
    n = db.upsert(conn, "derived_features", ("grid_id", "timestamp"), rows)
    print(f"  wrote {n} rows to derived_features")
    return 0


def cmd_all(args) -> int:
    for step in (cmd_met, cmd_met_recent, cmd_aq, cmd_fires, cmd_derive):
        rc = step(args)
        if rc:
            return rc
    return cmd_show(args)


def cmd_baseline(args) -> int:
    """Generate the two baselines any model has to beat."""
    conn = db.connect()
    station = args.station or baselines.default_station(conn)
    start, end = _dt(args.start), _dt(args.end)
    print(f"\nBaseline forecasts  {args.start} .. {args.end}")
    _rule()
    print(f"  station    {station}")
    print(f"  horizon    {args.horizon} h, issued every {args.every} h")

    rows = baselines.generate(conn, station, start, end,
                              horizon_hours=args.horizon,
                              issue_every_hours=args.every)
    n = db.upsert(conn, "forecasts",
                  ("issued_at", "valid_at", "station_id", "species",
                   "model_version"), rows)
    print(f"  wrote {n} forecast rows")
    print("  every row carries issued_at — a forecast used only data at or")
    print("  before that time, which is what makes scoring meaningful.")
    return 0


def cmd_score(args) -> int:
    """Score stored forecasts against what actually happened."""
    conn = db.connect()
    station = args.station or baselines.default_station(conn)
    start, end = _dt(args.start), _dt(args.end)
    print(f"\nForecast skill  valid {args.start} .. {args.end}")
    _rule()
    print(f"  station    {station}")

    results = baselines.score(conn, station, start, end)
    if not results:
        print("\n  nothing to score — run `baseline` first.\n")
        return 1

    print(f"\n  {'Model':<20}{'Lead':>10}{'N':>8}{'MAE':>9}{'RMSE':>9}{'Bias':>9}")
    _rule()
    for r in results:
        print(f"  {r['model']:<20}{r['lead']:>10}{r['n']:>8}"
              f"{r['mae']:>9.1f}{r['rmse']:>9.1f}{r['bias']:>+9.1f}")
    _rule()
    print("  MAE/RMSE/bias in ug/m3. Any model must beat BOTH baselines at a")
    print("  given lead time to have skill there. Persistence usually wins")
    print("  short leads; climatology is the long-horizon floor.\n")
    return 0


def cmd_show(args) -> int:
    """
    The milestone table: pollution, meteorology, ventilation and fire, joined.

    The AQ side is the MEDIAN across reporting stations for the hour, not one
    station. A single monitor is a monitor; the median is the airshed, and the
    airshed is what ventilation describes.
    """
    conn = db.connect()

    print("\nfeature store")
    _rule()
    for row in db.table_summary(conn):
        span = (f"{row['first'][:13]} .. {row['last'][:13]}"
                if row["first"] else "empty")
        print(f"  {row['table']:<20} {row['rows']:>9,} rows   {span}")

    grid = args.grid or "ncr_28.63_77.22"
    rows = conn.execute(
        """
        SELECT m.timestamp                AS ts,
               m.boundary_layer_height    AS pblh,
               m.wind_speed_10m           AS wind,
               d.ventilation_coefficient  AS vc,
               d.inversion_strength       AS inv,
               d.plume_influence          AS plume,
               d.sustained_low_ventilation AS low,
               (SELECT COUNT(*) FROM fire_events f
                 WHERE f.timestamp = m.timestamp)          AS fires,
               (SELECT AVG(pm25) FROM station_readings s
                 WHERE s.timestamp = m.timestamp
                   AND s.pm25 IS NOT NULL)                 AS pm25
          FROM met_hourly m
          LEFT JOIN derived_features d
                 ON d.grid_id = m.grid_id AND d.timestamp = m.timestamp
         WHERE m.grid_id = ?
           AND m.timestamp >= COALESCE(?, m.timestamp)
         ORDER BY m.timestamp
         LIMIT ?
        """, (grid, args.since or None, args.rows)).fetchall()

    if not rows:
        print(f"\n  nothing stored for grid {grid} yet — run "
              f"`python backfill.py all` first.\n")
        return 1

    print(f"\nAREE DATASET   grid {grid}")
    _rule()
    print(f"  {'Timestamp':<17}{'PM2.5':>7}{'PBLH':>7}{'Wind':>7}"
          f"{'VC':>8}{'Inv':>7}{'Plume':>8}{'Fire':>6}{'Low':>5}")
    _rule()

    def fmt(v, spec: str) -> str:
        if v is not None:
            return format(v, spec)
        # Pad the placeholder to the column's own width, or a missing value
        # shifts every column to its right and the table stops lining up.
        width = int("".join(c for c in spec.split(".")[0] if c.isdigit()) or 0)
        return "—".rjust(width)

    for r in rows:
        print(f"  {r['ts'][:16].replace('T', ' '):<17}"
              f"{fmt(r['pm25'], '>7.0f')}"
              f"{fmt(r['pblh'], '>7.0f')}"
              f"{fmt(r['wind'], '>7.1f')}"
              f"{fmt(r['vc'], '>8.0f')}"
              f"{fmt(r['inv'], '>7.1f')}"
              f"{fmt(r['plume'], '>8.1f')}"
              f"{fmt(r['fires'], '>6d')}"
              f"{'  yes' if r['low'] else '   no':>5}")
    _rule()
    print("  Low = inside a run of >= 6 consecutive hours at or below the")
    print("  calibrated ventilation threshold — the same rule the live engine")
    print(f"  applies.   store: {db.db_path()}\n")
    return 0


COMMANDS = {
    "probe": cmd_probe, "met": cmd_met, "met-recent": cmd_met_recent,
    "aq": cmd_aq, "import-research": cmd_import_research,
    "fires": cmd_fires, "derive": cmd_derive,
    "baseline": cmd_baseline, "score": cmd_score,
    "all": cmd_all, "show": cmd_show,
}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="AREE historical backfill",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Start with:  python backfill.py probe")
    p.add_argument("command", choices=sorted(COMMANDS))
    p.add_argument("--start", default=DEFAULT_START)
    p.add_argument("--end", default=DEFAULT_END)
    p.add_argument("--all-months", action="store_true",
                   help="ignore the Oct-Feb season filter")
    p.add_argument("--limit-stations", type=int, default=0,
                   help="cap the AQ station pull while testing")
    p.add_argument("--grid", default="", help="grid id for `show`")
    p.add_argument("--rows", type=int, default=24, help="rows for `show`")
    p.add_argument("--station", default="", help="station id to forecast/score")
    p.add_argument("--horizon", type=int, default=72, help="forecast horizon (h)")
    p.add_argument("--every", type=int, default=24, help="issue interval (h)")
    p.add_argument("--since", default="",
                   help="start `show` at this timestamp, e.g. 2024-11-17")
    p.add_argument("--days", type=int, default=92,
                   help="lookback for `met-recent` (max 92)")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    try:
        return COMMANDS[args.command](args)
    except RuntimeError as exc:
        print(f"\n  {exc}\n", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n  interrupted — already-written rows are kept\n",
              file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
