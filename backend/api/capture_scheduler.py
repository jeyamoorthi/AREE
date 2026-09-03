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
    """Hours since the newest observed hour in the store. None when it is empty."""
    newest = newest_captured_hour(conn)
    if newest is None:
        return None
    now = now or datetime.now(timezone.utc)
    return (now - newest).total_seconds() / 3600.0


def _bootstrap_if_stale(capture, conn) -> None:
    """Refill from OpenAQ hourly history when the store has fallen behind the lags."""
    gap = gap_hours(conn)
    if gap is not None and gap <= MAX_TOLERABLE_GAP_HOURS:
        log.info("capture: store is %.1f h behind, no backfill needed", gap)
        return

    log.warning("capture: store is %s behind the lag window - backfilling %d days "
                "from OpenAQ hourly history",
                "empty" if gap is None else f"{gap:.1f} h", BOOTSTRAP_DAYS)
    try:
        args = type("Args", (), {"days": BOOTSTRAP_DAYS})()
        capture.cmd_bootstrap(conn, args)
        _state["bootstrapped"] = True
        after = gap_hours(conn)
        log.info("capture: after backfill the store is %s behind",
                 "empty" if after is None else f"{after:.1f} h")
    except Exception as exc:                                  # noqa: BLE001
        # A failed backfill must not stop the hourly loop: the loop is what repairs the
        # store from here on, and it is the more important of the two.
        _state["last_error"] = f"bootstrap failed: {exc}"
        log.warning("capture: backfill failed (%s) - continuing with hourly capture", exc)


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

    _bootstrap_if_stale(capture, conn)

    while not _stop.is_set():
        # Sleep first: the snapshot above has already covered this hour.
        now = datetime.now(timezone.utc)
        next_at = (now.replace(minute=0, second=0, microsecond=0)
                   + timedelta(seconds=INTERVAL_SECONDS + OFFSET_SECONDS))
        _stop.wait(max(RETRY_SECONDS, (next_at - now).total_seconds()))
        if _stop.is_set():
            break
        try:
            _snapshot_once(capture, conn)
        except Exception as exc:                               # noqa: BLE001
            # The loop must outlive any single failure: crashing costs every subsequent
            # hour, not just this one.
            _state["last_error"] = f"{type(exc).__name__}: {exc}"
            log.exception("capture: snapshot failed")

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
