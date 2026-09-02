"""
Historical fire detections for the NCR source region, via NASA FIRMS.

WHY THE BOX IS MUCH BIGGER THAN NCR
    The fires that matter to Delhi are not in Delhi. Crop-residue burning in
    Punjab and Haryana is 250-400 km upwind, and a detection box drawn around
    the city would contain almost none of it. The domain here spans the
    north-western plain so the plume source is inside the dataset; whether any
    given fire actually reached NCR is a question for the transport feature in
    features.py, not for the ingestion filter.

WHY VIIRS_SNPP_SP AND NOT _NRT
    NRT is near-real-time and only covers roughly the last two months - correct
    for the live path, useless for a six-winter backfill. SP is the standard
    science-processing archive: later, better geolocated, and available for the
    whole period. The live engine keeps using NRT; every row records which one
    it came from, because they are not the same measurement.

THE API'S HARD LIMIT, MEASURED RATHER THAN READ
    /api/area/csv accepts at most FIVE days per request. Several docs pages say
    ten; the endpoint itself disagrees and answers HTTP 400 with the plain-text
    body "Invalid day range. Expects [1..5]." Verified 2026-09-01 against
    VIIRS_SNPP_SP, VIIRS_SNPP_NRT and MODIS_SP - the limit is the API's, not
    the product's. So the range is split into 5-day windows, and a failed
    window costs five days rather than the whole run.

COVERAGE, ALSO MEASURED
    /api/data_availability/csv/{key}/ALL reports the real span of each product.
    As of 2026-09-01:

        VIIRS_SNPP_SP     2012-01-20 .. 2026-04-27     <- the backfill uses this
        VIIRS_SNPP_NRT    2026-04-28 .. 2026-09-01     <- the live path uses this
        VIIRS_NOAA20_SP   2018-04-01 .. 2026-05-31
        MODIS_SP          2000-11-01 .. 2026-04-30

    SP and NRT tile together with no overlap, which is why the backfill and the
    live engine must use different products and why every row records which.
    Call availability() rather than assuming any of this still holds.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import time
from datetime import datetime, timedelta, timezone

import requests

log = logging.getLogger("aree.backfill.fires")

URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{dataset}/{bbox}/{days}/{start}"

# Archive product. See the module docstring for why this is not the NRT feed.
DATASET = "VIIRS_SNPP_SP"

# minx,miny,maxx,maxy - Punjab, Haryana, western UP and the NCR itself.
SOURCE_BBOX = (73.5, 27.5, 78.5, 32.5)

# Five, not ten. See the module docstring - this was measured against the live
# endpoint, which rejects anything larger.
MAX_DAYS_PER_REQUEST = 5
REQUEST_SPACING_S = 1.0


def availability() -> list[dict]:
    """
    What each FIRMS product actually covers, straight from the API.

    Worth a function rather than a comment because these spans move: SP is
    reprocessed on a lag and its end date advances, NRT's start date advances
    with it. Anyone extending the backfill should check this before assuming a
    product covers their period.
    """
    try:
        r = requests.get(
            f"https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/"
            f"{_key()}/ALL", timeout=60)
        r.raise_for_status()
    except Exception as exc:                                # noqa: BLE001
        log.warning("FIRMS availability lookup failed: %s", exc)
        return []
    return list(csv.DictReader(io.StringIO(r.text.strip())))


def _key() -> str:
    key = os.getenv("FIRMS_API_KEY", "") or os.getenv("FIRMS_MAP_KEY", "")
    if not key:
        raise RuntimeError("FIRMS_API_KEY not set.")
    return key


def _windows(start: datetime, end: datetime) -> list[tuple[datetime, int]]:
    """Split the range into the 10-day windows the endpoint accepts."""
    out, cur = [], start
    while cur <= end:
        span = min(MAX_DAYS_PER_REQUEST, (end - cur).days + 1)
        out.append((cur, span))
        cur += timedelta(days=span)
    return out


def _parse_row(row: dict) -> dict | None:
    """
    One CSV line into a fire_events record.

    acq_time is HHMM with the leading zero dropped ("45" means 00:45), which is
    the single most common way this feed is parsed wrong.
    """
    try:
        date = row.get("acq_date") or ""
        raw_time = (row.get("acq_time") or "0").zfill(4)
        ts = datetime.strptime(f"{date} {raw_time}", "%Y-%m-%d %H%M").replace(
            tzinfo=timezone.utc)
        lat, lon = float(row["latitude"]), float(row["longitude"])
    except (ValueError, KeyError, TypeError):
        return None

    frp = row.get("frp")
    try:
        frp = float(frp) if frp not in (None, "") else None
    except ValueError:
        frp = None

    # Position plus acquisition minute identifies a detection. Re-pulling an
    # overlapping window then updates rows instead of duplicating hotspots.
    event_id = f"{ts:%Y%m%d%H%M}_{lat:.5f}_{lon:.5f}"
    return {
        "event_id": event_id,
        "timestamp": ts,
        "latitude": lat,
        "longitude": lon,
        "frp": frp,
        "confidence": row.get("confidence"),
        "satellite": row.get("satellite"),
        "source": f"firms:{DATASET}",
    }


def fetch_history(start: datetime, end: datetime,
                  bbox: tuple = SOURCE_BBOX,
                  months: set[int] | None = None) -> list[dict]:
    """Every detection in the source region over the range."""
    bbox_str = ",".join(str(v) for v in bbox)
    out: list[dict] = []

    for window_start, days in _windows(start, end):
        if months and window_start.month not in months:
            continue
        url = URL.format(key=_key(), dataset=DATASET, bbox=bbox_str,
                         days=days, start=window_start.strftime("%Y-%m-%d"))
        try:
            r = requests.get(url, timeout=120)
            r.raise_for_status()
        except Exception as exc:                            # noqa: BLE001
            log.warning("  FIRMS %s +%dd failed: %s",
                        window_start.date(), days, exc)
            continue

        text = r.text.strip()
        # The API answers errors with a plain-text body and HTTP 200 - an
        # invalid key returns prose, not a status code. Check for the header.
        if not text or "latitude" not in text.split("\n", 1)[0]:
            log.warning("  FIRMS %s: unexpected body: %s",
                        window_start.date(), text[:120])
            continue

        rows = [_parse_row(row) for row in csv.DictReader(io.StringIO(text))]
        rows = [r for r in rows if r]
        out.extend(rows)
        log.info("  %s +%dd: %d detections", window_start.date(), days, len(rows))
        time.sleep(REQUEST_SPACING_S)

    return out
