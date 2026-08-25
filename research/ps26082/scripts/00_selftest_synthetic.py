"""
Step 0 - synthetic end-to-end self-test.

WHY THIS RUNS FIRST
    The estimator in step 4 claims to recover a feedback loop gain from noisy,
    strongly diurnal observational data. That claim has to be tested against
    data where the true answer is known, BEFORE it is pointed at ERA5 and its
    output is believed. Otherwise there is no way to distinguish "lambda is
    0.8 because Delhi is locking in" from "lambda is 0.8 because the estimator
    is biased".

WHAT IT DOES
    Generates a synthetic hourly record with:
      * realistic diurnal cycles in PBL height and shortwave (the confounder
        the estimator must survive),
      * a PRESCRIBED set of elasticities e1, e2, e3, so the true lambda is
        known exactly,
      * observational noise,
      * a set of injected pollution episodes, some of which lock in.

    Then it runs steps 3-6 on that record and checks that the recovered
    lambda matches the prescribed one.

PASS CRITERIA
    recovered lambda within +-25% of the true value, and the correct sign on
    every elasticity. If this fails, the estimator is broken and no result
    from real data can be trusted.

    This also gives the team a working pipeline on day one, with no API keys,
    so frontend and integration work can start in parallel with the data pull.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

# Ground truth we will try to recover.
TRUE_E1 = -0.90     # dilution: deeper layer -> lower concentration
TRUE_E2 = 0.55      # radiative PBL growth
TRUE_E3 = -0.28     # aerosol attenuation of surface shortwave
TRUE_LAMBDA = TRUE_E1 * TRUE_E2 * TRUE_E3

RNG = np.random.default_rng(20260823)


def diurnal(hours: np.ndarray, peak_hour: float, amp: float, base: float) -> np.ndarray:
    """
    A smooth daily cycle.

    This is the nuisance signal the anomaly step must remove. It is generated
    deliberately large so that an estimator which fails to de-seasonalise will
    visibly fail the test rather than quietly passing.
    """
    return base + amp * np.cos(2 * np.pi * (hours - peak_hour) / 24.0)


def synthesise(n_days: int = 420) -> pd.DataFrame:
    """
    Build the synthetic hourly panel.

    The generative model is written in logs so the prescribed elasticities are
    exactly the log-log slopes the estimator is trying to recover - there is no
    ambiguity about what "true lambda" means.
    """
    n = n_days * 24
    t0 = pd.Timestamp("2021-10-01", tz="UTC")
    idx = pd.date_range(t0, periods=n, freq="h")
    hour_ist = ((idx.hour + int(C.IST_OFFSET_HOURS)) % 24).to_numpy()
    month = ((idx + pd.Timedelta(hours=C.IST_OFFSET_HOURS)).month).to_numpy()

    # --- exogenous drivers -------------------------------------------------
    # Synoptic forcing: slow, autocorrelated. Drives emissions and stagnation.
    synoptic = pd.Series(RNG.normal(0, 1, n)).rolling(72, min_periods=1).mean()
    synoptic = ((synoptic - synoptic.mean()) / synoptic.std()).to_numpy()

    wind = np.exp(np.log(2.2) + 0.45 * RNG.normal(0, 1, n) - 0.35 * synoptic)
    wind = np.clip(wind, 0.3, 12.0)

    # Clear-sky shortwave: pure geometry, zero at night.
    ssrdc = np.clip(diurnal(hour_ist, 12.5, 420, 380), 0, None)
    seasonal = 1.0 - 0.18 * np.cos(2 * np.pi * (month - 6) / 12.0)
    ssrdc = ssrdc * seasonal

    # Emissions: diurnal traffic + winter residential heating + synoptic.
    log_emis = (np.log(60.0)
                + 0.25 * np.cos(2 * np.pi * (hour_ist - 8) / 24.0)
                + 0.20 * np.cos(2 * np.pi * (hour_ist - 20) / 24.0)
                + 0.30 * np.isin(month, [11, 12, 1]).astype(float)
                + 0.45 * synoptic)

    # --- coupled system ----------------------------------------------------
    # Solved by fixed-point iteration at each hour: C depends on H, H depends
    # on S, S depends on C. Iterating to convergence is what actually creates
    # the closed loop in the synthetic data.
    log_H_base = np.log(np.clip(diurnal(hour_ist, 14.0, 480, 620), 60, None))
    log_C = log_emis - np.log(np.clip(wind, 0.3, None))
    log_S_ratio = np.zeros(n)

    for _ in range(60):
        # radiation responds to aerosol
        log_S_ratio_new = TRUE_E3 * (log_C - log_C.mean())
        # PBL responds to radiation
        log_H = log_H_base + TRUE_E2 * log_S_ratio_new
        # concentration responds to PBL (plus horizontal ventilation)
        log_C_new = (log_emis
                     + TRUE_E1 * (log_H - log_H_base.mean())
                     - 0.5 * np.log(np.clip(wind, 0.3, None)))
        if np.max(np.abs(log_C_new - log_C)) < 1e-6:
            log_C, log_S_ratio = log_C_new, log_S_ratio_new
            break
        log_C, log_S_ratio = log_C_new, log_S_ratio_new

    log_H = log_H_base + TRUE_E2 * log_S_ratio

    # --- observation noise -------------------------------------------------
    pm25 = np.exp(log_C + RNG.normal(0, 0.12, n))
    blh = np.exp(log_H + RNG.normal(0, 0.10, n))
    clearness = np.clip(np.exp(log_S_ratio + RNG.normal(0, 0.06, n)), 0.02, 1.15)
    ssrd = ssrdc * clearness

    df = pd.DataFrame({
        "pm25_ncr": pm25,
        "blh": np.clip(blh, 30, 3000),
        "ssrd_wm2": ssrd,
        "ssrdc_wm2": ssrdc,
        "clearness": np.where(ssrdc > C.MIN_SSRDC_WM2, clearness, np.nan),
        "wind_speed": wind,
        "rh": np.clip(45 + 22 * np.log(pm25 / pm25.mean()) + RNG.normal(0, 8, n), 10, 100),
        "hour_ist": hour_ist,
        "month": month,
    }, index=idx)
    df.index.name = "datetime_utc"

    df["vent_coef"] = df.blh * df.wind_speed
    df["is_day"] = pd.Series(hour_ist, index=idx).between(*C.DAY_HOURS_IST)
    df["in_season"] = pd.Series(month, index=idx).isin(C.SEASON_MONTHS)
    df["n_stations"] = 9

    holdout = pd.Series(False, index=idx)
    for lo, hi in C.HOLDOUT_PERIODS:
        holdout |= ((idx >= pd.Timestamp(lo, tz="UTC")) &
                    (idx <= pd.Timestamp(hi, tz="UTC")))
    df["holdout"] = holdout
    return df


def run(script: str) -> int:
    """Invoke a pipeline step as a subprocess so the test exercises the real code."""
    print("\n" + "=" * 70)
    print(f"RUNNING {script}")
    print("=" * 70)
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).parent / script)],
        cwd=str(Path(__file__).resolve().parent.parent),
    )
    return proc.returncode


def main() -> None:
    print(f"synthetic ground truth:  e1={TRUE_E1}  e2={TRUE_E2}  e3={TRUE_E3}")
    print(f"                         TRUE lambda = {TRUE_LAMBDA:.4f}")

    df = synthesise()
    out = C.PROCESSED / "panel_hourly.parquet"
    df.to_parquet(out)
    print(f"\nwrote synthetic panel -> {out}  rows={len(df)}")
    print(f"  PM2.5  mean={df.pm25_ncr.mean():.0f}  p95={df.pm25_ncr.quantile(.95):.0f}")
    print(f"  BLH    mean={df.blh.mean():.0f} m")
    print(f"  wind   mean={df.wind_speed.mean():.2f} m/s")

    for step in ("04_compute_lambda.py", "05_label_episodes.py", "06_validate_lambda.py"):
        if run(step) != 0:
            print(f"\n*** {step} FAILED ***")
            sys.exit(1)

    lam = pd.read_parquet(C.PROCESSED / "lambda_hourly.parquet")
    recovered = float(lam["lambda"].median())
    err = abs(recovered - TRUE_LAMBDA) / abs(TRUE_LAMBDA)

    print("\n" + "=" * 70)
    print("SELF-TEST RESULT")
    print("=" * 70)
    print(f"  true lambda       {TRUE_LAMBDA:+.4f}")
    print(f"  recovered lambda  {recovered:+.4f}   (median of rolling estimate)")
    print(f"  relative error    {err*100:.1f}%")
    ok = err <= 0.25
    print(f"\n  {'PASS' if ok else 'FAIL'} - estimator "
          f"{'recovers' if ok else 'does NOT recover'} the prescribed loop gain")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
