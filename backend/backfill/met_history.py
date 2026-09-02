"""
Historical meteorology for the NCR grid, via the Open-Meteo ERA5 archive.

WHY A 3x3 GRID AND NOT ONE POINT
    The live path is a single point at the NCR centroid, and for a live
    ventilation outlook that is defensible: one number for one airshed. A
    training corpus is different. One grid cell inherits that cell's
    land-surface assumptions - its roughness, its albedo, its urban fraction -
    and a model fitted on it learns those as if they were atmosphere. Sampling
    the box gives the fit something closer to the airshed it is supposed to
    describe.

    The grid is small (3x3 by default) because ERA5 is ~31 km native: more
    points inside the NCR box would be interpolation, not information.

WHY THIS IS ERA5 AND WHAT THAT COSTS
    Reanalysis assimilates observations that were not available at forecast
    time. It is the right thing to TRAIN on and the wrong thing to SCORE on.
    Rows land with is_forecast=False and a source of "openmeteo:era5" so the
    distinction survives into the database, where the next person to write a
    scoring script will see it.

RATE LIMITING
    The archive endpoint takes an arbitrary date range in one request, so a
    six-winter pull for nine points is nine requests, not thousands. There is
    no burst to manage - which is exactly why the range is requested whole
    rather than chunked.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime

from ..ingestion import weather_stream as ws

log = logging.getLogger("aree.backfill.met")

# Seconds between grid-point requests. A 4.5-year hourly pull is a large
# response and nine in a row exceeded what Open-Meteo would serve.
REQUEST_SPACING_S = 5.0

# Grid points whose last fetch came back empty. Module-level because the CLI
# has to be able to say "5 of 9 points returned nothing" rather than printing a
# row count that looks like success.
failed: list[str] = []

# Delhi NCR sampling box. Tighter than the station bbox because we want the
# urban airshed, not the whole administrative region.
GRID_LAT = (28.40, 28.63, 28.86)
GRID_LON = (76.95, 77.22, 77.49)

ARCHIVE_VARS = ws.HOURLY_VARS + ws.ARCHIVE_PRESSURE_VARS

# Open-Meteo column name -> our column name. Explicit rather than a prefix rule
# so a renamed upstream field fails loudly at the mapping instead of quietly
# writing NULLs.
COLUMN_MAP = {
    "temperature_2m": "temperature_2m",
    "relative_humidity_2m": "relative_humidity",
    "wind_speed_10m": "wind_speed_10m",
    "wind_direction_10m": "wind_direction_10m",
    "precipitation": "precipitation",
    "shortwave_radiation": "solar_radiation",
    "terrestrial_radiation": "terrestrial_radiation",
    "cloud_cover": "cloud_cover",
    "surface_pressure": "surface_pressure",
    "boundary_layer_height": "boundary_layer_height",
    "temperature_1000hPa": "temperature_1000",
    "temperature_925hPa": "temperature_925",
    "temperature_850hPa": "temperature_850",
}


def grid_points(lats=GRID_LAT, lons=GRID_LON) -> list[tuple[str, float, float]]:
    """
    The sampling points, each with a stable id.

    The id is derived from the coordinates rather than an index so that adding
    a point later does not renumber the existing ones - which would silently
    re-label every historical row already in the store.
    """
    return [(f"ncr_{lat:.2f}_{lon:.2f}", lat, lon)
            for lat in lats for lon in lons]


def _to_records(rows: list[dict], grid_id: str, lat: float, lon: float,
                source: str) -> list[dict]:
    out = []
    for r in rows:
        rec = {
            "grid_id": grid_id,
            "timestamp": r["observed_at"],
            "latitude": lat,
            "longitude": lon,
            "source": source,
        }
        for upstream, column in COLUMN_MAP.items():
            rec[column] = r.get(upstream)
        out.append(rec)
    return out


def pressure_coverage(rows: list[dict]) -> float:
    """
    Fraction of rows that actually carry a 925 hPa temperature.

    Exists because the archive returns nulls for pressure levels without
    erroring (see weather_stream.ARCHIVE_PRESSURE_VARS). Measuring the coverage
    and reporting it is the difference between a known limitation and a column
    of silent NULLs that someone later mistakes for missing weather.
    """
    if not rows:
        return 0.0
    have = sum(1 for r in rows if r.get("temperature_925") is not None)
    return have / len(rows)


def fetch_grid(start: datetime, end: datetime,
               points: list[tuple[str, float, float]] | None = None
               ) -> list[dict]:
    """ERA5 hourly for every grid point over the range, ready for met_hourly."""
    points = points or grid_points()
    lo, hi = start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")
    out: list[dict] = []
    failed.clear()

    for i, (grid_id, lat, lon) in enumerate(points):
        # Space the requests out. A multi-year hourly pull is a large response,
        # and nine back to back tripped Open-Meteo's limiter: four grid points
        # returned data and five came back empty, which _fetch reports as [] -
        # indistinguishable from "no data for this range" unless someone is
        # counting. Hence both the pause and the `failed` list.
        if i:
            time.sleep(REQUEST_SPACING_S)
        rows = ws.fetch_archive(lat, lon, lo, hi, variables=ARCHIVE_VARS)
        if not rows:
            log.warning("  %s: archive returned nothing for %s..%s",
                        grid_id, lo, hi)
            failed.append(grid_id)
            continue
        out.extend(_to_records(rows, grid_id, lat, lon, "openmeteo:era5"))
        log.info("  %s: %d hours", grid_id, len(rows))

    if out and pressure_coverage(out) == 0.0:
        log.warning(
            "  pressure levels absent for the whole pull — the ERA5 archive "
            "serves surface fields only. inversion_strength and lapse_rate "
            "will be NULL for this range. Use `met-recent` for the last ~92 "
            "days, or Copernicus CDS for the full period.")
    return out


def fetch_recent_grid(days: int = 92,
                      points: list[tuple[str, float, float]] | None = None
                      ) -> list[dict]:
    """
    The last ~92 days from the forecast endpoint's own analysis window.

    Worth having as a separate command because this is the ONLY Open-Meteo path
    that returns pressure-level temperature, and therefore the only one from
    which inversion strength can be computed. It overlaps the archive; the
    upsert key means re-running it simply fills in the columns the archive left
    null for those hours.
    """
    points = points or grid_points()
    out: list[dict] = []
    for grid_id, lat, lon in points:
        rows = ws.fetch_recent(lat, lon, past_days=days, variables=ARCHIVE_VARS)
        if not rows:
            log.warning("  %s: no recent analysis returned", grid_id)
            continue
        out.extend(_to_records(rows, grid_id, lat, lon, "openmeteo:forecast_analysis"))
        log.info("  %s: %d hours", grid_id, len(rows))
    return out
