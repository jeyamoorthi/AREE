"""
The truthfulness boundary.

Migrated from `backend/tests_claims.py`.

THE RULE: a field may carry a value only if the running engine computed it.
Anything else is absent, not defaulted.

Direct mode does not poll NASA FIRMS and does not run causal attribution — both
live behind `app.py`, the Pathway entry point. It nevertheless published
`fire_count: 0`, `transport_score: 0`, `pollution_cause: "unclassified"`,
`eri_score: 0` and `eri_category: "LOW READINESS"`.

Zero is not a missing value. It is a measurement, and every consumer read it as
one: the satellite card coloured a never-polled feed GREEN — the all-clear — and
the PDF escalation report printed "No upwind thermal anomalies detected. Local
emission dominant.", asserting both a search that never happened and a causal
conclusion nothing computed.

The station-level scans need live upstream feeds and are marked `network`. The
outlook half needs no network and runs everywhere, because it protects the
opposite property: capability that IS computed must survive a truthfulness pass.
"""

from __future__ import annotations

import urllib.parse

import pytest

REPLAY_AT = "2024-11-02T06:00:00Z"

# field -> values it must NOT hold while the engine does not compute it.
# Written as forbidden values rather than "must be null" so a future direct-mode
# FIRMS poll can populate them for real without editing this list: a genuine
# measurement of zero fires arrives with firms_status "ok", which is accounted
# for below.
RETIRED = {
    "fire_count": (0,),
    "high_conf_fires": (0,),
    "aligned_fires": (0,),
    "transport_score": (0,),
    "transport_probability": (0.0, 0),
    "cause_confidence": (0.0, 0),
    "plume_distance_km": (0.0, 0),
    "wind_alignment_deg": (0.0, 0),
    "transport_label": ("unknown",),
    "pollution_cause": ("unclassified",),
    "wind_label": ("unknown",),
    "eri_score": (0,),
    "eri_category": ("LOW READINESS",),
    "confidence_score": (85,),
}

ENGINE_INDEPENDENT = {"eri_score", "eri_category", "confidence_score"}


def _scan(payload: dict, where: str) -> list[str]:
    firms_ok = payload.get("firms_status") == "ok"
    problems = []
    for field, forbidden in RETIRED.items():
        if field not in payload:
            continue
        # A real poll may legitimately measure zero; an absent poll may not.
        if firms_ok and field not in ENGINE_INDEPENDENT:
            continue
        value = payload[field]
        if value is not None and value in forbidden:
            problems.append(f"{where}.{field} = {value!r} (manufactured)")
    return problems


@pytest.fixture(scope="module")
def a_station(http):
    status, listing = http("GET", "/api/stations")
    if status != 200 or not listing.get("stations"):
        pytest.skip("no station state; live upstream feeds unavailable")
    return listing["stations"][0]["station"]


@pytest.mark.network
def test_station_detail_manufactures_nothing(http, a_station):
    quoted = urllib.parse.quote(a_station, safe="")
    status, detail = http("GET", f"/api/stations/{quoted}")
    assert status == 200
    assert detail.get("firms_status") is not None, (
        "FIRMS status must be stated explicitly — it is the provenance flag "
        "consumers key their unavailable state off")
    assert not _scan(detail, "stations/{id}")


@pytest.mark.network
def test_risk_endpoint_manufactures_nothing(http, a_station):
    quoted = urllib.parse.quote(a_station, safe="")
    status, risk = http("GET", f"/api/risk/{quoted}")
    assert status == 200
    problems = _scan(risk, "risk/{id}")
    assert not problems, (
        "the risk endpoint served invented values: " + str(problems))


@pytest.mark.network
def test_rankings_exclude_stations_without_the_metric(http):
    """An ordering of absences, presented with rank numbers, is not a ranking."""
    status, dash = http("GET", "/api/dashboard")
    assert status == 200
    unranked = [e for e in (dash.get("top_eri") or []) if e.get("eri_score") is None]
    assert not unranked, (
        f"{len(unranked)} station(s) ranked by an ERI they do not have")


# --- the other half: computed capability must SURVIVE -----------------------

def _find_plume(payload):
    if isinstance(payload, dict):
        if "influence" in payload and "detections_24h" in payload:
            return payload
        for value in payload.values():
            found = _find_plume(value)
            if found:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _find_plume(value)
            if found:
                return found
    return None


def test_plume_influence_is_retained_with_its_provenance(http):
    """
    `plume_influence` IS computed (163,176 rows in derived_features). A
    truthfulness pass that quietly deleted real capability would fail here.
    """
    status, body = http("GET", f"/api/aree/outlook?at={REPLAY_AT}")
    assert status == 200
    plume = _find_plume(body)
    assert plume, "the plume block disappeared from the outlook"
    assert plume["influence"] is not None, "plume influence is null"
    assert "FIRMS" in str(plume.get("source", "")), "plume does not name its source"
    assert isinstance(plume.get("available"), bool), "plume hides its availability"
    assert "not a measured contribution" in str(plume.get("note", "")), (
        "the plume index lost the qualifier that stops it reading as a "
        "measured contribution")


def test_the_forecast_still_states_what_it_is(http):
    status, body = http("GET", f"/api/aree/outlook?at={REPLAY_AT}")
    assert status == 200
    assert len(body["forecast"]["series"]) == 72
    provenance = body["provenance"]
    assert provenance.get("models")
    assert provenance.get("warning_rule")
