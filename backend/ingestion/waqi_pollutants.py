"""
Per-pollutant readings from WAQI (aqicn.org) - a backup for the CPCB feeds.

WHY THIS EXISTS
    CPCB's own feed (cpcb_live) drops connections from every cloud host tried -
    Render in Singapore, Vercel in the US and in Mumbai - and data.gov.in, the
    other copy of it, was answering 503. On the hosted dashboard that left every
    pollutant tile blank. WAQI's API is reachable from anywhere and carries the
    same CPCB/DPCC stations, so it is tried after data.gov.in and before OpenAQ.

WHAT THE NUMBERS ARE: US EPA SUB-INDICES
    WAQI's `iaqi` values are per-pollutant sub-indices on the US EPA scale,
    computed from hourly readings - not CPCB's national sub-index, and not
    concentrations. Measured at the same hour, Pusa, Delhi: WAQI PM2.5 89 against
    CPCB's 64. Rows are tagged QUANTITY = "us_sub_index" so the dashboard can say
    which scale a number is on; mixing them unlabelled would make the same air
    read as two different levels.

WAQI IS STALE FOR MOST OF THE NCR
    Measured 2026-09-29: the HSPCB and UPPCB stations' newest WAQI reading was
    2026-06-23 and one station's was 2019, while DPCC/IITM stations in Delhi were
    current. A reading older than POLLUTANT_MAX_AGE_HOURS is dropped, the same
    rule the OpenAQ backup applies - a stale value shown as current is worse than
    a blank tile.

MATCHING WAQI STATIONS TO CAQM STATIONS
    WAQI has its own ids and its own names ("Teri Gram, Gurugram, India" for
    "Teri Gram, Gurugram - HSPCB"; "ITI Jahangirpuri" for "Jahangirpuri"), and
    its coordinates can differ from CAQM's by a few kilometres even for the same
    site. A WAQI station is accepted for a CAQM station at:

        same site name (first segment)       within 5 km
        one name's words inside the other's  within 2 km
        no name agreement                    within 0.3 km (same site, renamed)

    and each WAQI station is given to at most one CAQM station, the closest - two
    CAQM stations named "Pusa" otherwise both matched WAQI's single "Pusa". Nearby
    but different sites (IIT Delhi vs Sri Aurobindo Marg, 1.6 km) stay unmatched.
"""

from __future__ import annotations

import logging
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .ncr_observations import POLLUTANT_MAX_AGE_HOURS

log = logging.getLogger("aree.waqi")

BASE = "https://api.waqi.info"
QUANTITY = "us_sub_index"
POLLUTANTS = ("pm25", "pm10", "no2", "so2", "o3", "co")

# Same NCR box as the other sources.
NCR_BOUNDS = "27.9,76.5,29.3,77.9"

EXACT_KM, WORDS_KM, COORD_KM = 5.0, 2.0, 0.3

# Station ids change on the order of months; readings hourly.
_MAP_TTL_SECONDS = 24 * 3600
_READING_TTL_SECONDS = 600
WORKERS = 6

_map_cache: dict[str, Any] = {"value": None, "fetched_at": None}
_reading_cache: dict[str, Any] = {"value": None, "fetched_at": None}

_WORD = re.compile(r"[a-z0-9]+")


def _token() -> str:
    token = os.getenv("WAQI_TOKEN", "")
    if not token:
        raise RuntimeError("WAQI_TOKEN not set")
    return token


def _get(path: str, **params) -> Any:
    r = requests.get(f"{BASE}/{path}", params={**params, "token": _token()},
                     timeout=20)
    r.raise_for_status()
    body = r.json()
    if body.get("status") != "ok":
        # WAQI answers 200 with {"status": "error", "data": "Invalid key"}.
        raise RuntimeError(f"WAQI {path}: {body.get('data')}")
    return body.get("data")


def _words(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


def _norm(text: str) -> str:
    return "".join(_WORD.findall(text.lower()))


def _site(caqm_name: str) -> str:
    """'Teri Gram, Gurugram - HSPCB' -> 'Teri Gram'."""
    return caqm_name.rsplit(" - ", 1)[0].split(",")[0].strip()


def _city(caqm_name: str) -> str | None:
    """'Teri Gram, Gurugram - HSPCB' -> 'Gurugram'."""
    parts = caqm_name.rsplit(" - ", 1)[0].split(",")
    return parts[1].strip() if len(parts) > 1 else None


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def _rank(station: dict, name: str, lat: float, lon: float) -> tuple[int, float] | None:
    """(tier, km) when `name` at (lat, lon) is acceptable for `station`, else None."""
    d = _km(station["lat"], station["lon"], lat, lon)
    site = _site(station["station"])
    first = name.split(",")[0]
    if _norm(first) == _norm(site):
        return (0, d) if d <= EXACT_KM else None
    # The city is in nearly every name on both sides, so sharing it is not
    # agreement: "IIT Delhi" must not match a WAQI station called "Delhi, ...".
    generic = _words(_city(station["station"]) or "") | {"india"}
    site_words, first_words = _words(site) - generic, _words(first) - generic
    if site_words and first_words and (site_words <= _words(name)
                                       or first_words <= site_words):
        return (1, d) if d <= WORDS_KM else None
    return (2, d) if d <= COORD_KM else None


def match_stations(stations: list[dict],
                   candidates: dict[int, tuple[str, float, float]]) -> dict[str, int]:
    """CAQM station name -> WAQI uid, one CAQM station per uid."""
    best_for_uid: dict[int, tuple[tuple[int, float], str]] = {}
    for st in stations:
        if st.get("lat") is None or st.get("lon") is None:
            continue
        ranked = [(r, uid) for uid, (name, lat, lon) in candidates.items()
                  if (r := _rank(st, name, lat, lon)) is not None]
        if not ranked:
            continue
        rank, uid = min(ranked)
        held = best_for_uid.get(uid)
        if held is None or rank < held[0]:
            best_for_uid[uid] = (rank, st["station"])
    return {name: uid for uid, (_, name) in best_for_uid.items()}


def _candidates(stations: list[dict]) -> dict[int, tuple[str, float, float]]:
    """Every WAQI station a search for these sites or their cities turns up.

    The map endpoint alone returns ~24 NCR stations, so each site name and each
    city is searched too.
    """
    keywords = ({_site(st["station"]) for st in stations}
                | {c for st in stations if (c := _city(st["station"]))})
    found: dict[int, tuple[str, float, float]] = {}

    def search(keyword: str) -> list[dict]:
        try:
            return _get("search/", keyword=keyword) or []
        except Exception as exc:                            # noqa: BLE001
            log.debug("WAQI search %r failed: %s", keyword, exc)
            return []

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for results in pool.map(search, sorted(keywords)):
            for row in results:
                geo = (row.get("station") or {}).get("geo") or []
                if len(geo) == 2 and row.get("uid") is not None:
                    found[row["uid"]] = (row["station"].get("name", ""),
                                         float(geo[0]), float(geo[1]))

    for row in _get("map/bounds/", latlng=NCR_BOUNDS) or []:
        if row.get("uid") is not None:
            found[row["uid"]] = ((row.get("station") or {}).get("name", ""),
                                 float(row["lat"]), float(row["lon"]))
    return found


def _station_map(stations: list[dict], now: datetime) -> dict[str, int]:
    cached, at = _map_cache["value"], _map_cache["fetched_at"]
    if cached and at and (now - at).total_seconds() < _MAP_TTL_SECONDS:
        return cached
    mapping = match_stations(stations, _candidates(stations))
    log.info("WAQI: %d of %d CAQM stations matched", len(mapping), len(stations))
    if mapping:
        _map_cache["value"], _map_cache["fetched_at"] = mapping, now
    return mapping


def _reading(caqm_name: str, uid: int, cutoff: datetime) -> dict | None:
    try:
        data = _get(f"feed/@{uid}/")
    except Exception as exc:                                # noqa: BLE001
        log.debug("WAQI feed @%s failed: %s", uid, exc)
        return None
    try:
        observed = datetime.fromisoformat(data["time"]["iso"]).astimezone(timezone.utc)
    except (KeyError, TypeError, ValueError):
        return None
    if observed < cutoff:
        return None
    iaqi = data.get("iaqi") or {}
    row: dict[str, Any] = {"station": caqm_name, "observed_at": observed}
    for key in POLLUTANTS:
        value = (iaqi.get(key) or {}).get("v")
        if isinstance(value, (int, float)) and value >= 0:
            row[key] = float(value)
    return row if len(row) > 2 else None


def fetch_ncr(now: datetime | None = None,
              stations: list[dict] | None = None) -> list[dict]:
    """Fresh WAQI readings for the CAQM stations, one row per matched station.

    Same row shape as cpcb_stream.fetch_ncr(), keyed by the CAQM station name,
    so the engine joins it without branching. `stations` defaults to the CAQM
    roster (name, lat, lon).
    """
    now = now or datetime.now(timezone.utc)
    _token()  # fail fast, and visibly, when the token is missing

    cached, at = _reading_cache["value"], _reading_cache["fetched_at"]
    if cached is not None and at and (now - at).total_seconds() < _READING_TTL_SECONDS:
        return cached

    if stations is None:
        from . import caqm_stream
        stations = caqm_stream.fetch_roster()
    mapping = _station_map(stations, now)
    cutoff = now - timedelta(hours=POLLUTANT_MAX_AGE_HOURS)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        rows = [r for r in pool.map(lambda kv: _reading(kv[0], kv[1], cutoff),
                                    mapping.items()) if r is not None]
    log.info("WAQI: %d of %d matched stations have a reading under %d h old",
             len(rows), len(mapping), POLLUTANT_MAX_AGE_HOURS)

    if rows:
        _reading_cache["value"], _reading_cache["fetched_at"] = rows, now
    return rows
