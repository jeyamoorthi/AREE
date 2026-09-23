"""
The capture scheduler's repair trigger.

THE REGRESSION THIS FILE EXISTS FOR
    The scheduler decided whether to repair the observation store from the
    TRAILING gap alone — `now - MAX(timestamp)`. A hole behind the newest row is
    invisible to that, and a hole behind the newest row is the case that actually
    happens: the API restarts, loses six hours, comes back, and the hourly capture
    resumes. From that moment MAX(timestamp) tracks the clock and the trailing gap
    reads healthy forever, while the hole sits inside the lag window disqualifying
    every anchor and the outlook answers 424 indefinitely.

    Measured on the dev store before the fix: trailing gap 1.63 h against a
    threshold of 2 h — "no backfill needed" — and ten missing hours it could not
    see.

    These tests need no network and no upstream feed: they build a store, punch a
    hole in it, and assert what the scheduler concludes.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """A private, empty store with the real schema."""
    monkeypatch.setenv("AREE_DB_PATH", str(tmp_path / "continuity.db"))
    from backend.backfill import db
    conn = db.connect()
    yield conn
    conn.close()


def _write_hour(conn, hour: datetime, stations: int = 5) -> None:
    from backend.backfill import db
    db.upsert(conn, "station_readings", ("station_id", "timestamp"), [
        {"station_id": f"test-{i}", "timestamp": db.iso(hour), "pm25": 100.0 + i,
         "latitude": 28.6, "longitude": 77.2, "n_stations": 1,
         "source": "live:test"}
        for i in range(stations)
    ])


def _fill(conn, now: datetime, hours: int, skip: set[int] | None = None) -> None:
    """`hours` hours of history back from `now`, optionally skipping some."""
    skip = skip or set()
    for back in range(hours):
        if back in skip:
            continue
        _write_hour(conn, now - timedelta(hours=back))


def test_a_hole_behind_the_newest_row_is_invisible_to_the_trailing_gap(store):
    """The exact shape of the bug: healthy trailing gap, unusable store."""
    from backend.api import capture_scheduler as cs
    from backend.forecast import pm25_forecast as fc

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    # Continuous except for a six-hour hole 12–17 hours back — behind the newest
    # row, and squarely inside the lag window.
    _fill(store, now, hours=fc.OBSERVATION_WINDOW_HOURS + 2,
          skip={12, 13, 14, 15, 16, 17})

    gap = cs.gap_hours(store, now)
    assert gap is not None and gap <= cs.MAX_TOLERABLE_GAP_HOURS, (
        f"the trailing gap should look healthy here, got {gap}")

    holes = cs.missing_hours(store, now)
    assert len(holes) == 6, [h.isoformat() for h in holes]
    assert min(holes) == now - timedelta(hours=17)
    assert max(holes) == now - timedelta(hours=12)


def test_a_continuous_store_reports_no_holes(store):
    from backend.api import capture_scheduler as cs
    from backend.forecast import pm25_forecast as fc

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    _fill(store, now, hours=fc.OBSERVATION_WINDOW_HOURS + 2)

    assert cs.missing_hours(store, now) == []


def test_the_unpublished_recent_hours_are_not_holes(store):
    """A feed that is merely on time must not read as a broken store.

    CPCB and CAQM publish 40–100 minutes behind the hour, so the newest hour or
    two being absent is punctuality, not loss. Counting them would trigger a
    repair once an hour, every hour, forever.
    """
    from backend.api import capture_scheduler as cs
    from backend.forecast import pm25_forecast as fc

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    # Everything except the most recent PUBLICATION_DELAY_HOURS.
    _fill(store, now, hours=fc.OBSERVATION_WINDOW_HOURS + 2,
          skip=set(range(cs.PUBLICATION_DELAY_HOURS)))

    assert cs.missing_hours(store, now) == []


def test_an_empty_store_is_reported_as_empty_not_as_zero_gap(store):
    """None and 0.0 are different answers and must not be confused."""
    from backend.api import capture_scheduler as cs

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    assert cs.gap_hours(store, now) is None
    # Every readable hour is missing, which is the correct description of empty.
    assert len(cs.missing_hours(store, now)) > 0


def test_only_network_rows_count_as_observations(store):
    """A legacy research row is not a live network hour and must not fill a hole.

    `observation_series` treats the two differently on purpose — the network
    target is a median over ~80 instruments and the legacy series is one monitor
    — so a store carrying only legacy rows for an hour still has a hole for the
    purposes of live forecasting.
    """
    from backend.api import capture_scheduler as cs
    from backend.backfill import db
    from backend.forecast import pm25_forecast as fc

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    _fill(store, now, hours=fc.OBSERVATION_WINDOW_HOURS + 2, skip={10})

    db.upsert(store, "station_readings", ("station_id", "timestamp"), [{
        "station_id": "legacy-monitor",
        "timestamp": db.iso(now - timedelta(hours=10)),
        "pm25": 180.0, "latitude": 28.6, "longitude": 77.2,
        "n_stations": 1, "source": "research:legacy",
    }])

    holes = cs.missing_hours(store, now)
    assert holes == [now - timedelta(hours=10)], [h.isoformat() for h in holes]
