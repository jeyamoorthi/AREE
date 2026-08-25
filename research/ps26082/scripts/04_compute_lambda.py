"""
Step 4 - estimate the aerosol-PBL feedback loop gain, lambda.

=============================================================================
THE FORMULATION
=============================================================================
The loop the problem statement describes is:

    PM2.5 up -> shortwave at surface down -> sensible heat flux down
             -> turbulent kinetic energy down -> PBL height down
             -> mixing volume down -> PM2.5 up   (loop closes)

Write it as three log-sensitivities (elasticities) around the ring:

    e1 = d ln C / d ln H     PM2.5 response to boundary-layer depth
    e2 = d ln H / d ln S     PBL response to surface shortwave
    e3 = d ln S / d ln C     shortwave response to aerosol load

    lambda = e1 * e2 * e3

Expected signs from the physics:
    e1 < 0   deeper layer dilutes  (box model: C ~ E/(H*U) gives e1 = -1)
    e2 > 0   more radiation grows the layer (encroachment: H ~ S^0.5 -> ~+0.5)
    e3 < 0   more aerosol attenuates radiation (Beer-Lambert)

    product of (-)(+)(-) = POSITIVE  ->  self-reinforcing feedback.

Closed-loop amplification of any perturbation is then

    A = 1 / (1 - lambda)          for lambda < 1

which is the standard linear-feedback form used for climate feedback
factors (Roe 2009, Feedbacks Timescales and Seeing Red, Annu. Rev. Earth
Planet. Sci. 37:93-115). lambda -> 1 is the runaway threshold: the system
stops damping perturbations and locks in.

Elasticities are dimensionless, so lambda is dimensionless and comparable
across cities, seasons and years. That is why the formulation uses logs
rather than raw partial derivatives.

=============================================================================
THE TRAP THIS SCRIPT IS BUILT TO AVOID
=============================================================================
PM2.5, PBL height and surface shortwave ALL have huge, in-phase diurnal
cycles. A naive regression of ln C on ln H recovers the diurnal cycle, not
the feedback, and returns a beautiful, meaningless e1 near -1 every time.

The fix, applied everywhere below: every variable is converted to a
LOG ANOMALY from its own (month, hour-of-day) climatology before any
regression. What remains is the perturbation about the normal diurnal
evolution - which is exactly the quantity a feedback gain is defined on.
If this step is removed, lambda still computes and is still wrong.

=============================================================================
SUPPORTING EVIDENCE FOR THE MAGNITUDES (published work)
=============================================================================
  * Aerosol dimming over Delhi / Indo-Gangetic Plain: WRF-Chem studies report
    surface shortwave reduction of roughly 25-80 W m-2 during haze episodes.
  * PBL collapse over Delhi: daytime maximum height falls from about 1.3 km
    in clean air toward about 0.6 km under heavy aerosol loading (WiFEX).
  * Aerosol-boundary-layer feedback framing: Ding et al. 2016 GRL, the black
    carbon dome effect; Petaja et al. 2016 Sci. Rep. on aerosol-BL feedback
    in polluted megacities; subsequent work on the secondary-aerosol positive
    feedback during severe haze.
  * Ventilation coefficient (PBLH x wind) is the conventional dispersion
    metric that lambda must outperform to be worth reporting.
Full citation table lives in the architecture document.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

# Maximum cloud cover (%) for an hour to count toward the aerosol-attenuation
# term. Above this, cloud dominates the clearness index and the aerosol signal
# cannot be separated from it.
CLOUD_MAX_PCT = 25.0

PANEL = C.PROCESSED / "panel_hourly.parquet"
OUT = C.PROCESSED / "lambda_hourly.parquet"


# --------------------------------------------------------------------------
# anomaly construction
# --------------------------------------------------------------------------

def log_anomaly(df: pd.DataFrame, col: str, floor: float) -> pd.Series:
    """
    ln(x) minus its (month, hour-of-day) climatological mean.

    Its own function because this is the single most important methodological
    choice in the pipeline and it must be applied identically to all four
    variables. Any inconsistency here silently corrupts lambda.

    floor guards the log against zeros and physically impossible values.
    """
    x = df[col].where(df[col] > floor)
    lx = np.log(x)
    clim = lx.groupby([df["month"], df["hour_ist"]]).transform("mean")
    return lx - clim


def build_anomalies(df: pd.DataFrame) -> pd.DataFrame:
    """Assemble the anomaly frame the elasticity fits consume."""
    a = pd.DataFrame(index=df.index)
    a["lC"] = log_anomaly(df, "pm25_ncr", floor=1.0)      # aerosol load
    a["lH"] = log_anomaly(df, "blh", floor=20.0)          # PBL height
    a["lS"] = log_anomaly(df, "clearness", floor=0.02)    # clear-sky-normalised SW
    a["lU"] = log_anomaly(df, "wind_speed", floor=0.2)    # control
    # Cloud is NOT log-transformed: it is a percentage that legitimately hits
    # zero, and it is used as a filter rather than as an elasticity.
    a["cloud"] = df["cloud_cover"] if "cloud_cover" in df.columns else 0.0
    a["is_day"] = df["is_day"]
    a["in_season"] = df["in_season"]
    a["hour_ist"] = df["hour_ist"]
    return a


# --------------------------------------------------------------------------
# elasticity estimation
# --------------------------------------------------------------------------

def ols_slope(y: np.ndarray, x: np.ndarray,
              controls: list | None = None) -> tuple[float, float, int]:
    """
    Partial slope of y on x, optionally controlling for other regressors.

    Plain least squares with an intercept. Returns (slope, r2, n).

    Written out rather than pulled from statsmodels so the pipeline has no
    heavyweight dependency and so a reviewer can see there is no hidden
    regularisation, weighting or robustification changing the answer.
    """
    cols = [x] if controls is None else [x, *controls]
    X = np.column_stack([np.ones_like(x), *cols])
    mask = np.isfinite(X).all(axis=1) & np.isfinite(y)
    if mask.sum() < C.ELASTICITY_MIN_SAMPLES:
        return np.nan, np.nan, int(mask.sum())
    Xm, ym = X[mask], y[mask]
    beta, *_ = np.linalg.lstsq(Xm, ym, rcond=None)
    resid = ym - Xm @ beta
    ss_tot = ((ym - ym.mean()) ** 2).sum()
    r2 = 1.0 - (resid ** 2).sum() / ss_tot if ss_tot > 0 else np.nan
    return float(beta[1]), float(r2), int(mask.sum())


def estimate_elasticities(a: pd.DataFrame) -> dict:
    """
    Fit e1, e2, e3 on one block of anomalies.

    Control choices, stated explicitly because they are contestable:
      e1 (C on H): wind anomaly is controlled for. Wind ventilates
          horizontally and would otherwise be absorbed into the vertical
          dilution term.
      e2 (H on S): no control. Radiation is the buoyancy source; adding
          wind here would remove mechanical turbulence that is genuinely
          part of PBL growth.
      e3 (S on C): NO humidity control, deliberately. Hygroscopic growth
          under high RH is part of the causal path from dry mass to optical
          extinction. Controlling for RH would remove real feedback.
    """
    day = a[a.is_day & a.in_season]

    # e1 and e2 use all daytime hours: cloud-driven radiation variability is a
    # genuine driver of PBL growth and must not be filtered out of e2.
    e1, r1, n1 = ols_slope(day.lC.to_numpy(), day.lH.to_numpy(),
                           controls=[day.lU.to_numpy()])
    e2, r2, n2 = ols_slope(day.lH.to_numpy(), day.lS.to_numpy())

    # e3 is different. The clearness index carries cloud AND aerosol, and cloud
    # is by far the larger signal. Estimating the aerosol attenuation on all
    # hours would mostly measure cloudiness that happens to correlate with
    # stagnation. Restricting to low-cloud hours is the standard way surface
    # pyranometer records are used to infer aerosol optical effects.
    clear = day[day.cloud <= CLOUD_MAX_PCT]
    e3, r3, n3 = ols_slope(clear.lS.to_numpy(), clear.lC.to_numpy())

    lam = e1 * e2 * e3 if all(np.isfinite([e1, e2, e3])) else np.nan
    return {
        "e1_C_on_H": e1, "e1_r2": r1, "e1_n": n1,
        "e2_H_on_S": e2, "e2_r2": r2, "e2_n": n2,
        "e3_S_on_C": e3, "e3_r2": r3, "e3_n": n3,
        "lambda": lam,
        "amplification": (1.0 / (1.0 - lam)
                          if np.isfinite(lam) and lam < 0.98 else np.inf),
    }


def rolling_lambda(a: pd.DataFrame, window_h: int) -> pd.DataFrame:
    """
    Re-estimate lambda on a trailing window so it becomes a TIME SERIES.

    A single season-wide lambda says whether the feedback exists. A rolling
    lambda says when it is active - which is the operationally useful object,
    and the one that can be forecast.
    """
    idx = a.index
    out = []
    step = 6                                  # recompute every 6 h
    for i in range(window_h, len(idx), step):
        block = a.iloc[i - window_h:i]
        est = estimate_elasticities(block)
        est["datetime_utc"] = idx[i]
        out.append(est)
    return pd.DataFrame(out).set_index("datetime_utc")


# --------------------------------------------------------------------------
# sanity checks
# --------------------------------------------------------------------------

def report_signs(est: dict) -> bool:
    """
    Confirm the fitted elasticities have the signs the physics demands.

    This is the honesty gate. If e1 is positive, or e3 is positive, the data
    does not contain the mechanism and lambda must NOT be reported as a
    feedback gain. Printing this rather than hiding it is the difference
    between a diagnostic and a number.
    """
    checks = [
        ("e1 = dlnC/dlnH  should be NEGATIVE (dilution)", est["e1_C_on_H"], -1),
        ("e2 = dlnH/dlnS  should be POSITIVE (radiative growth)", est["e2_H_on_S"], +1),
        ("e3 = dlnS/dlnC  should be NEGATIVE (attenuation)", est["e3_S_on_C"], -1),
    ]
    ok = True
    print("\n  physical sign checks")
    print("  " + "-" * 62)
    for label, val, want in checks:
        good = bool(np.isfinite(val)) and np.sign(val) == want
        ok &= good
        print(f"  {'PASS' if good else 'FAIL'}  {label:<52} {val:+.3f}")
    return ok


def main() -> None:
    if not PANEL.exists():
        raise SystemExit(f"[lambda] missing {PANEL}. Run 03_build_panel.py first.")

    df = pd.read_parquet(PANEL)
    print(f"[lambda] panel rows={len(df)}")

    if "cloud_cover" in df.columns:
        day_season = df[df.is_day & df.in_season]
        frac = (day_season.cloud_cover <= CLOUD_MAX_PCT).mean()
        print(f"[lambda] low-cloud daytime hours (<={CLOUD_MAX_PCT:.0f}%): "
              f"{frac*100:.0f}% of in-season daytime")

    need = ["pm25_ncr", "blh", "clearness", "wind_speed"]
    missing = [c for c in need if c not in df.columns]
    if missing:
        raise SystemExit(f"[lambda] panel is missing {missing}")

    # Hold out the evaluation episodes from the training-period estimate.
    holdout = pd.Series(False, index=df.index)
    for lo, hi in C.HOLDOUT_PERIODS:
        holdout |= ((df.index >= pd.Timestamp(lo, tz="UTC")) &
                    (df.index <= pd.Timestamp(hi, tz="UTC")))
    df["holdout"] = holdout

    a = build_anomalies(df)

    print("\n[lambda] season-wide estimate on TRAINING period only")
    train_est = estimate_elasticities(a[~holdout.to_numpy()])
    for k, v in train_est.items():
        print(f"    {k:<16} {v}")
    signs_ok = report_signs(train_est)

    print(f"\n[lambda] rolling estimate, window={C.ELASTICITY_WINDOW_HOURS}h")
    roll = rolling_lambda(a, C.ELASTICITY_WINDOW_HOURS)
    print(f"[lambda] rolling points={len(roll)}  "
          f"median={roll['lambda'].median():.3f}  "
          f"p95={roll['lambda'].quantile(0.95):.3f}")

    carry = [c for c in ["pm25_ncr", "blh", "clearness", "wind_speed",
                         "vent_coef", "rh", "hour_ist", "month", "holdout"]
             if c in df.columns]
    merged = roll.join(df[carry], how="left")
    merged.to_parquet(OUT)
    print(f"[lambda] wrote {OUT}")

    if not signs_ok:
        print("\n[lambda] *** SIGN CHECK FAILED - lambda is NOT a valid "
              "feedback gain on this data. Do not present it as one. ***")


if __name__ == "__main__":
    main()
