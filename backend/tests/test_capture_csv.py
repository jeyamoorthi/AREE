"""
The committed observation archive, and how a cold container reads it.

THE FAILURE THIS FILE EXISTS FOR
    GitHub runs the hourly capture on a best-effort schedule - seven runs of
    twenty-four on 2026-09-28 - and each run recorded only the hour CPCB was
    publishing. The archive a cold container imported therefore had 34 holes in
    the forecast's 49-hour window, and every boot spent minutes rebuilding them
    from OpenAQ behind a "Restoring observation history" screen.

    These tests pin the two fixes: the export fills archive holes itself, and the
    import reads the repository's current archive rather than the image's copy.
    No network: OpenAQ and GitHub are both stubbed.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import capture_csv  # noqa: E402

NOW = datetime(2026, 9, 29, 4, 30, tzinfo=timezone.utc)
HEADER = ",".join(capture_csv.FIELDS)


def _stamp(hour: datetime) -> str:
    return f"{hour:%Y-%m-%dT%H:00:00Z}"


def _row(hour: datetime, station: str = "Anand Vihar", pm25: float = 80.0,
         source: str = "live:test") -> dict:
    return {"station_id": station, "timestamp": _stamp(hour), "pm25": pm25,
            "latitude": 28.6, "longitude": 77.3, "n_stations": 1, "source": source}


@pytest.fixture()
def archive(tmp_path, monkeypatch):
    monkeypatch.setattr(capture_csv, "OBS_DIR", tmp_path)
    return tmp_path


def _window() -> list[datetime]:
    top = NOW.replace(minute=0)
    since = top - timedelta(hours=capture_csv.ARCHIVE_WINDOW_HOURS)
    until = top - timedelta(hours=capture_csv.PUBLICATION_DELAY_HOURS)
    return [since + timedelta(hours=h)
            for h in range(int((until - since).total_seconds() // 3600) + 1)]


def test_window_matches_the_forecast():
    """Restated for the runner, which cannot import LightGBM - so pinned here."""
    from backend.api import capture_scheduler as cs
    from backend.forecast import pm25_forecast as fc

    assert capture_csv.ARCHIVE_WINDOW_HOURS == fc.OBSERVATION_WINDOW_HOURS
    assert capture_csv.PUBLICATION_DELAY_HOURS == cs.PUBLICATION_DELAY_HOURS


def test_holes_are_the_hours_no_file_carries(archive):
    hours = _window()
    gone = {hours[3], hours[20], hours[-1]}
    capture_csv._append([_row(h) for h in hours if h not in gone])

    assert set(capture_csv.archive_holes(NOW)) == gone


def test_rows_are_filed_by_their_own_day(archive):
    """A 23:00 reading captured after midnight belongs to the day it describes."""
    late = datetime(2026, 9, 28, 23, tzinfo=timezone.utc)
    capture_csv._append([_row(late)])

    assert (archive / "2026-09-28.csv").exists()
    assert not (archive / "2026-09-29.csv").exists()


def test_append_skips_rows_already_committed(archive):
    hour = _window()[0]
    assert len(capture_csv._append([_row(hour)])) == 1
    assert capture_csv._append([_row(hour)]) == []


def test_fill_writes_only_the_missing_hours(archive, monkeypatch):
    hours = _window()
    gone = {hours[5], hours[6]}
    capture_csv._append([_row(h) for h in hours if h not in gone])

    offered = [_row(h, station="OpenAQ site", source="openaq:hourly") for h in hours]
    asked = {}

    class _Capture:
        @staticmethod
        def openaq_rows(window_hours):
            asked["window"] = window_hours
            return offered

    monkeypatch.setitem(sys.modules, "capture", _Capture)
    written = capture_csv.fill_holes(NOW)

    assert {r["timestamp"] for r in written} == {_stamp(h) for h in gone}
    assert capture_csv.archive_holes(NOW) == []
    # Bounded to the oldest hole, not the whole window.
    assert asked["window"] == int((NOW - min(gone)).total_seconds() // 3600) + 1


def test_export_keeps_filling_when_the_live_feed_is_down(archive, monkeypatch):
    hour = _window()[0]

    def _down():
        raise RuntimeError("composite unavailable")

    monkeypatch.setattr(capture_csv, "collect", _down)
    monkeypatch.setattr(capture_csv, "fill_holes", lambda: capture_csv._append(
        [_row(hour, source="openaq:hourly")]))

    with pytest.raises(RuntimeError, match="composite unavailable"):
        capture_csv.cmd_export(type("Args", (), {"no_fill": False})())
    # The live failure is still reported, and the fill it did not block is kept.
    assert _stamp(hour) in (archive / f"{hour:%Y-%m-%d}.csv").read_text()


def test_remote_copy_wins_over_the_image(archive):
    hour = _window()[0]
    capture_csv._append([_row(hour, pm25=10.0)])
    remote = [(f"{hour:%Y-%m-%d}.csv",
               f"{HEADER}\nAnand Vihar,{_stamp(hour)},99.0,28.6,77.3,1,live:test\n")]

    rows = capture_csv._read_csvs(sorted(archive.glob("*.csv")), remote)

    assert [r["pm25"] for r in rows] == [99.0]


def test_remote_off_fetches_nothing(monkeypatch):
    monkeypatch.setattr(capture_csv, "REMOTE_BASE", "off")
    assert capture_csv._fetch_remote() == []


def test_remote_failures_degrade_to_fewer_files(monkeypatch):
    """One day served, one missing, one unreachable: one file, no exception."""
    import requests

    today = datetime.now(timezone.utc).date()
    served, missing, down = (f"{today - timedelta(days=d):%Y-%m-%d}.csv"
                             for d in range(3))

    class _Resp:
        def __init__(self, code, text=""):
            self.status_code, self.text = code, text

    def _get(url, timeout):
        if url.endswith(served):
            return _Resp(200, HEADER + "\n")
        if url.endswith(missing):
            return _Resp(404)
        assert url.endswith(down)
        raise requests.ConnectionError("unreachable")

    monkeypatch.setattr(capture_csv, "REMOTE_BASE", "https://example.invalid/obs")
    monkeypatch.setattr(requests, "get", _get)

    assert [name for name, _ in capture_csv._fetch_remote()] == [served]
