"""
CPCB CAAQMS per-pollutant readings, read from CPCB's own public feed.

WHY THIS EXISTS ALONGSIDE cpcb_stream.py (data.gov.in)
    data.gov.in republishes this same CPCB feed - same station names, same
    PM2.5 / PM10 / NO2 / NH3 / SO2 / CO / OZONE ids, same min / max / avg
    triple - but it is the weaker copy of it on every axis that was measured:

        data.gov.in (cpcb_stream) : HTTP 503 for the whole pull, 140 s spent
                                    in retries before giving up; ~5 h behind
                                    even when it answers
        airquality.cpcb.gov.in    : one 700 KB GET, ~2 s, NCR readings 12 min
                                    old; 73 of 74 CAQM stations match by name

    With data.gov.in down and OpenAQ's CPCB mirror five days behind, every
    pollutant tile on the dashboard read "not reported" while the station's
    AQI was current. This feed is tried first; the other two remain behind it.

WHAT THE NUMBERS ARE: SUB-INDICES, NOT CONCENTRATIONS
    The XML form of this feed names the element <Pollutant_Index>, and the
    values behave as indices, not ug/m3. Measured across all 469 stations that
    reported: airQualityIndexValue == max(avg) at every one of them. Read as
    concentrations and converted through the CPCB breakpoint table, the same
    numbers reproduce the published AQI at only 107 - the stations where the
    PM10 table happens to map 1:1.

    Teri Gram, Gurugram shows it plainly: PM2.5 avg 83, PM10 avg 109, AQI 109
    led by PM10. As a concentration, 83 ug/m3 of PM2.5 is a sub-index of ~176
    and would have led the AQI; as a sub-index it sits below PM10's 109.

    So every row this module returns is tagged QUANTITY = "sub_index", and the
    dashboard labels it as such. Inverting the breakpoints back to ug/m3 is not
    done, for the reason caqm_stream gives: it would fabricate a precision the
    source never published.

WHY THERE IS A RELAY
    The hosted backend (Render, Singapore) got nothing from this feed while the
    same request succeeded from a machine in India and from a server outside
    India - so it is not a blanket geo-block, and it is not the code. The
    frontend's host serves the same bytes at /relay/cpcb-feed
    (frontend/src/app/relay/cpcb-feed/route.ts), and this module falls back to
    it when the direct read fails. The relay takes no parameters: it can only
    ever fetch this one public feed. `last_route` records which path answered
    and why the other did not, and /api/system/status publishes it.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Iterator

import requests

from .cpcb_stream import REQUEST_HEADERS, pivot_stations

log = logging.getLogger("aree.cpcb_live")

FEED_URL = "https://airquality.cpcb.gov.in/caaqms/iit_rss_feed_with_coordinates"
# Empty string disables the relay.
RELAY_URL = os.getenv("AREE_CPCB_RELAY_URL",
                      "https://aree.vercel.app/relay/cpcb-feed")
SOURCE = "CPCB CAAQMS (airquality.cpcb.gov.in)"
QUANTITY = "sub_index"

# (connect, read). A host that cannot reach CPCB tends to fail at connect, so
# that half is kept short: it is paid on every uncached pull before the relay.
TIMEOUT = (10, 30)

# Which route answered the last pull ("direct" / "relay", None when neither),
# and the error from each route that failed on the way.
last_route: dict[str, Any] = {}

# Same NCR domain as cpcb_stream.fetch_ncr and caqm_stream, so all three
# sources describe one airshed.
NCR_LAT = (27.9, 29.3)
NCR_LON = (76.5, 77.9)

# CPCB refreshes the feed hourly; the direct engine cycles every 120 s.
_TTL_SECONDS = 300
_cache: dict[str, Any] = {"value": None, "fetched_at": None}


def _records(payload: dict) -> Iterator[dict]:
    """Flatten the nested country/state/city/station tree into data.gov.in rows.

    Emitting the exact field names data.gov.in uses lets pivot_stations() parse
    both copies of the feed, so "NA" cells, IST timestamps and pollutant ids are
    handled by one piece of code rather than two that could drift apart.
    """
    for state in payload.get("country") or []:
        for city in state.get("citiesInState") or []:
            for st in city.get("stationsInCity") or []:
                for p in st.get("pollutants") or []:
                    yield {
                        "station": st.get("stationName"),
                        "city": city.get("cityId"),
                        "state": state.get("stateId"),
                        "latitude": st.get("latitude"),
                        "longitude": st.get("longitude"),
                        "last_update": st.get("lastUpdate") or "",
                        "pollutant_id": p.get("indexId"),
                        "avg_value": p.get("avg"),
                        "min_value": p.get("min"),
                        "max_value": p.get("max"),
                    }


def _download() -> dict:
    """The feed's JSON, direct from CPCB or, failing that, via the relay."""
    routes = [("direct", FEED_URL)] + ([("relay", RELAY_URL)] if RELAY_URL else [])
    errors: dict[str, str] = {}
    for name, url in routes:
        try:
            r = requests.get(url, headers=REQUEST_HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            payload = r.json()
            # An error page served with a 200 must not pass for "no stations".
            if not isinstance(payload, dict) or "country" not in payload:
                raise ValueError("response is not the CPCB station feed")
        except Exception as exc:                            # noqa: BLE001
            errors[name] = f"{type(exc).__name__}: {exc}"[:300]
            log.warning("CPCB live feed: %s route failed - %s", name, errors[name])
            continue
        last_route.clear()
        last_route.update(via=name, errors=errors)
        return payload

    last_route.clear()
    last_route.update(via=None, errors=errors)
    raise RuntimeError("; ".join(f"{k}: {v}" for k, v in errors.items()))


def fetch_ncr(now: datetime | None = None) -> list[dict]:
    """Every NCR station in the feed, one row per station, pollutants as keys.

    Same row shape as cpcb_stream.fetch_ncr(), so the engine joins either by
    station name without branching on which one answered.
    """
    now = now or datetime.now(timezone.utc)
    cached, at = _cache["value"], _cache["fetched_at"]
    if cached is not None and at and (now - at).total_seconds() < _TTL_SECONDS:
        return cached

    inside = [
        st for st in pivot_stations(_records(_download()))
        if st["lat"] is not None and st["lon"] is not None
        and NCR_LAT[0] <= st["lat"] <= NCR_LAT[1]
        and NCR_LON[0] <= st["lon"] <= NCR_LON[1]
    ]
    log.info("CPCB live feed: %d NCR stations", len(inside))

    # An empty pull is not cached, so an outage is retried next cycle rather
    # than served as "no stations" for five minutes.
    if inside:
        _cache["value"], _cache["fetched_at"] = inside, now
    return inside
