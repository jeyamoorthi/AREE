# Dynamic pan-india station loader
# Fetches stations from WAQI search API, caches for 1 hour

import requests
import time
from config import WAQI_TOKEN

_cache = None
_cache_ts = 0
CACHE_TTL = 3600


def load_stations_from_waqi(keyword="india", limit=30):
    global _cache, _cache_ts

    if _cache and (time.time() - _cache_ts) < CACHE_TTL:
        return _cache

    if not WAQI_TOKEN:
        return {}

    try:
        url = f"https://api.waqi.info/search/?token={WAQI_TOKEN}&keyword={keyword}"
        resp = requests.get(url, timeout=15)
        data = resp.json()

        if data.get("status") != "ok":
            return {}

        stations = {}
        seen = set()

        for item in data.get("data", []):
            if len(stations) >= limit:
                break

            uid = item.get("uid")
            if not uid or uid in seen:
                continue
            seen.add(uid)

            stn = item.get("station", {})
            name = stn.get("name", f"Station {uid}")
            geo = stn.get("geo", [])
            if not geo or len(geo) < 2:
                continue

            lat, lon = float(geo[0]), float(geo[1])
            parts = [p.strip() for p in name.split(",")]
            city = parts[0] if parts else name
            state = parts[-1] if len(parts) > 1 else "India"

            display = f"{city} — @{uid}"
            stations[display] = {
                "feed_id": f"@{uid}",
                "lat": lat, "lon": lon,
                "city": city, "state": state,
                "api_name": name,
            }

        _cache = stations
        _cache_ts = time.time()
        print(f"[STATIONS] loaded {len(stations)} from WAQI")
        return stations

    except Exception as e:
        print(f"[STATIONS] search err: {e}")
        return {}


def get_all_stations(hardcoded, limit=30):
    dynamic = load_stations_from_waqi(limit=limit)
    merged = dict(hardcoded)
    existing_feeds = {v["feed_id"] for v in merged.values()}
    for name, info in dynamic.items():
        if info["feed_id"] not in existing_feeds:
            merged[name] = info
    return merged
