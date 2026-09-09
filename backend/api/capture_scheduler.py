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
#
# ONE HOUR, NOT TWO, AND WHY THAT IS NOT AN ARBITRARY TIGHTENING
#     The forecast needs observations at lags 0, 1, 3, 6, 12 and 24 h before an
#     anchor, and may step the anchor back at most 6 h. A lag is an EXACT hour:
#     one missing hour is not a degraded forecast, it is no forecast, and it
#     disqualifies every anchor whose lag set touches it - measured, a single
#     seven-hour hole disqualified all seven candidate anchors at once.
#
#     At a tolerance of 2 h the scheduler could look at a store that had already
#     lost an hour and conclude no repair was needed, because "1.8 h behind" read
#     as healthy. It is not healthy: an hour is already gone and nothing else
#     will ever write it. One hour is the smallest tolerance that still absorbs
#     the normal 40-100 minute publication delay without thrashing, so it is the
#     honest threshold rather than a cautious one.
#
#     This does NOT create the missing observations - 4.2 does that. It only
#     stops the scheduler from declaring a broken chain intact.
MAX_TOLERABLE_GAP_HOURS = 1
BOOTSTRAP_DAYS = 3

# Retry cadence while the source is failing. Short enough to recover within one lag slot.
RETRY_SECONDS = 300

def db_iso(moment: datetime) -> str:
    """`backend.backfill.db.iso`, imported lazily.

    This module is imported by api/main.py at startup and the store module pulls
    in the schema machinery; keeping the import inside the call preserves the
    existing import order rather than adding a new top-level edge to it.
    """
    from ..backfill import db                                 # noqa: PLC0415
    return db.iso(moment)


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
    """Hours since the newest observed hour in the store. None when it is empty.

    This is the TRAILING gap only. See missing_hours() for why that is not on its
    own a description of whether the store is usable.
    """
    newest = newest_captured_hour(conn)
    if newest is None:
        return None
    now = now or datetime.now(timezone.utc)
    return (now - newest).total_seconds() / 3600.0


# CPCB and CAQM publish 40-100 minutes behind the hour, so the newest hour or two
# being absent is a feed that is on time, not a hole. Counting them as holes would
# make the store look broken once an hour, every hour.
PUBLICATION_DELAY_HOURS = 2


def observed_hours(conn, since: datetime, until: datetime) -> set[datetime]:
    """Hours in [since, until] that carry at least one network PM2.5 reading."""
    out: set[datetime] = set()
    for row in conn.execute(
            "SELECT DISTINCT timestamp t FROM station_readings "
            "WHERE (source LIKE 'live:%' OR source LIKE 'openaq:%') "
            "AND pm25 IS NOT NULL AND timestamp >= ? AND timestamp <= ?",
            (db_iso(since), db_iso(until))):
        try:
            out.add(datetime.strptime(row["t"], "%Y-%m-%dT%H:00:00Z")
                    .replace(tzinfo=timezone.utc))
        except (ValueError, TypeError):
            continue
    return out


def missing_hours(conn, now: datetime | None = None) -> list[datetime]:
    """Hours the live forecast can read that the store does not have.

    THE BUG THIS EXISTS TO FIX, AND WHY LOWERING A THRESHOLD DID NOT FIX IT
        The scheduler used to decide whether to repair the store from gap_hours()
        alone - now minus MAX(timestamp). That measures the TRAILING gap, and a
        hole behind the newest row is invisible to it.

        Which is the case that actually happens. The API restarts, loses six
        hours, comes back, and the hourly capture resumes: from that moment
        MAX(timestamp) tracks the clock and gap_hours() reports a healthy ~1 h
        forever, while the six-hour hole sits inside the lag window breaking
        every forecast. Measured on the dev store: gap_hours() = 1.63 h against
        MAX_TOLERABLE_GAP_HOURS = 1 - and ten missing hours it could not see.

        Tightening the threshold from 2 h to 1 h does not touch this. It makes
        the trailing measure more sensitive; it does not make it a measure of
        continuity. So continuity is now measured directly.

    WHAT COUNTS AS A HOLE
        Any hour inside the window the live forecast actually reads - the anchor
        may step back MAX_ANCHOR_BACKOFF_HOURS and its oldest lag is another
        max(PM_LAGS) before that, which is exactly OBSERVATION_WINDOW_HOURS -
        with no network reading. The newest PUBLICATION_DELAY_HOURS are excluded:
        upstream has not published them yet, so their absence is punctuality
        rather than loss, and the trailing gap already covers that case.

        The window is imported rather than restated so the two cannot drift; a
        change to the lag set has to move this automatically or it is wrong.
    """
    from ..forecast import pm25_forecast as fc                # noqa: PLC0415

    now = (now or datetime.now(timezone.utc)).replace(
        minute=0, second=0, microsecond=0)
    since = now - timedelta(hours=fc.OBSERVATION_WINDOW_HOURS)
    until = now - timedelta(hours=PUBLICATION_DELAY_HOURS)
    if until <= since:
        return []

    have = observed_hours(conn, since, until)
    out, cursor = [], since
    while cursor <= until:
        if cursor not in have:
            out.append(cursor)
        cursor += timedelta(hours=1)
    return out


def _repair_if_incomplete(capture, conn) -> None:
    """Refill from OpenAQ when the store cannot serve the forecast's lag set.

    Two independent reasons to repair, because they are two different failures:

        the trailing gap   nothing recent has been captured at all
        a hole             something older is missing from inside the lag window

    Either one disqualifies anchors, and only the first was ever checked.
    """
    now = datetime.now(timezone.utc)
    gap = gap_hours(conn, now)
    try:
        holes = missing_hours(conn, now)
    except Exception as exc:                                  # noqa: BLE001
        # Continuity is an improvement on the trailing check, not a dependency of
        # it. If it cannot be computed, fall back rather than skipping the repair.
        log.warning("capture: continuity check failed (%s), using the "
                    "trailing gap alone", exc)
        holes = []

    trailing_ok = gap is not None and gap <= MAX_TOLERABLE_GAP_HOURS
    if trailing_ok and not holes:
        log.info("capture: store is %.1f h behind and continuous across the "
                 "forecast window - no backfill needed", gap)
        return

    # Bound the pull to what is actually missing. A four-hour hole does not need
    # three days of history, and the difference is not academic: the backfill's
    # location filter keys off this window, so a wider one admits every location
    # that reported inside it and spends the API budget re-fetching hours the
    # store already has.
    oldest = min(holes) if holes else None
    if gap is None:
        window_hours = BOOTSTRAP_DAYS * 24                    # empty store
    else:
        span = gap if oldest is None else max(gap, (now - oldest).total_seconds() / 3600.0)
        # +1 h so the oldest missing hour is comfortably inside the range rather
        # than exactly on its edge.
        window_hours = int(min(BOOTSTRAP_DAYS * 24, max(2.0, span + 1.0)))

    log.warning("capture: repairing the store - trailing gap %s, %d hole(s) "
                "inside the forecast window%s; backfilling %d h from OpenAQ",
                "empty" if gap is None else f"{gap:.1f} h", len(holes),
                f" (oldest {oldest:%Y-%m-%d %H:00}Z)" if oldest else "",
                window_hours)
    try:
        args = type("Args", (), {"days": BOOTSTRAP_DAYS, "hours": window_hours})()
        capture.cmd_bootstrap(conn, args)
        _state["bootstrapped"] = True
        after_gap = gap_hours(conn)
        after_holes = len(missing_hours(conn))
        log.info("capture: after backfill the store is %s behind with %d hole(s) "
                 "remaining in the forecast window",
                 "empty" if after_gap is None else f"{after_gap:.1f} h", after_holes)
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

    _repair_if_incomplete(capture, conn)

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
