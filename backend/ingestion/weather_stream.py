"""
Meteorological ingestion for the coupled forecasting pipeline.

WHY THIS FILE WAS EMPTY, AND WHY THAT MATTERED
    Until now AREE ingested no meteorology at all. The only weather-like
    quantities in the system were wind speed and bearing, and those arrived
    incidentally inside the WAQI air-quality payload rather than from any
    weather source. For SIH25216 that was survivable: the question was "is AQI
    high", and AQI is measured directly.

    PS 26082 asks a different question. Its subject IS the coupling between
    meteorology and chemistry - specifically that aerosol loading suppresses
    surface shortwave, which suppresses the sensible heat flux, which collapses
    the boundary layer, which concentrates the aerosol further. None of the
    state variables in that sentence existed anywhere in this codebase.

WHAT THIS MODULE SUPPLIES
    boundary_layer_height   the mixing depth. The single most important
                            meteorological control on surface concentration,
                            and the H in the lambda diagnostic.
    shortwave_radiation     surface downwelling SW.
    terrestrial_radiation   top-of-atmosphere SW. The ratio of the two is the
                            clearness index, which is how aerosol attenuation
                            is separated from solar geometry.
    cloud_cover             needed to tell cloud attenuation from aerosol
                            attenuation in that ratio.
    temperature / RH / wind / pressure / precipitation

WHY OPEN-METEO
    It serves ECMWF-family fields (ERA5 for the archive, GFS/ECMWF for the
    forecast) over plain REST, with no key, no queue and an arbitrary horizon
    in one call. The Copernicus CDS is the primary source for the historical
    training corpus, but it is unusable inside a live loop: requests queue for
    minutes to hours. For an operational path that must re-anchor continuously,
    a low-latency REST endpoint is the correct dependency.

TIME SEMANTICS
    Every record carries observed_at (the hour the value describes),
    received_at (when we fetched it) and, for forecast rows, issued_at. The
    existing feed_time.py freshness machinery consumes these. Forecast rows are
    flagged is_forecast so nothing downstream can mistake a prediction for an
    observation - which, in a system that generates regulatory escalations, is
    the failure mode that matters most.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import requests

log = logging.getLogger("aree.weather")

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

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

# Pressure-level temperatures. Inversion strength is what these exist for: a
# temperature that RISES with height caps the mixed layer, and is the mechanism
# behind the shallow winter boundary layer whose consequence ventilation
# already measures.
#
# MEASURED LIMITATION, DO NOT REDISCOVER THIS THE HARD WAY
#   The ARCHIVE endpoint accepts these names and answers HTTP 200 with a fully
#   populated `hourly` block in which every pressure-level value is null. It
#   does not reject the request and it does not set `reason`. Verified on
#   2024-11-01 for temperature_1000hPa / _925hPa / _850hPa, with and without
#   models=era5, and on the /v1/era5 alias:
#
#       temperature_2m       [19.6, 19.4, 20.3, 22.9]
#       temperature_925hPa   [None, None, None, None]
#
#   The FORECAST endpoint does serve them (verified: [25.3, 25.9, 26.1]), but
#   only across its own window - roughly 92 past days. So inversion strength is
#   computable for recent weeks and NOT for the 2019-2025 training corpus from
#   this source. Pressure levels for the full period need Copernicus CDS
#   directly (research/ps26082/scripts/01_fetch_era5.py), which is why that
#   script stays in the repository.
#
#   This is the same failure mode as the OpenAQ bbox bug and the CAQM
#   timestamp-free payload: an endpoint that answers confidently rather than
#   refusing, so the wrong answer looks exactly like the right one.
ARCHIVE_PRESSURE_VARS = [
    "temperature_1000hPa",
    "temperature_925hPa",
    "temperature_850hPa",
]

# Delhi NCR centroid. Callers pass explicit coordinates for per-station pulls.
DEFAULT_LAT, DEFAULT_LON = 28.63, 77.22

# Minimum top-of-atmosphere flux (W m-2) for the clearness ratio to be
# meaningful. Below this the sun is too low and the ratio is dominated by
# geometry and horizon effects rather than by atmospheric transmission.
MIN_TOA_WM2 = 120.0


def _rows_from_payload(payload: dict, is_forecast: bool,
                       variables: list[str] | None = None) -> list[dict]:
    """
    Convert an Open-Meteo hourly block into flat per-hour records.

    Kept separate from the HTTP call so the same parser serves both the archive
    and forecast endpoints, which return an identical hourly structure. One
    parser means the two paths cannot drift into producing different schemas -
    the exact class of bug that makes a replayed backtest disagree with live.
    """
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    received = datetime.now(timezone.utc)

    rows = []
    for i, t in enumerate(times):
        observed = datetime.fromisoformat(t).replace(tzinfo=timezone.utc)
        rec = {
            "observed_at": observed,
            "received_at": received,
            "is_forecast": is_forecast,
            "lat": payload.get("latitude"),
            "lon": payload.get("longitude"),
        }
        for var in (variables or HOURLY_VARS):
            series = hourly.get(var)
            rec[var] = series[i] if series and i < len(series) else None
        rows.append(_derive(rec))
    return rows


def _derive(rec: dict) -> dict:
    """
    Add the quantities the feedback diagnostic needs but the API does not ship.

    clearness is the one that matters. Surface shortwave on its own is useless
    for detecting aerosol attenuation because it is dominated by solar zenith
    angle: a clean winter noon and a polluted autumn afternoon can report the
    same W m-2. Dividing by the top-of-atmosphere flux removes the geometry and
    leaves atmospheric transmission, which is what aerosol actually changes.
    """
    sw = rec.get("shortwave_radiation")
    toa = rec.get("terrestrial_radiation")
    if sw is not None and toa is not None and toa > MIN_TOA_WM2:
        rec["clearness"] = max(0.01, min(1.2, sw / toa))
    else:
        rec["clearness"] = None

    blh = rec.get("boundary_layer_height")
    ws = rec.get("wind_speed_10m")
    # Ventilation coefficient: the conventional dispersion metric, mixing depth
    # times transport speed. Carried alongside the feedback diagnostic because
    # it is the published baseline any new index has to beat.
    rec["ventilation_coefficient"] = (blh * ws) if (blh is not None and ws is not None) else None

    return rec


# The most recent upstream failure, so a caller handed [] can say WHY.
#
# WHY THIS EXISTS
#     _fetch returns [] for every failure - timeout, 429, DNS, TLS - and an empty
#     list is indistinguishable from "the request worked, there is simply no
#     weather". Downstream that became "no meteorology available after <hour>",
#     which names the wrong subsystem: the store was not stale, the HTTP call
#     failed. On a hosted instance nobody can attach a debugger, and the free
#     Open-Meteo tier rate-limits by SOURCE IP - which a managed platform shares
#     across tenants - so that message was the only available signal and it
#     pointed away from the cause.
#
#     One module-level dict turns an undiagnosable production failure into a
#     stated one. It is deliberately not an exception: a missing forecast must
#     still degrade rather than take the API down.
_LAST_ERROR: dict[str, object] = {"reason": None, "at": None, "url": None}


def last_error() -> dict[str, object]:
    """The most recent _fetch failure. `reason` is None if the last call succeeded."""
    return dict(_LAST_ERROR)


def _note_error(url: str, reason: str) -> None:
    _LAST_ERROR.update({"reason": reason,
                        "at": datetime.now(timezone.utc), "url": url})
    log.warning("open-meteo: %s (%s)", reason, url)


# Seconds to wait between retries. The previous code retried a 429 IMMEDIATELY,
# three times, which against a rate limiter is three guaranteed failures inside a
# few milliseconds followed by []. A 429 from a shared egress IP is usually
# somebody else's traffic and clears on its own, so waiting IS the remedy.
RETRY_BACKOFF_S = (1.0, 4.0)


def _backoff(attempt: int) -> float:
    return RETRY_BACKOFF_S[min(attempt, len(RETRY_BACKOFF_S) - 1)]


def _fetch(url: str, params: dict, is_forecast: bool, retries: int = 3,
           variables: list[str] | None = None) -> list[dict]:
    """One HTTP call with retry. Returns [] rather than raising, and records why."""
    for attempt in range(retries):
        last = attempt == retries - 1
        try:
            r = requests.get(url, params=params, timeout=60)
            if r.status_code == 429:
                if last:
                    _note_error(url, f"rate limited (HTTP 429) after {retries} attempts")
                    return []
                # Honour Retry-After when the server sends one: it knows its own
                # window better than any constant chosen here.
                wait = _backoff(attempt)
                try:
                    wait = max(wait, float(r.headers.get("Retry-After") or 0))
                except (TypeError, ValueError):
                    pass
                log.info("open-meteo: rate limited, retrying in %.0fs", wait)
                time.sleep(wait)
                continue
            r.raise_for_status()
            rows = _rows_from_payload(r.json(), is_forecast, variables)
            if not rows:
                _note_error(url, "upstream returned no hourly rows")
                return []
            _LAST_ERROR.update({"reason": None, "at": None, "url": None})
            return rows
        except Exception as exc:                            # noqa: BLE001
            if last:
                _note_error(url, f"{type(exc).__name__}: {exc}")
                return []
            time.sleep(_backoff(attempt))
    return []


def fetch_forecast(lat: float = DEFAULT_LAT, lon: float = DEFAULT_LON,
                   hours: int = 72) -> list[dict]:
    """
    Hourly meteorological forecast out to `hours`.

    72 is the default because that is the horizon PS 26082 specifies. Rows are
    returned with is_forecast=True so the decision layer can require observed
    data for a current-breach escalation while still allowing a predicted
    breach to open a preparatory case.
    """
    # Open-Meteo counts forecast_days from TODAY 00:00 UTC, but the caller wants
    # `hours` ahead of NOW. The hours already elapsed today come back in the
    # payload and are then dropped by the filter below, so ceil(hours / 24) days
    # delivered only `hours - elapsed` of future weather: a 72 h request issued at
    # 08:00 UTC returned 64, and the PM2.5 forecast quietly served a 64-hour
    # horizon against a problem statement that specifies 72. Counting the elapsed
    # hours into the request is what makes the horizon asked for the horizon got.
    elapsed = datetime.now(timezone.utc).hour
    days = max(1, min(16, (elapsed + hours + 23) // 24))
    rows = _fetch(FORECAST_URL, {
        "latitude": lat, "longitude": lon,
        "hourly": ",".join(HOURLY_VARS),
        "forecast_days": days,
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }, is_forecast=True)
    now = datetime.now(timezone.utc)
    return [r for r in rows if r["observed_at"] >= now.replace(minute=0, second=0,
                                                               microsecond=0)][:hours]


def fetch_recent(lat: float = DEFAULT_LAT, lon: float = DEFAULT_LON,
                 past_days: int = 2,
                 variables: list[str] | None = None) -> list[dict]:
    """
    Recent OBSERVED meteorology, for anchoring the forecast against reality.

    Separate from fetch_forecast because these rows are analysis rather than
    prediction and must not be flagged is_forecast. This is the series the
    online lambda estimate is computed on: a feedback gain derived from
    forecast fields would be circular, since it would only be re-reading the
    model's own output.
    """
    vars_ = variables or HOURLY_VARS
    return _fetch(FORECAST_URL, {
        "latitude": lat, "longitude": lon,
        "hourly": ",".join(vars_),
        "past_days": min(past_days, 92),
        "forecast_days": 1,
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }, is_forecast=False, variables=vars_)


def fetch_archive(lat: float = DEFAULT_LAT, lon: float = DEFAULT_LON,
                  start_date: str = "", end_date: str = "",
                  variables: list[str] | None = None) -> list[dict]:
    """
    ERA5 reanalysis for a closed date range. The historical backfill path.

    WHY THIS IS NOT fetch_forecast WITH past_days
        past_days on the forecast endpoint is capped and serves the model's own
        recent analysis. The archive endpoint serves ERA5 proper and accepts an
        arbitrary range in one call, which is what a multi-winter backfill needs.

    WHY THE ROWS ARE FLAGGED is_forecast=False, AND WHY THAT MATTERS
        Reanalysis already knows the answer. It is legitimate training data and
        illegitimate skill evidence. Anything scored against these rows measures
        hindcast fit, not forecast skill - for that use the previous-runs
        endpoint at a fixed lead time. Keeping the flag honest here is what
        stops the two from being confused three months from now.

    `variables` defaults to HOURLY_VARS. The backfill passes HOURLY_VARS plus
    ARCHIVE_PRESSURE_VARS, because inversion strength needs temperature aloft
    and the live path has no use for it.
    """
    vars_ = variables or HOURLY_VARS
    return _fetch(ARCHIVE_URL, {
        "latitude": lat, "longitude": lon,
        "hourly": ",".join(vars_),
        "start_date": start_date,
        "end_date": end_date,
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }, is_forecast=False, variables=vars_)


def data_age_seconds(record: dict) -> float:
    """Seconds between the hour a record describes and now."""
    return (datetime.now(timezone.utc) - record["observed_at"]).total_seconds()


if __name__ == "__main__":
    obs = fetch_recent()
    fc = fetch_forecast(hours=72)
    print(f"observed rows: {len(obs)}")
    print(f"forecast rows: {len(fc)}")

    if obs:
        latest = [r for r in obs if r["observed_at"] <= datetime.now(timezone.utc)]
        if latest:
            r = latest[-1]
            print("\nlatest observed hour")
            print(f"  time  {r['observed_at']}  age={data_age_seconds(r)/60:.0f} min")
            print(f"  BLH   {r['boundary_layer_height']} m")
            print(f"  SW    {r['shortwave_radiation']} W/m2   "
                  f"TOA {r['terrestrial_radiation']} W/m2")
            print(f"  clearness {r['clearness']}   cloud {r['cloud_cover']} %")
            print(f"  wind  {r['wind_speed_10m']} m/s   T {r['temperature_2m']} C   "
                  f"RH {r['relative_humidity_2m']} %")
            print(f"  ventilation coefficient {r['ventilation_coefficient']}")

    if fc:
        print(f"\nforecast horizon: {fc[0]['observed_at']} -> {fc[-1]['observed_at']}")
        blhs = [r["boundary_layer_height"] for r in fc if r["boundary_layer_height"]]
        if blhs:
            print(f"  BLH over 72 h: min={min(blhs):.0f} max={max(blhs):.0f} m")
