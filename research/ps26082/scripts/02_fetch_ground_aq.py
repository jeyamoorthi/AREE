"""
Step 2 - pull hourly ground PM2.5 for the NCR stations from OpenAQ v3.

WHY OPENAQ AND NOT CPCB DIRECTLY
    CPCB's CCR portal has no documented public API and is scraped through a
    Selenium session that breaks whenever the page changes. OpenAQ ingests the
    same CPCB/DPCC CAAQMS feed, normalises units and timestamps, and exposes a
    documented v3 REST API. data.gov.in carries a CPCB resource too, but it is
    a real-time snapshot rather than a multi-year archive, so it belongs to the
    live pipeline (Dataset A) and not to this historical build (Dataset B).

THE TRAP THAT COST AN HOUR - DOCUMENTED SO NOBODY REPEATS IT
    A location's datetimeFirst/datetimeLast describe the LOCATION, spanning
    every sensor ever deployed there. Individual sensors are retired and
    replaced with new ids at the same site. R K Puram's location reports
    coverage to 2026, but sensor 35 at that location stopped in Feb 2018.
    Selecting sensors on location dates silently returns zero rows for any
    recent window. Every sensor is therefore queried for its OWN coverage
    before it is used.

WHAT THE MEASUREMENT ACTUALLY IS - THIS MATTERS FOR lambda
    CPCB PM2.5 comes from BAM-1020 beta-attenuation monitors with a heated
    inlet holding sample RH at or below ~35%, so the reported number is DRY
    aerosol mass. Satellite AOD sees ambient WET aerosol including hygroscopic
    growth. lambda as formulated uses ground PM2.5 only and is internally
    consistent; the moment AOD enters (the emulator) a growth-factor
    correction becomes mandatory.

OUTPUT
    data/interim/ground_pm25_hourly.parquet   domain median per hour
    data/interim/openaq_sensors.csv           the sensors actually used
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

BASE = "https://api.openaq.org/v3"
OUT = C.INTERIM / "ground_pm25_hourly.parquet"
SENSOR_CSV = C.INTERIM / "openaq_sensors.csv"
PROBE_CACHE = C.INTERIM / "openaq_probe_cache.csv"

WINDOW_FROM = pd.Timestamp(C.ARCHIVE_START, tz="UTC")
WINDOW_TO = pd.Timestamp(C.ARCHIVE_END, tz="UTC")


def _headers() -> dict:
    if not C.OPENAQ_KEY:
        raise SystemExit("OPENAQ_API_KEY not set (expected in .env)")
    return {"X-API-Key": C.OPENAQ_KEY}


def _get(url: str, params: dict | None = None, retries: int = 4) -> dict:
    """
    One GET with backoff on rate limiting.

    Centralised so every call in this module retries identically; a bare
    request would drop stations silently and change the domain median without
    anything in the output indicating that it happened.
    """
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, headers=_headers(), timeout=90)
        except requests.RequestException:
            time.sleep(4 * (attempt + 1))
            continue
        if r.status_code in (408, 429, 500, 502, 503, 504):
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"rate limited after {retries} attempts: {url}")


def list_pm25_sensors() -> pd.DataFrame:
    """
    Every PM2.5 sensor inside the NCR box, with its OWN coverage window.

    Two passes on purpose: the locations endpoint gives sensor ids cheaply,
    then each sensor is asked for its own dates. Slower, but it is the only
    way to avoid the retired-sensor trap described in the module docstring.
    """
    # bbox, not coordinates+radius: OpenAQ caps radius at 25 km and the NCR
    # domain is wider than that in both directions. bbox is minx,miny,maxx,maxy.
    bbox = (f"{C.NCR_LON_RANGE[0]},{C.NCR_LAT_RANGE[0]},"
            f"{C.NCR_LON_RANGE[1]},{C.NCR_LAT_RANGE[1]}")

    found = []
    for page in range(1, 6):
        js = _get(f"{BASE}/locations", {"bbox": bbox, "limit": 1000, "page": page})
        res = js.get("results", [])
        if not res:
            break
        for loc in res:
            co = loc.get("coordinates") or {}
            if not (co.get("latitude") and co.get("longitude")):
                continue
            if not (C.NCR_LAT_RANGE[0] <= co["latitude"] <= C.NCR_LAT_RANGE[1]
                    and C.NCR_LON_RANGE[0] <= co["longitude"] <= C.NCR_LON_RANGE[1]):
                continue
            for s in (loc.get("sensors") or []):
                if (s.get("parameter") or {}).get("name") == "pm25":
                    found.append({"sensor_id": s["id"], "location": loc["name"],
                                  "lat": co["latitude"], "lon": co["longitude"]})
    df = pd.DataFrame(found).drop_duplicates("sensor_id")
    print(f"[aq] {len(df)} PM2.5 sensors inside the NCR box")

    # Probing 198 sensors one at a time takes ~10 minutes. Cache it: the
    # coverage windows change on the order of months, and re-probing on every
    # run makes iterating on the SELECTION logic needlessly expensive.
    if PROBE_CACHE.exists():
        cached = pd.read_csv(PROBE_CACHE, parse_dates=["first", "last"])
        print(f"[aq] using cached probe ({len(cached)} sensors) - "
              f"delete {PROBE_CACHE.name} to refresh")
        return cached

    rows = []
    for i, r in enumerate(df.itertuples(), 1):
        try:
            meta = _get(f"{BASE}/sensors/{r.sensor_id}")["results"][0]
        except Exception:                                  # noqa: BLE001
            continue
        first = (meta.get("datetimeFirst") or {}).get("utc")
        last = (meta.get("datetimeLast") or {}).get("utc")
        if not first or not last:
            continue
        rows.append({**r._asdict(),
                     "first": pd.Timestamp(first), "last": pd.Timestamp(last)})
        if i % 25 == 0:
            print(f"[aq]   probed {i}/{len(df)} sensors")
    out = pd.DataFrame(rows)
    out.to_csv(PROBE_CACHE, index=False)
    return out


# Regulatory / reference-grade networks. OpenAQ also carries low-cost and
# research nodes inside the NCR box (a hotel-terrace sensor, a NASA calibration
# unit). Those are not BAM-1020 equivalents: they report ambient wet mass and
# are often uncalibrated, so mixing them into the domain median would corrupt
# the very quantity lambda is estimated on.
REFERENCE_NETWORKS = ("CPCB", "DPCC", "UPPCB", "HSPCB", "IMD", "IITM", "RSPCB")

# Cap on sensors pulled. The domain median stabilises well before this; more
# only multiply API calls.
MAX_STATIONS = 34

# The US Embassy monitor in New Delhi. OpenAQ's Indian CPCB feed has a hard
# gap between Nov 2022 and Feb 2025 - the old sensor generation stops, the new
# one starts, and nothing covers the middle. This reference-grade station runs
# continuously from 2016 to now and is the ONLY series in the box that spans
# both holdout Novembers. Without it there is no held-out evaluation at all.
ANCHOR_SENSOR_IDS = (23534,)


def is_reference_grade(location: str) -> bool:
    """
    True if the station name carries a known regulatory network suffix.

    Name-based because OpenAQ's provider field is inconsistent for the Indian
    feed - several CPCB sites report provider "Unknown Governmental
    Organization". The suffix convention ("... - CPCB") is reliable.
    """
    return any(f"- {net}" in location or location.endswith(net)
               for net in REFERENCE_NETWORKS)


def select_sensors(sen: pd.DataFrame) -> pd.DataFrame:
    """
    Keep reference-grade sensors overlapping our window, one per station.

    Deduplicating by station matters: several sites expose two live sensor ids
    for the same physical monitor. Counting both would double-weight that
    station in the domain median.
    """
    sen = sen.copy()
    before = len(sen)
    keep = sen.location.map(is_reference_grade) | sen.sensor_id.isin(ANCHOR_SENSOR_IDS)
    sen = sen[keep]
    print(f"[aq] reference-grade filter: {before} -> {len(sen)} sensors")
    sen["ov_start"] = sen[["first"]].assign(w=WINDOW_FROM).max(axis=1)
    sen["ov_end"] = sen[["last"]].assign(w=WINDOW_TO).min(axis=1)
    sen["overlap_days"] = (sen.ov_end - sen.ov_start).dt.total_seconds() / 86400
    sen = sen[sen.overlap_days > 180].copy()
    # Deliberately NOT deduplicated by location. A site retires one sensor id
    # and starts another; the two cover DIFFERENT eras, so keeping only the
    # longest-overlap one per location silently truncates the record at 2022.
    # That is exactly the bug that removed both holdout Novembers on the first
    # attempt. Overlapping generations are handled downstream by averaging
    # within a station-hour before taking the cross-station median.
    sen = (sen.sort_values("overlap_days", ascending=False)
              .head(MAX_STATIONS)
              .reset_index(drop=True))

    cov = sen.assign(y0=sen["first"].dt.year, y1=sen["last"].dt.year)
    print(f"[aq] coverage spread: earliest={cov.y0.min()} latest={cov.y1.max()}")
    return sen


def fetch_sensor(sensor_id: int, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """
    Hourly aggregates for one sensor, walked in MONTHLY chunks.

    Monthly, not yearly, and this matters. A month holds at most 744 hours,
    comfortably under the API's 1000-row page limit, so every request is page 1
    and deep pagination never happens. Yearly chunks forced pages 2-9, and
    OpenAQ returns 500s and 408s on deep offsets - the first attempt at this
    pull failed on exactly that for three consecutive stations.

    Server-side hourly means are used rather than raw measurements so the
    15-minute-to-hourly resampling happens once, at the source, consistently
    for every station.
    """
    rows = []
    months = pd.date_range(start.normalize(), end, freq="MS", tz="UTC")
    for m0 in months:
        m1 = min(m0 + pd.offsets.MonthEnd(1) + pd.Timedelta(hours=23, minutes=59), end)
        try:
            js = _get(f"{BASE}/sensors/{sensor_id}/hours",
                      {"datetime_from": m0.strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "datetime_to": m1.strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "limit": 1000})
        except Exception:                                   # noqa: BLE001
            # One bad month must not lose the station. The gap shows up in
            # n_stations for those hours, which is exactly the visibility we
            # want rather than a silent hole.
            continue
        for rec in js.get("results", []):
            per = (rec.get("period") or {}).get("datetimeFrom") or {}
            if per.get("utc"):
                rows.append({"datetime_utc": per["utc"], "pm25": rec.get("value")})
    return pd.DataFrame(rows)


def main() -> None:
    sen = list_pm25_sensors()
    if sen.empty:
        raise SystemExit("[aq] no sensors resolved")

    sel = select_sensors(sen)
    sel.to_csv(SENSOR_CSV, index=False)
    print(f"\n[aq] {len(sel)} stations selected (>180 d overlap, deduped)")
    for r in sel.itertuples():
        print(f"[aq]   {r.sensor_id:<10} {r.location[:44]:<46} "
              f"{str(r.first)[:10]} -> {str(r.last)[:10]}  "
              f"{r.overlap_days:.0f} d")

    frames = []
    for i, r in enumerate(sel.itertuples(), 1):
        t0 = time.time()
        try:
            d = fetch_sensor(int(r.sensor_id), WINDOW_FROM, WINDOW_TO)
        except Exception as exc:                            # noqa: BLE001
            print(f"[aq] ({i}/{len(sel)}) {r.location[:30]} FAILED: {exc}")
            continue
        if d.empty:
            print(f"[aq] ({i}/{len(sel)}) {r.location[:30]} empty")
            continue
        d["station"] = r.location
        frames.append(d)
        print(f"[aq] ({i}/{len(sel)}) {r.location[:34]:<36} "
              f"{len(d):>6} hours  {time.time()-t0:.0f}s")

    if not frames:
        raise SystemExit("[aq] no data returned")

    df = pd.concat(frames, ignore_index=True)
    df["datetime_utc"] = pd.to_datetime(df["datetime_utc"], utc=True)
    df = df.dropna(subset=["pm25"])
    df = df[(df.pm25 >= 0) & (df.pm25 < 2000)]
    df["datetime_utc"] = df["datetime_utc"].dt.floor("h")

    # Median across stations, not mean: lambda is a property of the NCR
    # airshed and one faulty monitor must not be able to move it. Same
    # principle the existing AREE escalation engine already applies.
    # Two-stage aggregation. First mean within (station, hour) so a station
    # exposing two live sensor ids, or sub-hourly rows, contributes exactly one
    # value. Only then take the median ACROSS stations. Doing it in one step
    # would let a double-instrumented site outvote the rest of the network.
    per_station = (df.groupby(["datetime_utc", "station"])["pm25"]
                     .mean().reset_index())
    panel = (per_station.groupby("datetime_utc")["pm25"]
                        .median().rename("pm25_ncr").to_frame())
    panel["n_stations"] = per_station.groupby("datetime_utc")["pm25"].count()
    panel.to_parquet(OUT)

    print(f"\n[aq] wrote {OUT}")
    print(f"[aq] hours={len(panel)}  {panel.index.min()} .. {panel.index.max()}")
    print(f"[aq] PM2.5 median={panel.pm25_ncr.median():.0f}  "
          f"p95={panel.pm25_ncr.quantile(.95):.0f}  "
          f"max={panel.pm25_ncr.max():.0f} ug/m3")
    print(f"[aq] stations per hour: median={panel.n_stations.median():.0f}")


if __name__ == "__main__":
    main()
