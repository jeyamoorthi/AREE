"""
Live NCR ground-truth PM2.5 for the predictive escalation path.

WHY THIS MODULE EXISTS
    The ventilation forecast needs no ground stations at all - it is boundary
    layer height times wind speed, both from a numerical weather model. But the
    ESCALATION trigger is a conjunction: observed pollution AND a forecast
    ventilation collapse. That observed half has to come from somewhere real.

CORRECTNESS BUG THIS MODULE WAS REWRITTEN TO FIX
    The first implementation called /v3/parameters/2/latest with a bbox for the
    NCR domain and reported "198 stations". That endpoint SILENTLY IGNORES both
    bbox and coordinates+radius: the returned rows were from South Korea,
    Lithuania and China, and the "Delhi composite" was a global median. It
    looked entirely plausible - a sensible station count and a sensible
    concentration - which is exactly what made it dangerous.

    The lesson generalises: an API that ignores a filter rather than rejecting
    it will hand you a confident wrong answer. Every geographic query in this
    module now verifies the coordinates it got back, and the verification is a
    hard filter rather than an assertion, so a future API change degrades the
    station count instead of silently widening the domain.

HOW IT WORKS NOW
    1. /v3/locations?bbox=  resolves NCR locations. This endpoint DOES honour
       bbox, and returns station names - the names that appear in GRAP orders.
    2. Locations whose most recent reading is older than ACTIVE_WINDOW_HOURS
       are dropped as retired. Delhi has ~135 PM2.5 locations on record and
       ~88 currently reporting; the difference is retired hardware.
    3. /v3/locations/{id}/latest is then read per active location, in parallel.
    4. Every returned coordinate is re-checked against the NCR box.

SOURCE CHOICE, AND WHY NOT CPCB DIRECTLY
    cpcb_stream.py reads the authoritative CPCB feed via data.gov.in and has
    better provenance. It is also, measured repeatedly, unreliable under any
    sustained call pattern: single requests answer in 2-4 s, a burst returns an
    empty-bodied HTTP 502 after ~60 s, and a full four-state pull exceeded
    seven minutes. Not something to put on a request path.
"""

from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any

import requests

log = logging.getLogger("aree.ncr_observations")

BASE = "https://api.openaq.org/v3"

# minx, miny, maxx, maxy  (lon/lat) - the Delhi NCR domain.
NCR_BBOX = (76.5, 27.9, 77.9, 29.3)
NCR_LON = (76.5, 77.9)
NCR_LAT = (27.9, 29.3)

# A location whose newest reading is older than this is retired hardware, not
# a station between updates.
ACTIVE_WINDOW_HOURS = 6

# Freshness for a reading to count toward the live composite. CPCB publishes
# hourly, so past three hours a station has stopped reporting.
MAX_READING_AGE_HOURS = 3

MIN_STATIONS = 3

# Location metadata changes on the order of months; readings change hourly.
LOCATION_TTL_SECONDS = 3600
READING_TTL_SECONDS = 90
MAX_SERVE_STALE_MINUTES = 30

# Wall-clock budget for the CPCB pull when a composite is built on an HTTP
# request path. Unbounded, a slow data.gov.in held /ventilation/* open for
# minutes; past this the request falls through to OpenAQ / the last good value.
# Kept well under the Next.js proxy's 30 s socket timeout, or the browser gets a
# bare 500 from the proxy instead of our answer.
REQUEST_CPCB_BUDGET_SECONDS = 18
# OpenAQ is only attempted if at least this much of the budget is left.
REQUEST_OPENAQ_MIN_SECONDS = 6
# One worker: concurrent requests must not fan out into parallel OpenAQ pulls.
_openaq_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="openaq-fallback")

_loc_cache: dict[str, Any] = {"value": None, "fetched_at": None}
_obs_cache: dict[str, Any] = {"value": None, "fetched_at": None}


def _api_key() -> str:
    key = os.getenv("OPENAQ_API_KEY", "")
    if not key:
        raise RuntimeError("OPENAQ_API_KEY not set")
    return key


def _headers() -> dict:
    # An explicit User-Agent for the same reason cpcb_stream sets one:
    # the default python-requests identifier is treated as a bot by more
    # than one Indian government-adjacent edge, and the resulting failure
    # is a slow empty 502 rather than an honest 403.
    return {
        "X-API-Key": _api_key(),
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "Accept": "application/json",
    }


def _get(url: str, params: dict | None = None, timeout: int = 60,
         retries: int = 4) -> dict:
    """
    One OpenAQ GET with backoff on rate limiting.

    OpenAQ answers 429 under sustained use, and a bare request turns that into
    a dead subsystem. Centralised so the location lookup and the per-station
    reads back off identically - the first version retried on neither, and a
    burst of testing was enough to take the whole engine down.
    """
    import time as _t
    delay = 4
    last = None
    for _ in range(retries):
        r = requests.get(url, params=params, headers=_headers(), timeout=timeout)
        if r.status_code == 429:
            last = r
            _t.sleep(delay)
            delay *= 2
            continue
        r.raise_for_status()
        return r.json()
    if last is not None:
        last.raise_for_status()
    raise RuntimeError(f"rate limited after {retries} attempts: {url}")


def _parse_ts(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _inside_ncr(lat: Any, lon: Any) -> bool:
    """
    Hard geographic check.

    Applied to every row even though the query was already geographic, because
    the endpoint that caused the original bug accepted a bbox and ignored it.
    Trusting the request is what produced a global median labelled as Delhi.
    """
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return NCR_LAT[0] <= lat <= NCR_LAT[1] and NCR_LON[0] <= lon <= NCR_LON[1]


def resolve_active_locations(now: datetime | None = None) -> list[dict]:
    """
    NCR locations with a PM2.5 sensor that are currently reporting.

    Cached for an hour: this is metadata, and re-resolving it on every request
    would triple the API traffic for information that changes monthly.
    """
    now = now or datetime.now(timezone.utc)
    cached, at = _loc_cache["value"], _loc_cache["fetched_at"]
    if cached is not None and at and (now - at).total_seconds() < LOCATION_TTL_SECONDS:
        return cached

    bbox = ",".join(str(v) for v in NCR_BBOX)
    payload = _get(f"{BASE}/locations", {"bbox": bbox, "limit": 1000})

    cutoff = now - timedelta(hours=ACTIVE_WINDOW_HOURS)
    out = []
    for loc in payload.get("results", []):
        coords = loc.get("coordinates") or {}
        if not _inside_ncr(coords.get("latitude"), coords.get("longitude")):
            continue
        pm = [s for s in (loc.get("sensors") or [])
              if (s.get("parameter") or {}).get("name") == "pm25"]
        if not pm:
            continue
        last = _parse_ts((loc.get("datetimeLast") or {}).get("utc"))
        if last is None or last < cutoff:
            continue
        out.append({
            "location_id": loc["id"],
            "station": loc.get("name"),
            "sensor_id": pm[0]["id"],
            "lat": coords.get("latitude"),
            "lon": coords.get("longitude"),
            "provider": (loc.get("provider") or {}).get("name"),
        })

    _loc_cache["value"], _loc_cache["fetched_at"] = out, now
    return out


def _latest_for_location(loc: dict) -> dict | None:
    """Read one location's latest PM2.5 value. Returns None on any failure."""
    try:
        payload = _get(f"{BASE}/locations/{loc['location_id']}/latest",
                       timeout=30, retries=3)
    except Exception:                                       # noqa: BLE001
        return None

    for rec in payload.get("results", []):
        if rec.get("sensorsId") != loc["sensor_id"]:
            continue
        value = rec.get("value")
        ts = _parse_ts((rec.get("datetime") or {}).get("utc"))
        if value is None or ts is None:
            return None
        return {**loc, "pm25": float(value), "observed_at": ts}
    return None


def fetch_station_values(locations: list[dict], workers: int = 10) -> list[dict]:
    """
    Read every active location's latest value, in parallel.

    Sequential reads of ~88 locations take well over a minute, which is too
    slow for a request path even behind a cache. Ten workers brings it to a
    few seconds; more would risk tripping OpenAQ's rate limiter, which is a
    worse failure than being slightly slow.
    """
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(_latest_for_location, locations))
    return [r for r in results if r is not None]


def _stale_fallback(now: datetime, reason: str) -> dict[str, Any] | None:
    """Last good composite when the upstream is failing, clearly labelled."""
    val, at = _obs_cache["value"], _obs_cache["fetched_at"]
    if val is None or at is None:
        return None
    age_min = (now - at).total_seconds() / 60.0
    if age_min > MAX_SERVE_STALE_MINUTES:
        return None
    out = dict(val)
    out["served_from_cache"] = True
    out["degraded"] = True
    out["degraded_reason"] = reason
    out["data_age_minutes"] = round(out.get("data_age_minutes", 0) + age_min)
    return out


def composite_pm25(now: datetime | None = None,
                   include_stations: bool = True,
                   budget_s: float | None = None) -> dict[str, Any]:
    """
    One airshed PM2.5 value, with every station behind it.

    Median rather than mean across stations, matching the historical pipeline
    so an operational reading is comparable to the record the decision
    threshold was calibrated on. A mean would let one failed analyser move the
    decision.

    `budget_s` bounds the CPCB pull (request paths pass
    REQUEST_CPCB_BUDGET_SECONDS). The engine and capture job omit it.
    """
    now = now or datetime.now(timezone.utc)
    deadline = None if budget_s is None else time.monotonic() + budget_s

    cached, at = _obs_cache["value"], _obs_cache["fetched_at"]
    if cached is not None and at and (now - at).total_seconds() < READING_TTL_SECONDS:
        out = dict(cached)
        out["served_from_cache"] = True
        out["cache_age_seconds"] = round((now - at).total_seconds())
        if not include_stations:
            out.pop("stations", None)
        return out

    # CPCB is the authoritative source for this domain. OpenAQ remains a
    # useful fallback, but its API key can expire independently of CPCB.
    try:
        from .cpcb_stream import fetch_ncr

        cpcb_started = time.monotonic()
        cpcb_rows = fetch_ncr(deadline=deadline)
        cpcb_stations = [
            {
                "station": row["station"],
                "pm25_ugm3": round(row["pm25"], 1),
                "lat": row["lat"],
                "lon": row["lon"],
                "observed_at": row.get("observed_at") or now,
                "age_minutes": round((now - (row.get("observed_at") or now)).total_seconds() / 60),
                "location_id": row.get("station", ""),
            }
            for row in cpcb_rows
            if row.get("pm25") is not None
            and 0 <= row["pm25"] < 2000
            and row.get("lat") is not None
            and row.get("lon") is not None
        ]
        if cpcb_stations:
            values = sorted(row["pm25_ugm3"] for row in cpcb_stations)
            newest = max(row["observed_at"] for row in cpcb_stations)
            result: dict[str, Any] = {
                "available": True,
                "pm25_ugm3": round(median(values), 1),
                "n_stations": len(cpcb_stations),
                "n_active_locations": len(cpcb_stations),
                "n_stale_discarded": 0,
                "n_rejected_values": 0,
                "p25": round(values[len(values) // 4], 1),
                "p75": round(values[3 * len(values) // 4], 1),
                "min": round(values[0], 1),
                "max": round(values[-1], 1),
                "newest_observation": newest,
                "data_age_minutes": round((now - newest).total_seconds() / 60.0),
                "domain": "Delhi NCR",
                "bbox": list(NCR_BBOX),
                "source": "CPCB CAAQMS via data.gov.in",
                "checked_at": now,
                "served_from_cache": False,
                "stations": sorted(cpcb_stations,
                                    key=lambda station: station["pm25_ugm3"],
                                    reverse=True),
            }
            _obs_cache["value"], _obs_cache["fetched_at"] = result, now
            if not include_stations:
                result.pop("stations", None)
            log.info("CPCB source: %d stations in %.1fs",
                     len(cpcb_stations), time.monotonic() - cpcb_started)
            return result
    except Exception as exc:                                # noqa: BLE001
        log.warning("CPCB source unavailable, trying OpenAQ: %s", exc)

    if deadline is not None and deadline - time.monotonic() < REQUEST_OPENAQ_MIN_SECONDS:
        reason = (f"CPCB pull did not complete within the {budget_s:.0f} s "
                  f"request budget")
        fb = _stale_fallback(now, reason)
        return fb or {"available": False, "checked_at": now, "reason": reason}

    if deadline is None:
        return _openaq_composite(now, include_stations)

    # OpenAQ's own per-call timeouts run to a minute, so on a request path it is
    # bounded by what is left of the budget. A pull that finishes late still
    # refreshes the cache for the next caller.
    future = _openaq_pool.submit(_openaq_composite, now, include_stations)
    try:
        return future.result(timeout=max(0.0, deadline - time.monotonic()))
    except FuturesTimeout:
        reason = (f"no ground-observation source answered within the "
                  f"{budget_s:.0f} s request budget")
        fb = _stale_fallback(now, reason)
        return fb or {"available": False, "checked_at": now, "reason": reason}


def _openaq_composite(now: datetime, include_stations: bool) -> dict[str, Any]:
    """The OpenAQ half of composite_pm25, used when CPCB yields nothing."""
    try:
        locations = resolve_active_locations(now)
    except Exception as exc:                                # noqa: BLE001
        fb = _stale_fallback(now, f"location lookup failed: {exc}")
        return fb or {"available": False, "checked_at": now,
                      "reason": f"location lookup failed: {exc}"}

    readings = fetch_station_values(locations)

    cutoff = now - timedelta(hours=MAX_READING_AGE_HOURS)
    fresh, stale, rejected = [], 0, 0
    for rec in readings:
        if not (0 <= rec["pm25"] < 2000):
            rejected += 1
            continue
        if rec["observed_at"] < cutoff:
            stale += 1
            continue
        fresh.append(rec)

    if len(fresh) < MIN_STATIONS:
        fb = _stale_fallback(now, f"only {len(fresh)} fresh stations this cycle")
        return fb or {
            "available": False,
            "checked_at": now,
            "reason": (f"only {len(fresh)} stations reported within "
                       f"{MAX_READING_AGE_HOURS} h (minimum {MIN_STATIONS})"),
            "n_active_locations": len(locations),
        }

    values = sorted(r["pm25"] for r in fresh)
    newest = max(r["observed_at"] for r in fresh)

    stations = sorted(
        [
            {
                "station": r["station"],
                "pm25_ugm3": round(r["pm25"], 1),
                "lat": r["lat"],
                "lon": r["lon"],
                "observed_at": r["observed_at"],
                "age_minutes": round((now - r["observed_at"]).total_seconds() / 60),
                "location_id": r["location_id"],
            }
            for r in fresh
        ],
        key=lambda s: s["pm25_ugm3"],
        reverse=True,
    )

    result: dict[str, Any] = {
        "available": True,
        "pm25_ugm3": round(median(values), 1),
        "n_stations": len(fresh),
        "n_active_locations": len(locations),
        "n_stale_discarded": stale,
        "n_rejected_values": rejected,
        "p25": round(values[len(values) // 4], 1),
        "p75": round(values[3 * len(values) // 4], 1),
        "min": round(values[0], 1),
        "max": round(values[-1], 1),
        "newest_observation": newest,
        "data_age_minutes": round((now - newest).total_seconds() / 60.0),
        "domain": "Delhi NCR",
        "bbox": list(NCR_BBOX),
        "source": "OpenAQ v3 (CPCB / DPCC / IMD / UPPCB / HSPCB / RSPCB)",
        "checked_at": now,
        "served_from_cache": False,
        "stations": stations,
    }

    _obs_cache["value"], _obs_cache["fetched_at"] = result, now
    out = dict(result)
    if not include_stations:
        out.pop("stations", None)
    return out


# --- Per-pollutant concentrations (backup for data.gov.in) -------------------
#
# data.gov.in is the only source of pollutant concentrations for the station
# table, and when it is down every tile goes blank. OpenAQ mirrors the same CPCB
# stations under the same names, but most of the NCR mirror lags by days, so a
# reading only counts when it is at most POLLUTANT_MAX_AGE_HOURS old. A stale
# value presented as current is worse than a blank tile.
POLLUTANT_MAX_AGE_HOURS = 3

# Molar masses (g/mol) for ppb -> µg/m³ at 25 °C and 1 atm, where one mole of
# gas occupies 24.45 L. CPCB publishes at the same reference conditions.
_MOLAR_MASS = {"no2": 46.0055, "so2": 64.066, "o3": 47.998, "co": 28.010,
               "nh3": 17.031}
_MOLAR_VOLUME_L = 24.45
_POLLUTANTS = ("pm25", "pm10", "no2", "so2", "o3", "co", "nh3")


def _to_cpcb_units(parameter: str, value: float, units: str) -> float | None:
    """
    Convert one OpenAQ reading to CPCB's units: µg/m³, except CO in mg/m³.

    Returns None for a unit we do not recognise rather than guessing.
    """
    u = (units or "").strip().lower().replace("µ", "u").replace("μ", "u")
    if u in ("ug/m3", "ug/m³"):
        ug = value
    elif u in ("ppb", "ppm") and parameter in _MOLAR_MASS:
        ppb = value * 1000 if u == "ppm" else value
        ug = ppb * _MOLAR_MASS[parameter] / _MOLAR_VOLUME_L
    elif u in ("mg/m3", "mg/m³"):
        ug = value * 1000
    else:
        return None
    return ug / 1000 if parameter == "co" else ug


def _pollutants_for_location(loc: dict, cutoff: datetime) -> dict | None:
    """Latest fresh value of each pollutant at one location, in CPCB units."""
    try:
        payload = _get(f"{BASE}/locations/{loc['id']}/latest", timeout=30, retries=2)
    except Exception:                                       # noqa: BLE001
        return None

    sensors = {s["id"]: s["parameter"] for s in loc.get("sensors") or []
               if s.get("id") and s.get("parameter")}
    best: dict[str, tuple[datetime, float]] = {}
    for rec in payload.get("results", []):
        param = sensors.get(rec.get("sensorsId"))
        if not param or param.get("name") not in _POLLUTANTS:
            continue
        ts = _parse_ts((rec.get("datetime") or {}).get("utc"))
        value = rec.get("value")
        # Old co-located sensors are still listed; only fresh readings count.
        if ts is None or ts < cutoff or value is None or value < 0:
            continue
        converted = _to_cpcb_units(param["name"], float(value), param.get("units", ""))
        if converted is None:
            continue
        name = param["name"]
        if name not in best or ts > best[name][0]:
            best[name] = (ts, round(converted, 2))

    if not best:
        return None
    row: dict[str, Any] = {"station": loc.get("name")}
    row.update({name: value for name, (_, value) in best.items()})
    row["observed_at"] = min(ts for ts, _ in best.values())
    return row


def fetch_ncr_pollutants(now: datetime | None = None,
                         workers: int = 10) -> list[dict]:
    """
    Fresh per-pollutant concentrations for NCR stations from OpenAQ.

    Rows have the same shape as cpcb_stream.pivot_stations() - station name,
    one key per pollutant, observed_at - so the engine can join either source
    by station name. observed_at is the OLDEST of the values used, so the age
    the dashboard shows is never flattering.
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=POLLUTANT_MAX_AGE_HOURS)

    bbox = ",".join(str(v) for v in NCR_BBOX)
    payload = _get(f"{BASE}/locations", {"bbox": bbox, "limit": 1000})
    fresh = []
    for loc in payload.get("results", []):
        coords = loc.get("coordinates") or {}
        last = _parse_ts((loc.get("datetimeLast") or {}).get("utc"))
        if (loc.get("name") and last is not None and last >= cutoff
                and _inside_ncr(coords.get("latitude"), coords.get("longitude"))):
            fresh.append(loc)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        rows = list(pool.map(lambda loc: _pollutants_for_location(loc, cutoff), fresh))
    return [r for r in rows if r is not None]


if __name__ == "__main__":
    out = composite_pm25()
    if not out["available"]:
        print("unavailable:", out.get("reason"))
        raise SystemExit(1)

    print(f"  domain            {out['domain']}  bbox={out['bbox']}")
    print(f"  PM2.5 median      {out['pm25_ugm3']} ug/m3")
    print(f"  spread            min {out['min']} / p25 {out['p25']} / "
          f"p75 {out['p75']} / max {out['max']}")
    print(f"  stations fresh    {out['n_stations']} of "
          f"{out['n_active_locations']} active")
    print(f"  stale discarded   {out['n_stale_discarded']}")
    print(f"  newest reading    {out['data_age_minutes']} min old")
    print()
    print(f"  {'station':<50}{'PM2.5':>8}{'age':>7}")
    print("  " + "-" * 65)
    for s in out["stations"]:
        print(f"  {str(s['station'])[:48]:<50}{s['pm25_ugm3']:>8.1f}"
              f"{s['age_minutes']:>6}m")
