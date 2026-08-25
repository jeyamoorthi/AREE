"""
Central configuration for the PS 26082 lambda-validation pipeline.

Everything that a reviewer might want to change - domain, seasons, thresholds,
variable names - lives here rather than being scattered through the scripts.
That is deliberate: the scientific claim depends on these numbers, so they must
be inspectable in one place and diffable in version control.
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------- paths
# Everything stays on D:. Nothing is written to the system drive.

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
INTERIM = DATA / "interim"
PROCESSED = DATA / "processed"
FIGURES = ROOT / "figures"

for _d in (RAW, INTERIM, PROCESSED, FIGURES):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- domain
# Delhi NCR bounding box. CDS wants [North, West, South, East].
# Chosen to cover Delhi + Gurugram + Noida + Ghaziabad + Faridabad, with a
# margin north-west toward Punjab/Haryana so advected stubble smoke is inside
# the domain rather than arriving from outside it.

NCR_BBOX_NWSE = [29.3, 76.5, 27.9, 77.9]
NCR_LAT_RANGE = (27.9, 29.3)
NCR_LON_RANGE = (76.5, 77.9)

# Point used for the single-column diagnostic (central Delhi).
DELHI_LAT, DELHI_LON = 28.63, 77.22

# ---------------------------------------------------------------- time
# Pollution season only. Running Mar-Sep would dilute the sample with a regime
# where the feedback is physically inactive (deep PBL, monsoon washout) and
# would flatter the classifier for the wrong reason.

YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]
SEASON_MONTHS = [10, 11, 12, 1, 2]      # Oct-Feb

# WHY THE WINDOW STARTS IN 2018 AND NOT 2020
#     OpenAQ's dense Indian CPCB coverage runs 2018-08 to 2022-10. After that
#     the old sensor generation retires and nothing but the US Embassy monitor
#     reports until Feb 2025 - a gap present in OpenAQ's S3 archive too, so it
#     is missing data rather than an API limitation, and CPCB's own portal is
#     captcha-gated.
#
#     The fix is therefore to extend BACKWARDS into coverage that exists
#     rather than forwards into coverage that does not. Starting in 2018 buys
#     two extra multi-station winters (2018-19, 2019-20) and roughly doubles
#     the episodes backed by a real network instead of one instrument.
ARCHIVE_START = "2018-06-01"
ARCHIVE_END = "2025-03-31"

# Held out from every fitting step.
#
# Deliberately chosen from the DENSE period. The earlier choice of Nov 2023 and
# Nov 2024 was severe-episode-wise ideal but sat inside the single-station gap,
# so the held-out evaluation rested on one monitor. Two dense Novembers are a
# weaker headline and a far stronger test.
HOLDOUT_PERIODS = [
    ("2019-11-01", "2019-11-30"),
    ("2021-11-01", "2021-11-30"),
]

# Retained for reference: the sparse Novembers are still evaluated, but
# reported separately and flagged as single-station.
SPARSE_HOLDOUT_PERIODS = [
    ("2023-11-01", "2023-11-30"),
    ("2024-11-01", "2024-11-30"),
]

# ---------------------------------------------------------------- ERA5
# Short names as they appear in the returned NetCDF, mapped to the long CDS
# request names.
ERA5_VARIABLES = {
    "blh":   "boundary_layer_height",
    "ssrd":  "surface_solar_radiation_downwards",
    "ssrdc": "surface_solar_radiation_downward_clear_sky",
    "t2m":   "2m_temperature",
    "d2m":   "2m_dewpoint_temperature",
    "u10":   "10m_u_component_of_wind",
    "v10":   "10m_v_component_of_wind",
    "sp":    "surface_pressure",
    "tp":    "total_precipitation",
    "sshf":  "surface_sensible_heat_flux",
}

ERA5_DATASET = "reanalysis-era5-single-levels"

# ---------------------------------------------------------------- ground AQ
# CPCB CAAQMS stations inside the NCR domain. feed ids are WAQI's; the
# station_id fields are filled in by the OpenAQ resolver at fetch time.
NCR_STATIONS = {
    "Anand Vihar":      {"lat": 28.6468, "lon": 77.3162, "waqi": "@2553"},
    "NSIT Dwarka":      {"lat": 28.6100, "lon": 77.0400, "waqi": "A568246"},
    "RK Puram":         {"lat": 28.5631, "lon": 77.1866, "waqi": None},
    "Punjabi Bagh":     {"lat": 28.6742, "lon": 77.1310, "waqi": None},
    "ITO":              {"lat": 28.6285, "lon": 77.2410, "waqi": None},
    "Rohini":           {"lat": 28.7325, "lon": 77.1197, "waqi": None},
    "Sector 62 Noida":  {"lat": 28.6242, "lon": 77.3578, "waqi": None},
    "Vasundhara Ghz":   {"lat": 28.6603, "lon": 77.3572, "waqi": None},
    "Gurugram Sec 51":  {"lat": 28.4211, "lon": 77.0468, "waqi": None},
}

# ---------------------------------------------------------------- physics
# Solar-hour mask. The aerosol-radiation term is only defined when the sun is
# up; at night SSRD is zero and ln(SSRD/SSRDC) is undefined. All radiation-
# dependent elasticities are therefore fitted on daytime hours only.
DAY_HOURS_IST = (9, 16)          # inclusive, local solar-ish window
IST_OFFSET_HOURS = 5.5

# Minimum clear-sky flux (W m-2) below which the clearness ratio is too noisy
# to use. Filters dawn/dusk geometry.
MIN_SSRDC_WM2 = 120.0

# Rolling window (hours) over which the local elasticities are estimated.
# 15 days of daytime hours ~ 120 samples, enough for a stable 3-term fit
# without smearing across regime changes.
ELASTICITY_WINDOW_HOURS = 24 * 15
ELASTICITY_MIN_SAMPLES = 40

# ---------------------------------------------------------------- episodes
# An "episode" is a contiguous run of hours above the PM2.5 threshold.
EPISODE_PM25_THRESHOLD = 120.0     # ug m-3, ~ CPCB "Very Poor" in PM2.5 terms
EPISODE_MIN_DURATION_H = 12
EPISODE_MERGE_GAP_H = 6

# Lock-in classification: an episode "locked in" if it both persisted and
# intensified rather than ventilating out.
LOCKIN_MIN_DURATION_H = 48
LOCKIN_PEAK_PM25 = 250.0

# ---------------------------------------------------------------- secrets
CDS_URL = os.getenv("CDSAPI_URL", "https://cds.climate.copernicus.eu/api")
CDS_KEY = os.getenv("CDSAPI_KEY", "")
OPENAQ_KEY = os.getenv("OPENAQ_API_KEY", "")
FIRMS_KEY = os.getenv("FIRMS_MAP_KEY", "")
