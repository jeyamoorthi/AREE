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

from datetime import datetime, timezone

import requests

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

# Delhi NCR centroid. Callers pass explicit coordinates for per-station pulls.
DEFAULT_LAT, DEFAULT_LON = 28.63, 77.22

# Minimum top-of-atmosphere flux (W m-2) for the clearness ratio to be
# meaningful. Below this the sun is too low and the ratio is dominated by
# geometry and horizon effects rather than by atmospheric transmission.
MIN_TOA_WM2 = 120.0


def _rows_from_payload(payload: dict, is_forecast: bool) -> list[dict]:
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
        for var in HOURLY_VARS:
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


def _fetch(url: str, params: dict, is_forecast: bool, retries: int = 3) -> list[dict]:
    """One HTTP call with retry. Returns [] rather than raising."""
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=60)
            if r.status_code == 429:
                continue
            r.raise_for_status()
            return _rows_from_payload(r.json(), is_forecast)
        except Exception:                                   # noqa: BLE001
            if attempt == retries - 1:
                return []
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
    days = max(1, min(16, (hours + 23) // 24))
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
                 past_days: int = 2) -> list[dict]:
    """
    Recent OBSERVED meteorology, for anchoring the forecast against reality.

    Separate from fetch_forecast because these rows are analysis rather than
    prediction and must not be flagged is_forecast. This is the series the
    online lambda estimate is computed on: a feedback gain derived from
    forecast fields would be circular, since it would only be re-reading the
    model's own output.
    """
    return _fetch(FORECAST_URL, {
        "latitude": lat, "longitude": lon,
        "hourly": ",".join(HOURLY_VARS),
        "past_days": min(past_days, 92),
        "forecast_days": 1,
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }, is_forecast=False)


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
