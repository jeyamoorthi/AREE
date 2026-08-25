"""
CPCB CAAQMS ingestion via the data.gov.in open-data API.

WHY THIS EXISTS ALONGSIDE aqi_stream.py (WAQI)
    WAQI is a re-publisher. It aggregates CPCB's feed, applies its own AQI
    conversion, and exposes one composite `aqi` number per station plus an
    `iaqi` dictionary. Two consequences bite us:

      1. Provenance. We cannot tell a regulator which CPCB station and which
         reading produced an escalation, because WAQI's station ids are its
         own. data.gov.in returns the CPCB station name verbatim
         ("ITO, Delhi - CPCB"), which is the name that appears in GRAP orders.

      2. Freshness is invisible. WAQI's payload carries the observation time
         but the engine polls every 30 s and the dashboard implied that
         cadence. CPCB publishes hourly. This module returns `last_update`
         from the source, so data age is a measured quantity rather than an
         assumption - see feed_time.py for how it is surfaced.

    This does not replace WAQI; it is the authoritative source for the NCR
    domain, with WAQI retained as a fallback for cities CPCB does not cover.

WHAT THE ENDPOINT ACTUALLY RETURNS
    One row per (station, pollutant), not one row per station. Each row has
    min_value / max_value / avg_value for the hour. Pollutants seen in the
    Delhi feed: PM2.5, PM10, NO2, NH3, SO2, CO, OZONE. Rows are pivoted here
    so downstream code receives one record per station with pollutants as
    fields, matching the shape the Pathway AQI schema already expects.

    Values arrive as strings and can be "NA". Coercion is centralised in
    _to_float so a single bad cell cannot take down a poll cycle.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any

import requests

# CPCB "Real time Air Quality Index from various locations" resource.
RESOURCE_ID = "3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69"
BASE = f"https://api.data.gov.in/resource/{RESOURCE_ID}"

# CPCB timestamps are IST, formatted dd-mm-YYYY HH:MM:SS, with no zone marker.
CPCB_TIME_FMT = "%d-%m-%Y %H:%M:%S"
IST_OFFSET_SECONDS = 5 * 3600 + 30 * 60

POLLUTANT_FIELD = {
    "PM2.5": "pm25",
    "PM10": "pm10",
    "NO2": "no2",
    "SO2": "so2",
    "CO": "co",
    "OZONE": "o3",
    "NH3": "nh3",
}


def _api_key() -> str:
    key = os.getenv("DATA_GOV_API_KEY", "")
    if not key:
        raise RuntimeError("DATA_GOV_API_KEY not set")
    return key


def _to_float(value: Any) -> float | None:
    """
    Coerce a CPCB cell to float, or None.

    CPCB emits "NA" for offline analysers and occasionally an empty string.
    Centralised so every caller treats a missing analyser identically instead
    of some paths raising and others silently producing a zero - a zero PM2.5
    would read as pristine air and could suppress an escalation.
    """
    if value in (None, "", "NA", "-"):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f >= 0 else None


def parse_cpcb_timestamp(raw: str) -> datetime | None:
    """
    Convert a CPCB IST timestamp string into an aware UTC datetime.

    Its own function because the format carries no timezone and naive parsing
    would tag readings as UTC, shifting every observation 5h30m earlier. That
    error is invisible on a dashboard and fatal to a persistence window.
    """
    if not raw:
        return None
    try:
        naive = datetime.strptime(raw.strip(), CPCB_TIME_FMT)
    except ValueError:
        return None
    return naive.replace(tzinfo=timezone.utc) - _ist_delta()


def _ist_delta():
    from datetime import timedelta
    return timedelta(seconds=IST_OFFSET_SECONDS)


# Page size. data.gov.in reads slow enough that a single large request times
# out: limit=2000 reliably exceeds a 45 s read timeout, while 500 returns in a
# couple of seconds. Paging is not an optimisation here, it is the difference
# between the endpoint working and not.
PAGE_SIZE = 500
MAX_PAGES = 12

# data.gov.in sits behind a WAF that blocks the default python-requests
# User-Agent. The request is accepted, held open for ~60 s, then answered with
# an empty-bodied HTTP 502. The identical request carrying a browser UA returns
# 200 in about a second - measured repeatedly, with and without the header.
#
# So what the retry logic below reads as "the endpoint is unreliable under
# sustained load" was really client identification, not rate limiting. That
# misdiagnosis is why fetch_ncr() took minutes: every page burned a 60 s
# timeout and a backoff sleep before succeeding on a later attempt or being
# dropped. The backoff stays - a real 5xx is still possible - but with this
# header a four-state NCR pull completes in seconds instead of minutes.
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}



def _get_with_backoff(params: dict, retries: int = 4) -> list[dict] | None:
    """
    One paged GET, tolerant of data.gov.in's behaviour under load.

    Observed empirically: the endpoint answers a single request in 2-4 s, but
    a burst of consecutive requests makes it return HTTP 502 with a zero-length
    body after ~60 s rather than a 429. So the retry has to treat "5xx with no
    body" as rate limiting, and back off generously. Without this the poller
    silently loses whole states.
    """
    delay = 5
    for _ in range(retries):
        try:
            r = requests.get(BASE, params=params, headers=REQUEST_HEADERS,
                             timeout=75)
        except requests.RequestException:
            time.sleep(delay)
            delay *= 2
            continue
        if r.status_code >= 500 or not r.text:
            time.sleep(delay)
            delay *= 2
            continue
        r.raise_for_status()
        try:
            return r.json().get("records", []) or []
        except ValueError:
            time.sleep(delay)
            delay *= 2
    return None


def fetch_records(state: str = "Delhi") -> list[dict]:
    """
    Pull the raw (station, pollutant) rows for one state, paging by offset.

    Separated from the pivot so the untransformed payload can be logged and
    replayed - the audit trail needs the bytes CPCB actually served, not our
    interpretation of them.
    """
    out: list[dict] = []
    for page in range(MAX_PAGES):
        params = {
            "api-key": _api_key(),
            "format": "json",
            "limit": PAGE_SIZE,
            "offset": page * PAGE_SIZE,
            "filters[state]": state,
        }
        recs = _get_with_backoff(params)
        if recs is None:
            break
        out.extend(recs)
        if len(recs) < PAGE_SIZE:
            break
    return out


def pivot_stations(records: list[dict]) -> list[dict]:
    """
    Collapse (station, pollutant) rows into one record per station.

    Uses avg_value, which is CPCB's hourly mean for the analyser. min/max are
    retained for PM2.5 only, because the spread within an hour is a cheap data
    -quality signal: a station reporting min==max across many hours is almost
    certainly holding a stale value rather than measuring.
    """
    by_station: dict[str, dict] = {}

    for rec in records:
        name = rec.get("station")
        if not name:
            continue
        st = by_station.setdefault(name, {
            "station": name,
            "city": rec.get("city"),
            "state": rec.get("state"),
            "lat": _to_float(rec.get("latitude")),
            "lon": _to_float(rec.get("longitude")),
            "observed_at": parse_cpcb_timestamp(rec.get("last_update", "")),
            "received_at": datetime.now(timezone.utc),
        })

        field = POLLUTANT_FIELD.get((rec.get("pollutant_id") or "").upper())
        if not field:
            continue
        st[field] = _to_float(rec.get("avg_value"))
        if field == "pm25":
            st["pm25_min"] = _to_float(rec.get("min_value"))
            st["pm25_max"] = _to_float(rec.get("max_value"))

    return list(by_station.values())


def data_age_seconds(station: dict) -> float | None:
    """
    Seconds between the CPCB observation and now.

    This is the number the dashboard should show. Polling every 30 s does not
    make data 30 s old; CPCB publishes hourly, so a healthy feed sits anywhere
    from 0 to ~3600 s behind. Reporting measured age is more credible than
    claiming real time, and it is what lets an escalation record state how
    stale the evidence was when the decision fired.
    """
    obs = station.get("observed_at")
    if not obs:
        return None
    return (datetime.now(timezone.utc) - obs).total_seconds()


def fetch_ncr(lat_range=(27.9, 29.3), lon_range=(76.5, 77.9)) -> list[dict]:
    """
    Every CPCB station inside the NCR bounding box.

    Queries the three states the NCR spans rather than filtering nationally:
    the API's state filter is indexed, a national pull is not, and NCR
    genuinely crosses Delhi / Haryana / Uttar Pradesh boundaries.
    """
    out: list[dict] = []
    # Exact strings the API indexes on. "Uttar_Pradesh" silently returns zero
    # rows rather than erroring, which is the worst kind of wrong.
    for state in ("Delhi", "Haryana", "Uttar Pradesh", "Rajasthan"):
        try:
            out.extend(pivot_stations(fetch_records(state=state)))
        except Exception:                                   # noqa: BLE001
            continue

    inside = []
    for st in out:
        if st["lat"] is None or st["lon"] is None:
            continue
        if (lat_range[0] <= st["lat"] <= lat_range[1]
                and lon_range[0] <= st["lon"] <= lon_range[1]):
            st["data_age_s"] = data_age_seconds(st)
            inside.append(st)
    return inside


if __name__ == "__main__":
    stations = fetch_ncr()
    print(f"CPCB NCR stations: {len(stations)}")
    with_pm25 = [s for s in stations if s.get("pm25") is not None]
    print(f"reporting PM2.5:   {len(with_pm25)}")
    if with_pm25:
        ages = [s["data_age_s"] for s in with_pm25 if s.get("data_age_s")]
        pm = sorted(s["pm25"] for s in with_pm25)
        print(f"PM2.5 median:      {pm[len(pm)//2]:.0f} ug/m3")
        if ages:
            print(f"data age median:   {sorted(ages)[len(ages)//2]/60:.0f} min")
        for s in with_pm25[:6]:
            print(f"  {s['station'][:46]:<48} pm25={s['pm25']:>6} "
                  f"age={s.get('data_age_s', 0)/60:.0f}m")
