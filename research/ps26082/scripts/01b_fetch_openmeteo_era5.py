"""
Step 1b - ERA5 meteorology via the Open-Meteo archive API.

WHY THIS EXISTS ALONGSIDE 01_fetch_era5.py
    01 talks to the Copernicus CDS directly and is the canonical path, but it
    needs a CDS account and its queue can take hours per request. Open-Meteo
    re-serves the same ERA5 reanalysis over a plain REST API with no key and
    no queue, accepting an arbitrary date range in one call.

    For the validation gate that is strictly better: it removes the only
    hard external dependency between the team and a go/no-go answer. The CDS
    path stays in the repository because the operational system will want the
    native fields, and because a reviewer will ask whether we went to the
    primary source.

THE THREE FIELDS THAT MATTER
    boundary_layer_height   the H in lambda. ERA5 bulk-Richardson diagnostic,
                            with the known shallow-stable-layer bias that
                            Module B has to quantify.
    shortwave_radiation     surface downwelling SW - the S in lambda.
    terrestrial_radiation   top-of-atmosphere SW on a horizontal surface.

    The ratio SW / TOA is the classic CLEARNESS INDEX from solar meteorology.
    It removes solar geometry entirely, which is the single biggest confounder
    in the radiative term. What remains in the ratio is cloud plus aerosol -
    so cloud_cover is fetched too, and the aerosol term is estimated on
    low-cloud hours only. That is the standard way surface pyranometer records
    are used to infer aerosol attenuation.

SPATIAL SAMPLING
    A 3x3 grid across the NCR box rather than one point. lambda describes the
    airshed; one grid cell inherits that cell's land-surface assumptions.

OUTPUT
    data/interim/openmeteo_era5_ncr.parquet
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
OUT = C.INTERIM / "openmeteo_era5_ncr.parquet"

HOURLY_VARS = [
    "boundary_layer_height",
    "shortwave_radiation",
    "terrestrial_radiation",
    "cloud_cover",
    "temperature_2m",
    "relative_humidity_2m",
    "wind_speed_10m",
    "wind_direction_10m",
    "surface_pressure",
    "precipitation",
]

START = C.ARCHIVE_START
END = C.ARCHIVE_END


def grid_points(n: int = 3) -> list[tuple[float, float]]:
    """
    Evenly spaced sample points across the NCR bounding box.

    Its own function so the sampling density is one number to change, and so
    the same grid can be reused by the AOD and emissions fetchers later.
    """
    lats = np.linspace(C.NCR_LAT_RANGE[0] + 0.15, C.NCR_LAT_RANGE[1] - 0.15, n)
    lons = np.linspace(C.NCR_LON_RANGE[0] + 0.15, C.NCR_LON_RANGE[1] - 0.15, n)
    return [(round(float(la), 3), round(float(lo), 3)) for la in lats for lo in lons]


def fetch_point(lat: float, lon: float, retries: int = 4) -> pd.DataFrame:
    """
    Pull the full date range for one grid point.

    Retries with backoff because the archive API rate-limits rather than
    failing hard; a bare request would drop points silently and leave the
    domain mean computed over a varying number of cells.
    """
    params = {
        "latitude": lat, "longitude": lon,
        "start_date": START, "end_date": END,
        "hourly": ",".join(HOURLY_VARS),
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }
    for attempt in range(retries):
        try:
            r = requests.get(ARCHIVE, params=params, timeout=180)
            if r.status_code == 429:
                time.sleep(20 * (attempt + 1))
                continue
            r.raise_for_status()
            h = r.json()["hourly"]
            df = pd.DataFrame(h)
            df["datetime_utc"] = pd.to_datetime(df.pop("time"), utc=True)
            df["lat"], df["lon"] = lat, lon
            return df
        except Exception as exc:                       # noqa: BLE001
            if attempt == retries - 1:
                print(f"[om]   {lat},{lon} FAILED: {exc}")
                return pd.DataFrame()
            time.sleep(6 * (attempt + 1))
    return pd.DataFrame()


def to_domain_mean(frames: list[pd.DataFrame]) -> pd.DataFrame:
    """
    Collapse the grid to one hourly series per variable.

    Mean over grid points, matching the median-over-stations choice made for
    PM2.5: lambda is a property of the airshed, not of a single cell.
    """
    df = pd.concat(frames, ignore_index=True)
    num = [c for c in df.columns if c not in ("datetime_utc", "lat", "lon")]
    out = df.groupby("datetime_utc")[num].mean()
    out["n_cells"] = df.groupby("datetime_utc")["lat"].count()
    return out.sort_index()


def main() -> None:
    pts = grid_points(3)
    print(f"[om] {len(pts)} grid points  {START} -> {END}")
    print(f"[om] variables: {', '.join(HOURLY_VARS)}")

    frames = []
    for i, (la, lo) in enumerate(pts, 1):
        t0 = time.time()
        d = fetch_point(la, lo)
        if d.empty:
            continue
        frames.append(d)
        print(f"[om] ({i}/{len(pts)}) {la},{lo}  rows={len(d)}  "
              f"{time.time()-t0:.1f}s")
        time.sleep(1.5)

    if not frames:
        raise SystemExit("[om] nothing fetched")

    dom = to_domain_mean(frames)
    dom.to_parquet(OUT)
    print(f"\n[om] wrote {OUT}")
    print(f"[om] rows={len(dom)}  {dom.index.min()} .. {dom.index.max()}")
    print(f"[om] BLH   mean={dom.boundary_layer_height.mean():.0f} m  "
          f"min={dom.boundary_layer_height.min():.0f}  "
          f"max={dom.boundary_layer_height.max():.0f}")
    print(f"[om] SW    mean={dom.shortwave_radiation.mean():.0f} W/m2")
    print(f"[om] TOA   mean={dom.terrestrial_radiation.mean():.0f} W/m2")
    print(f"[om] wind  mean={dom.wind_speed_10m.mean():.2f} m/s")
    print(f"[om] cloud mean={dom.cloud_cover.mean():.0f} %")


if __name__ == "__main__":
    main()
