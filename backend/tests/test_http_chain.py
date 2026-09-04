"""
The chain a clean environment must be able to execute, over real HTTP.

    install -> import -> start backend -> HTTP -> forecast -> outlook
            -> case/auth -> PDF

Every request here crosses a TCP socket. That is not ceremony: a decorator once
landed on the wrong function and left `/api/aree/outlook` answering 422 to every
real request while the handler itself worked perfectly when called directly, and
every suite stayed green. Route wiring, dependency injection, header parsing and
status codes are all things FastAPI does *around* a handler, so they can only be
checked from outside it.

These tests need no network: they run against the committed 1 MB fixture store,
in replay. Anything that needs live upstream feeds is marked `network`.
"""

from __future__ import annotations

import pytest

REPLAY_AT = "2024-11-02T06:00:00Z"


# --- the service is up ------------------------------------------------------

def test_health(http):
    status, body = http("GET", "/api/health")
    assert status == 200, body
    assert body.get("status") == "ok", body


def test_engine_reports_direct_mode(http):
    """Direct is the production path and must be what a clean start selects."""
    status, body = http("GET", "/api/system/status")
    assert status == 200, body
    assert body.get("mode") == "direct", (
        f"expected the direct engine, got {body.get('mode')!r}")


def test_openapi_is_served(http):
    status, body = http("GET", "/openapi.json")
    assert status == 200
    assert "/api/aree/outlook" in body.get("paths", {})


# --- forecast and outlook ---------------------------------------------------

def test_outlook_replay_serves_a_full_forecast(http):
    status, body = http("GET", f"/api/aree/outlook?at={REPLAY_AT}")
    assert status == 200, body
    assert body["mode"] == "replay"
    series = body["forecast"]["series"]
    assert len(series) == 72, f"expected a 72-hour horizon, got {len(series)}"


def test_forecast_carries_its_provenance(http):
    """A number without provenance is not evidence."""
    status, body = http("GET", f"/api/aree/outlook?at={REPLAY_AT}")
    assert status == 200
    provenance = body["provenance"]
    assert provenance.get("models"), "no model provenance published"
    assert provenance.get("warning_rule"), "the warning rule is not published"
    assert provenance.get("target_source"), "no target source published"


def test_every_forecast_point_is_ahead_of_as_of(http):
    """The temporal contract, asserted at the API boundary."""
    from datetime import datetime

    status, body = http("GET", f"/api/aree/outlook?at={REPLAY_AT}")
    assert status == 200
    as_of = datetime.fromisoformat(body["as_of"].replace("Z", "+00:00"))
    for point in body["forecast"]["series"]:
        valid = datetime.fromisoformat(point["valid_at"].replace("Z", "+00:00"))
        assert valid > as_of, (
            f"forecast point valid at {valid} is not ahead of as_of {as_of}")


def test_outlook_rejects_a_malformed_timestamp(http):
    status, body = http("GET", "/api/aree/outlook?at=not-a-timestamp")
    assert status in (400, 422), f"expected a validation error, got {status}"


# --- the case workflow ------------------------------------------------------

def test_outlook_proposes_a_case_without_creating_one(http):
    """
    GET must stay pure. Viewing an outlook may not mint a regulatory record.
    """
    status, before = http("GET", "/api/cases")
    assert status == 200
    count_before = before["total"]

    for _ in range(3):
        http("GET", f"/api/aree/outlook?at={REPLAY_AT}")

    status, after = http("GET", "/api/cases")
    assert status == 200
    assert after["total"] == count_before, (
        f"viewing the outlook created {after['total'] - count_before} case(s)")


def test_case_decision_requires_authentication(http):
    status, body = http("POST", "/api/cases/9de99f8d8332/decision",
                        body={"decision": "approve", "as_of": REPLAY_AT})
    assert status == 401, f"an unauthenticated decision returned {status}: {body}"


def test_full_case_workflow(http, authority_token):
    """Propose -> authenticate -> decide -> read back, all over HTTP."""
    status, outlook = http("GET", f"/api/aree/outlook?at={REPLAY_AT}")
    assert status == 200
    case_id = outlook["decision"]["case_id"]
    assert case_id, "the outlook proposed no case to decide"

    status, decided = http("POST", f"/api/cases/{case_id}/decision",
                           token=authority_token,
                           body={"decision": "approve", "as_of": REPLAY_AT,
                                 "reason": "pytest full-chain check"})
    assert status == 200, f"authenticated decision failed: {status} {decided}"

    status, stored = http("GET", f"/api/cases/{case_id}")
    assert status == 200
    assert stored["status"] == "APPROVED"
    action = stored["actions"][-1]
    assert action["actor_verified"] is True, "the decision was recorded unverified"
    assert action["reason"] == "pytest full-chain check"


def test_a_decided_case_cannot_be_decided_again(http, authority_token):
    """Runs after the workflow test; a decided case is terminal."""
    status, outlook = http("GET", f"/api/aree/outlook?at={REPLAY_AT}")
    case_id = outlook["decision"]["case_id"]
    status, body = http("POST", f"/api/cases/{case_id}/decision",
                        token=authority_token,
                        body={"decision": "approve", "as_of": REPLAY_AT})
    assert status == 409, f"expected 409 already_decided, got {status}: {body}"
    assert body.get("error") == "already_decided"


# --- the report -------------------------------------------------------------

def test_pdf_report_renders():
    """
    Exercised directly rather than through the route: the HTTP endpoint needs a
    live station state, which needs upstream feeds this offline suite does not
    have. What is being protected here is that reportlab is installed and the
    generator produces a real PDF — the runtime dependency, not the routing.
    """
    from report_generator import generate_escalation_report

    state = {
        "station": "Anand Vihar, Delhi", "aqi": 421, "pm25": 318.0,
        "grap_stage": "Stage IV", "risk_score": 0.91,
        "advisory_text": "pytest render", "timestamp": REPLAY_AT,
        "firms_status": "not_polled", "fire_count": None,
    }
    pdf = generate_escalation_report(state["station"], state, None)
    assert pdf[:4] == b"%PDF", "output is not a PDF"
    assert len(pdf) > 2000, f"suspiciously small PDF: {len(pdf)} bytes"


def test_pdf_report_handles_all_three_firms_states():
    """
    Not polled / polled-with-fires / polled-with-none print differently, and the
    uncomputed case must not raise. `fire_count=None` once crashed this with a
    TypeError from `None > 0`.
    """
    from report_generator import generate_escalation_report

    base = {"station": "X", "aqi": 400, "pm25": 300.0, "grap_stage": "Stage IV",
            "risk_score": 0.9, "advisory_text": "t", "timestamp": REPLAY_AT}
    variants = [
        dict(base, firms_status="not_polled", fire_count=None),
        dict(base, firms_status="ok", fire_count=42, transport_score=71),
        dict(base, firms_status="ok", fire_count=0, transport_score=3),
    ]
    for state in variants:
        pdf = generate_escalation_report("X", state, None)
        assert pdf[:4] == b"%PDF"


# --- live mode --------------------------------------------------------------

@pytest.mark.network
def test_live_outlook(http):
    """
    Live needs recent observations from upstream feeds, so it is not part of the
    offline gate. When those are stale the API answers 424 with a precise reason,
    and that is correct behaviour rather than a failure — asserted as such.
    """
    status, body = http("GET", "/api/aree/outlook")
    assert status in (200, 424), f"unexpected status {status}: {body}"
    if status == 424:
        pytest.skip(f"live observations unavailable: {body.get('detail')}")
    assert body["mode"] == "live"
    assert body["forecast"]["series"], "live returned an empty series"
