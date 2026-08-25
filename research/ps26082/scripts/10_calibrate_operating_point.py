"""
Step 10 - derive the operating point the application will actually ship.

WHY A SEPARATE CALIBRATION STEP
    Everything before this was science: does the signal exist, does it survive
    a forecast. This step converts the answer into the two numbers the running
    system needs and cannot invent for itself:

        1. the ventilation threshold below which an episode is flagged
        2. what that choice costs in false alarms

    Hard-coding a threshold that "looked about right" is how a demo passes and
    a deployment fails. The number written here comes from the same episode
    set, with the same holdout, as every other result in this repository.

THE COST ASYMMETRY IS A POLICY CHOICE, NOT A MODELLING ONE
    A missed lock-in means a severe multi-day episode nobody prepared for. A
    false alarm means GRAP measures invoked unnecessarily - halted
    construction, closed schools, real economic cost. Those are not
    interchangeable, and the exchange rate between them belongs to CAQM, not
    to us.

    So this script does not pick one threshold. It emits the whole curve plus
    three named operating points, and the application loads whichever the
    operator selects. The default is balanced; the alternatives are there
    because a regulator may reasonably want a different one.

OUTPUT
    backend/config/ventilation_operating_point.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aree import config as C
from importlib import import_module

auc_mann_whitney = import_module("06_validate_lambda").auc_mann_whitney

REPO_ROOT = Path(__file__).resolve().parents[3]
OUT = REPO_ROOT / "backend" / "config" / "ventilation_operating_point.json"

OUTCOME_WINDOW_H = 48


def window_mean(series: pd.Series, t0: pd.Timestamp, h0: int, h1: int) -> float:
    lo, hi = t0 + pd.Timedelta(hours=h0), t0 + pd.Timedelta(hours=h1)
    seg = series.loc[(series.index >= lo) & (series.index < hi)].dropna()
    return float(seg.mean()) if len(seg) else np.nan


def build_curve(vent: np.ndarray, locked: np.ndarray) -> pd.DataFrame:
    """
    Full confusion table across every candidate threshold.

    Emitted whole rather than reduced to a single "best" value because the
    right point depends on the cost ratio, which is not ours to set. The
    application reads a named point from this curve.
    """
    cand = np.unique(vent[np.isfinite(vent)])
    rows = []
    for t in cand:
        flag = vent <= t                       # low ventilation = flag
        tp = int((flag & locked).sum())
        fn = int((~flag & locked).sum())
        fp = int((flag & ~locked).sum())
        tn = int((~flag & ~locked).sum())
        rows.append({
            "threshold": float(t),
            "tp": tp, "fn": fn, "fp": fp, "tn": tn,
            "hit_rate": tp / max(tp + fn, 1),
            "false_alarm_rate": fp / max(fp + tn, 1),
            "precision": tp / max(tp + fp, 1),
        })
    df = pd.DataFrame(rows)
    df["youden"] = df.hit_rate - df.false_alarm_rate
    return df


def pick(df: pd.DataFrame, mode: str) -> dict:
    """
    Three named operating points, each answering a different regulator question.

    balanced      maximise hit rate minus false-alarm rate (Youden J)
    precautionary catch at least 80% of lock-ins, accept the alarms
    conservative  keep false alarms at or under 20%, accept the misses
    """
    if mode == "balanced":
        row = df.loc[df.youden.idxmax()]
    elif mode == "precautionary":
        ok = df[df.hit_rate >= 0.80]
        row = ok.loc[ok.false_alarm_rate.idxmin()] if len(ok) else df.loc[df.hit_rate.idxmax()]
    else:
        ok = df[df.false_alarm_rate <= 0.20]
        row = ok.loc[ok.hit_rate.idxmax()] if len(ok) else df.loc[df.false_alarm_rate.idxmin()]
    return {
        "mode": mode,
        "threshold_m2_s": round(float(row.threshold), 1),
        "hit_rate": round(float(row.hit_rate), 3),
        "false_alarm_rate": round(float(row.false_alarm_rate), 3),
        "precision": round(float(row.precision), 3),
    }


def main() -> None:
    panel = pd.read_parquet(C.PROCESSED / "panel_hourly.parquet")
    ep = pd.read_parquet(C.PROCESSED / "episodes.parquet")

    vent_series = panel["vent_coef"]
    ep = ep.copy()
    ep["vent_after"] = [window_mean(vent_series, t, 0, OUTCOME_WINDOW_H)
                        for t in ep.onset]
    ep = ep.dropna(subset=["vent_after"])

    train = ep[~ep.holdout]
    test = ep[ep.holdout]
    locked_tr = (train.label == "locked_in").to_numpy()
    vent_tr = train.vent_after.to_numpy()

    a = auc_mann_whitney(-vent_tr[locked_tr], -vent_tr[~locked_tr])
    print(f"[calib] training episodes: {len(train)}  "
          f"locked_in={int(locked_tr.sum())}")
    print(f"[calib] ventilation AUC (0-{OUTCOME_WINDOW_H}h after onset): {a:.3f}")

    curve = build_curve(vent_tr, locked_tr)
    points = {m: pick(curve, m)
              for m in ("balanced", "precautionary", "conservative")}

    print("\n[calib] operating points")
    print(f"  {'mode':<16}{'threshold':>12}{'hit':>8}{'false alarm':>14}{'precision':>11}")
    for m, p in points.items():
        print(f"  {m:<16}{p['threshold_m2_s']:>12.0f}{p['hit_rate']:>8.2f}"
              f"{p['false_alarm_rate']:>14.2f}{p['precision']:>11.2f}")

    # Held-out check on the default point.
    default = points["balanced"]
    if len(test):
        vt = test.vent_after.to_numpy()
        lt = (test.label == "locked_in").to_numpy()
        flag = vt <= default["threshold_m2_s"]
        hit = float(flag[lt].mean()) if lt.any() else None
        fa = float(flag[~lt].mean()) if (~lt).any() else None
        print(f"\n[calib] HELD OUT (n={len(test)}): hit={hit} false_alarm={fa}")
    else:
        hit = fa = None

    payload = {
        "metric": "ventilation_coefficient",
        "definition": "boundary_layer_height_m * wind_speed_10m_ms",
        "units": "m2 s-1",
        "outcome_window_hours": OUTCOME_WINDOW_H,
        "auc_training": round(float(a), 3),
        "n_train_episodes": int(len(train)),
        "n_train_locked_in": int(locked_tr.sum()),
        "n_holdout_episodes": int(len(test)),
        "holdout_hit_rate": hit,
        "holdout_false_alarm_rate": fa,
        "default_mode": "balanced",
        "operating_points": points,
        "provenance": {
            "episodes": "research/ps26082/data/processed/episodes.parquet",
            "panel": "research/ps26082/data/processed/panel_hourly.parquet",
            "holdout_periods": C.HOLDOUT_PERIODS,
            "caveat": (
                "Derived from 5 winters of Delhi NCR data in which 64 percent "
                "of in-season hours rest on two or fewer PM2.5 stations. "
                "Sample is small; treat as a starting operating point to be "
                "re-derived once the OpenAQ 2022-2025 gap is closed from CPCB."
            ),
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2))
    print(f"\n[calib] wrote {OUT}")


if __name__ == "__main__":
    main()
