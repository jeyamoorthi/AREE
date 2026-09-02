"""
Historical ground observations for the NCR domain, via OpenAQ v3.

PROBE BEFORE YOU INGEST
    The plan said "do not assume OpenAQ == all CPCB data", and that is the
    whole reason this module leads with probe() rather than fetch(). We already
    know the Indian feed has a gap from Nov 2022 to Feb 2025, present in the S3
    archive too. A backfill that runs happily and returns a thin dataset is far
    more dangerous than one that refuses, because the thinness shows up later as
    a model that "just doesn't work" rather than as missing data.

    So: probe() reports how many stations, which providers, which pollutants
    and what date span actually exist, and a human decides whether to proceed.
    If the answer is that OpenAQ cannot cover our seasons, we go to CPCB
    directly rather than forcing OpenAQ into the architecture.

THE TWO TRAPS THIS MODULE IS SHAPED AROUND
    1. /v3/parameters/{id}/latest SILENTLY IGNORES bbox and coordinates. It
       returns global rows and does not error - the bug that once produced a
       "Delhi composite" built from South Korean monitors. Only
       /v3/locations?bbox= honours the box, and every coordinate that comes
       back is re-checked here anyway. The check is a hard filter, not an
       assert, so a future API change costs us stations instead of silently
       widening the domain.

    2. Deep pagination returns 500s and 408s. History is therefore requested in
       MONTHLY chunks: a month of hourly data is at most 744 rows, which fits
       inside one 1000-row page, so the pager is never exercised.

WHAT A "STATION" IS HERE
    OpenAQ models a location as a set of sensors, one per parameter, and a
    location's datetimeFirst/datetimeLast spans every sensor ever sited there -
    including retired ones. So coverage is read per SENSOR, never per location,
    and the station row is assembled by pivoting sensors back together on the
    hour. Reading it the other way produces date ranges that do not exist.
"""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from ..ingestion import ncr_observations as obs

log = logging.getLogger("aree.backfill.openaq")

BASE = "https://api.openaq.org/v3"

# The parameters we store, mapped to our column names.
WANTED = {
    "pm25": "pm25", "pm10": "pm10", "o3": "o3",
    "no2": "no2", "so2": "so2", "co": "co",
}

# OpenAQ's free tier is around 60 requests a minute. One second between calls
# keeps us inside it without a token bucket; the backfill is not latency bound.
REQUEST_SPACING_S = 1.0
PAGE_LIMIT = 1000


def _headers() -> dict:
    key = os.getenv("OPENAQ_API_KEY", "")
    if not key:
        raise RuntimeError(
            "OPENAQ_API_KEY not set. The v3 API rejects unauthenticated reads.")
    return {"X-API-Key": key, "Accept": "application/json"}


class AuthFailed(RuntimeError):
    """The key was rejected. Distinct from 'no data', deliberately."""


def _get(path: str, params: dict | None = None, retries: int = 3) -> dict:
    """One call, with backoff on the two failures this API actually produces.

    A 401/403 raises instead of returning {}. Without that the probe reports
    "0 locations in box" for a rejected key, which reads as "the NCR has no
    monitors" - a wrong answer that looks like a real one. Retrying an
    authentication failure is also pointless.
    """
    url = f"{BASE}{path}"
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, headers=_headers(), timeout=60)
            if r.status_code in (401, 403):
                raise AuthFailed(
                    f"OpenAQ rejected the key ({r.status_code}: "
                    f"{r.text[:120]}). Set a valid OPENAQ_API_KEY in .env — "
                    f"register at https://explore.openaq.org/register")
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            time.sleep(REQUEST_SPACING_S)
            return r.json()
        except AuthFailed:
            raise
        except Exception as exc:                            # noqa: BLE001
            if attempt == retries - 1:
                log.warning("OpenAQ %s failed: %s", path, exc)
                return {}
            time.sleep(2 * (attempt + 1))
    return {}


def _inside_ncr(lat: Any, lon: Any) -> bool:
    """Re-verify a coordinate the API claims is in our box. See trap 1."""
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return (obs.NCR_LON[0] <= lon <= obs.NCR_LON[1]
            and obs.NCR_LAT[0] <= lat <= obs.NCR_LAT[1])


def _parse(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def discover_stations() -> list[dict]:
    """
    Every NCR location, with its per-parameter sensors and their real spans.

    Returns one dict per location carrying only the sensors we care about, so
    the caller never has to know that OpenAQ splits a station by parameter.
    """
    bbox = ",".join(str(v) for v in obs.NCR_BBOX)
    payload = _get("/locations", {"bbox": bbox, "limit": PAGE_LIMIT})

    stations = []
    for row in payload.get("results") or []:
        coords = row.get("coordinates") or {}
        if not _inside_ncr(coords.get("latitude"), coords.get("longitude")):
            continue

        sensors = []
        for s in row.get("sensors") or []:
            name = ((s.get("parameter") or {}).get("name") or "").lower()
            if name in WANTED:
                sensors.append({
                    "sensor_id": s.get("id"),
                    "parameter": WANTED[name],
                    "units": (s.get("parameter") or {}).get("units"),
                })
        if not sensors:
            continue

        stations.append({
            "location_id": row.get("id"),
            "station": row.get("name"),
            "latitude": coords.get("latitude"),
            "longitude": coords.get("longitude"),
            "provider": (row.get("provider") or {}).get("name"),
            "first": _parse((row.get("datetimeFirst") or {}).get("utc")),
            "last": _parse((row.get("datetimeLast") or {}).get("utc")),
            "sensors": sensors,
        })
    return stations


def probe() -> dict[str, Any]:
    """
    What coverage actually exists, before anyone commits to an ingestion run.

    Reports counts by provider and by pollutant, and the span of the network.
    Deliberately cheap - one request - so there is no excuse for skipping it.
    """
    stations = discover_stations()
    by_provider: dict[str, int] = defaultdict(int)
    by_param: dict[str, int] = defaultdict(int)
    firsts, lasts = [], []

    for st in stations:
        by_provider[st["provider"] or "unknown"] += 1
        for s in st["sensors"]:
            by_param[s["parameter"]] += 1
        if st["first"]:
            firsts.append(st["first"])
        if st["last"]:
            lasts.append(st["last"])

    now = datetime.now(timezone.utc)
    return {
        "domain": "Delhi NCR",
        "bbox": list(obs.NCR_BBOX),
        "n_stations": len(stations),
        "n_pm25_stations": by_param.get("pm25", 0),
        "by_provider": dict(sorted(by_provider.items(),
                                   key=lambda kv: -kv[1])),
        "by_pollutant": dict(sorted(by_param.items(), key=lambda kv: -kv[1])),
        "earliest": min(firsts).isoformat() if firsts else None,
        "latest": max(lasts).isoformat() if lasts else None,
        "reporting_last_7d": sum(
            1 for st in stations
            if st["last"] and (now - st["last"]) < timedelta(days=7)),
        "stations": stations,
    }


def _months(start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
    """Split a range into calendar months. See trap 2."""
    out, cur = [], start.replace(day=1, hour=0, minute=0, second=0,
                                 microsecond=0)
    while cur <= end:
        nxt = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        out.append((max(cur, start), min(nxt - timedelta(seconds=1), end)))
        cur = nxt
    return out


def _sensor_hours(sensor_id: int, lo: datetime, hi: datetime) -> list[dict]:
    """Hourly aggregates for one sensor over one month."""
    payload = _get(f"/sensors/{sensor_id}/hours", {
        "datetime_from": lo.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "datetime_to": hi.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "limit": PAGE_LIMIT,
    })
    out = []
    for row in payload.get("results") or []:
        ts = _parse(((row.get("period") or {}).get("datetimeFrom") or {}).get("utc"))
        if ts is None or row.get("value") is None:
            continue
        out.append({"timestamp": ts, "value": float(row["value"])})
    return out


def fetch_history(stations: list[dict], start: datetime, end: datetime,
                  months: set[int] | None = None) -> list[dict]:
    """
    Pivot every sensor back into one row per station-hour.

    `months` restricts to a season (the winter regime is what this PS is about),
    so a full multi-year pull does not spend most of its requests on monsoon
    months no episode ever occurs in.
    """
    rows: dict[tuple[str, datetime], dict] = {}

    for st in stations:
        for lo, hi in _months(start, end):
            if months and lo.month not in months:
                continue
            for sensor in st["sensors"]:
                for point in _sensor_hours(sensor["sensor_id"], lo, hi):
                    key = (st["station"], point["timestamp"])
                    rec = rows.setdefault(key, {
                        "station_id": st["station"],
                        "timestamp": point["timestamp"],
                        "latitude": st["latitude"],
                        "longitude": st["longitude"],
                        "source": f"openaq:{st.get('provider') or 'unknown'}",
                    })
                    rec[sensor["parameter"]] = point["value"]
            log.info("  %s %s: %d station-hours so far",
                     st["station"], lo.strftime("%Y-%m"), len(rows))

    return list(rows.values())
