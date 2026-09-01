"""
CAQM CAAQMS ingestion — the regulator's own live station feed.

WHY THIS EXISTS ALONGSIDE cpcb_stream.py
    Both ultimately carry CPCB CAAQMS observations, but they are republished on
    very different schedules, and the difference is not cosmetic:

        data.gov.in (cpcb_stream) : measured 322 min behind, 0 of 78 stations
                                    inside the 90-minute freshness window
        caqm.nic.in (this module) : measured  79 min behind (median),
                                    75 of 79 stations inside that same window

    The 90-minute threshold in config.py was never the problem. The feed was.
    data.gov.in refreshes that resource a few times a day; CAQM publishes
    hourly, because it backs the Commission's own public dashboard - the one a
    regulator actually looks at.

    cpcb_stream is retained and is still the source for the ventilation
    composite. See "WHAT THIS MODULE CANNOT SUPPLY" below.

THE TRAP IN THIS API, AND WHY THE OBVIOUS IMPLEMENTATION IS WRONG
    GetGoogleMapData returns the whole network in a single 3-second call:
    station name, coordinates, and an `aqi` for every station. It is exactly
    what you want, and using it alone is a correctness bug.

    That payload carries NO timestamp, and it serves an aqi for stations whose
    analyser stopped reporting long ago. Measured on the live feed:

        New Moti Bagh, Delhi - MHUA          aqi=123   last reading 24.3 days old
        Vasundhara Nagar_UIT, Bhiwadi        aqi=104   last reading  5.6 days old
        Alipur, Delhi - DPCC                 aqi=112   last reading  0.6 days old

    A 24-day-old number, indistinguishable from a live one, on a dashboard that
    drives GRAP escalation. This is the same failure mode the OpenAQ bbox bug
    had (see ncr_observations): an endpoint that answers confidently rather
    than refusing, so the wrong answer looks exactly like the right one.

    Therefore: GetGoogleMapData is used ONLY for the station roster and
    coordinates. Every value is re-read from GetActualSiteData, which does
    carry `lastupdate`, and anything without a fresh timestamp is dropped
    rather than displayed. 79 parallel reads cost about 10 seconds.

WHAT THIS MODULE CANNOT SUPPLY
    CAQM publishes sub-indices, not concentrations. There is no PM2.5 ug/m3
    anywhere in these payloads. The ventilation episode threshold is calibrated
    in ug/m3, so ncr_observations.composite_pm25() must keep reading CPCB via
    data.gov.in. Inverting the CPCB breakpoint table to recover a concentration
    from a sub-index would fabricate precision the source never had, and it
    would do so inside the one number the escalation decision turns on.

    So: CAQM for what the station network is reporting now, data.gov.in for
    concentrations. Each source is used for what it is actually authoritative
    on, and every record says which one it came from.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

log = logging.getLogger("aree.caqm")

BASE = "https://caqm.nic.in/PavanCoreAPI/api/Home"

# This is a browser-facing endpoint behind the Commission's public dashboard.
# The Referer is sent because that is what the origin expects; the UA is set
# for the same reason cpcb_stream sets one.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://caqm.nic.in/landingpage/pages/home",
}

# Same NCR domain as ncr_observations, so the two sources describe one airshed.
NCR_LAT = (27.9, 29.3)
NCR_LON = (76.5, 77.9)

# CAQM timestamps are IST with no zone marker, same convention as CPCB's.
IST = timezone(timedelta(hours=5, minutes=30))
CAQM_TIME_FMT = "%d-%m-%Y %H:%M:%S"

# A station whose newest reading is older than this is retired hardware, not a
# station between updates. Measured: the live network has two such stations,
# at 5.6 and 24.3 days, both still advertising an aqi on the bulk endpoint.
RETIRED_AFTER_HOURS = 24

# Readings change hourly; one cycle of the direct engine is 120 s.
READING_TTL_SECONDS = 90

# Measured: at 10 workers the endpoint starts timing out individual reads and
# a cycle returns 44 of 67 stations instead of all of them. This is a public
# dashboard's backend, not a bulk API - fewer parallel requests and a retry
# recover more stations than raw concurrency does, and the whole pull still
# finishes well inside the 120 s engine cycle.
WORKERS = 6
READ_RETRIES = 2

# A per-station read returns a couple of hundred bytes. The 45 s default is a
# roster-sized timeout and applying it here is unsafe: 45 s x 2 retries across
# 61 stations at 6 workers can exceed the 120 s engine cycle, so a slow patch
# of the network stalls the whole poll loop rather than degrading it. Fifteen
# seconds is generous for this payload and bounds a worst-case cycle.
READ_TIMEOUT_SECONDS = 15

# CAQM parameter names -> the keys used everywhere else in this codebase.
_NORMALISE = {
    "PM2.5": "pm25", "PM10": "pm10", "NO2": "no2", "SO2": "so2",
    "CO": "co", "OZONE": "o3", "NH3": "nh3",
}

# The roster is metadata - station names and coordinates change on the order
# of months - so it is cached far longer than the readings. This is not an
# optimisation: caqm.nic.in intermittently times out under the 79-request
# burst, and when the roster call was the one to fail, the whole source went
# down and the engine flipped to the 5-hour-old data.gov.in feed for a cycle.
# The station table then flip-flopped between two differently-named networks.
_ROSTER_TTL_SECONDS = 3600

_roster_cache: dict[str, Any] = {"value": None, "fetched_at": None}
_cache: dict[str, Any] = {"value": None, "fetched_at": None}


def _get(path: str, params: dict | None = None, timeout: int = 45) -> dict:
    r = requests.get(f"{BASE}/{path}", params=params, headers=HEADERS,
                     timeout=timeout)
    r.raise_for_status()
    return r.json()


def _parse_ts(raw: Any) -> datetime | None:
    """Parse a CAQM IST timestamp into an aware UTC datetime.

    Its own function for the same reason cpcb_stream has one: the format
    carries no zone, and parsing it as UTC would shift every reading 5h30m
    earlier - invisible on a dashboard, fatal to a freshness threshold.
    """
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw).strip(), CAQM_TIME_FMT) \
                       .replace(tzinfo=IST).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _inside_ncr(lat: Any, lon: Any) -> bool:
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return NCR_LAT[0] <= lat <= NCR_LAT[1] and NCR_LON[0] <= lon <= NCR_LON[1]


def fetch_roster() -> list[dict]:
    """Every station CAQM knows about, with coordinates.

    Roster only. The `aqi` field in this payload is deliberately discarded -
    see the module docstring for the 24-day-old reading it will hand you.
    """
    now = datetime.now(timezone.utc)
    cached, at = _roster_cache["value"], _roster_cache["fetched_at"]
    if cached and at and (now - at).total_seconds() < _ROSTER_TTL_SECONDS:
        return cached

    # One retry: the observed failure is a transient read timeout, not a
    # rejection, and losing the roster costs the entire source for a cycle.
    payload = None
    for attempt in (1, 2):
        try:
            payload = _get("GetGoogleMapData",
                           {"state": 0, "district": 0, "station": 0})
            break
        except Exception as exc:                            # noqa: BLE001
            log.warning("CAQM roster attempt %d failed: %s", attempt, exc)
    if payload is None:
        # Serve the last known roster rather than dropping the source. The
        # readings are re-fetched per station regardless, so a slightly old
        # roster costs nothing but a station that has since been added.
        if cached:
            log.warning("CAQM roster unavailable, reusing cached roster")
            return cached
        return []

    out = []
    for row in payload.get("data") or []:
        if not _inside_ncr(row.get("latitude"), row.get("longitude")):
            continue
        out.append({
            "station": row.get("stationName"),
            "station_id": row.get("stationId"),
            "lat": float(row["latitude"]),
            "lon": float(row["longitude"]),
            "city": row.get("city"),
            "state": row.get("state"),
        })
    if out:
        _roster_cache["value"], _roster_cache["fetched_at"] = out, now
    return out


def known_station_names() -> set[str]:
    """Names in the cached roster.

    Lets the engine tell "this station did not answer this cycle" apart from
    "this station is not part of this feed at all" - only the second is a
    reason to drop it from the table.
    """
    return {r["station"] for r in (_roster_cache["value"] or []) if r.get("station")}


def _reading_for(entry: dict) -> dict | None:
    """One station's current reading and the time it was actually taken."""
    payload = None
    for _ in range(READ_RETRIES):
        try:
            payload = _get("GetActualSiteData",
                           {"request": entry["station_id"], "state_id": 0},
                           timeout=READ_TIMEOUT_SECONDS)
            break
        except Exception:                                   # noqa: BLE001
            continue
    if payload is None:
        return None

    rows = payload.get("data") or []
    if not rows:
        return None

    # A station can report several parameters. The prominent one is whichever
    # carries the highest sub-index - that is what the AQI itself is defined
    # as, so taking the max keeps this consistent with the published number.
    best = max(rows, key=lambda r: r.get("indexvalue") or 0)
    observed_at = _parse_ts(best.get("lastupdate"))
    value = best.get("indexvalue")
    if observed_at is None or value is None:
        return None

    return {
        **entry,
        "aqi": float(value),
        # CAQM writes "PM2.5"/"OZONE"; the rest of the codebase keys on
        # "pm25"/"o3". Normalised here so the frontend does not have to know
        # which feed a station came from.
        "dominant_pollutant": _NORMALISE.get(
            (best.get("parameter") or "").strip().upper(),
            (best.get("parameter") or "").strip().lower() or None),
        "observed_at": observed_at,
    }


def fetch_ncr(now: datetime | None = None) -> list[dict]:
    """Every currently-reporting NCR station, with its true reading age.

    Shaped to match what fallback_engine._build_state consumes, so the direct
    engine needs no branching on which source it is reading.
    """
    now = now or datetime.now(timezone.utc)

    cached, at = _cache["value"], _cache["fetched_at"]
    if cached is not None and at and (now - at).total_seconds() < READING_TTL_SECONDS:
        return cached

    roster = fetch_roster()
    if not roster:
        return []

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        readings = [r for r in pool.map(_reading_for, roster) if r is not None]

    cutoff = now - timedelta(hours=RETIRED_AFTER_HOURS)
    fresh, retired = [], 0
    for rec in readings:
        if rec["observed_at"] < cutoff:
            # Dropped, not shown as stale: the bulk endpoint would happily
            # render these as live, which is exactly what we are avoiding.
            retired += 1
            continue
        age_min = (now - rec["observed_at"]).total_seconds() / 60.0
        fresh.append({
            "station": rec["station"],
            "aqi": rec["aqi"],
            # CAQM publishes sub-indices only. No concentration is available
            # here, and none is invented - see the module docstring.
            "pm25_ugm3": None,
            "dominant_pollutant": rec["dominant_pollutant"],
            "lat": rec["lat"],
            "lon": rec["lon"],
            "observed_at": rec["observed_at"],
            "age_minutes": round(age_min),
            "location_id": str(rec["station_id"]),
            "source": "CAQM CAAQMS (caqm.nic.in)",
        })

    log.info("CAQM: %d stations reporting, %d retired analysers dropped",
             len(fresh), retired)

    _cache["value"], _cache["fetched_at"] = fresh, now
    return fresh


if __name__ == "__main__":
    import statistics

    logging.basicConfig(level=logging.INFO)
    rows = fetch_ncr()
    ages = [r["age_minutes"] for r in rows]
    print(f"CAQM NCR stations : {len(rows)}")
    if ages:
        print(f"median age        : {statistics.median(ages):.0f} min")
        print(f"within 90 min     : {sum(1 for a in ages if a <= 90)}")
