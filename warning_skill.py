#!/usr/bin/env python
"""
Experiment D — warning skill. The metric the problem statement actually uses.

    python warning_skill.py
    python warning_skill.py --threshold 250 --min-hours 6

THE QUESTION
    MAE is not the currency of disaster management. An authority does not act
    on "mean absolute error 84"; it acts on "a severe episode is likely to
    begin in N hours". So this scores the whole chain in operational units:

        did we warn?   how early?   how often were we wrong?

    And specifically, given the objective experiment:

        Does q90 give earlier and better severe-event warnings without an
        unacceptable false-alarm burden?

    That is a question MAE cannot answer, and it is the one that decides which
    objective ships.

EVERY DEFINITION IS FROZEN HERE, BEFORE ANY RESULT IS SEEN
    Otherwise the event definition becomes a tuning knob and the experiment
    proves nothing. Written down, with the reasoning:

    EVENT       observed PM2.5 >= 250 ug/m3, sustained >= 6 consecutive hours.
                250 is not chosen by eye - it is the CPCB "Severe" breakpoint
                for PM2.5 (the 121-250 band is Very Poor; above 250 is Severe).
                6 hours mirrors the sustained-run rule the live ventilation
                engine already applies, so a historical event and a live alert
                mean the same thing.
    ONSET       the first hour of that run.
    MERGE       two events separated by less than 12 h are one event. Without
                this a single episode that dips for an hour counts twice, and
                the hit rate is inflated by arithmetic rather than skill.
    WARNING     at issue time T, a model warns if its own forecast crosses the
                SAME threshold for the SAME sustained duration anywhere in its
                72 h horizon. Symmetry with the event definition matters: a
                model is asked to predict the thing being scored, not a
                weaker proxy of it.
    HIT         an event for which at least one issue time within 72 h before
                onset produced a warning.
    LEAD        onset minus the EARLIEST such issue time. Earliest, not latest,
                because lead time is the operational product - the question is
                how much warning the authority could have had.
    FALSE ALARM an issue time that warned when no event onset falls inside the
                window it warned about.
    MISS        an event with no qualifying warning.

WHAT IS DELIBERATELY NOT DONE
    No regime classifier touches PM2.5. Nothing here is tuned on the 17-19 Nov
    2024 episode; it is reported separately as a microscope, never selected on.
    Baselines are scored by exactly the same function as the models - if the
    definition flatters anyone, it flatters everyone equally.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env")

_TMP = _PROJECT_ROOT / ".tmp"
_TMP.mkdir(exist_ok=True)
tempfile.tempdir = str(_TMP)
os.environ["TMP"] = os.environ["TEMP"] = os.environ["TMPDIR"] = str(_TMP)

from backend.backfill import baselines, db  # noqa: E402
from backend.streaming import predictive_engine as pe  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Imported from the decision engine, NOT redefined here. The rule that runs in
# production must be the same object this scores, or the two silently drift and
# the validation stops describing the deployed system.
THRESHOLD = pe.SEVERE_PM25_UGM3
MIN_HOURS = pe.WARNING_MIN_HOURS
MERGE_GAP_HOURS = pe.WARNING_MERGE_GAP_HOURS
HORIZON = 72

# Only the single-monitor folds are mutually comparable (C0).
COMPARABLE = (2022, 2023, 2024)
MODELS = ("persistence-v1", "climatology-v1", "lgbm-v1", "lgbm-l2", "lgbm-q90")
EPISODE = ("2024-11-17", "2024-11-19")


def _rule(width: int = 94) -> None:
    print("  " + "─" * width)


def _parse(raw: str) -> datetime:
    return datetime.strptime(raw, "%Y-%m-%dT%H:00:00Z").replace(
        tzinfo=timezone.utc)


def find_runs(series: list[tuple[datetime, float]], threshold: float,
              min_hours: int) -> list[tuple[datetime, datetime]]:
    """Delegates to the decision engine. See the note on THRESHOLD above."""
    return pe.sustained_runs(series, threshold, min_hours)


def merge_events(runs: list[tuple[datetime, datetime]], gap_hours: int
                 ) -> list[tuple[datetime, datetime]]:
    """Delegates to the decision engine. See the note on THRESHOLD above."""
    return pe.merge_runs(runs, gap_hours)


def observed_events(conn, station: str, years: tuple[int, ...],
                    threshold: float, min_hours: int) -> list[dict]:
    """Every severe episode in the scored windows."""
    observations = baselines.load_observations(conn, station)
    events = []
    for year in years:
        series = [(t, v) for t, v in observations.items()
                  if t.year == year and t.month == 11]
        runs = merge_events(find_runs(series, threshold, min_hours),
                            MERGE_GAP_HOURS)
        for start, end in runs:
            peak = max(v for t, v in series if start <= t <= end)
            events.append({"year": year, "onset": start, "end": end,
                           "hours": int((end - start).total_seconds() // 3600) + 1,
                           "peak": peak})
    return events


def model_warnings(conn, station: str, model: str, years: tuple[int, ...],
                   threshold: float, min_hours: int) -> list[dict]:
    """
    Every issue time at which this model raised a sustained warning.

    Grouped by issued_at, because a warning is a decision made at one moment
    from one forecast - not a property of individual hours.
    """
    rows = conn.execute(
        "SELECT issued_at, valid_at, forecast_value FROM forecasts "
        "WHERE station_id = ? AND species = ? AND model_version = ?",
        (station, baselines.SPECIES, model)).fetchall()

    by_issue: dict[datetime, list] = defaultdict(list)
    for r in rows:
        issued = _parse(r["issued_at"])
        if issued.year not in years or issued.month != 11:
            continue
        by_issue[issued].append((_parse(r["valid_at"]), r["forecast_value"]))

    out = []
    for issued, series in by_issue.items():
        runs = merge_events(find_runs(series, threshold, min_hours),
                            MERGE_GAP_HOURS)
        out.append({
            "issued": issued,
            "warned": bool(runs),
            "predicted_onset": runs[0][0] if runs else None,
        })
    return sorted(out, key=lambda w: w["issued"])


def score_model(events: list[dict], warnings: list[dict],
                observations: dict, threshold: float) -> dict:
    """Event-based verification: hits, misses, false alarms, lead times.

    COLD-START is the metric that separates skill from bookkeeping. A model
    that says "still severe" while an episode is already under way will score
    a hit on the next event for free - persistence does exactly this by
    construction. A COLD hit is one whose earliest qualifying warning was
    issued while the observed concentration was still BELOW the threshold:
    the model called an episode that had not started. That is the warning an
    authority can actually act on, and it is the number worth comparing.
    """
    onsets = [e["onset"] for e in events]

    hits, leads, missed = 0, [], []
    cold_hits, cold_leads = 0, []
    for event in events:
        earliest = None
        for w in warnings:
            if not w["warned"]:
                continue
            gap = event["onset"] - w["issued"]
            # A warning counts only if it was issued BEFORE onset and within
            # the horizon it could actually see.
            if timedelta(0) <= gap <= timedelta(hours=HORIZON):
                if earliest is None or w["issued"] < earliest:
                    earliest = w["issued"]
        if earliest is not None:
            hits += 1
            lead = (event["onset"] - earliest).total_seconds() / 3600
            leads.append(lead)
            observed_then = observations.get(earliest)
            if observed_then is not None and observed_then < threshold:
                cold_hits += 1
                cold_leads.append(lead)
        else:
            missed.append(event)

    false_alarms, warned_total = 0, 0
    for w in warnings:
        if not w["warned"]:
            continue
        warned_total += 1
        window_end = w["issued"] + timedelta(hours=HORIZON)
        if not any(w["issued"] <= o <= window_end for o in onsets):
            false_alarms += 1

    quiet = [w for w in warnings
             if not any(w["issued"] <= o <= w["issued"] + timedelta(hours=HORIZON)
                        for o in onsets)]

    return {
        "events": len(events),
        "hits": hits,
        "misses": len(missed),
        "pod": hits / len(events) if events else float("nan"),
        "median_lead": median(leads) if leads else float("nan"),
        "min_lead": min(leads) if leads else float("nan"),
        "max_lead": max(leads) if leads else float("nan"),
        "cold_hits": cold_hits,
        "cold_pod": cold_hits / len(events) if events else float("nan"),
        "cold_lead": median(cold_leads) if cold_leads else float("nan"),
        "alert_burden": warned_total / len(warnings) if warnings else float("nan"),
        "false_alarms": false_alarms,
        "far": false_alarms / warned_total if warned_total else float("nan"),
        "fa_rate": false_alarms / len(quiet) if quiet else float("nan"),
        "warned_total": warned_total,
        "issues": len(warnings),
        "missed_events": missed,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Experiment D — warning skill")
    p.add_argument("--threshold", type=float, default=THRESHOLD)
    p.add_argument("--min-hours", type=int, default=MIN_HOURS)
    p.add_argument("--station", default="")
    args = p.parse_args(argv)

    conn = db.connect()
    station = args.station or baselines.default_station(conn)

    print("\nEXPERIMENT D — WARNING SKILL")
    _rule()
    print(f"  station     {station}")
    print(f"  event       PM2.5 >= {args.threshold:.0f} µg/m³ (CPCB Severe) "
          f"for >= {args.min_hours} consecutive hours")
    print(f"  merged if   separated by < {MERGE_GAP_HOURS} h")
    print(f"  warning     the model's own forecast crosses the SAME threshold")
    print(f"              for the SAME duration inside its {HORIZON} h horizon")
    print(f"  folds       Nov {', '.join(str(y) for y in COMPARABLE)} "
          f"(single-monitor target, mutually comparable)")

    observations = baselines.load_observations(conn, station)
    events = observed_events(conn, station, COMPARABLE,
                             args.threshold, args.min_hours)
    print(f"\n  OBSERVED SEVERE EPISODES: {len(events)}")
    _rule()
    if not events:
        print("  none at this threshold — nothing to score.\n")
        return 1
    print(f"  {'onset (UTC)':<20}{'duration':>10}{'peak PM2.5':>13}")
    for e in events:
        print(f"  {e['onset'].strftime('%Y-%m-%d %H:%M'):<20}"
              f"{e['hours']:>8} h{e['peak']:>13.0f}")
    _rule()

    print(f"\n  {'model':<16}{'POD':>6}{'COLD POD':>10}{'cold lead':>11}"
          f"{'lead med':>10}{'FA':>6}{'alert burden':>14}")
    _rule()

    results = {}
    for model in MODELS:
        warnings = model_warnings(conn, station, model, COMPARABLE,
                                  args.threshold, args.min_hours)
        if not warnings:
            continue
        r = score_model(events, warnings, observations, args.threshold)
        results[model] = r
        cold_lead = (f"{r['cold_lead']:.0f}h" if r["cold_hits"]
                     else "—")
        print(f"  {model:<16}{r['pod']:>6.0%}"
              f"{f'{r[chr(99)+chr(111)+chr(108)+chr(100)+chr(95)+chr(104)+chr(105)+chr(116)+chr(115)]}/{r[chr(101)+chr(118)+chr(101)+chr(110)+chr(116)+chr(115)]}':>10}"
              f"{cold_lead:>11}{r['median_lead']:>9.0f}h"
              f"{r['false_alarms']:>6}{r['alert_burden']:>13.0%} ")
    _rule()
    print("  POD       events warned at all (includes warnings issued while")
    print("            an episode was already under way — cheap for some models)")
    print("  COLD POD  events warned while concentrations were still BELOW the")
    print("            threshold. This is the operationally meaningful number.")
    print("  alert     share of issue times spent in a warning state. A model")
    print("  burden    that is always warning is not warning.")

    # The microscope. Reported, never tuned on.
    print(f"\n  MICROSCOPE — the 17–19 Nov 2024 episode")
    _rule()
    # Match by overlap, not onset date: the 17-19 Nov window sits INSIDE a
    # longer episode that began on the 16th, so an onset-date test misses it.
    target = [e for e in events
              if e["onset"].strftime("%Y-%m-%d") <= EPISODE[1]
              and e["end"].strftime("%Y-%m-%d") >= EPISODE[0]
              and e["year"] == 2024]
    if not target:
        print("  that episode does not meet the frozen event definition.")
    else:
        for e in target:
            print(f"  onset {e['onset']:%Y-%m-%d %H:%M} UTC, "
                  f"{e['hours']} h, peak {e['peak']:.0f} µg/m³")
        for model in MODELS:
            if model not in results:
                continue
            warnings = model_warnings(conn, station, model, (2024,),
                                      args.threshold, args.min_hours)
            best = None
            for e in target:
                for w in warnings:
                    if not w["warned"]:
                        continue
                    gap = (e["onset"] - w["issued"]).total_seconds() / 3600
                    if 0 <= gap <= HORIZON and (best is None or gap > best):
                        best = gap
            print(f"    {model:<16}"
                  + (f"warned {best:.0f} h before onset" if best is not None
                     else "NO WARNING"))
    _rule()
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
