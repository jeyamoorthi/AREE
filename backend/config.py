# Central configuration

import os
from dotenv import load_dotenv

# .env lives at the project root (one level above backend/). Resolve it
# explicitly so the engine works regardless of the process working directory.
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))
load_dotenv()

# API keys
WAQI_TOKEN = os.getenv("WAQI_TOKEN", "")
FIRMS_API_KEY = os.getenv("FIRMS_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Gemini model id. Google retires model ids over time — `gemini-2.5-flash-lite`
# became unavailable to new keys and the API now points callers at the 3.5 line.
# Override with GEMINI_MODEL if this one is retired too; the engine falls back to
# deterministic analysis when the call fails, so a stale id degrades silently.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")

# verified WAQI feed IDs
STATIONS = {
    "SIDCO Kurichi (Coimbatore) — @11847": {
        "feed_id": "@11847",
        "lat": 11.0000,
        "lon": 76.9700,
        "city": "Coimbatore",
    },
    "BTM (Bangalore) — @8190": {
        "feed_id": "@8190",
        "lat": 12.9166,
        "lon": 77.6101,
        "city": "Bangalore",
    },
    "Tirumala (Tirupati) — @9069": {
        "feed_id": "@9069",
        "lat": 13.6833,
        "lon": 79.3500,
        "city": "Tirupati",
    },
    "NSIT Dwarka (Delhi) — A568246": {
        "feed_id": "A568246",
        "lat": 28.6100,
        "lon": 77.0400,
        "city": "Delhi",
    },
    "Anand Vihar (Delhi) — @2553": {
        "feed_id": "@2553",
        "lat": 28.6468,
        "lon": 77.3162,
        "city": "Delhi",
    },
}

CITY_NAMES = list(STATIONS.keys())

# polling intervals (seconds)
AQI_POLL_INTERVAL = 30
FIRE_POLL_INTERVAL = 60

# persistence / escalation
PERSISTENCE_THRESHOLD = 3
HIGH_AQI_THRESHOLD = 300
WINDOW_DURATION_MINUTES = 3
WINDOW_HOP_MINUTES = 1
HYSTERESIS_CONFIRMATIONS = 2

# CPCB bands
CPCB_BANDS = [
    (0,   50,  "Good"),
    (51,  100, "Satisfactory"),
    (101, 200, "Moderate"),
    (201, 300, "Poor"),
    (301, 400, "Very Poor"),
    (401, 500, "Severe"),
]

# GRAP stages, as published by CAQM.
#
# CORRECTION, 2026-09: this table previously read 101-200 -> "Stage I (Poor)", which
# shifted every stage down by one and made ordinary Delhi air (AQI 101-200, CPCB
# "Moderate") display as a GRAP stage. The CAQM schedule in policies/ is explicit:
#
#     Stage I   'Poor'      AQI 201-300
#     Stage II  'Very Poor' AQI 301-400
#     Stage III 'Severe'    AQI 401-450
#     Stage IV  'Severe+'   AQI >450
#
# The stage bands are NOT the CPCB_BANDS above: CPCB's "Poor" band starts at 201 and
# GRAP Stage I starts with it, but the two tables diverge from there (CPCB tops out at
# 401-500 "Severe", GRAP splits 401-450 / >450). Keeping both tables is correct; keeping
# them in disagreement about GRAP was the bug.
#
# streaming/predictive_engine.py::GRAP_BY_AQI carries the same boundaries for the
# predictive path. backend/tests_grap.py asserts the two agree for every AQI in 0..600 -
# a GRAP stage that differs depending on which code path produced it is worse than
# either answer alone.
GRAP_STAGES = [
    (0,    200,  "None",                  "No GRAP action required"),
    (201,  300,  "Stage I (Poor)",        "Actions under GRAP Stage I"),
    (301,  400,  "Stage II (Very Poor)",  "Actions under GRAP Stage II"),
    (401,  450,  "Stage III (Severe)",    "Actions under GRAP Stage III"),
    # 9999 rather than 500: AQI is uncapped above 450 and the dashboard renders this
    # sentinel as "451+". A 500 upper bound silently returned "None" for AQI 501.
    (451,  9999, "Stage IV (Severe+)",    "Emergency actions under GRAP Stage IV"),
]

# NASA FIRMS
FIRMS_DATASET = "VIIRS_SNPP_NRT"
FIRMS_POLL_MINUTES = 5
FIRMS_BBOX_DELTA = 0.15
FIRMS_LOOKBACK_DAYS = 1
FIRMS_CONFIDENCE_FILTER = ["high", "nominal"]
WIND_ALIGNMENT_THRESHOLD = 45
WIND_SPEED_MIN = 2.0
FIRE_TRANSPORT_THRESHOLD = 3

# multi-window analysis
WINDOW_5MIN_DURATION = 5
WINDOW_15MIN_DURATION = 15

# causal attribution
CAUSAL_FIRE_THRESHOLD = 30
CAUSAL_WIND_THRESHOLD = 2.0

# ── Feed freshness classification ──
# WAQI publishes hourly, so a newest reading is routinely 0-60+ min old: a
# healthy London feed was measured at ~100 min and Beijing at ~40 min. The old
# 20-minute threshold therefore flagged functioning feeds as stale. These bands
# describe the upstream cadence, not a relaxation of the warning - anything past
# STALE_DATA_THRESHOLD_SECONDS is still reported prominently as stale.
#   current : 0-90 min      feed recent enough for normal operation
#   aging   : >90-120 min   older than expected, still plausible for hourly
#   stale   : >120 min      exceeded the acceptable freshness window
FRESH_DATA_THRESHOLD_SECONDS = 90 * 60   # 90 min
STALE_DATA_THRESHOLD_SECONDS = 120 * 60  # 120 min

# policy directory
POLICY_DIR = os.path.join(os.path.dirname(__file__), "policies")

# VPPE multipliers
VULNERABILITY_MULTIPLIERS = {
    "general": 1.0,
    "elderly": 1.4,
    "children": 1.6,
    "respiratory": 1.8,
}

# impact estimation (static placeholders)
DEFAULT_IMPACT_RADIUS_KM = 5
DEFAULT_EST_POPULATION = 500000
