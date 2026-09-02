#!/usr/bin/env python
"""
Read-only audit: does real multi-station hourly PM2.5 exist for our winters?

    python audit_history.py
    python audit_history.py --years 2022 2023 2024

THE ONE QUESTION
    The OpenAQ probe reports 138 NCR locations, 199 PM2.5 sensors and location
    date spans reaching back to 2016. That is a LEAD, not evidence. A
    location's datetimeFirst/datetimeLast covers every sensor ever sited there,
    including long-retired ones, so a 2016-2026 span says nothing whatever
    about whether hourly data exists in the middle.

    So this asks the only question that settles it:

        For the PM2.5 sensors reporting today, does each sensor's OWN span
        cover November 2022, 2023 and 2024 - and do actual hourly rows come
        back when asked?

    Metadata about a location is not accepted as an answer.

WHY IT MATTERS
    Three of four evaluation folds rest on a single monitor (C0). The plan is
    to fix that by capturing the live network and waiting for winter, which is
    a months-long wait. If real multi-station history existed for those
    Novembers, the wait would collapse: the NCR target could be rebuilt
    retroactively and the frozen protocol re-run against a proper airshed
    target now.

THE TRAP THAT MADE THE FIRST VERSION OF THIS AUDIT WRONG
    The first run picked stations by location metadata and reported a uniform
    0/720 across every station and year - which looks exactly like a broken
    query. It was not broken. The stations picked were retired: one had a last
    reading in 2018. Checking a live station then STILL returned 0 for
    November 2024, and the reason was decisive - that location's CURRENT pm25
    sensor has datetimeFirst 2025-02-18. It did not exist during the fold.

    Hence this audit works from SENSOR dates and verifies them against real
    returned rows. Sanity check that the query itself works: the same sensor
    returns 167 rows for the last 14 days and 1000 for the last 60.

WHAT THIS DOES NOT DO
    It writes nothing, trains nothing, and changes no threshold, feature or
    target definition. It is an availability audit and nothing else.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env")

_TMP = _PROJECT_ROOT / ".tmp"
_TMP.mkdir(exist_ok=True)
tempfile.tempdir = str(_TMP)
os.environ["TMP"] = os.environ["TEMP"] = os.environ["TMPDIR"] = str(_TMP)

from backend.backfill import openaq_history as aq  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

HOURS_IN_NOV = 720
ACTIVE_WITHIN_DAYS = 30

# A multi-station target needs a network, not a handful. Below this many
# sensors a "rebuild" would reproduce the single-monitor problem C0 found.
ENOUGH_SENSORS = 15


def _rule(width: int = 84) -> None:
    print("  " + "-" * width)


def sensor_dates(sensor_id: int) -> tuple:
    """
    The SENSOR's own first/last dates - the only ones that mean anything.

    A location's dates span every sensor ever sited there, so an
    active-looking location can carry a pm25 sensor installed last year.
    Reading location dates and concluding "history exists" is precisely the
    trap this audit exists to avoid.
    """
    payload = aq._get(f"/sensors/{sensor_id}")
    results = payload.get("results") or [{}]
    first = (results[0].get("datetimeFirst") or {}).get("utc")
    last = (results[0].get("datetimeLast") or {}).get("utc")

    def parse(value):
        if not value:
            return None
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))

    return parse(first), parse(last)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="OpenAQ historical availability audit")
    parser.add_argument("--years", type=int, nargs="*",
                        default=[2022, 2023, 2024])
    parser.add_argument("--verify", type=int, default=4,
                        help="sensors per year to verify with real hour counts")
    args = parser.parse_args(argv)

    print("")
    print("HISTORICAL AVAILABILITY AUDIT - sensor-level, not location metadata")
    _rule()
    print("  question  does real multi-station hourly PM2.5 exist for the")
    print("            Novembers we score?")
    print("  method    each PM2.5 sensor's OWN datetimeFirst/datetimeLast,")
    print("            then verified against actual returned hours")
    print("  writes    nothing")
    print("")

    try:
        stations = aq.discover_stations()
    except aq.AuthFailed as exc:
        print(f"  {exc}", file=sys.stderr)
        return 2

    now = datetime.now(timezone.utc)
    active = [st for st in stations
              if st.get("last") and (now - st["last"]).days <= ACTIVE_WITHIN_DAYS
              and any(x["parameter"] == "pm25" for x in st["sensors"])]
    print(f"  {len(active)} PM2.5 sensors at locations active in the last "
          f"{ACTIVE_WITHIN_DAYS} days")

    mids = {year: datetime(year, 11, 15, tzinfo=timezone.utc)
            for year in args.years}
    covering: dict[int, list] = {year: [] for year in args.years}
    starts, failed = [], 0

    for st in active:
        sensor_id = next(x for x in st["sensors"]
                         if x["parameter"] == "pm25")["sensor_id"]
        first, last = sensor_dates(sensor_id)
        if first is None:
            failed += 1
            continue
        starts.append(first)
        for year, mid in mids.items():
            if last and first <= mid <= last:
                covering[year].append((st["station"], sensor_id))

    if failed:
        print(f"  ({failed} sensors returned an API error and were skipped)")

    print("")
    print(f"  {'November':<12}{'sensors whose own span covers it':>36}")
    _rule()
    for year in args.years:
        count = len(covering[year])
        print(f"  {year:<12}{f'{count} / {len(active)}':>36}   " + "#" * count)
    _rule()

    print("")
    print("  when the PM2.5 sensors reporting today actually began:")
    buckets: dict[str, int] = defaultdict(int)
    for first in starts:
        buckets[first.strftime("%Y")] += 1
    for year in sorted(buckets):
        print(f"    {year}: {buckets[year]:>3} sensors  "
              + "#" * min(50, buckets[year]))

    print("")
    print("  verification - actual returned hours for sensors claiming coverage:")
    _rule()
    checked = 0
    for year in args.years:
        for name, sensor_id in covering[year][:args.verify]:
            lo = datetime(year, 11, 1, tzinfo=timezone.utc)
            hi = datetime(year, 11, 30, 23, tzinfo=timezone.utc)
            rows = aq._sensor_hours(sensor_id, lo, hi)
            print(f"    Nov {year}  {name[:42]:<44}{len(rows):>5}/{HOURS_IN_NOV}")
            checked += 1
    if not checked:
        print("    nothing to verify - no sensor claims coverage of any"
              " audited November.")
    _rule()

    worst = min(len(covering[y]) for y in args.years)
    best = max(len(covering[y]) for y in args.years)
    print("")
    if best >= ENOUGH_SENSORS:
        print("  VERDICT: enough multi-station history exists to rebuild the")
        print("  NCR target retroactively. The months-long wait is avoidable.")
    else:
        print("  VERDICT: THE GAP IS REAL, and the reason is sharper than")
        print("  'OpenAQ has a gap'. The sensors reporting today did not exist")
        print("  during our evaluation winters - the Indian feed was")
        print("  re-established with NEW sensor ids, so there is no retroactive")
        print(f"  multi-station target to rebuild. Only {worst}-{best} sensors")
        print("  span the audited Novembers, which is the single-monitor")
        print("  situation C0 already found.")
        print("")
        print("  Keep the capture running. Waiting for winter remains the only")
        print("  path to a proper multi-station target.")
    print("")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
