"""
Keep the live forecast alive: capture the NCR network every hour, in-process.

THE FAILURE THIS EXISTS TO PREVENT
    The live PM2.5 forecast needs observed lags at 0, 1, 3, 6, 12 and 24 hours before
    its anchor. Those rows come from capture.py, which until now had to be run by hand
    (`python capture.py loop`) or by a Windows scheduled task that was documented but
    never registered on the demo machine.

    Measured on 2026-09-03: the last hourly snapshot was 16:00 the previous day, with a
    single stray row at 23:00. Every anchor in the six-hour backoff window was missing at
    least one lag, so /api/aree/outlook answered

        424  observed PM2.5 missing at lag(s) [0, 1, 3, 6] h before 2026-09-03 03:00 UTC

    and the Atmospheric Outlook - the hero screen - rendered "Outlook unavailable" in
    live mode while replay carried on working. A demonstration that depends on someone
    having remembered to start a second process is a demonstration that fails.

WHY IN THE API PROCESS
    It needs no new dependency, no service manager and no scheduled task, and it lives
    exactly as long as the thing that serves the forecast. The Windows task is still
    worth registering as a second line of defence - the two cannot conflict, because
    every write is an upsert on (station_id, timestamp).

WHAT IT DOES ON BOOT
    Measures the gap first. A gap wider than the lag window cannot be filled by waiting,
    so it backfills from OpenAQ's hourly history before entering the loop. That is the
    same data by a different delivery route, tagged `openaq:hourly` so its origin stays
    visible in the store.

DISABLING IT
    AREE_CAPTURE=off. Tests and short-lived tooling should set it; a demo should not.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

log = logging.getLogger("aree.capture")

# The upstream network publishes hourly. Polling faster buys nothing and only risks the
# endpoint; polling slower loses hours permanently.
INTERVAL_SECONDS = 3600

# How long after the hour to sample. CPCB/CAQM publish with 40-100 minutes of delay, so
# sampling at :10 catches the hour that has just been published rather than racing it.
OFFSET_SECONDS = 600

# A gap wider than this cannot be repaired by waiting - the oldest lag the forecast needs
# is 24 h, so anything approaching that has to be backfilled from history instead.
MAX_TOLERABLE_GAP_HOURS = 2
BOOTSTRAP_DAYS = 3

# Retry cadence while the source is failing. Short enough to recover within one lag slot.
RETRY_SECONDS = 300

_thread: threading.Thread | None = None
_stop = threading.Event()
_state: dict = {
    "enabled": False,
    "running": False,
    "last_snapshot_at": None,
    "last_written": None,
    "last_error": None,
    "cycles": 0,
    "bootstrapped": False,
    # Whether the forecast can currently be anchored. This, not recency, is the fact
    # that decides whether the Outlook screen works, so it is the one published.
    "lag_window_complete": None,
    "last_repair": None,
}


def _import_capture():
    """The root-level capture module, reused rather than reimplemented.

    Duplicating snapshot() here would create exactly the drift this codebase keeps
    getting bitten by - two writers of the same table disagreeing about the value key.
    """
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if root not in sys.path:
        sys.path.insert(0, root)
    import capture                                            # noqa: PLC0415
    return capture


def newest_captured_hour(conn) -> datetime | None:
    row = conn.execute(
        "SELECT MAX(timestamp) t FROM station_readings "
        "WHERE source LIKE 'live:%' OR source LIKE 'openaq:%'").fetchone()
    if not row or not row["t"]:
        return None
    try:
        return datetime.strptime(row["t"], "%Y-%m-%dT%H:00:00Z").replace(
            tzinfo=timezone.utc)
    except ValueError:
        return None


def gap_hours(conn, now: datetime | None = None) -> float | None:
    """Hours since the newest observed hour in the store. None when it is empty.

    DIAGNOSTIC ONLY. This used to decide whether a backfill ran, and it is the wrong
    quantity for that decision - see _repair_if_incomplete. It still answers a real
    question ("is the capture keeping up?") so it stays, but nothing branches on it.
    """
    newest = newest_captured_hour(conn)
    if newest is None:
        return None
    now = now or datetime.now(timezone.utc)
    return (now - newest).total_seconds() / 3600.0


def _repair_if_incomplete(capture, conn, *, reason: str) -> bool:
    """Refill from OpenAQ hourly history while the forecast's lag window has holes.

    THE TWO DEFECTS THIS REPLACES

    1. IT MEASURED RECENCY, AND RECENCY IS NOT THE QUESTION.
       The old test was `gap_hours() > MAX_TOLERABLE_GAP_HOURS` - hours since the
       NEWEST row. But the forecast does not need a recent hour, it needs six
       particular ones (0, 1, 3, 6, 12 and 24 h before its anchor). The boot snapshot
       writes the current hour, so from that moment on recency was always ~1 h and the
       test could never fail again, no matter how many hours were missing behind it.

       Measured on 2026-09-07, with the store holding 05:00, 06:00, 08:00 and 15:00
       and nothing else:

           capture: after backfill the store is 1.3 h behind      <- looks healthy
           GET /api/aree/outlook  424  missing at lag(s) [0, 3, 6] h

       It now asks forecast.live_anchor_gap(), which is the same test the forecast
       itself applies, so "the capture is satisfied" and "the forecast works" cannot
       drift apart again.

    2. IT RAN ONCE, AT BOOT, AND GAVE UP ON FAILURE.
       The backfill is a network call to OpenAQ. On 2026-09-07 it hit a transient TLS
       error:

           OpenAQ /locations failed: SSLEOFError(8, 'EOF occurred in violation of
           protocol') ... capture: after backfill the store is 1.3 h behind

       Three retries inside one attempt, then the attempt was over for the lifetime of
       the process. Because the hourly loop only ever writes the CURRENT hour, the
       holes behind it were permanent: the outage lasted until someone restarted the
       container, and a restart is exactly when the machine has been off and the holes
       are widest. The same endpoint answered normally minutes later.

       The repair now runs after every capture cycle for as long as the window is
       incomplete, which turns a momentary upstream failure into a delay of one hour
       instead of an outage that cannot end on its own.

    Returns True when the lag window is complete afterwards.
    """
    from ..forecast import pm25_forecast as fc                 # noqa: PLC0415

    gap = fc.live_anchor_gap(conn)
    if gap["anchor"] is not None:
        _state["last_repair"] = None
        _state["lag_window_complete"] = True
        log.info("capture: lag window complete, anchor %s (%d observed hours)",
                 gap["anchor"].strftime("%Y-%m-%d %H:00Z"), gap["observed_hours"])
        return True

    _state["lag_window_complete"] = False
    holes = gap["missing_hours"]
    log.warning("capture: no anchorable hour (%s) - %d hour(s) missing from the lag "
                "window, earliest %s; backfilling %d days from OpenAQ hourly history",
                reason, len(holes),
                holes[0].strftime("%Y-%m-%d %H:00Z") if holes else "?",
                BOOTSTRAP_DAYS)

    written = 0
    try:
        args = type("Args", (), {"days": BOOTSTRAP_DAYS})()
        before = _observed_hour_count(conn)
        capture.cmd_bootstrap(conn, args)
        written = _observed_hour_count(conn) - before
    except Exception as exc:                                  # noqa: BLE001
        # A failed repair must not stop the hourly loop: the loop is what carries the
        # store forward, and it is the more important of the two. It is also what
        # brings us back here next cycle to try again.
        _state["last_error"] = f"repair failed: {exc}"
        log.warning("capture: backfill raised (%s) - retrying next cycle", exc)
        return False

    after = fc.live_anchor_gap(conn)
    ok = after["anchor"] is not None
    _state["lag_window_complete"] = ok
    _state["bootstrapped"] = ok
    _state["last_repair"] = {
        "at": datetime.now(timezone.utc).isoformat(),
        "hours_written": written,
        "resolved": ok,
    }

    if ok:
        log.info("capture: backfill wrote %d hour(s); lag window complete, anchor %s",
                 written, after["anchor"].strftime("%Y-%m-%d %H:00Z"))
    else:
        # SAYING SO PLAINLY. The old code logged "after backfill the store is 1.3 h
        # behind" on this path - a sentence with a number in it that sounded like a
        # result and was in fact the boot snapshot's own row being measured. A repair
        # that fixed nothing now says that.
        _state["last_error"] = (
            f"backfill wrote {written} hour(s); still missing "
            f"{len(after['missing_hours'])} hour(s) of the lag window")
        log.warning("capture: backfill wrote %d hour(s) and the window is still "
                    "incomplete (%d hour(s) short) - retrying next cycle",
                    written, len(after["missing_hours"]))
    return ok


def _observed_hour_count(conn) -> int:
    """Distinct observed hours in the store. The unit a repair is measured in."""
    row = conn.execute(
        "SELECT COUNT(DISTINCT timestamp) n FROM station_readings "
        "WHERE source LIKE 'live:%' OR source LIKE 'openaq:%'").fetchone()
    return int(row["n"] or 0) if row else 0


def _rebuild_target(conn) -> None:
    """Derive ncr_target from the station rows just written.

    Kept beside the capture because the target is only ever as current as the stations
    behind it, and a target table that lags the readings is worse than no table.
    """
    try:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        if root not in sys.path:
            sys.path.insert(0, root)
        import target                                          # noqa: PLC0415
        target.cmd_build(conn, None)
    except Exception as exc:                                   # noqa: BLE001
        log.debug("capture: ncr_target rebuild skipped (%s)", exc)


def _snapshot_once(capture, conn) -> dict:
    """One capture cycle, with its bookkeeping. Returns the raw report."""
    result = capture.snapshot(conn)
    _state["cycles"] += 1
    _state["last_snapshot_at"] = datetime.now(timezone.utc)
    if result.get("ok"):
        _state["last_written"] = result.get("written")
        _state["last_error"] = None
        log.info("capture: %s station-hours written (%s reporting, %s min old)",
                 result.get("written"), result.get("n_stations"),
                 result.get("data_age_minutes"))
        _rebuild_target(conn)
    else:
        _state["last_error"] = result.get("reason")
        log.warning("capture: unavailable - %s", result.get("reason"))
    return result


def _loop() -> None:
    from ..backfill import db                                  # noqa: PLC0415

    capture = _import_capture()
    conn = db.connect()

    # ORDER MATTERS. The current hour comes from CAQM in about ten seconds and is what
    # supplies lag 0; the history backfill walks ~90 OpenAQ locations and takes minutes.
    # Doing the slow one first held the cheap one hostage - the store sat without a
    # current hour for the whole backfill, which is the state the forecast cannot serve.
    try:
        _snapshot_once(capture, conn)
    except Exception:                                          # noqa: BLE001
        log.exception("capture: first snapshot failed")

    complete = _repair_if_incomplete(capture, conn, reason="boot")

    while not _stop.is_set():
        # WAIT FOR THE HOUR, OR RETRY SOONER WHILE THE WINDOW IS BROKEN.
        #
        # A complete window only needs the next hourly snapshot. An INCOMPLETE one is
        # an outage on the hero screen, and sleeping an hour on it means the screen
        # stays dark for that hour even when the upstream that failed recovered
        # seconds later - which is what actually happened on 2026-09-07. While the
        # window has holes the loop comes back at the retry cadence instead.
        now = datetime.now(timezone.utc)
        next_at = (now.replace(minute=0, second=0, microsecond=0)
                   + timedelta(seconds=INTERVAL_SECONDS + OFFSET_SECONDS))
        due_in = max(RETRY_SECONDS, (next_at - now).total_seconds())
        _stop.wait(RETRY_SECONDS if not complete else due_in)
        if _stop.is_set():
            break

        # Only snapshot when an hour has actually turned over. On the retry cadence
        # the store already holds this hour, and re-reading CAQM every five minutes
        # would hammer the source to write the row it just wrote.
        try:
            if datetime.now(timezone.utc) >= next_at:
                _snapshot_once(capture, conn)
        except Exception as exc:                               # noqa: BLE001
            # The loop must outlive any single failure: crashing costs every subsequent
            # hour, not just this one.
            _state["last_error"] = f"{type(exc).__name__}: {exc}"
            log.exception("capture: snapshot failed")

        # THE REPAIR IS PART OF THE CYCLE, NOT PART OF BOOT.
        # Every hour the process was down is a hole, and the hourly capture can only
        # ever write the hour it is in - so holes are repaired here or not at all.
        try:
            complete = _repair_if_incomplete(capture, conn, reason="cycle")
        except Exception as exc:                               # noqa: BLE001
            _state["last_error"] = f"repair raised: {exc}"
            log.exception("capture: repair failed")

    _state["running"] = False


def start() -> bool:
    """Start the hourly capture. Idempotent; returns True when the thread is live."""
    global _thread

    if os.getenv("AREE_CAPTURE", "").lower() in ("off", "0", "false", "no"):
        log.info("capture: disabled by AREE_CAPTURE")
        _state["enabled"] = False
        return False

    if _thread and _thread.is_alive():
        return True

    _stop.clear()
    _state.update(enabled=True, running=True)
    _thread = threading.Thread(target=_loop, name="aree-capture", daemon=True)
    _thread.start()
    log.info("capture: hourly NCR network capture started")
    return True


def stop() -> None:
    _stop.set()


def status() -> dict:
    out = dict(_state)
    out["running"] = bool(_thread and _thread.is_alive())
    last = out.get("last_snapshot_at")
    out["last_snapshot_at"] = last.isoformat() if last else None
    return out


def diagnose(conn) -> dict:
    """Why the live forecast can or cannot be served, from the store as it stands.

    Written for the operator who is looking at "Outlook unavailable" and needs to know
    whether to wait, and for how long. It reports the hole itself rather than a proxy
    for it.
    """
    from ..forecast import pm25_forecast as fc                 # noqa: PLC0415

    gap = fc.live_anchor_gap(conn)
    return {
        "anchorable": gap["anchor"] is not None,
        "anchor": gap["anchor"].isoformat() if gap["anchor"] else None,
        "missing_hours": [h.isoformat() for h in gap["missing_hours"]],
        "missing_lags_now": gap["missing_lags_at_now"],
        "observed_hours": gap["observed_hours"],
        "newest_hour": (lambda n: n.isoformat() if n else None)(
            newest_captured_hour(conn)),
        "gap_hours": gap_hours(conn),
        "capture": status(),
    }
