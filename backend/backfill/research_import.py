"""
Import the historical ground PM2.5 series the research pipeline already built.

WHY THIS EXISTS INSTEAD OF PULLING OPENAQ AGAIN
    openaq_history.py is the general path and is the right one to use when the
    key works. Today it does not - the key in .env is rejected with 401 Invalid
    credentials - and even with a working key, re-pulling five winters station
    by station would take hours of rate-limited requests to reproduce a series
    that is already on disk at
    research/ps26082/data/interim/ground_pm25_hourly.parquet.

    So this module imports that file. It is not a shortcut around the data
    layer; it IS the data layer for the historical AQ half, and it is what makes
    Milestone 1 reachable before anyone fixes a credential.

WHAT THIS SERIES IS, PRECISELY
    An hourly NCR-wide COMPOSITE, not a station. 29,953 hours spanning
    2020-10-01 to 2025-03-30, each an average across whatever monitors were
    reporting that hour. It is stored under a station_id that says so, and the
    monitor count is carried per row in n_stations.

WHY n_stations MATTERS MORE THAN IT LOOKS
    Measured on this file: 20,007 of the 29,953 hours rest on a SINGLE monitor.
    That is the thin-coverage caveat behind the 466 m2/s operating point, and
    it is a property of individual hours rather than of the dataset as a whole.
    Carrying it per row lets a model - or a person reading a backtest - weight
    or exclude the hours that are effectively one instrument, instead of
    treating a 24-station hour and a 1-station hour as equally observed.
"""

from __future__ import annotations

import logging
from datetime import timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("aree.backfill.research")

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_PARQUET = (_REPO_ROOT / "research" / "ps26082" / "data" / "interim"
                   / "ground_pm25_hourly.parquet")

# The series is a composite. The id says that in words, because it will appear
# in a backtest report next to real CPCB station names and the difference must
# be obvious without consulting a schema.
STATION_ID = "Delhi NCR composite (research)"
SOURCE = "research:ground_pm25_hourly"

# NCR centroid, matching the live ventilation point. The composite has no single
# location; this is the domain it describes, and it is recorded so a spatial
# join does not silently drop the rows.
LAT, LON = 28.63, 77.22


def available(path: Path | None = None) -> bool:
    return (path or DEFAULT_PARQUET).exists()


def load(path: Path | None = None) -> list[dict[str, Any]]:
    """
    Read the parquet into station_readings rows.

    pyarrow rather than pandas: the file is three columns and a few tens of
    thousands of rows, so a DataFrame buys nothing, and pandas is not in the
    minimal install this repository documents.
    """
    src = path or DEFAULT_PARQUET
    if not src.exists():
        raise RuntimeError(
            f"{src} not found. It is produced by "
            f"research/ps26082/scripts/02_fetch_ground_aq.py")

    try:
        import pyarrow.parquet as pq
    except ImportError as exc:                              # noqa: BLE001
        raise RuntimeError(
            "pyarrow is required to read the research parquet: "
            "pip install pyarrow tzdata") from exc

    table = pq.read_table(src).to_pydict()
    times = table["datetime_utc"]
    values = table["pm25_ncr"]
    counts = table.get("n_stations") or [None] * len(times)

    rows = []
    for ts, pm25, n in zip(times, values, counts):
        if ts is None or pm25 is None:
            continue
        moment = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        rows.append({
            "station_id": STATION_ID,
            "timestamp": moment.astimezone(timezone.utc),
            "pm25": float(pm25),
            "latitude": LAT,
            "longitude": LON,
            "source": SOURCE,
            "n_stations": int(n) if n is not None else None,
        })

    thin = sum(1 for r in rows if (r["n_stations"] or 0) <= 1)
    log.info("read %d hours from %s; %d rest on a single monitor",
             len(rows), src.name, thin)
    return rows
