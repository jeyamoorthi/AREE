"""
Step 7 - why are the elasticities so much smaller than physics predicts?

The first real-data run returned the right SIGNS on all three terms but
magnitudes far below theory: e1 = -0.04 against a box-model expectation of
-1, and e3 = -0.009. Reporting lambda ~ 0 without understanding that gap
would be as bad as reporting a large lambda without checking it.

There are four candidate explanations, and they have different fixes:

  A. ERRORS-IN-VARIABLES ATTENUATION
     ERA5 boundary layer height is a bulk-Richardson diagnostic with large
     error, worst in exactly the shallow stable layers that dominate a Delhi
     winter. Classical measurement error in a regressor biases the slope
     TOWARD ZERO by a factor of the reliability ratio. If ERA5 BLH carries 50%
     noise variance, a true -1 is measured as -0.5 or smaller. This alone can
     explain most of the gap.

  B. SPATIAL MISMATCH
     For 64% of hours the PM2.5 "domain median" is a single station (the US
     Embassy monitor), while BLH is a 9-cell domain mean. Point-versus-area
     comparison attenuates covariance further.

  C. TIMESCALE
     The feedback is a daily-scale process: a day's aerosol load suppresses
     that day's boundary-layer growth. Hourly anomalies are dominated by
     advection and measurement noise. Daily daytime aggregates should show a
     stronger relationship if the mechanism is real.

  D. THE MECHANISM GENUINELY IS WEAK OVER DELHI
     Possible, and the outcome the gate exists to detect.

This script separates them. It does not tune anything toward a preferred
answer: every comparison below is reported whichever way it comes out.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module

_lam = import_module("04_compute_lambda")
log_anomaly = _lam.log_anomaly
ols_slope = _lam.ols_slope

PANEL = C.PROCESSED / "panel_hourly.parquet"


def section(title: str) -> None:
    print("\n" + "=" * 72)
    print(title)
    print("=" * 72)


def raw_structure(df: pd.DataFrame) -> None:
    """
    Does the RAW data show the expected shape at all, before any anomaly step?

    If the raw diurnal relationship between PBL depth and concentration is
    absent, the problem is the data, not the estimator.
    """
    section("A. RAW STRUCTURE - median PM2.5 and BLH by hour (in-season)")
    d = df[df.in_season].dropna(subset=["pm25_ncr", "blh"])
    g = d.groupby("hour_ist").agg(pm25=("pm25_ncr", "median"),
                                  blh=("blh", "median"),
                                  clear=("clearness", "median"))
    print(f"  {'hIST':>5}{'PM2.5':>9}{'BLH m':>9}{'clearness':>11}")
    for h, r in g.iterrows():
        cl = "  n/a" if pd.isna(r.clear) else f"{r.clear:>9.3f}"
        print(f"  {h:>5}{r.pm25:>9.0f}{r.blh:>9.0f}{cl:>11}")


def daily_scale(df: pd.DataFrame) -> None:
    """
    Re-estimate on DAILY daytime aggregates instead of hourly values.

    Physically better motivated: mixed-layer growth integrates the day's
    surface heating, so the natural unit of the feedback is a day, not an hour.
    Aggregating also averages down the independent part of the measurement
    error, which directly attacks explanation A.
    """
    section("C. TIMESCALE - hourly vs daily daytime aggregates")

    d = df[df.in_season & df.is_day].copy()
    d = d.dropna(subset=["pm25_ncr", "blh", "clearness", "wind_speed"])
    ist = d.index + pd.Timedelta(hours=C.IST_OFFSET_HOURS)
    d["day"] = ist.date
    d["month_"] = ist.month

    daily = d.groupby("day").agg(
        pm25=("pm25_ncr", "mean"),
        blh=("blh", "max"),               # daytime MAXIMUM depth
        clearness=("clearness", "mean"),
        wind=("wind_speed", "mean"),
        cloud=("cloud_cover", "mean"),
        month_=("month_", "first"),
        holdout=("holdout", "any"),
    ).dropna()
    daily = daily[daily.index.map(lambda x: True)]
    print(f"  daily records: {len(daily)}")

    # Log anomalies relative to month climatology (no hour dimension at daily
    # resolution, so the seasonal cycle is what has to be removed).
    def anom(col, floor):
        x = daily[col].where(daily[col] > floor)
        lx = np.log(x)
        return lx - lx.groupby(daily.month_).transform("mean")

    lC, lH = anom("pm25", 1.0), anom("blh", 20.0)
    lS, lU = anom("clearness", 0.02), anom("wind", 0.2)
    train = ~daily.holdout.to_numpy()
    clear = (daily.cloud <= 25).to_numpy()

    e1, r1, n1 = ols_slope(lC.to_numpy()[train], lH.to_numpy()[train],
                           controls=[lU.to_numpy()[train]])
    e2, r2, n2 = ols_slope(lH.to_numpy()[train], lS.to_numpy()[train])
    m = train & clear
    e3, r3, n3 = ols_slope(lS.to_numpy()[m], lC.to_numpy()[m])
    lam = e1 * e2 * e3

    print(f"\n  {'term':<8}{'daily':>10}{'r2':>8}{'n':>7}   expectation")
    print(f"  {'e1':<8}{e1:>10.3f}{r1:>8.3f}{n1:>7}   ~ -1  (box dilution)")
    print(f"  {'e2':<8}{e2:>10.3f}{r2:>8.3f}{n2:>7}   ~ +0.5 (encroachment)")
    print(f"  {'e3':<8}{e3:>10.3f}{r3:>8.3f}{n3:>7}   -0.1 to -0.4")
    print(f"  {'lambda':<8}{lam:>10.4f}")
    return daily, lC, lH, lS, lU


def station_density(df: pd.DataFrame) -> None:
    """
    Compare the multi-station era against the single-station era.

    If e1 is materially stronger when 15-21 stations back the PM2.5 median than
    when one does, explanation B is doing real work and the fix is more ground
    data rather than a different estimator.
    """
    section("B. SPATIAL MISMATCH - dense network vs single station")
    d = df[df.in_season & df.is_day].dropna(
        subset=["pm25_ncr", "blh", "wind_speed", "n_stations"])

    for label, sub in (("dense  (n_stations >= 8)", d[d.n_stations >= 8]),
                       ("sparse (n_stations <= 2)", d[d.n_stations <= 2])):
        if len(sub) < 200:
            print(f"  {label}: only {len(sub)} hours, skipped")
            continue
        lC = log_anomaly(sub, "pm25_ncr", 1.0)
        lH = log_anomaly(sub, "blh", 20.0)
        lU = log_anomaly(sub, "wind_speed", 0.2)
        e1, r2, n = ols_slope(lC.to_numpy(), lH.to_numpy(),
                              controls=[lU.to_numpy()])
        print(f"  {label}: e1={e1:+.3f}  r2={r2:.3f}  n={n}")


def attenuation_bound(df: pd.DataFrame) -> None:
    """
    How much attenuation could ERA5 BLH error alone produce?

    Reverse-regression bounds the true slope. For y on x, OLS attenuates toward
    zero; regressing x on y and inverting over-states it. The true value under
    classical measurement error lies between the two. This is a standard,
    assumption-light bracket - not a correction, a bound.
    """
    section("A. ERRORS-IN-VARIABLES - reverse-regression bracket on e1")
    d = df[df.in_season & df.is_day].dropna(
        subset=["pm25_ncr", "blh", "wind_speed"])
    lC = log_anomaly(d, "pm25_ncr", 1.0).to_numpy()
    lH = log_anomaly(d, "blh", 20.0).to_numpy()

    fwd, _, n = ols_slope(lC, lH)                 # C on H  -> attenuated
    rev, _, _ = ols_slope(lH, lC)                 # H on C  -> invert
    inv = 1.0 / rev if rev not in (0, np.nan) else np.nan
    print(f"  forward  d lnC/d lnH        = {fwd:+.3f}   (attenuated, n={n})")
    print(f"  reverse  1 / (d lnH/d lnC)  = {inv:+.3f}   (over-stated)")
    print(f"  true e1 lies between        {fwd:+.3f} and {inv:+.3f}")
    print(f"  implied reliability ratio   {abs(fwd/inv) if inv else float('nan'):.3f}")
    print("\n  A reliability ratio well below 1 means ERA5 BLH noise, not a weak")
    print("  mechanism, is suppressing the measured elasticity.")


def main() -> None:
    df = pd.read_parquet(PANEL)
    raw_structure(df)
    attenuation_bound(df)
    station_density(df)
    daily_scale(df)

    section("READ THIS BEFORE QUOTING ANY NUMBER")
    print("""
  The signs are right, so the mechanism is present in the data. The question
  the numbers above answer is whether the small magnitudes are physical or
  instrumental.

  If the reverse-regression bracket is wide and the daily-scale e1 is much
  larger than the hourly one, the hourly estimate was noise-attenuated and the
  daily formulation is the one to carry forward.

  If daily and hourly agree and both are near zero, the aerosol-PBL feedback
  is weak over this domain in this record, and the lock-in claim must be
  dropped rather than argued around.
""")


if __name__ == "__main__":
    main()
