"""
Regression tests for QA defects: escalation ordering, request budgets, input
bounds and the escalation brief's handling of missing values.

All offline. Upstream calls are monkeypatched, never made.
"""

from __future__ import annotations

import io
import time
from datetime import datetime, timedelta, timezone

import pytest


# --- /api/escalations -------------------------------------------------------

def test_escalations_newest_first_and_filter_on_either_key(monkeypatch):
    from backend.api.routes import escalations as route

    t0 = datetime(2026, 9, 29, 5, 0, tzinfo=timezone.utc)
    log = [
        # Deliberately oldest-first and mixed: direct-engine rows key the name
        # under "station" with datetimes, app.py rows under "city" with strings.
        {"timestamp": t0, "station": "A", "to_stage": "Stage I (Poor)"},
        {"timestamp": (t0 + timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S UTC"),
         "city": "B", "to_stage": "Stage II (Very Poor)"},
        {"timestamp": t0 + timedelta(hours=2), "station": "A", "to_stage": "Stage II (Very Poor)"},
    ]
    monkeypatch.setattr(route, "require_engine", lambda: None)
    monkeypatch.setattr(route.engine, "escalation_log", lambda: list(log))

    out = route.escalations(station=None, limit=2)
    assert out.total == 3
    assert [e.to_stage for e in out.events] == ["Stage II (Very Poor)"] * 2
    assert out.events[0].timestamp.startswith("2026-09-29T07:00")
    assert all(e.city and e.station == e.city for e in out.events)

    only_a = route.escalations(station="A", limit=50)
    assert only_a.total == 2
    assert [e.city for e in only_a.events] == ["A", "A"]


# --- CPCB request budget ----------------------------------------------------

def test_cpcb_pull_honours_its_deadline(monkeypatch):
    from backend.ingestion import cpcb_stream as cpcb

    def hanging_get(*_args, timeout=None, **_kw):
        time.sleep(min(timeout or 0, 0.5))
        raise cpcb.requests.ConnectionError("simulated slow upstream")

    monkeypatch.setattr(cpcb.requests, "get", hanging_get)
    monkeypatch.setattr(cpcb, "_ncr_cache", {"value": None, "fetched_at": None})
    started = time.monotonic()
    rows = cpcb.fetch_ncr(deadline=time.monotonic() + 2)
    assert rows == []
    assert time.monotonic() - started < 5, "deadline not honoured"


# --- input validation -------------------------------------------------------

@pytest.mark.parametrize("path", [
    "/api/ventilation/forecast?lat=999",
    "/api/ventilation/current?lon=-200",
    "/api/ventilation/assessment?pm25=100&lat=91",
])
def test_ventilation_rejects_out_of_range_coordinates(http, path):
    status, _ = http("GET", path)
    assert status == 422


# --- the escalation brief ---------------------------------------------------

def _pdf_text(state: dict) -> str:
    pypdf = pytest.importorskip("pypdf")
    from report_generator import generate_escalation_report
    pdf = generate_escalation_report("Test Station", state, None,
                                     policy_state={"docs_indexed": 5})
    return "\n".join(p.extract_text() for p in pypdf.PdfReader(io.BytesIO(pdf)).pages)


def test_brief_never_prints_none_for_missing_values():
    keys = ("aqi cpcb_band grap_stage consecutive_windows remaining_windows "
            "forecast stale_seconds waqi_timestamp projected_trigger_time "
            "eri_score eri_category dominant_pollutant governance_rule api_time "
            "firms_status fire_count vulnerable_risk rag_docs_indexed").split()
    text = _pdf_text({**{k: None for k in keys}, "mode": "direct"})
    assert "None" not in text
    assert "Data Freshness: Unknown" in text
    assert "Not computed" in text                       # ERI, not "0/100"
    assert "retrieved via Pathway" not in text           # direct mode


def test_brief_derives_stage_and_keeps_calm_wind():
    state = {
        "mode": "direct", "aqi": 245, "consecutive_windows": 2,
        "forecast": {"projected_5min": 250, "projected_30min": 269,
                     "direction": None, "data_points": 5},
        "firms_status": "ok", "fire_count": 2, "wind_speed": 0, "wind_direction": 0,
        "dominant_pollutant": "pm25", "waqi_timestamp": "2026-09-29T05:30:00Z",
        "stale_seconds": 3 * 3600,
    }
    text = _pdf_text(state)
    assert "Stage I (Poor) (from projected AQI)" in text
    assert "0.0 m/s" in text and "0°" in text
    assert "29 Sep 2026, 11:00 IST (05:30 UTC)" in text
    assert "STALE DATA" in text
    assert "Dominant Pollutant: Not determined" in text
    # AQI below threshold: the heading and the trace agree with engine_mode().
    assert "NORMAL OPERATIONS" in text and "WATCH" not in text


# --- Pollutant backup from OpenAQ ------------------------------------------

def test_openaq_units_are_converted_to_cpcb_units():
    from backend.ingestion import ncr_observations as obs

    # ppb -> µg/m³ at 25 °C: NO2 10 ppb = 10 * 46.0055 / 24.45.
    assert obs._to_cpcb_units("no2", 10, "ppb") == pytest.approx(18.816, abs=1e-3)
    # CPCB publishes CO in mg/m³: 1000 ppb CO = 1.1456 mg/m³.
    assert obs._to_cpcb_units("co", 1000, "ppb") == pytest.approx(1.1456, abs=1e-4)
    assert obs._to_cpcb_units("co", 2270, "µg/m³") == pytest.approx(2.27)
    assert obs._to_cpcb_units("pm25", 42.0, "µg/m³") == 42.0
    # A unit we do not know is dropped, not guessed.
    assert obs._to_cpcb_units("pm25", 42.0, "particles/cm³") is None


def test_openaq_backup_uses_only_fresh_readings(monkeypatch):
    from backend.ingestion import ncr_observations as obs

    now = datetime(2026, 9, 29, 6, 0, tzinfo=timezone.utc)
    fresh, stale = "2026-09-29T05:00:00Z", "2026-09-24T17:30:00Z"
    loc = {
        "id": 1, "name": "Sector-51, Gurugram - HSPCB",
        "coordinates": {"latitude": 28.42, "longitude": 77.07},
        "datetimeLast": {"utc": fresh},
        "sensors": [
            {"id": 10, "parameter": {"name": "pm25", "units": "µg/m³"}},
            {"id": 11, "parameter": {"name": "no2", "units": "ppb"}},
            {"id": 12, "parameter": {"name": "pm10", "units": "µg/m³"}},
            {"id": 13, "parameter": {"name": "temperature", "units": "c"}},
        ],
    }
    old = dict(loc, id=2, name="Retired, Delhi - DPCC", datetimeLast={"utc": stale})

    def fake_get(url, params=None, **_):
        if url.endswith("/locations"):
            return {"results": [loc, old]}
        assert url.endswith("/locations/1/latest"), "stale location must not be read"
        return {"results": [
            {"sensorsId": 10, "value": 88.5, "datetime": {"utc": fresh}},
            {"sensorsId": 11, "value": 10, "datetime": {"utc": fresh}},
            # A co-located sensor that stopped years ago must not leak through.
            {"sensorsId": 12, "value": 999.99, "datetime": {"utc": "2022-10-16T16:00:00Z"}},
            {"sensorsId": 13, "value": 27.9, "datetime": {"utc": fresh}},
        ]}

    monkeypatch.setattr(obs, "_get", fake_get)
    rows = obs.fetch_ncr_pollutants(now)
    assert len(rows) == 1
    row = rows[0]
    assert row["station"] == "Sector-51, Gurugram - HSPCB"
    assert row["pm25"] == 88.5 and row["no2"] == pytest.approx(18.82, abs=0.01)
    assert "pm10" not in row and "temperature" not in row


def test_openaq_fills_only_what_data_gov_in_left_empty(monkeypatch):
    import fallback_engine as fe
    from ingestion import cpcb_live, cpcb_stream, ncr_observations

    now = datetime.now(timezone.utc)
    monkeypatch.setattr(cpcb_live, "fetch_ncr", lambda _now=None: [])
    monkeypatch.setattr(cpcb_stream, "fetch_ncr", lambda: [
        {"station": "A", "pm25": 100.0, "observed_at": now}])
    monkeypatch.setattr(ncr_observations, "fetch_ncr_pollutants", lambda _now=None: [
        {"station": "A", "pm25": 1.0, "observed_at": now},
        {"station": "B", "pm25": 55.0, "no2": 20.0, "observed_at": now}])

    stations = [{"station": "A"}, {"station": "B"}, {"station": "C"}]
    assert fe._attach_pollutants(stations) == 2
    a, b, c = stations
    assert a["raw_pm25"] == 100.0 and "data.gov.in" in a["pollutant_source"]
    assert b["raw_pm25"] == 55.0 and b["pollutants_available"] == 2
    assert b["pollutant_source"].startswith("OpenAQ")
    assert not c.get("pollutant_source")


def test_openaq_backs_up_everything_when_data_gov_in_is_down(monkeypatch):
    import fallback_engine as fe
    from ingestion import cpcb_live, cpcb_stream, ncr_observations

    def down():
        raise RuntimeError("503 Service Temporarily Unavailable")

    now = datetime.now(timezone.utc)
    monkeypatch.setattr(cpcb_live, "fetch_ncr", lambda _now=None: down())
    monkeypatch.setattr(cpcb_stream, "fetch_ncr", down)
    monkeypatch.setattr(ncr_observations, "fetch_ncr_pollutants", lambda _now=None: [
        {"station": "A", "pm25": 42.0, "observed_at": now}])

    stations = [{"station": "A"}]
    assert fe._attach_pollutants(stations) == 1
    assert stations[0]["raw_pm25"] == 42.0
    assert stations[0]["pollutant_quantity"] == "concentration"


# Trimmed from a live airquality.cpcb.gov.in response (2026-09-29 20:00 IST).
_CPCB_LIVE_PAYLOAD = {
    "countryId": "India",
    "country": [{
        "stateId": "Haryana",
        "citiesInState": [{
            "cityId": "Gurugram",
            "stationsInCity": [{
                "stationName": "Teri Gram, Gurugram - HSPCB",
                "latitude": 28.4275, "longitude": 77.1465,
                "lastUpdate": "29-09-2026 20:00:00",
                "pollutants": [
                    {"indexId": "PM2.5", "min": "16", "max": "132", "avg": "83"},
                    {"indexId": "PM10", "min": "23", "max": "146", "avg": "109"},
                    {"indexId": "CO", "min": "20", "max": "31", "avg": "24"},
                    {"indexId": "OZONE", "min": "NA", "max": "NA", "avg": "NA"},
                ],
                "airQualityIndexValue": "109", "predominantParameter": "PM10",
            }],
        }, {
            "cityId": "Amaravati",
            "stationsInCity": [{
                # Outside the NCR box: must not be returned.
                "stationName": "Secretariat, Amaravati - APPCB",
                "latitude": 16.515, "longitude": 80.518,
                "lastUpdate": "29-09-2026 20:00:00",
                "pollutants": [{"indexId": "PM10", "avg": "101"}],
            }],
        }],
    }],
}


def test_cpcb_live_feed_pivots_to_ncr_station_rows(monkeypatch):
    from ingestion import cpcb_live

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return _CPCB_LIVE_PAYLOAD

    monkeypatch.setattr(cpcb_live.requests, "get", lambda *a, **k: _Resp())
    monkeypatch.setitem(cpcb_live._cache, "value", None)

    rows = cpcb_live.fetch_ncr()
    assert [r["station"] for r in rows] == ["Teri Gram, Gurugram - HSPCB"]
    row = rows[0]
    assert (row["pm25"], row["pm10"], row["co"]) == (83.0, 109.0, 24.0)
    # "NA" is a missing analyser, never a zero.
    assert row.get("o3") is None
    # 20:00 IST is 14:30 UTC.
    assert row["observed_at"] == datetime(2026, 9, 29, 14, 30, tzinfo=timezone.utc)


def test_cpcb_live_comes_first_and_is_labelled_a_sub_index(monkeypatch):
    import fallback_engine as fe
    from ingestion import cpcb_live, cpcb_stream, ncr_observations

    now = datetime.now(timezone.utc)
    monkeypatch.setattr(cpcb_live, "fetch_ncr", lambda _now=None: [
        {"station": "A", "pm10": 109.0, "observed_at": now}])

    def must_not_run(*_a, **_k):
        raise AssertionError("a later source ran for a station already filled")

    monkeypatch.setattr(cpcb_stream, "fetch_ncr", must_not_run)
    monkeypatch.setattr(ncr_observations, "fetch_ncr_pollutants", must_not_run)

    stations = [{"station": "A"}]
    assert fe._attach_pollutants(stations) == 1
    assert stations[0]["raw_pm10"] == 109.0
    assert stations[0]["pollutant_quantity"] == "sub_index"
    assert stations[0]["pollutant_source"].startswith("CPCB CAAQMS (airquality")


def test_published_state_is_patched_before_slower_sources_answer(monkeypatch):
    import fallback_engine as fe
    from ingestion import cpcb_live, cpcb_stream, ncr_observations

    now = datetime.now(timezone.utc)
    monkeypatch.setattr(fe, "latest_state", {
        "A": {"station": "A", "raw_pm10": None, "pollutant_source": None},
        "B": {"station": "B", "raw_pm25": None, "pollutant_source": None},
    })
    monkeypatch.setattr(cpcb_live, "fetch_ncr", lambda _now=None: [
        {"station": "A", "pm10": 109.0, "observed_at": now}])

    seen_while_data_gov_in_ran = {}

    def slow_data_gov_in():
        # Station A must already be served by the time this slow pull runs.
        seen_while_data_gov_in_ran.update(fe.latest_state["A"])
        return []

    monkeypatch.setattr(cpcb_stream, "fetch_ncr", slow_data_gov_in)
    monkeypatch.setattr(ncr_observations, "fetch_ncr_pollutants", lambda _now=None: [
        {"station": "B", "pm25": 55.0, "observed_at": now}])

    assert fe._enrich_published_pollutants([{"station": "A"}, {"station": "B"}]) == 2
    assert seen_while_data_gov_in_ran["raw_pm10"] == 109.0
    assert seen_while_data_gov_in_ran["pollutant_quantity"] == "sub_index"
    assert fe.latest_state["B"]["raw_pm25"] == 55.0
    assert fe.latest_state["B"]["pollutant_quantity"] == "concentration"
