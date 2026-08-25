"""
Step 3 - collapse meteorology + ground PM2.5 into one hourly panel.

WHY A SINGLE PANEL
    lambda is a product of three elasticities that must be estimated on the
    SAME hours. If radiation came from one resampling path and PBL height from
    another, the derivatives would be evaluated at inconsistent times and the
    product would be meaningless. Building one table, once, is the guardrail.

TWO METEOROLOGY SOURCES, ONE OUTPUT SCHEMA
    openmeteo   data/interim/openmeteo_era5_ncr.parquet   (preferred, no key)
    cds         data/raw/era5_*.nc                        (canonical, needs key)

    Whichever is present, this script emits identical column names so nothing
    downstream knows or cares which was used.

THE UNIT TRAP THAT SEPARATES THE TWO SOURCES
    CDS ERA5 delivers radiation and heat flux as ACCUMULATIONS in J m-2 over
    the preceding hour. Open-Meteo delivers the same fields already converted
    to mean W m-2. Dividing the Open-Meteo values by 3600 - or failing to
    divide the CDS values - produces a silent 3600x scale error that does not
    crash anything and simply makes every radiative elasticity nonsense.
    The two loaders are therefore kept separate and each states its convention.

THE CLEARNESS INDEX
    clearness = surface shortwave / top-of-atmosphere shortwave

    This is the classic clearness index from solar meteorology. Dividing by the
    TOA flux removes solar zenith angle and day length entirely, which is the
    single largest confounder in the radiative term. What remains is cloud plus
    aerosol - so cloud cover is carried through, and step 4 estimates the
    aerosol term on low-cloud hours only.

OUTPUT
    data/processed/panel_hourly.parquet
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

OUT = C.PROCESSED / "panel_hourly.parquet"
OPENMETEO = C.INTERIM / "openmeteo_era5_ncr.parquet"


def load_openmeteo() -> pd.DataFrame:
    """
    Load the Open-Meteo ERA5 archive pull and rename to the canonical schema.

    Convention: every flux is ALREADY a mean W m-2 over the hour. No division.
    """
    df = pd.read_parquet(OPENMETEO)
    df = df.rename(columns={
        "boundary_layer_height": "blh",
        "shortwave_radiation": "ssrd_wm2",
        "terrestrial_radiation": "toa_wm2",
        "temperature_2m": "t2m_c",
        "relative_humidity_2m": "rh",
        "wind_speed_10m": "wind_speed",
        "wind_direction_10m": "wind_dir",
        "surface_pressure": "sp_hpa",
        "precipitation": "precip_mm",
    })
    df.index = pd.to_datetime(df.index, utc=True)
    return df.sort_index()


def load_cds_era5() -> pd.DataFrame:
    """
    Load monthly CDS NetCDF files and reduce the domain to a spatial mean.

    Convention: radiation and heat-flux fields are J m-2 accumulations over the
    preceding hour and MUST be divided by 3600 to become W m-2.
    """
    import xarray as xr

    files = sorted(C.RAW.glob("era5_*.nc"))
    if not files:
        raise SystemExit("no CDS ERA5 files and no Open-Meteo parquet")

    frames = []
    for f in files:
        ds = xr.open_dataset(f)
        tname = "valid_time" if "valid_time" in ds.coords else "time"
        spatial = [d for d in ("latitude", "longitude") if d in ds.dims]
        df = ds.mean(dim=spatial, keep_attrs=True).to_dataframe().reset_index()
        df = df.rename(columns={tname: "datetime_utc"})
        frames.append(df)
        ds.close()

    era = pd.concat(frames, ignore_index=True)
    era["datetime_utc"] = pd.to_datetime(era["datetime_utc"], utc=True)
    era = era.drop_duplicates("datetime_utc").sort_values("datetime_utc")
    era = era.set_index("datetime_utc")

    for col in ("ssrd", "ssrdc", "sshf"):
        if col in era.columns:
            era[col + "_wm2"] = era[col] / 3600.0
    if "ssrdc_wm2" in era.columns:
        era["toa_wm2"] = era["ssrdc_wm2"]      # clear-sky as the denominator
    if {"u10", "v10"}.issubset(era.columns):
        era["wind_speed"] = np.hypot(era.u10, era.v10)
        era["wind_dir"] = (np.degrees(np.arctan2(-era.u10, -era.v10)) + 360) % 360
    if {"t2m", "d2m"}.issubset(era.columns):
        tc, tdc = era.t2m - 273.15, era.d2m - 273.15
        a, b = 17.625, 243.04
        era["rh"] = np.clip(
            100.0 * np.exp(a * tdc / (b + tdc)) / np.exp(a * tc / (b + tc)), 0, 100)
        era["t2m_c"] = tc
    return era


def derive(df: pd.DataFrame) -> pd.DataFrame:
    """
    Build the quantities lambda is defined on.

    Nothing speculative is computed here; every column below is consumed by one
    of the three elasticities or by the episode labeller.
    """
    out = df.copy()

    # Clearness index - the aerosol-attenuation observable.
    if {"ssrd_wm2", "toa_wm2"}.issubset(out.columns):
        valid = out.toa_wm2 > C.MIN_SSRDC_WM2
        out["clearness"] = np.where(valid, out.ssrd_wm2 / out.toa_wm2, np.nan)
        out["clearness"] = out["clearness"].clip(lower=0.01, upper=1.2)

    # Ventilation coefficient - the published baseline lambda must beat.
    if {"blh", "wind_speed"}.issubset(out.columns):
        out["vent_coef"] = out.blh * out.wind_speed

    return out


def attach_local_time(df: pd.DataFrame) -> pd.DataFrame:
    """IST hour and month drive every stratification downstream."""
    ist = df.index + pd.Timedelta(hours=C.IST_OFFSET_HOURS)
    df["hour_ist"] = ist.hour
    df["month"] = ist.month
    df["is_day"] = df.hour_ist.between(*C.DAY_HOURS_IST)
    df["in_season"] = df.month.isin(C.SEASON_MONTHS)
    return df


def mark_holdout(df: pd.DataFrame) -> pd.DataFrame:
    """Flag the evaluation periods so no fitting step can see them."""
    hold = pd.Series(False, index=df.index)
    for lo, hi in C.HOLDOUT_PERIODS:
        hold |= ((df.index >= pd.Timestamp(lo, tz="UTC")) &
                 (df.index <= pd.Timestamp(hi, tz="UTC")))
    df["holdout"] = hold
    return df


def report_coverage(df: pd.DataFrame) -> None:
    """
    Print PM2.5 station coverage per season-year.

    This exists because OpenAQ's Indian feed has a hard gap between Nov 2022
    and Feb 2025: the old CPCB sensor generation stops and the new one starts,
    with only the continuously-operating US Embassy monitor spanning the
    middle. During that stretch the "domain median" is effectively one station.

    That is a real limitation of the evidence base, and it covers both holdout
    Novembers. Printing it every run means nobody quotes a held-out AUC without
    seeing how many instruments stood behind it.
    """
    if "n_stations" not in df.columns or df.n_stations.isna().all():
        return
    d = df[df.in_season].dropna(subset=["pm25_ncr"]).copy()
    if d.empty:
        return
    ist = d.index + pd.Timedelta(hours=C.IST_OFFSET_HOURS)
    d["season_year"] = ist.year - (ist.month < 6).astype(int)

    print("")
    print("[panel] PM2.5 coverage by season (Oct-Feb)")
    print(f"[panel]   {'season':<12}{'hours':>8}{'median stns':>13}"
          f"{'min':>6}{'PM2.5 p95':>11}")
    for yr, g in d.groupby("season_year"):
        print(f"[panel]   {int(yr)}-{str(int(yr)+1)[2:]:<9}{len(g):>8}"
              f"{g.n_stations.median():>13.0f}{g.n_stations.min():>6.0f}"
              f"{g.pm25_ncr.quantile(.95):>11.0f}")

    thin = d[d.n_stations <= 2]
    if len(thin):
        print(f"[panel]   WARNING {len(thin)} hours "
              f"({100*len(thin)/len(d):.0f}%) rest on <=2 stations")


def main() -> None:
    if OPENMETEO.exists():
        print(f"[panel] meteorology source: Open-Meteo ERA5 archive")
        met = load_openmeteo()
    else:
        print(f"[panel] meteorology source: Copernicus CDS NetCDF")
        met = load_cds_era5()

    print(f"[panel] met hours: {len(met)}  {met.index.min()} .. {met.index.max()}")

    df = derive(met)
    df = attach_local_time(df)
    df = mark_holdout(df)

    aq_path = C.INTERIM / "ground_pm25_hourly.parquet"
    if aq_path.exists():
        aq = pd.read_parquet(aq_path)
        aq.index = pd.to_datetime(aq.index, utc=True)
        df = df.join(aq, how="left")
        n = int(df.pm25_ncr.notna().sum())
        print(f"[panel] joined PM2.5: {n} hours matched "
              f"({100*n/len(df):.1f}% of met hours)")
    else:
        df["pm25_ncr"] = np.nan
        df["n_stations"] = 0
        print("[panel] WARNING no ground PM2.5 - run 02_fetch_ground_aq.py")

    report_coverage(df)

    df.to_parquet(OUT)
    print(f"[panel] wrote {OUT}  rows={len(df)}")

    season = df[df.in_season]
    print(f"[panel] in-season hours: {len(season)}")
    if season.pm25_ncr.notna().any():
        print(f"[panel]   PM2.5 median={season.pm25_ncr.median():.0f} "
              f"p95={season.pm25_ncr.quantile(.95):.0f} ug/m3")
    print(f"[panel]   BLH   median={season.blh.median():.0f} m")
    if "clearness" in season:
        d = season[season.is_day]
        print(f"[panel]   clearness (day) median={d.clearness.median():.3f}")
    if "cloud_cover" in season:
        print(f"[panel]   cloud  median={season.cloud_cover.median():.0f} %")


if __name__ == "__main__":
    main()
