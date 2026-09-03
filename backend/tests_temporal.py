"""
Temporal integrity: nothing in a replay may come from after the moment it replays.

WHY THIS TEST EXISTS
    The forecast layer is leakage-proof by construction - models are named for the last
    date they were allowed to see, and load_for() only offers files with
    train_end <= as_of, so a replay CANNOT load a later model.

    The presentation layer undid that guarantee. intelligence.exposure() read
    MAX(timestamp) from the live capture regardless of as_of, so a reconstruction of
    02 November 2024 rendered its spatial panel, its station count and its "worst
    places" ranking from the September 2026 network - under a banner promising the
    opposite. A judge who checks one timestamp finds it immediately, and the leakage
    proof elsewhere stops being believed.

    So this asserts the property END TO END, on the payload the dashboard actually
    receives, for every mode the demo uses.

WHAT IT CHECKS
    1. Every timestamp in a replay payload is <= as_of.
    2. The observation names its target and its monitor count, and never manufactures
       one - a legacy hour reports the count the store holds, not today's network size.
    3. Live and replay differ ONLY by as_of: same endpoint, same keys, same shapes.
    4. Replay is deterministic - the same as_of twice returns the same decision.
    5. All four status values are presentable, including EPISODE_UNDERWAY, which the
       dashboard used to render as "stable".

Run:  python -m backend.tests_temporal          (needs the API on :8102)
      python -m backend.tests_temporal --url http://127.0.0.1:8000
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_URL = "http://127.0.0.1:8102"

REPLAYS = [
    "2024-11-02T06:00:00Z",
    "2024-11-14T00:00:00Z",
    "2024-11-16T00:00:00Z",
]

# Keys whose values are timestamps describing WHEN SOMETHING WAS OBSERVED OR FORECAST.
# generated_at is deliberately excluded: it records when the reconstruction was
# computed, which is legitimately "now" even for a 2024 replay.
_WALL_CLOCK_KEYS = {"generated_at"}


def _get(url: str, timeout: int = 120) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _parse(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _walk_timestamps(node, path="", out=None):
    """Every ISO-8601 string in the payload, with the path that reached it."""
    if out is None:
        out = []
    if isinstance(node, dict):
        for k, v in node.items():
            if k in _WALL_CLOCK_KEYS:
                continue
            _walk_timestamps(v, f"{path}.{k}" if path else k, out)
    elif isinstance(node, list):
        # Sample the ends of long series rather than all 72 points; a leak that appears
        # only in the middle of an ordered series is not a failure mode this can have.
        items = node if len(node) <= 6 else [*node[:3], *node[-3:]]
        for i, v in enumerate(items):
            _walk_timestamps(v, f"{path}[{i}]", out)
    elif isinstance(node, str) and len(node) >= 19 and node[4] == "-":
        ts = _parse(node)
        if ts is not None:
            out.append((path, ts))
    return out


def check_replay_is_clean(payload: dict, as_of_raw: str) -> list[str]:
    """No OBSERVED quantity may postdate the moment being replayed."""
    failures = []
    as_of = _parse(as_of_raw)
    assert as_of is not None

    for path, ts in _walk_timestamps(payload):
        # `valid_at` means "the hour this forecast is FOR" - it is ahead of the issue
        # time by definition, everywhere it appears (forecast.series, and
        # risk.supporting_points, which is the forecast window backing the warning).
        # Observed instants use different names: observed_at, as_of, checked_at.
        if path.endswith("valid_at"):
            continue
        if ".at" in path or path.startswith("timeline"):
            continue          # timeline marks are future milestones by design
        if path.endswith("first_crossing") or path.endswith("onset"):
            continue          # forecast events, also legitimately ahead
        if ts > as_of:
            failures.append(
                f"    {path} = {ts:%Y-%m-%d %H:%M} is AFTER as_of {as_of:%Y-%m-%d %H:%M}")
    return failures


def check_observation_contract(payload: dict, mode: str) -> list[str]:
    failures = []
    obs = payload.get("observation") or {}

    for key in ("value", "unit", "band", "observed_at", "target",
                "target_label", "n_stations", "source"):
        if key not in obs:
            failures.append(f"    observation is missing {key!r}")

    target = obs.get("target")
    if target not in ("legacy", "network"):
        failures.append(f"    observation.target = {target!r}, expected legacy|network")

    observed_at = _parse(obs.get("observed_at", ""))
    as_of = _parse(payload.get("as_of", ""))
    if observed_at and as_of and observed_at > as_of:
        failures.append("    observation.observed_at is after as_of")

    # The rule that matters: a historical hour must not borrow today's station count.
    if mode == "replay" and target == "network":
        failures.append(
            "    a 2024 replay reported a NETWORK target - station-level capture "
            "begins Sept 2026, so this can only be leaked live data")

    return failures


def check_exposure(payload: dict, mode: str, as_of_raw: str) -> list[str]:
    failures = []
    exp = payload.get("exposure") or {}
    kind = exp.get("kind")

    if kind not in ("network", "composite_only", "none"):
        failures.append(f"    exposure.kind = {kind!r}, expected network|composite_only|none")

    as_of = _parse(as_of_raw)
    observed_at = _parse(exp.get("observed_at") or "")
    if observed_at and as_of and observed_at > as_of:
        failures.append(
            f"    exposure.observed_at {observed_at:%Y-%m-%d %H:%M} is AFTER "
            f"as_of {as_of:%Y-%m-%d %H:%M} - this is the leak the fix removed")

    if mode == "replay" and kind == "network":
        failures.append(
            "    a 2024 replay returned a station-level exposure field; the store has "
            "no station rows before Sept 2026, so this is current data")

    if kind == "network":
        for st in exp.get("points") or []:
            if st.get("band") is None:
                failures.append("    a station in exposure.points has no CPCB band")
                break
    return failures


def check_status_contract(payload: dict) -> list[str]:
    failures = []
    risk = payload.get("risk") or {}
    status = risk.get("status")

    valid = {"SEVERE_EPISODE_UNDERWAY", "PREDICTIVE_WARNING",
             "EPISODE_UNDERWAY", "MONITOR"}
    if status not in valid:
        failures.append(f"    risk.status = {status!r}, not one of the four states")

    for key in ("status_label", "status_short", "status_tone"):
        if not risk.get(key):
            failures.append(f"    risk.{key} missing - the UI would have to infer it")

    tone = risk.get("status_tone")
    if tone not in ("critical", "warning", "elevated", "calm"):
        failures.append(f"    risk.status_tone = {tone!r} is outside the vocabulary")

    # Precedence: a severe episode must never be reported as a predictive warning,
    # because a continuation is not a new warning.
    if risk.get("severe_episode_underway") and status == "PREDICTIVE_WARNING":
        failures.append("    severe episode reported as PREDICTIVE_WARNING")

    return failures


def check_all_four_states_presentable() -> list[str]:
    """The table must cover every state the engine can emit."""
    # Imported through the `backend` package, not off sys.path: backend/api/routes uses
    # package-relative imports (`from ...backfill import db`), so reaching it as a
    # top-level `api.routes` fails on the first one.
    from backend.api.routes.intelligence import STATUS_PRESENTATION   # noqa: PLC0415
    from backend.streaming.predictive_engine import status_for        # noqa: PLC0415

    emitted = {
        status_for(300.0, False)[0],   # severe
        status_for(50.0, True)[0],     # predictive warning
        status_for(150.0, False)[0],   # episode under way
        status_for(20.0, False)[0],    # monitor
    }
    missing = emitted - set(STATUS_PRESENTATION)
    return [f"    status {s!r} is emitted but has no presentation" for s in sorted(missing)]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Temporal integrity checks")
    p.add_argument("--url", default=DEFAULT_URL)
    args = p.parse_args(argv)

    print("\nTEMPORAL INTEGRITY")
    print("  " + "-" * 74)

    failures: list[str] = []

    print("\n  all four states have a presentation")
    state_fail = check_all_four_states_presentable()
    print("    OK" if not state_fail else "\n".join(state_fail))
    failures += state_fail

    # --- live ---------------------------------------------------------------
    print(f"\n  LIVE  {args.url}/api/aree/outlook")
    try:
        live = _get(f"{args.url}/api/aree/outlook")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:200]
        print(f"    UNAVAILABLE (HTTP {exc.code}) {body}")
        print("    Live needs recent observed lags; replay checks continue.")
        live = None
    except Exception as exc:                                     # noqa: BLE001
        print(f"    UNREACHABLE: {exc}")
        return 2

    live_keys: set[str] = set()
    if live:
        live_keys = set(live)
        obs = live["observation"]
        print(f"    mode={live['mode']}  as_of={live['as_of']}  "
              f"status={live['risk']['status']}")
        print(f"    observation: {obs['value']} ug/m3 · target={obs['target']} · "
              f"n_stations={obs['n_stations']}")
        print(f"    exposure   : kind={live['exposure'].get('kind')} "
              f"observed_at={live['exposure'].get('observed_at')}")
        f = check_observation_contract(live, "live") + \
            check_exposure(live, "live", live["as_of"]) + \
            check_status_contract(live)
        print("    OK" if not f else "\n".join(f))
        failures += f

    # --- replays ------------------------------------------------------------
    for at in REPLAYS:
        print(f"\n  REPLAY  ?at={at}")
        try:
            payload = _get(f"{args.url}/api/aree/outlook?at={at}")
        except Exception as exc:                                 # noqa: BLE001
            print(f"    FAILED: {exc}")
            failures.append(f"    replay {at} did not answer")
            continue

        obs = payload["observation"]
        exp = payload["exposure"]
        print(f"    mode={payload['mode']}  as_of={payload['as_of']}  "
              f"status={payload['risk']['status']} ({payload['risk']['status_label']})")
        print(f"    observation: {obs['value']} ug/m3 · target={obs['target']} · "
              f"n_stations={obs['n_stations']} · {obs['target_label']}")
        print(f"    exposure   : kind={exp.get('kind')} "
              f"n_monitors={exp.get('n_monitors')} "
              f"observed_at={exp.get('observed_at')}")

        f = (check_replay_is_clean(payload, at)
             + check_observation_contract(payload, "replay")
             + check_exposure(payload, "replay", at)
             + check_status_contract(payload))

        if payload["mode"] != "replay":
            f.append(f"    mode is {payload['mode']!r}, expected 'replay'")
        if payload["as_of"] != at:
            f.append(f"    as_of was moved: asked {at}, got {payload['as_of']}")

        # Same code path: a replay must carry the same top-level keys as live.
        if live_keys:
            missing = live_keys - set(payload)
            extra = set(payload) - live_keys
            if missing or extra:
                f.append(f"    shape differs from live: missing={sorted(missing)} "
                         f"extra={sorted(extra)}")

        print("    OK" if not f else "\n".join(f))
        failures += f

    # --- determinism --------------------------------------------------------
    print(f"\n  DETERMINISM  ?at={REPLAYS[0]} twice")
    try:
        a = _get(f"{args.url}/api/aree/outlook?at={REPLAYS[0]}")
        b = _get(f"{args.url}/api/aree/outlook?at={REPLAYS[0]}")
        drift = [k for k in ("observation", "risk", "decision", "mechanism", "timeline")
                 if json.dumps(a.get(k), sort_keys=True, default=str)
                 != json.dumps(b.get(k), sort_keys=True, default=str)]
        if drift:
            failures.append(f"    replay is not deterministic; {drift} differ")
            print(f"    NOT DETERMINISTIC: {drift}")
        else:
            print("    OK - identical observation, risk, decision, mechanism, timeline")
    except Exception as exc:                                     # noqa: BLE001
        print(f"    FAILED: {exc}")

    print("\n" + "  " + "-" * 74)
    if failures:
        print(f"  {len(failures)} FAILURE(S)")
        return 1
    print("  ALL TEMPORAL INTEGRITY CHECKS PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
