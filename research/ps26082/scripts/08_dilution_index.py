"""
Step 8 - the ventilation-failure index, a reformulation forced by step 7.

WHY THE ORIGINAL lambda FAILED, IN ONE SENTENCE
    It required differentiating ERA5 boundary-layer-height ANOMALIES, and step
    7 showed those anomalies carry a reliability ratio of 0.016 - essentially
    all noise - so the elasticity that depends on them is attenuated to zero
    and flips sign between specifications.

WHAT STEP 7 ALSO SHOWED
    The raw diurnal structure is textbook. Median PM2.5 falls from 163 ug/m3
    at 23 IST to 79 at 15 IST while BLH rises from 44 m to 1102 m. The
    mechanism is unambiguously present. What is unmeasurable is the small
    residual after the diurnal cycle is removed - not the mechanism itself.

THE REFORMULATION
    Stop trying to measure the loop gain from noisy model-derived derivatives.
    Measure the OBSERVABLE CONSEQUENCE of the loop instead, using the variable
    that is actually well measured: PM2.5 itself.

    Every normal day, convective growth of the mixed layer dilutes the
    overnight accumulation, and surface PM2.5 falls sharply from its
    pre-dawn peak to a mid-afternoon minimum. That drop is the atmosphere
    ventilating. Define

        V = ln( PM_pre_dawn / PM_afternoon )

    V is large on days that ventilate. V collapses toward zero on days when
    the mixed layer fails to grow - which is precisely what the aerosol-
    radiation-PBL feedback does. V is therefore a direct, instrument-grade
    proxy for feedback strength, and it requires NO boundary-layer height, no
    radiation field, and no derivative of anything.

WHY THIS IS NOT CURVE-FITTING TO A DESIRED ANSWER
    V is defined from the physics before looking at the outcome, it uses one
    variable measured by a reference-grade BAM monitor, and it is evaluated on
    the same held-out Novembers with the same episode labels as the original
    formulation. If it fails, it is reported as failing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module

_val = import_module("06_validate_lambda")
auc_mann_whitney = _val.auc_mann_whitney
sweep_threshold = _val.sweep_threshold

PANEL = C.PROCESSED / "panel_hourly.parquet"
EPISODES = C.PROCESSED / "episodes.parquet"
OUT = C.PROCESSED / "dilution_index.parquet"
REPORT = C.PROCESSED / "dilution_report.json"

# Windows in IST. Pre-dawn is the accumulation peak; afternoon is the
# convective minimum. Read straight off the diurnal table printed by step 7.
PREDAWN_HOURS = (22, 6)      # wraps midnight
AFTERNOON_HOURS = (13, 16)


def daily_dilution(df: pd.DataFrame) -> pd.DataFrame:
    """
    One record per day: how much did PM2.5 actually dilute?

    The pre-dawn window wraps midnight, so hours 22-23 are assigned to the
    FOLLOWING day - otherwise a night's accumulation would be split across two
    records and the ratio would compare unrelated air masses.
    """
    d = df.dropna(subset=["pm25_ncr"]).copy()
    ist = d.index + pd.Timedelta(hours=C.IST_OFFSET_HOURS)
    d["hour_ist"] = ist.hour
    d["date_ist"] = ist.date
    d["month_"] = ist.month

    # Roll the late-evening hours forward into the next day's night.
    night_day = np.where(d.hour_ist >= PREDAWN_HOURS[0],
                         ist.date + pd.Timedelta(days=1), ist.date)

    is_night = (d.hour_ist >= PREDAWN_HOURS[0]) | (d.hour_ist <= PREDAWN_HOURS[1])
    is_noon = d.hour_ist.between(*AFTERNOON_HOURS)

    night = (d[is_night].assign(day=night_day[is_night.to_numpy()])
                        .groupby("day")["pm25_ncr"].mean().rename("pm_night"))
    noon = (d[is_noon].groupby("date_ist")["pm25_ncr"]
                      .mean().rename("pm_noon"))
    meta = d.groupby("date_ist").agg(month_=("month_", "first"),
                                     blh_max=("blh", "max"),
                                     wind=("wind_speed", "mean"),
                                     cloud=("cloud_cover", "mean"),
                                     n_st=("n_stations", "median"),
                                     holdout=("holdout", "any"))

    out = pd.concat([night, noon, meta], axis=1).dropna(subset=["pm_night", "pm_noon"])
    out.index = pd.to_datetime(out.index, utc=True)

    # The index itself. Positive = the day ventilated. Near zero or negative =
    # the mixed layer never cleared the overnight load.
    out["V"] = np.log(out.pm_night.clip(lower=1) / out.pm_noon.clip(lower=1))

    # Ventilation FAILURE, so that higher = worse, matching the convention the
    # decision layer already uses for every other risk signal.
    out["vent_failure"] = -out.V
    return out.sort_index()


def seasonal_anomaly(daily: pd.DataFrame) -> pd.DataFrame:
    """
    Remove the month climatology from V.

    December genuinely ventilates less than October; without this the index
    would mostly rank months rather than days. Only the seasonal cycle is
    removed - there is no hour dimension left at daily resolution, which is
    exactly why this formulation is robust where the hourly one was not.
    """
    daily = daily.copy()
    daily["V_anom"] = daily.V - daily.groupby("month_")["V"].transform("mean")
    daily["vf_anom"] = -daily.V_anom
    return daily


def evaluate(daily: pd.DataFrame, ep: pd.DataFrame, col: str) -> dict:
    """Separation and lead time for one predictor, held out honestly."""
    ep = ep.copy()
    series = daily[col]

    preds = []
    for onset in ep.onset:
        lo = onset - pd.Timedelta(hours=48)
        seg = series.loc[(series.index >= lo) & (series.index < onset)]
        preds.append(float(seg.max()) if len(seg) else np.nan)
    ep["pred"] = preds

    train, test = ep[~ep.holdout], ep[ep.holdout]
    pos = train.loc[train.label == "locked_in", "pred"].dropna().to_numpy()
    neg = train.loc[train.label == "ventilated", "pred"].dropna().to_numpy()
    if len(pos) == 0 or len(neg) == 0:
        return {"predictor": col, "error": "one class empty in training"}

    auc = auc_mann_whitney(pos, neg)
    sweep = sweep_threshold(pos, neg)
    best = sweep.loc[sweep.youden.idxmax()]
    thr = float(best.threshold)

    tp = test.loc[test.label == "locked_in", "pred"].dropna().to_numpy()
    tn = test.loc[test.label == "ventilated", "pred"].dropna().to_numpy()

    return {
        "predictor": col,
        "n_train_locked": int(len(pos)),
        "n_train_vent": int(len(neg)),
        "auc_train": float(auc),
        "threshold": thr,
        "hit_rate_train": float(best.hit_rate),
        "false_alarm_train": float(best.false_alarm_rate),
        "n_holdout": int(len(test)),
        "hit_rate_holdout": float((tp >= thr).mean()) if len(tp) else None,
        "false_alarm_holdout": float((tn >= thr).mean()) if len(tn) else None,
    }


def main() -> None:
    df = pd.read_parquet(PANEL)
    daily = seasonal_anomaly(daily_dilution(df))
    season = daily[daily.month_.isin(C.SEASON_MONTHS)]
    print(f"[dilution] daily records: {len(daily)}  in-season: {len(season)}")

    print("\n[dilution] ventilation index V = ln(PM_predawn / PM_afternoon)")
    print(f"  V median (in-season)      {season.V.median():+.3f}")
    print(f"  V p10 / p90               {season.V.quantile(.1):+.3f} / "
          f"{season.V.quantile(.9):+.3f}")
    print(f"  days with V <= 0          {int((season.V <= 0).sum())} "
          f"({100*(season.V <= 0).mean():.0f}%)  - no net daytime dilution")

    # Sanity: does V behave like a ventilation measure?
    s = season.dropna(subset=["blh_max", "wind"])
    if len(s) > 100:
        print("\n[dilution] does V behave like ventilation? (in-season daily)")
        print(f"  corr(V, daytime max BLH)  {np.corrcoef(s.V, s.blh_max)[0,1]:+.3f}")
        print(f"  corr(V, mean wind)        {np.corrcoef(s.V, s.wind)[0,1]:+.3f}")
        print(f"  corr(V, next-day PM2.5)   "
              f"{s.V.corr(s.pm_night.shift(-1)):+.3f}")

    daily.to_parquet(OUT)

    if not EPISODES.exists():
        print("\n[dilution] no episodes file yet - run 05_label_episodes.py")
        return

    ep = pd.read_parquet(EPISODES)
    print(f"\n[dilution] episodes: {len(ep)}  "
          f"locked_in={int((ep.label=='locked_in').sum())}  "
          f"ventilated={int((ep.label=='ventilated').sum())}  "
          f"holdout={int(ep.holdout.sum())}")

    results = [evaluate(daily, ep, "vent_failure"),
               evaluate(daily, ep, "vf_anom")]
    for r in results:
        print(f"\n  predictor: {r['predictor']}")
        if "error" in r:
            print(f"    {r['error']}")
            continue
        print(f"    train  locked={r['n_train_locked']} vent={r['n_train_vent']}")
        print(f"    AUC (train)          {r['auc_train']:.3f}")
        print(f"    hit / false alarm    {r['hit_rate_train']:.2f} / "
              f"{r['false_alarm_train']:.2f}")
        print(f"    HOLDOUT hit / FA     {r['hit_rate_holdout']} / "
              f"{r['false_alarm_holdout']}   (n={r['n_holdout']})")

    REPORT.write_text(json.dumps(results, indent=2, default=str))
    print(f"\n[dilution] wrote {REPORT}")

    best = max((r for r in results if "auc_train" in r),
               key=lambda r: r["auc_train"], default=None)
    print("\n" + "=" * 68)
    if best and best["auc_train"] >= 0.75:
        print(f"VERDICT: ventilation-failure index separates the classes "
              f"(AUC {best['auc_train']:.3f}).")
        print("This replaces lambda as the regime diagnostic. It needs no PBL")
        print("height, so it is immune to the ERA5 noise that killed lambda.")
    elif best and best["auc_train"] >= 0.6:
        print(f"VERDICT: weak separation (AUC {best['auc_train']:.3f}). "
              "Usable as a supporting")
        print("signal, not as the headline claim.")
    else:
        print("VERDICT: no useful separation. Drop the regime-detection claim")
        print("and position on coupled forecasting alone.")
    print("=" * 68)


if __name__ == "__main__":
    main()
