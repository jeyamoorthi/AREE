# aqi_stream.py — WAQI-direct ingestion with data integrity
# Uses WAQI AQI directly for escalation. PM2.5 for transparency only.
# Extracts WAQI timestamp, station name, all pollutants from payload.

import requests
import os
import time
from datetime import datetime, timezone
from dotenv import load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .feed_time import extract_sync, local_display, utc_display

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))
load_dotenv()

WAQI_TOKEN = os.getenv("WAQI_TOKEN")
if not WAQI_TOKEN:
    raise ValueError("WAQI_TOKEN not found in .env")

BASE_URL = "https://api.waqi.info/feed/{feed_id}/?token={token}"

session = requests.Session()
retry_strategy = Retry(
    total=5, backoff_factor=2,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["GET"],
)
adapter = HTTPAdapter(max_retries=retry_strategy)
session.mount("https://", adapter)
session.headers.update({"User-Agent": "UrbanLive-AI/2.1", "Accept": "application/json"})


# ── Debug data (side-channel for UI transparency) ──
_debug_data = {}


def fetch_aqi(station_key, feed_id):
    """
    Fetch AQI from WAQI. Returns WAQI AQI directly (not computed).
    Stores full payload metadata in _debug_data for transparency.
    """
    try:
        url = BASE_URL.format(feed_id=feed_id, token=WAQI_TOKEN)
        response = session.get(url, timeout=25)

        if response.status_code != 200:
            _set_error(station_key, f"HTTP {response.status_code}")
            return None

        data = response.json()
        if data.get("status") != "ok":
            _set_error(station_key, f"API status: {data.get('status')}")
            return None

        payload = data.get("data", {})

        # ── WAQI AQI (direct from API, used for escalation) ──
        # A feed can answer 200/ok yet carry aqi "-": WAQI's marker for "no
        # aggregate AQI available". That is a dormant station, not a fault, so
        # it is recorded distinctly instead of looking like a transient error.
        waqi_aqi = payload.get("aqi")
        if waqi_aqi is None or waqi_aqi == "-":
            _set_unavailable(station_key, payload, feed_id)
            return None
        try:
            waqi_aqi = int(waqi_aqi)
        except (TypeError, ValueError):
            _set_error(station_key, f"Non-numeric AQI in payload: {waqi_aqi!r}")
            return None

        # ── WAQI timestamp (from payload, not datetime.now) ──
        waqi_time_str = payload.get("time", {}).get("s", "")
        waqi_time_iso = payload.get("time", {}).get("iso", "")

        # ── Station name (from API) ──
        station_name = payload.get("city", {}).get("name", "Unknown")

        # ── Pollutant concentrations (transparency only) ──
        iaqi = payload.get("iaqi", {})
        pollutants = {}
        for key in ["pm25", "pm10", "no2", "so2", "o3", "co"]:
            val = iaqi.get(key, {}).get("v")
            if val is not None:
                pollutants[key] = val

        # ── Wind data (for satellite transport) ──
        wind_speed = iaqi.get("w", {}).get("v")
        wind_dir = iaqi.get("wd", {}).get("v")

        # ── Compute staleness ──
        api_response_time = datetime.now(timezone.utc).strftime("%H:%M:%S")
        stale_seconds = None
        if waqi_time_iso:
            try:
                waqi_dt = datetime.fromisoformat(waqi_time_iso.replace("Z", "+00:00"))
                stale_seconds = (datetime.now(timezone.utc) - waqi_dt).total_seconds()
            except Exception:
                pass

        # ── Display-only presentation of the same authoritative `iso` value,
        # plus WAQI's own last-sync marker. Neither feeds staleness or AQI. ──
        feed_last_sync = extract_sync(payload)

        # ── Store debug metadata ──
        _debug_data[station_key] = {
            "waqi_aqi": waqi_aqi,
            "waqi_timestamp": waqi_time_str,
            "waqi_timestamp_iso": waqi_time_iso,
            "station_name_api": station_name,
            "feed_id": feed_id,
            "raw_pm25": pollutants.get("pm25"),
            "raw_pm10": pollutants.get("pm10"),
            "raw_no2": pollutants.get("no2"),
            "raw_so2": pollutants.get("so2"),
            "raw_o3": pollutants.get("o3"),
            "raw_co": pollutants.get("co"),
            "pollutants_available": len(pollutants),
            "dominant_pollutant": max(pollutants, key=pollutants.get) if pollutants else "—",
            "wind_speed": wind_speed,
            "wind_direction": wind_dir,
            "api_time": api_response_time,
            "stale_seconds": stale_seconds,
            "waqi_timestamp_local": local_display(waqi_time_iso),
            "waqi_timestamp_utc": utc_display(waqi_time_iso),
            "feed_last_sync": feed_last_sync,
            "status": "ok",
            "error": None,
        }

        # ── Return enriched record for Pathway ──
        return {
            "timestamp": datetime.now(timezone.utc),
            "aqi": waqi_aqi,
            "city": station_key,
            "pm25": pollutants.get("pm25"),
            "pm10": pollutants.get("pm10"),
            "no2": pollutants.get("no2"),
            "so2": pollutants.get("so2"),
            "o3": pollutants.get("o3"),
            "co": pollutants.get("co"),
            "wind_speed": wind_speed,
            "wind_direction": wind_dir,
        }

    except Exception as e:
        _set_error(station_key, str(e))
        time.sleep(5)
        return None


def _set_unavailable(station_key, payload, feed_id):
    """Record a feed that answers OK but publishes no aggregate AQI.

    The station is real and may still report individual pollutants; it simply
    has no AQI to act on. Keeping that distinct from `status: error` lets the
    dashboard say "feed reports no AQI" rather than "awaiting telemetry".
    """
    iaqi = payload.get("iaqi", {}) or {}
    pollutants = {
        key: iaqi.get(key, {}).get("v")
        for key in ["pm25", "pm10", "no2", "so2", "o3", "co"]
        if iaqi.get(key, {}).get("v") is not None
    }

    waqi_time_str = payload.get("time", {}).get("s", "")
    waqi_time_iso = payload.get("time", {}).get("iso", "")
    stale_seconds = None
    if waqi_time_iso:
        try:
            waqi_dt = datetime.fromisoformat(waqi_time_iso.replace("Z", "+00:00"))
            stale_seconds = (datetime.now(timezone.utc) - waqi_dt).total_seconds()
        except Exception:
            pass

    previous = _debug_data.get(station_key, {})

    _debug_data[station_key] = {
        "waqi_aqi": None,
        "waqi_timestamp": waqi_time_str,
        "waqi_timestamp_iso": waqi_time_iso,
        "station_name_api": payload.get("city", {}).get("name", ""),
        "feed_id": feed_id,
        "raw_pm25": pollutants.get("pm25"),
        "raw_pm10": pollutants.get("pm10"),
        "raw_no2": pollutants.get("no2"),
        "raw_so2": pollutants.get("so2"),
        "raw_o3": pollutants.get("o3"),
        "raw_co": pollutants.get("co"),
        "pollutants_available": len(pollutants),
        "dominant_pollutant": max(pollutants, key=pollutants.get) if pollutants else "—",
        "wind_speed": iaqi.get("w", {}).get("v"),
        "wind_direction": iaqi.get("wd", {}).get("v"),
        "api_time": datetime.now(timezone.utc).strftime("%H:%M:%S"),
        "stale_seconds": stale_seconds,
        "waqi_timestamp_local": local_display(waqi_time_iso),
        "waqi_timestamp_utc": utc_display(waqi_time_iso),
        "feed_last_sync": extract_sync(payload),
        "status": "no_aqi",
        "error": "Feed publishes no aggregate AQI (WAQI reports '-')",
    }

    # This condition persists for as long as the station stays dormant, so log
    # it once per transition rather than on every poll.
    if previous.get("status") != "no_aqi":
        age = f", last reading {waqi_time_str}" if waqi_time_str else ""
        print(f"[AQI] {station_key} unavailable: no aggregate AQI{age}")


def _set_error(station_key, msg):
    """Record error state for UI display."""
    previous = _debug_data.get(station_key, {})
    _debug_data[station_key] = {
        "waqi_aqi": None,
        "waqi_timestamp": "",
        "waqi_timestamp_iso": "",
        "station_name_api": "",
        "feed_id": "",
        "raw_pm25": None,
        "raw_pm10": None,
        "raw_no2": None,
        "raw_so2": None,
        "raw_o3": None,
        "raw_co": None,
        "pollutants_available": 0,
        "dominant_pollutant": "—",
        "wind_speed": None,
        "wind_direction": None,
        "api_time": datetime.now(timezone.utc).strftime("%H:%M:%S"),
        "stale_seconds": None,
        "waqi_timestamp_local": None,
        "waqi_timestamp_utc": None,
        "feed_last_sync": None,
        "status": "error",
        "error": msg,
    }
    # Only log on transition: a persistently broken feed would otherwise print
    # on every poll interval.
    if previous.get("status") != "error" or previous.get("error") != msg:
        print(f"[AQI] {station_key} error: {msg}")