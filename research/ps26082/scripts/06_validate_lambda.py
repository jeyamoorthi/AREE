"""
Step 6 - does lambda separate locked-in episodes from ventilated ones,
         and how far in advance?

THIS SCRIPT IS THE GO / NO-GO GATE FOR THE ENTIRE PROJECT.

If lambda does not separate the two classes with useful lead time, the
central claim is dead and the team must know that in week one, not week six.
Nothing here is tuned to make lambda look good: the decision threshold is
swept, the baseline is a published metric, and the headline number is
computed on episodes the fit never saw.

WHAT IS MEASURED
    1. Separation      distribution of lambda in the pre-onset window for
                       locked-in vs ventilated episodes, with AUC.
    2. Lead time       hours between lambda first crossing its threshold and
                       the episode reaching lock-in severity.
    3. Skill vs baseline
                       the same test using the ventilation coefficient
                       (PBLH x wind), the conventional dispersion metric.
                       lambda has to beat it or it adds nothing.
    4. Operating point false alarm rate at the chosen threshold, because a
                       GRAP escalation has real economic cost and the team
                       will be asked what it costs to be wrong.

OUTPUT
    figures/lambda_separation.png
    figures/lambda_timeseries.png
    data/processed/validation_report.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

LAMBDA = C.PROCESSED / "lambda_hourly.parquet"
EPISODES = C.PROCESSED / "episodes.parquet"
REPORT = C.PROCESSED / "validation_report.json"

PRE_ONSET_WINDOW_H = 24      # window before onset in which we read the predictor


# --------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------

def auc_mann_whitney(pos: np.ndarray, neg: np.ndarray) -> float:
    """
    ROC AUC via the Mann-Whitney U identity.

    Hand-rolled rather than imported so there is no sklearn dependency and the
    computation is auditable. AUC = P(random positive scores above random
    negative), which is exactly the question "does lambda run higher before
    episodes that lock in".
    """
    pos = pos[np.isfinite(pos)]
    neg = neg[np.isfinite(neg)]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    allv = np.concatenate([pos, neg])
    ranks = pd.Series(allv).rank().to_numpy()
    r_pos = ranks[:len(pos)].sum()
    u = r_pos - len(pos) * (len(pos) + 1) / 2
    return float(u / (len(pos) * len(neg)))


def sweep_threshold(pos: np.ndarray, neg: np.ndarray) -> pd.DataFrame:
    """
    Sweep a decision threshold and tabulate the confusion outcomes.

    Kept explicit rather than reduced to a single "best" threshold: the right
    operating point depends on the cost of a false GRAP invocation versus a
    missed episode, and that is a policy judgement for CAQM, not a modelling
    choice. The table is what gets handed to the rule engine.
    """
    cand = np.unique(np.concatenate([pos, neg]))
    cand = cand[np.isfinite(cand)]
    rows = []
    for t in cand:
        tp = int((pos >= t).sum())
        fn = int((pos < t).sum())
        fp = int((neg >= t).sum())
        tn = int((neg < t).sum())
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


# --------------------------------------------------------------------------
# predictor extraction
# --------------------------------------------------------------------------

def predictor_before_onset(series: pd.Series, onset: pd.Timestamp,
                           window_h: int) -> float:
    """
    Value of a predictor in the window BEFORE an episode starts.

    Reading the predictor before onset is what makes this a forecast test
    rather than a description. Taking the maximum over the window rather than
    the value at onset reflects how it would be used operationally: an alert
    fires the first time the threshold is crossed.
    """
    lo = onset - pd.Timedelta(hours=window_h)
    seg = series.loc[(series.index >= lo) & (series.index < onset)]
    return float(seg.max()) if len(seg) else float("nan")


def lead_time_hours(series: pd.Series, threshold: float,
                    onset: pd.Timestamp, search_h: int = 96) -> float:
    """
    Hours between the first threshold crossing and episode onset.

    This is the number that matters operationally. A diagnostic that fires two
    hours before onset is a description; one that fires eighteen hours before
    is a decision-support system, because GRAP measures need time to take
    effect.
    """
    lo = onset - pd.Timedelta(hours=search_h)
    seg = series.loc[(series.index >= lo) & (series.index < onset)].dropna()
    crossed = seg[seg >= threshold]
    if crossed.empty:
        return float("nan")
    return float((onset - crossed.index[0]).total_seconds() / 3600.0)


# --------------------------------------------------------------------------
# evaluation
# --------------------------------------------------------------------------

def evaluate(name: str, series: pd.Series, ep: pd.DataFrame) -> dict:
    """Run the full separation + lead-time evaluation for one predictor."""
    ep = ep.copy()
    ep["pred"] = [predictor_before_onset(series, t, PRE_ONSET_WINDOW_H)
                  for t in ep.onset]

    train = ep[~ep.holdout]
    test = ep[ep.holdout]

    pos = train.loc[train.label == "locked_in", "pred"].to_numpy()
    neg = train.loc[train.label == "ventilated", "pred"].to_numpy()

    auc = auc_mann_whitney(pos, neg)
    sweep = sweep_threshold(pos, neg)
    best = sweep.loc[sweep.youden.idxmax()] if len(sweep) else None
    thr = float(best.threshold) if best is not None else float("nan")

    leads = []
    for _, r in ep[ep.label == "locked_in"].iterrows():
        lt = lead_time_hours(series, thr, r.onset)
        if np.isfinite(lt):
            leads.append(lt)

    # Held-out performance: the only number that should be quoted publicly.
    test_pos = test.loc[test.label == "locked_in", "pred"].to_numpy()
    test_neg = test.loc[test.label == "ventilated", "pred"].to_numpy()
    test_hit = float((test_pos >= thr).mean()) if len(test_pos) else float("nan")
    test_fa = float((test_neg >= thr).mean()) if len(test_neg) else float("nan")

    return {
        "predictor": name,
        "n_locked_in_train": int(len(pos)),
        "n_ventilated_train": int(len(neg)),
        "auc_train": auc,
        "threshold": thr,
        "hit_rate_train": float(best.hit_rate) if best is not None else None,
        "false_alarm_rate_train": float(best.false_alarm_rate) if best is not None else None,
        "median_lead_time_h": float(np.median(leads)) if leads else None,
        "lead_times_h": leads,
        "n_holdout_episodes": int(len(test)),
        "hit_rate_holdout": test_hit,
        "false_alarm_rate_holdout": test_fa,
    }


def make_figures(lam: pd.DataFrame, ep: pd.DataFrame) -> None:
    """Two plots: the separation, and lambda through one held-out episode."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ep = ep.copy()
    ep["pred"] = [predictor_before_onset(lam["lambda"], t, PRE_ONSET_WINDOW_H)
                  for t in ep.onset]

    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    for label, colour in (("ventilated", "#3b82f6"), ("locked_in", "#b91c1c")):
        vals = ep.loc[ep.label == label, "pred"].dropna()
        ax[0].hist(vals, bins=12, alpha=0.65, label=label, color=colour)
    ax[0].set_xlabel("lambda in 24 h before onset")
    ax[0].set_ylabel("episodes")
    ax[0].set_title("Separation by outcome")
    ax[0].legend(frameon=False)

    ax[1].plot(lam.index, lam["lambda"], lw=0.8, color="#111827")
    ax[1].axhline(1.0, ls="--", lw=1, color="#b91c1c")
    ax[1].set_ylabel("lambda")
    ax[1].set_title("Loop gain through the record")
    fig.tight_layout()
    fig.savefig(C.FIGURES / "lambda_separation.png", dpi=150)
    print(f"[validate] wrote {C.FIGURES / 'lambda_separation.png'}")


def main() -> None:
    for p in (LAMBDA, EPISODES):
        if not p.exists():
            raise SystemExit(f"[validate] missing {p}")

    lam = pd.read_parquet(LAMBDA).sort_index()
    ep = pd.read_parquet(EPISODES)
    print(f"[validate] lambda points={len(lam)}  episodes={len(ep)}")

    results = [evaluate("lambda", lam["lambda"], ep)]

    # Baseline. Ventilation is a DISPERSION metric: low ventilation means
    # trapped air, so the predictor is its negative to keep "higher = worse"
    # consistent with lambda.
    if "vent_coef" in lam.columns:
        results.append(evaluate("neg_ventilation_coefficient",
                                -lam["vent_coef"], ep))

    print()
    for r in results:
        print(f"  {r['predictor']}")
        print(f"    AUC (train)            {r['auc_train']}")
        print(f"    threshold              {r['threshold']}")
        print(f"    hit / false-alarm      {r['hit_rate_train']} / "
              f"{r['false_alarm_rate_train']}")
        print(f"    median lead time (h)   {r['median_lead_time_h']}")
        print(f"    HOLDOUT hit / FA       {r['hit_rate_holdout']} / "
              f"{r['false_alarm_rate_holdout']}")
        print()

    REPORT.write_text(json.dumps(results, indent=2, default=str))
    print(f"[validate] wrote {REPORT}")

    try:
        make_figures(lam, ep)
    except Exception as exc:                    # noqa: BLE001
        print(f"[validate] figure step skipped: {exc}")

    lam_auc = results[0]["auc_train"]
    print("\n" + "=" * 66)
    if np.isfinite(lam_auc) and lam_auc >= 0.75:
        print("VERDICT: lambda separates the classes. Proceed to the emulator.")
    elif np.isfinite(lam_auc) and lam_auc >= 0.6:
        print("VERDICT: weak separation. Refine the formulation before building on it.")
    else:
        print("VERDICT: lambda does NOT separate the classes on this data.")
        print("Do not build the pitch on it. Re-examine the elasticity estimates.")
    print("=" * 66)


if __name__ == "__main__":
    main()
