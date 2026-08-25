"""
Step 9 - the experiment that decides whether the product works.

THE CHAIN THIS TESTS
    Step 7/8 established that lock-in is not diagnosable from the state at
    onset (ventilation before onset: AUC 0.514) but IS determined by the
    ventilation over the following 48 hours (AUC 0.736).

    That 0.736 is a PERFECT-KNOWLEDGE upper bound. It assumes you already know
    the weather that has not happened. The operational question is:

        how much of 0.736 survives when you only have a forecast?

    If most of it survives, the whole product works:
        forecast ventilation -> predict lock-in -> issue intervention lead time
    If it collapses toward 0.5, ventilation is not forecastable far enough
    ahead to be actionable, and the lead-time claim has to shrink to whatever
    horizon actually holds.

HOW THE FORECAST IS OBTAINED HONESTLY
    Open-Meteo's previous-runs API serves, for each valid hour, the value that
    was FORECAST for it one day earlier, two days earlier, and so on. That is
    archived model output, not hindcast: it is what a forecaster would have
    had in hand at that lead time. Using it avoids the cardinal sin of
    evaluating a forecast system against data it has already seen.

    Approximation, stated rather than hidden: previous_dayN gives a roughly
    constant N-day lead across the window, whereas a real forecast issued at
    onset has lead times sweeping 0 to 48 h. previous_day1 is therefore
    slightly pessimistic for the first hours and slightly optimistic for the
    last. It brackets the operational case rather than reproducing it exactly.

WHAT IS REPORTED
    AUC for lock-in prediction using
      * analysis          (perfect knowledge, the 0.736 ceiling)
      * 1-day-ahead forecast
      * 2-day-ahead forecast
      * persistence        (the baseline any forecast must beat)
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aree import config as C
from importlib import import_module

auc_mann_whitney = import_module("06_validate_lambda").auc_mann_whitney
sweep_threshold = import_module("06_validate_lambda").sweep_threshold

PREV_RUNS = "https://previous-runs-api.open-meteo.com/v1/forecast"
CACHE = C.INTERIM / "openmeteo_previous_runs.parquet"
REPORT = C.PROCESSED / "forecast_skill_report.json"

BASE_VARS = ["boundary_layer_height", "wind_speed_10m"]
LEADS = [1, 2]                      # days ahead

# Window after onset over which ventilation decides the outcome. 48 h is not
# tuned - it is the window step 7 used to establish the 0.736 ceiling, and
# changing it here would make the comparison meaningless.
OUTCOME_WINDOW_H = 48


def build_var_list() -> list[str]:
    """Analysis fields plus one previous-run field per lead."""
    out = list(BASE_VARS)
    for lead in LEADS:
        out += [f"{v}_previous_day{lead}" for v in BASE_VARS]
    return out


def fetch_previous_runs(lat: float, lon: float,
                        start: str, end: str) -> pd.DataFrame:
    """
    Pull analysis and archived forecast values in one request.

    One request rather than one per lead so every series is guaranteed to come
    from the same grid cell and the same time base. Fetching them separately
    would risk silently comparing forecasts and analyses from different cells.
    """
    params = {
        "latitude": lat, "longitude": lon,
        "start_date": start, "end_date": end,
        "hourly": ",".join(build_var_list()),
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }
    for attempt in range(4):
        try:
            r = requests.get(PREV_RUNS, params=params, timeout=180)
            if r.status_code == 429:
                time.sleep(15 * (attempt + 1))
                continue
            r.raise_for_status()
            h = r.json()["hourly"]
            df = pd.DataFrame(h)
            df["datetime_utc"] = pd.to_datetime(df.pop("time"), utc=True)
            return df.set_index("datetime_utc").sort_index()
        except Exception as exc:                            # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(8 * (attempt + 1))
    return pd.DataFrame()


def ventilation(df: pd.DataFrame, suffix: str = "") -> pd.Series:
    """
    Ventilation coefficient = mixing depth x transport speed.

    Computed identically for analysis and every forecast lead, from the same
    function, so any difference in skill is a property of the forecast and not
    of how the metric was assembled.
    """
    blh = df.get(f"boundary_layer_height{suffix}")
    wind = df.get(f"wind_speed_10m{suffix}")
    if blh is None or wind is None:
        return pd.Series(dtype=float)
    return (blh * wind).rename(f"vent{suffix or '_analysis'}")


def window_mean(series: pd.Series, t0: pd.Timestamp,
                h0: int, h1: int) -> float:
    lo, hi = t0 + pd.Timedelta(hours=h0), t0 + pd.Timedelta(hours=h1)
    seg = series.loc[(series.index >= lo) & (series.index < hi)].dropna()
    return float(seg.mean()) if len(seg) else np.nan


def score(name: str, values: np.ndarray, labels: np.ndarray,
          holdout: np.ndarray) -> dict:
    """
    AUC and operating point for one predictor.

    Low ventilation means trapped air, so the predictor is negated to keep the
    convention "higher score = higher risk" consistent with everything else in
    the pipeline.
    """
    risk = -values
    tr = ~holdout & np.isfinite(risk)
    pos = risk[tr & (labels == "locked_in")]
    neg = risk[tr & (labels == "ventilated")]
    if len(pos) < 5 or len(neg) < 5:
        return {"predictor": name, "error": "insufficient training episodes"}

    a = auc_mann_whitney(pos, neg)
    sweep = sweep_threshold(pos, neg)
    best = sweep.loc[sweep.youden.idxmax()]
    thr = float(best.threshold)

    te = holdout & np.isfinite(risk)
    tp = risk[te & (labels == "locked_in")]
    tn = risk[te & (labels == "ventilated")]

    return {
        "predictor": name,
        "n_train": int(len(pos) + len(neg)),
        "auc": float(a),
        "threshold": thr,
        "hit_rate": float(best.hit_rate),
        "false_alarm": float(best.false_alarm_rate),
        "n_holdout": int(te.sum()),
        "hit_rate_holdout": float((tp >= thr).mean()) if len(tp) else None,
        "false_alarm_holdout": float((tn >= thr).mean()) if len(tn) else None,
    }


def main() -> None:
    ep = pd.read_parquet(C.PROCESSED / "episodes.parquet")
    print(f"[skill] episodes={len(ep)}  locked_in={int((ep.label=='locked_in').sum())}")

    if CACHE.exists():
        prev = pd.read_parquet(CACHE)
        print(f"[skill] using cached previous-runs data ({len(prev)} hours)")
    else:
        lat = (C.NCR_LAT_RANGE[0] + C.NCR_LAT_RANGE[1]) / 2
        lon = (C.NCR_LON_RANGE[0] + C.NCR_LON_RANGE[1]) / 2
        print(f"[skill] fetching previous-runs at {lat:.2f},{lon:.2f} ...")
        prev = fetch_previous_runs(lat, lon, "2020-10-01", "2025-03-31")
        prev.to_parquet(CACHE)
        print(f"[skill] wrote {CACHE}  hours={len(prev)}")

    avail = {c: int(prev[c].notna().sum()) for c in prev.columns}
    print("\n[skill] non-null hours per field")
    for k, v in avail.items():
        print(f"    {k:<48} {v:>7}")

    series = {"analysis": ventilation(prev)}
    for lead in LEADS:
        s = ventilation(prev, f"_previous_day{lead}")
        if s.notna().sum() > 1000:
            series[f"forecast_{lead}d"] = s
        else:
            print(f"[skill] lead {lead}d unavailable ({s.notna().sum()} hours)")

    # Persistence baseline: ventilation over the 24 h BEFORE onset, carried
    # forward. This is what you would predict with no model at all, and it is
    # the bar a forecast has to clear to be worth anything.
    labels = ep.label.to_numpy()
    holdout = ep.holdout.to_numpy()

    results = []
    for name, s in series.items():
        vals = np.array([window_mean(s, t, 0, OUTCOME_WINDOW_H) for t in ep.onset])
        results.append(score(name, vals, labels, holdout))

    pers = np.array([window_mean(series["analysis"], t, -24, 0) for t in ep.onset])
    results.append(score("persistence_24h", pers, labels, holdout))

    print("\n" + "=" * 74)
    print(f"{'predictor':<22}{'AUC':>8}{'hit':>8}{'FA':>8}{'n':>7}   interpretation")
    print("-" * 74)
    for r in results:
        if "error" in r:
            print(f"{r['predictor']:<22}   {r['error']}")
            continue
        a = r["auc"]
        tag = ("SKILFUL" if a >= 0.70 else
               "weak" if a >= 0.60 else "no skill")
        print(f"{r['predictor']:<22}{a:>8.3f}{r['hit_rate']:>8.2f}"
              f"{r['false_alarm']:>8.2f}{r['n_train']:>7}   {tag}")
    print("=" * 74)

    REPORT.write_text(json.dumps(results, indent=2, default=str))
    print(f"\n[skill] wrote {REPORT}")

    ceiling = next((r for r in results if r["predictor"] == "analysis"), None)
    fc1 = next((r for r in results if r["predictor"] == "forecast_1d"), None)
    base = next((r for r in results if r["predictor"] == "persistence_24h"), None)

    print("\n" + "=" * 74)
    if ceiling and fc1 and "auc" in ceiling and "auc" in fc1:
        retained = (fc1["auc"] - 0.5) / max(ceiling["auc"] - 0.5, 1e-9)
        print(f"skill retained by the 1-day forecast: {retained*100:.0f}% "
              f"of the perfect-knowledge ceiling")
        if base and "auc" in base:
            print(f"persistence baseline: AUC {base['auc']:.3f}")
        if fc1["auc"] >= 0.68 and (not base or fc1["auc"] > base["auc"] + 0.05):
            print("\nVERDICT: the chain works. Forecast ventilation predicts")
            print("lock-in with usable skill and beats persistence. Build the")
            print("product on this.")
        elif fc1["auc"] >= 0.60:
            print("\nVERDICT: partial skill. Usable, but the lead-time claim")
            print("must be scoped to the horizon that actually holds.")
        else:
            print("\nVERDICT: forecast skill does not survive. Ventilation is")
            print("not predictable far enough ahead to drive an intervention")
            print("window at this horizon.")
    print("=" * 74)


if __name__ == "__main__":
    main()
