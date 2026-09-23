"""
The live forecast's meteorology must survive Open-Meteo refusing this host.

Measured on the deployed instance: HTTP 429 from Open-Meteo, which rate-limits by
source IP, took the live outlook down while replay kept working. These tests pin
the fallback chain in weather_stream: reuse a fresh fetch, fall back to the mirror
the hourly capture commits, and refuse a copy too old to call a forecast.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from backend.ingestion import weather_stream as ws


class _Response:
    def __init__(self, status: int, payload: dict | None = None):
        self.status_code = status
        self._payload = payload or {}
        self.headers = {}

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _payload(start: datetime, hours: int = 120) -> dict:
    times = [(start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M") for h in range(hours)]
    hourly = {"time": times}
    for var in ws.HOURLY_VARS:
        hourly[var] = [100.0] * hours
    return {"latitude": ws.DEFAULT_LAT, "longitude": ws.DEFAULT_LON, "hourly": hourly}


def _today() -> datetime:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


@pytest.fixture
def upstream(monkeypatch, tmp_path):
    """Counts Open-Meteo calls and lets a test decide how they answer."""
    state = {"calls": 0, "status": 200}

    def fake_get(url, params=None, timeout=None):
        assert url == ws.FORECAST_URL, url
        state["calls"] += 1
        if state["status"] != 200:
            return _Response(state["status"])
        return _Response(200, _payload(_today()))

    monkeypatch.setattr(ws.requests, "get", fake_get)
    monkeypatch.setattr(ws.time, "sleep", lambda s: None)
    monkeypatch.setattr(ws, "MIRROR_URL", "off")
    monkeypatch.setattr(ws, "MIRROR_FILE", tmp_path / "met_forecast.json")
    monkeypatch.setattr(ws, "_forecasts", {})
    return state


def _write_mirror(fetched_at: datetime) -> None:
    ws.MIRROR_FILE.write_text(json.dumps({
        "fetched_at": fetched_at.isoformat().replace("+00:00", "Z"),
        "lat": ws.DEFAULT_LAT, "lon": ws.DEFAULT_LON,
        "payload": _payload(_today()),
    }), encoding="utf-8")


def test_a_fresh_fetch_is_reused_rather_than_refetched(upstream):
    first = ws.fetch_forecast(hours=72)
    second = ws.fetch_forecast(hours=72)

    assert len(first) == 72 and second == first
    assert upstream["calls"] == 1
    assert ws.forecast_source() == "openmeteo:forecast"


def test_a_rate_limit_falls_back_to_the_committed_mirror(upstream):
    upstream["status"] = 429
    _write_mirror(datetime.now(timezone.utc) - timedelta(minutes=40))

    rows = ws.fetch_forecast(hours=72)

    assert len(rows) == 72
    assert "mirror" in ws.forecast_source()
    assert "upstream unavailable" in ws.forecast_source()


def test_a_fallback_is_not_retried_against_upstream_on_every_request(upstream):
    upstream["status"] = 429
    _write_mirror(datetime.now(timezone.utc))

    ws.fetch_forecast()
    calls = upstream["calls"]
    ws.fetch_forecast()

    assert upstream["calls"] == calls


def test_a_mirror_older_than_the_limit_is_not_served(upstream):
    upstream["status"] = 429
    _write_mirror(datetime.now(timezone.utc) - timedelta(hours=ws.STALE_MAX_HOURS + 1))

    assert ws.fetch_forecast() == []
    assert "429" in (ws.last_error()["reason"] or "")


def test_a_mirror_for_another_point_is_not_substituted(upstream):
    upstream["status"] = 429
    _write_mirror(datetime.now(timezone.utc))

    assert ws.fetch_forecast(lat=28.40, lon=77.00) == []
