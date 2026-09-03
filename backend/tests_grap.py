"""
The two GRAP tables must agree, for every AQI.

WHY THIS TEST EXISTS
    AREE derives a GRAP stage on two independent paths:

        config.GRAP_STAGES              the observed path (state_machine, station views,
                                        the national summary, the PDF report)
        predictive_engine.GRAP_BY_AQI   the predictive path (assessments and cases)

    They were out of step: config mapped AQI 101-200 to "Stage I (Poor)", so 71 NCR
    stations sitting at ordinary Moderate air advertised a GRAP stage that CAQM had not
    invoked, while the predictive path - which had the boundaries right - disagreed with
    them on the same screen.

    A regulatory stage that depends on which function you asked is worse than either
    answer alone, so this asserts they cannot drift again. It also pins the boundaries
    to the published schedule rather than to whichever table was edited last.

Run:  python -m backend.tests_grap
"""

from __future__ import annotations

import os
import sys

_BACKEND = os.path.dirname(os.path.abspath(__file__))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from config import GRAP_STAGES                                    # noqa: E402
from streaming.predictive_engine import grap_stage_for            # noqa: E402

# The CAQM schedule (backend/policies/GRAP Schedule*.txt, rev. 21.11.2025), stated here
# independently of both implementations so the test fails if BOTH are edited to agree on
# a wrong value.
PUBLISHED = [
    (0, 200, "None"),
    (201, 300, "Stage I (Poor)"),
    (301, 400, "Stage II (Very Poor)"),
    (401, 450, "Stage III (Severe)"),
    (451, 9999, "Stage IV (Severe+)"),
]

MAX_AQI = 600   # AQI is uncapped in practice; Delhi has recorded above 500.


def stage_from_config(aqi: int) -> str:
    """The observed path's lookup, as state_machine performs it."""
    for lo, hi, stage, _desc in GRAP_STAGES:
        if lo <= aqi <= hi:
            return stage
    return "Stage IV (Severe+)"


def stage_from_published(aqi: int) -> str:
    for lo, hi, stage in PUBLISHED:
        if lo <= aqi <= hi:
            return stage
    return "Stage IV (Severe+)"


def main() -> int:
    failures: list[str] = []

    # 1. Every AQI resolves identically on both code paths.
    disagreements = []
    for aqi in range(0, MAX_AQI + 1):
        a = stage_from_config(aqi)
        b = grap_stage_for(aqi)[0]
        if a != b:
            disagreements.append((aqi, a, b))
    if disagreements:
        lo, a, b = disagreements[0]
        failures.append(
            f"config.GRAP_STAGES and predictive_engine.GRAP_BY_AQI disagree for "
            f"{len(disagreements)} AQI values, first at {lo}: {a!r} vs {b!r}")

    # 2. Both agree with the published schedule.
    for aqi in range(0, MAX_AQI + 1):
        want = stage_from_published(aqi)
        if stage_from_config(aqi) != want:
            failures.append(
                f"config.GRAP_STAGES({aqi}) = {stage_from_config(aqi)!r}, "
                f"CAQM schedule says {want!r}")
            break
    for aqi in range(0, MAX_AQI + 1):
        want = stage_from_published(aqi)
        if grap_stage_for(aqi)[0] != want:
            failures.append(
                f"grap_stage_for({aqi}) = {grap_stage_for(aqi)[0]!r}, "
                f"CAQM schedule says {want!r}")
            break

    # 3. The boundaries an evaluator will actually probe.
    boundaries = {
        151: "None",              # the value that shipped as "Stage I (Poor)"
        200: "None",
        201: "Stage I (Poor)",
        300: "Stage I (Poor)",
        301: "Stage II (Very Poor)",
        400: "Stage II (Very Poor)",
        401: "Stage III (Severe)",
        450: "Stage III (Severe)",
        451: "Stage IV (Severe+)",
        501: "Stage IV (Severe+)",  # above the old 500 ceiling
    }
    for aqi, want in boundaries.items():
        got = stage_from_config(aqi)
        if got != want:
            failures.append(f"AQI {aqi}: config gives {got!r}, expected {want!r}")

    # 4. No gaps or overlaps in the table itself.
    for (lo_a, hi_a, *_), (lo_b, *_rest) in zip(GRAP_STAGES, GRAP_STAGES[1:]):
        if lo_b != hi_a + 1:
            failures.append(
                f"GRAP_STAGES has a gap or overlap between {hi_a} and {lo_b}")

    print("GRAP stage tables")
    print("  " + "-" * 62)
    for lo, hi, stage, _ in GRAP_STAGES:
        span = f"{lo}-{hi}" if hi < 9999 else f"{lo}+"
        print(f"  AQI {span:<10} {stage}")
    print("  " + "-" * 62)
    print(f"  checked AQI 0..{MAX_AQI} on both code paths and against the schedule")

    print()
    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("ALL GRAP CHECKS PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
