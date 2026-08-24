# firms_stream.py — NASA FIRMS Satellite Fire Detection
# Polls VIIRS_SNPP_NRT for thermal anomalies near monitoring stations.
# Decoupled from AQI ingestion. Runs in its own thread.
# Graceful degradation: fire_count = 0 on failure.

import csv
import io
import math
import threading
import time
import requests
from datetime import datetime

from config import (
    FIRMS_API_KEY, FIRMS_DATASET, FIRMS_POLL_MINUTES,
    FIRMS_BBOX_DELTA, FIRMS_LOOKBACK_DAYS, FIRMS_CONFIDENCE_FILTER,
    STATIONS,
)

FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{dataset}/{bbox}/{days}"

# ── Module-level cache (thread-safe via GIL for simple reads) ──
firms_cache = {}
_firms_lock = threading.Lock()


def _bbox_str(lat, lon, delta):
    """Build W,S,E,N bounding box string."""
    return f"{lon - delta:.4f},{lat - delta:.4f},{lon + delta:.4f},{lat + delta:.4f}"


def _poll_firms():
    """Background poller: queries NASA FIRMS for each station."""
    while True:
        for city, info in STATIONS.items():
            lat, lon = info["lat"], info["lon"]
            bbox = _bbox_str(lat, lon, FIRMS_BBOX_DELTA)
            try:
                url = FIRMS_URL.format(
                    key=FIRMS_API_KEY,
                    dataset=FIRMS_DATASET,
                    bbox=bbox,
                    days=FIRMS_LOOKBACK_DAYS,
                )
                resp = requests.get(url, timeout=30)

                if resp.status_code != 200 or not resp.text.strip():
                    _set_failure(city, f"HTTP {resp.status_code}")
                    continue

                # Parse CSV
                reader = csv.DictReader(io.StringIO(resp.text))
                fires = []
                for row in reader:
                    conf = row.get("confidence", "").strip().lower()
                    if conf in FIRMS_CONFIDENCE_FILTER:
                        fires.append({
                            "lat": float(row.get("latitude", 0)),
                            "lon": float(row.get("longitude", 0)),
                            "confidence": conf,
                            "frp": float(row.get("frp", 0)),
                            "acq_date": row.get("acq_date", ""),
                            "acq_time": row.get("acq_time", ""),
                        })

                high_conf = sum(1 for f in fires if f["confidence"] == "high")

                with _firms_lock:
                    firms_cache[city] = {
                        "fire_count": len(fires),
                        "high_confidence": high_conf,
                        "nominal": len(fires) - high_conf,
                        "fires": fires,
                        "bbox": bbox,
                        "last_sync": datetime.utcnow().strftime("%H:%M:%S"),
                        "status": "ok",
                        "error": None,
                        "total_raw": len(fires),
                        "dataset": FIRMS_DATASET,
                    }

            except Exception as e:
                _set_failure(city, str(e))

        time.sleep(FIRMS_POLL_MINUTES * 60)


def _set_failure(city, error_msg):
    """Set cache to degraded state on failure."""
    with _firms_lock:
        firms_cache[city] = {
            "fire_count": 0,
            "high_confidence": 0,
            "nominal": 0,
            "fires": [],
            "bbox": "",
            "last_sync": datetime.utcnow().strftime("%H:%M:%S"),
            "status": "error",
            "error": error_msg,
            "total_raw": 0,
            "dataset": FIRMS_DATASET,
        }
    print(f"[FIRMS] {city} error: {error_msg}")


def get_firms_data(city):
    """Thread-safe read of cached FIRMS data."""
    with _firms_lock:
        return firms_cache.get(city, {
            "fire_count": 0, "high_confidence": 0, "nominal": 0,
            "fires": [], "bbox": "", "last_sync": "—",
            "status": "awaiting", "error": None,
            "total_raw": 0, "dataset": FIRMS_DATASET,
        })


def compute_wind_alignment(fire_lat, fire_lon, station_lat, station_lon, wind_dir):
    """
    Determine if a fire is upwind of the station.
    Returns alignment factor (0.0 to 1.0).
    """
    if wind_dir is None:
        return 0.0

    # Bearing from station to fire
    dlat = math.radians(fire_lat - station_lat)
    dlon = math.radians(fire_lon - station_lon)
    lat1 = math.radians(station_lat)
    lat2 = math.radians(fire_lat)
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    bearing = (math.degrees(math.atan2(x, y)) + 360) % 360

    # Wind blows FROM wind_dir, so upwind fires are in the direction the wind comes from
    # Fire at bearing B is upwind if B ≈ wind_dir
    diff = abs(bearing - wind_dir)
    if diff > 180:
        diff = 360 - diff

    if diff <= 45:
        return 1.0 - (diff / 45.0) * 0.5  # 1.0 at perfect alignment, 0.5 at 45°
    return 0.0


def compute_transport_score(city, wind_dir, wind_speed):
    """
    Deterministic transport score (0-100).
    Combines fire count with wind alignment.
    """
    from config import WIND_SPEED_MIN, FIRE_TRANSPORT_THRESHOLD

    data = get_firms_data(city)
    if data["fire_count"] == 0 or wind_speed is None:
        return 0, 0, "none"

    if wind_speed < WIND_SPEED_MIN:
        return 0, 0, "calm"

    station = STATIONS.get(city, {})
    slat, slon = station.get("lat", 0), station.get("lon", 0)

    aligned_count = 0
    total_alignment = 0.0

    for fire in data["fires"]:
        a = compute_wind_alignment(fire["lat"], fire["lon"], slat, slon, wind_dir)
        if a > 0:
            aligned_count += 1
            total_alignment += a

    if aligned_count == 0:
        return 0, aligned_count, "none"

    # Score: weighted fire count * alignment * wind factor
    fire_factor = min(1.0, data["fire_count"] / 10.0)
    alignment_factor = total_alignment / max(aligned_count, 1)
    wind_factor = min(1.0, wind_speed / 10.0)

    score = int(min(100, fire_factor * alignment_factor * wind_factor * 100))

    # Attribution label
    if aligned_count >= FIRE_TRANSPORT_THRESHOLD and score > 30:
        label = "regional_transport"
    elif aligned_count > 0:
        label = "possible_transport"
    else:
        label = "local_emission"

    return score, aligned_count, label


# ── Start background poller ──
_poller_thread = threading.Thread(target=_poll_firms, daemon=True)
_poller_thread.start()


# --- Pathway ConnectorSubject for fire data integration ---

class FIRMSConnectorSubject:
    """
    Pathway ConnectorSubject that emits per-station fire data
    into a Pathway table. Wraps existing FIRMS polling cache.
    """
    def __init__(self, poll_interval=None):
        self.poll_interval = poll_interval or (FIRMS_POLL_MINUTES * 60)

    def run(self):
        import time as _time
        from datetime import timezone as _tz
        # wait for initial FIRMS data to load
        _time.sleep(10)
        while True:
            for city in STATIONS:
                data = get_firms_data(city)
                record = {
                    "timestamp": datetime.now(_tz.utc),
                    "city": city,
                    "fire_count": data["fire_count"],
                    "high_confidence": data["high_confidence"],
                    "transport_status": data["status"],
                }
                self.next(**record)
            _time.sleep(self.poll_interval)

