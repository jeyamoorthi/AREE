"""
Step 5 - identify pollution episodes and label which ones LOCKED IN.

WHY THIS IS A SEPARATE STEP FROM lambda
    lambda must never see the labels. If episode labelling used lambda in any
    way, step 6 would be measuring lambda against itself and the separation
    result would be circular - the exact failure mode this whole pipeline is
    designed to avoid. Labels here come only from the PM2.5 trajectory.

DEFINITIONS
    Episode      a contiguous run of hours with PM2.5 above threshold, with
                 short gaps bridged so a single clean hour does not split one
                 physical event into two.
    Locked in    the episode both PERSISTED (>= LOCKIN_MIN_DURATION_H) and
                 INTENSIFIED (peak >= LOCKIN_PEAK_PM25). Both conditions are
                 required: a long mild episode is not a lock-in, and a brief
                 sharp spike from a local source is not one either.
    Ventilated   an episode that crossed the entry threshold and then decayed
                 without meeting the lock-in conditions.

The operational question is whether lambda, computed from meteorology and
aerosol state, tells these two classes apart BEFORE the outcome is visible.

OUTPUT
    data/processed/episodes.parquet  - one row per episode
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aree import config as C

PANEL = C.PROCESSED / "panel_hourly.parquet"
OUT = C.PROCESSED / "episodes.parquet"


def find_runs(mask: pd.Series) -> list[tuple[int, int]]:
    """
    Return (start_idx, end_idx) index pairs for each True run in a boolean series.

    Isolated so the run-finding logic can be tested against hand-built cases;
    off-by-one errors here silently shift every episode boundary by an hour and
    would corrupt the lead-time measurement in step 6.
    """
    vals = mask.to_numpy().astype(bool)
    if not vals.any():
        return []
    edges = np.diff(vals.astype(int))
    starts = list(np.where(edges == 1)[0] + 1)
    ends = list(np.where(edges == -1)[0])
    if vals[0]:
        starts.insert(0, 0)
    if vals[-1]:
        ends.append(len(vals) - 1)
    return list(zip(starts, ends))


def merge_short_gaps(runs: list[tuple[int, int]], max_gap: int) -> list[tuple[int, int]]:
    """
    Bridge runs separated by fewer than max_gap hours.

    Physical justification: a single hour dipping under the threshold during a
    multi-day smog event is measurement noise or a brief gust, not the end of
    the episode. Without this, one November event fragments into a dozen
    pseudo-episodes and the class balance becomes meaningless.
    """
    if not runs:
        return []
    merged = [list(runs[0])]
    for s, e in runs[1:]:
        if s - merged[-1][1] <= max_gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged]


def classify(peak: float, duration_h: int) -> str:
    """Apply the two-condition lock-in rule."""
    if duration_h >= C.LOCKIN_MIN_DURATION_H and peak >= C.LOCKIN_PEAK_PM25:
        return "locked_in"
    return "ventilated"


def build_episodes(df: pd.DataFrame) -> pd.DataFrame:
    """Walk the PM2.5 series and emit one record per episode."""
    pm = df["pm25_ncr"]
    mask = pm >= C.EPISODE_PM25_THRESHOLD
    runs = merge_short_gaps(find_runs(mask), C.EPISODE_MERGE_GAP_H)

    rows = []
    for s, e in runs:
        seg = df.iloc[s:e + 1]
        duration = len(seg)
        if duration < C.EPISODE_MIN_DURATION_H:
            continue
        peak = float(seg["pm25_ncr"].max())
        peak_at = seg["pm25_ncr"].idxmax()
        rows.append({
            "episode_id": f"EP{len(rows):03d}",
            "onset": df.index[s],
            "end": df.index[e],
            "duration_h": duration,
            "peak_pm25": peak,
            "peak_at": peak_at,
            "mean_pm25": float(seg["pm25_ncr"].mean()),
            "mean_blh": float(seg["blh"].mean()) if "blh" in seg else np.nan,
            "mean_wind": float(seg["wind_speed"].mean()) if "wind_speed" in seg else np.nan,
            "mean_vent": float(seg["vent_coef"].mean()) if "vent_coef" in seg else np.nan,
            "label": classify(peak, duration),
            "holdout": bool(seg["holdout"].any()) if "holdout" in seg else False,
        })
    return pd.DataFrame(rows)


def main() -> None:
    if not PANEL.exists():
        raise SystemExit(f"[episodes] missing {PANEL}. Run 03_build_panel.py first.")

    df = pd.read_parquet(PANEL)
    if "holdout" not in df.columns:
        holdout = pd.Series(False, index=df.index)
        for lo, hi in C.HOLDOUT_PERIODS:
            holdout |= ((df.index >= pd.Timestamp(lo, tz="UTC")) &
                        (df.index <= pd.Timestamp(hi, tz="UTC")))
        df["holdout"] = holdout

    df = df[df["in_season"]] if "in_season" in df.columns else df
    df = df.dropna(subset=["pm25_ncr"])
    print(f"[episodes] in-season hours with PM2.5: {len(df)}")

    ep = build_episodes(df)
    if ep.empty:
        raise SystemExit("[episodes] no episodes found - check thresholds")

    ep.to_parquet(OUT)
    n_lock = int((ep.label == "locked_in").sum())
    n_vent = int((ep.label == "ventilated").sum())
    print(f"[episodes] {len(ep)} episodes: {n_lock} locked_in / {n_vent} ventilated")
    print(f"[episodes] holdout episodes: {int(ep.holdout.sum())}")
    print(f"[episodes] wrote {OUT}")
    print()
    cols = ["episode_id", "onset", "duration_h", "peak_pm25", "mean_vent", "label"]
    print(ep[cols].to_string(index=False))


if __name__ == "__main__":
    main()
