"""
Everything computed rather than fetched.

WHY THIS IS A SEPARATE PASS AND NOT PART OF INGESTION
    Derived columns are the ones most likely to change. Ventilation will not,
    but the plume feature almost certainly will once someone looks at what it
    predicts. If derivation happened during ingestion, improving a feature
    would mean re-pulling six winters from three APIs. Here it means dropping
    one table and re-running one command against data already on disk.

WHY THE VENTILATION THRESHOLD IS NOT A CONSTANT IN THIS FILE
    It is read from the same operating-point config the live engine uses, so
    the historical label and the running system cannot drift apart. A feature
    computed against 466 while production runs at some other number would make
    every backtest quietly wrong.

WHY THE FIRE GEOMETRY IS COPIED RATHER THAN IMPORTED
    ingestion/firms_stream.py has exactly the alignment function this needs,
    but it starts a live polling thread at import time. A batch script that
    silently opens a network poller is a bad neighbour, so the twenty lines of
    spherical geometry are restated here. If that module ever separates its
    maths from its poller, this should import it instead.
"""

from __future__ import annotations

import logging
import math
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from ..forecast import ventilation as vent

log = logging.getLogger("aree.backfill.features")

# Standard-atmosphere heights for the pressure levels we fetch. Used only to
# turn a temperature difference into a rate per kilometre; the levels move with
# surface pressure, so this is a scaling convention, not a measurement.
Z_925_M = 750.0
Z_850_M = 1500.0

# Plume transport parameters.
#   LOOKBACK   fires burn out but their smoke does not arrive instantly. A day
#              covers the Punjab-to-NCR transit at typical winter wind speeds.
#   DECAY_KM   e-folding distance. At 250 km a Punjab fire still contributes;
#              at 1000 km it effectively does not.
PLUME_LOOKBACK_HOURS = 24
PLUME_DECAY_KM = 250.0


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * r * math.asin(math.sqrt(a))


def _alignment(fire_lat: float, fire_lon: float,
               site_lat: float, site_lon: float,
               wind_from_deg: float | None) -> float:
    """
    How well a fire sits upwind of the site. 0.0 to 1.0.

    Meteorological convention: wind_direction is the direction the wind blows
    FROM, so a fire matters when its bearing from the site matches that
    direction. Getting this backwards points the model at the wrong half of the
    map and still produces plausible-looking numbers.
    """
    if wind_from_deg is None:
        return 0.0
    dlon = math.radians(fire_lon - site_lon)
    lat1, lat2 = math.radians(site_lat), math.radians(fire_lat)
    x = math.sin(dlon) * math.cos(lat2)
    y = (math.cos(lat1) * math.sin(lat2)
         - math.sin(lat1) * math.cos(lat2) * math.cos(dlon))
    bearing = (math.degrees(math.atan2(x, y)) + 360) % 360

    diff = abs(bearing - wind_from_deg)
    if diff > 180:
        diff = 360 - diff
    if diff <= 45:
        return 1.0 - (diff / 45.0) * 0.5
    return 0.0


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:00:00Z").replace(
        tzinfo=timezone.utc)


def _load_fires(conn: sqlite3.Connection) -> dict[datetime, list[tuple]]:
    """Fires bucketed by hour, so the plume pass is a lookup not a scan."""
    buckets: dict[datetime, list[tuple]] = defaultdict(list)
    for row in conn.execute(
            "SELECT timestamp, latitude, longitude, frp FROM fire_events"):
        try:
            ts = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            continue
        hour = ts.replace(minute=0, second=0, microsecond=0)
        buckets[hour].append((row["latitude"], row["longitude"],
                              row["frp"] or 0.0))
    return buckets


def build(conn: sqlite3.Connection) -> list[dict]:
    """
    Recompute derived_features from met_hourly and fire_events.

    Returns the rows rather than writing them, so the caller owns the
    transaction and a failed derivation cannot leave the table half-written.
    """
    op = vent.load_operating_point()
    threshold = float(op["threshold_m2_s"])
    min_hours = vent.MIN_COLLAPSE_HOURS

    fires = _load_fires(conn)
    met = conn.execute(
        "SELECT grid_id, timestamp, latitude, longitude, boundary_layer_height,"
        " wind_speed_10m, wind_direction_10m, temperature_2m, temperature_925,"
        " temperature_850 FROM met_hourly ORDER BY grid_id, timestamp"
    ).fetchall()

    by_grid: dict[str, list] = defaultdict(list)
    for row in met:
        by_grid[row["grid_id"]].append(row)

    out: list[dict] = []
    for grid_id, rows in by_grid.items():
        vcs: list[float | None] = []

        for row in rows:
            blh, ws_ = row["boundary_layer_height"], row["wind_speed_10m"]
            vc = blh * ws_ if (blh is not None and ws_ is not None) else None
            vcs.append(vc)

            t2, t925, t850 = (row["temperature_2m"], row["temperature_925"],
                              row["temperature_850"])
            # Positive means temperature RISES with height: a capping inversion.
            inversion = (t925 - t2) if (t925 is not None and t2 is not None) else None
            lapse = ((t2 - t850) / (Z_850_M / 1000.0)
                     if (t2 is not None and t850 is not None) else None)

            hour = _parse(row["timestamp"])
            influence = 0.0
            for back in range(PLUME_LOOKBACK_HOURS):
                for f_lat, f_lon, frp in fires.get(hour - timedelta(hours=back), ()):
                    align = _alignment(f_lat, f_lon, row["latitude"],
                                       row["longitude"], row["wind_direction_10m"])
                    if align <= 0.0:
                        continue
                    dist = _haversine_km(f_lat, f_lon, row["latitude"],
                                         row["longitude"])
                    influence += frp * align * math.exp(-dist / PLUME_DECAY_KM)

            out.append({
                "grid_id": grid_id,
                "timestamp": row["timestamp"],
                "ventilation_coefficient": vc,
                "inversion_strength": inversion,
                "lapse_rate": lapse,
                "plume_influence": round(influence, 3),
                "sustained_low_ventilation": 0,
            })

        # Second pass for the run-length flag. An hour is marked only if it sits
        # inside a run of >= min_hours consecutive hours at or below threshold -
        # the same rule the live engine applies, so a historical label and a
        # live alert mean the same thing.
        start = idx = 0
        base = len(out) - len(rows)
        while idx <= len(vcs):
            below = idx < len(vcs) and vcs[idx] is not None and vcs[idx] <= threshold
            if below:
                idx += 1
                continue
            if idx - start >= min_hours:
                for j in range(start, idx):
                    out[base + j]["sustained_low_ventilation"] = 1
            idx += 1
            start = idx

    log.info("derived %d rows (threshold %.1f m2/s, run >= %d h)",
             len(out), threshold, min_hours)
    return out
