"""
Step 1 - pull ERA5 hourly reanalysis for the Delhi NCR domain.

WHY THIS EXISTS
    lambda needs three state variables that no ground network in India reports
    at hourly cadence: boundary layer height, surface shortwave down, and the
    clear-sky shortwave that lets us separate aerosol attenuation from cloud
    and solar geometry. ERA5 is the only free source that supplies all three,
    hourly, back to 1940, on a consistent grid.

WHY ERA5 AND NOT RADIOSONDE
    IMD launches two radiosondes a day from Safdarjung. Two profiles per day
    cannot resolve a feedback whose whole story is the daytime PBL growth
    curve. ERA5 gives 24 values a day. The cost is that ERA5 PBLH is a bulk
    Richardson-number diagnostic and is known to be biased in shallow stable
    layers, which is exactly our regime of interest - so step 6 quantifies that
    bias against radiosonde rather than ignoring it.

WHY ssrdc IS REQUESTED ALONGSIDE ssrd
    ssrd alone is dominated by solar zenith angle and cloud. The aerosol signal
    is the *ratio* ssrd/ssrdc (a clearness index). Requesting the clear-sky
    field is what makes the radiative term of lambda estimable at all. Without
    it the term is confounded by cloud and the whole diagnostic is worthless.

OUTPUT
    data/raw/era5_<year>_<month>.nc, one file per year-month, so a failed
    request retries cheaply instead of restarting a five-year pull.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C


def build_request(year: int, month: int) -> dict:
    """
    Assemble one CDS request payload.

    Kept as its own function so the request can be unit-tested and printed
    without network access - a reviewer can see exactly what was asked for.
    """
    n_days = {1: 31, 2: 29, 10: 31, 11: 30, 12: 31}[month]
    return {
        "product_type": ["reanalysis"],
        "variable": list(C.ERA5_VARIABLES.values()),
        "year": [str(year)],
        "month": [f"{month:02d}"],
        "day": [f"{d:02d}" for d in range(1, n_days + 1)],
        "time": [f"{h:02d}:00" for h in range(24)],
        "area": C.NCR_BBOX_NWSE,
        "data_format": "netcdf",
        "download_format": "unarchived",
    }


def season_year_months() -> list[tuple[int, int]]:
    """
    Expand YEARS x SEASON_MONTHS into concrete (year, month) pairs.

    Oct-Dec belong to the labelled year; Jan-Feb belong to the following
    calendar year. Getting this wrong silently shifts every winter by two
    months, so it is isolated here rather than inlined.
    """
    out = []
    for y in C.YEARS:
        for m in C.SEASON_MONTHS:
            cal_year = y if m >= 10 else y + 1
            if cal_year > max(C.YEARS):
                continue
            out.append((cal_year, m))
    return sorted(set(out))


def target_path(year: int, month: int) -> Path:
    return C.RAW / f"era5_{year}_{month:02d}.nc"


def fetch_all(dry_run: bool = False) -> None:
    pairs = season_year_months()
    print(f"[era5] {len(pairs)} year-month requests queued")
    print(f"[era5] domain N/W/S/E = {C.NCR_BBOX_NWSE}")
    print(f"[era5] variables      = {list(C.ERA5_VARIABLES.keys())}")

    if dry_run:
        y, m = pairs[0]
        import json
        print("\n[era5] example request payload:")
        print(json.dumps(build_request(y, m), indent=2)[:1200])
        print("\n[era5] targets:")
        for y, m in pairs:
            print("   ", target_path(y, m).name)
        return

    import cdsapi
    client = cdsapi.Client(url=C.CDS_URL, key=C.CDS_KEY) if C.CDS_KEY else cdsapi.Client()

    for i, (y, m) in enumerate(pairs, 1):
        out = target_path(y, m)
        if out.exists() and out.stat().st_size > 10_000:
            print(f"[era5] ({i}/{len(pairs)}) {out.name} exists, skip")
            continue
        print(f"[era5] ({i}/{len(pairs)}) requesting {y}-{m:02d} ...")
        t0 = time.time()
        try:
            client.retrieve(C.ERA5_DATASET, build_request(y, m), str(out))
            print(f"[era5]     ok  {out.stat().st_size/1e6:.1f} MB  "
                  f"{time.time()-t0:.0f}s")
        except Exception as exc:                      # noqa: BLE001
            print(f"[era5]     FAILED {y}-{m:02d}: {exc}")


if __name__ == "__main__":
    fetch_all(dry_run="--dry-run" in sys.argv)
