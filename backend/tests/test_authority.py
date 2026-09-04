"""
The authority boundary, over real HTTP.

Migrated from `backend/tests_auth.py`, which reported 41 checks as one pass/fail.
Every check is preserved; each is now a named test, so a failure says which
property broke instead of which suite did.

The property under protection: **identity comes from a signed token and from
nothing else.** A client may state intent (approve/reject, a reason, which moment
to recompute). It may not state who it is, and it has no path at all to
`actor_verified`.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from backend.api import auth
from .conftest import (ADMIN_PASSWORD, ADMIN_USER, AUTHORITY_PASSWORD,
                       AUTHORITY_USER)

REPLAY_AT = "2024-11-14T00:00:00Z"   # a different moment from the chain test,
                                     # so the two suites cannot collide on a case


# --- credentials ------------------------------------------------------------

def test_wrong_password_is_rejected(http):
    status, _ = http("POST", "/api/auth/token",
                     body={"username": AUTHORITY_USER, "password": "wrong"})
    assert status == 401


def test_unknown_user_is_rejected(http):
    status, _ = http("POST", "/api/auth/token",
                     body={"username": "no.such.user", "password": "anything"})
    assert status == 401


def test_unknown_user_is_indistinguishable_from_a_wrong_password(http):
    """Otherwise the endpoint is a directory of valid operator names."""
    _, wrong_password = http("POST", "/api/auth/token",
                             body={"username": AUTHORITY_USER, "password": "wrong"})
    _, unknown_user = http("POST", "/api/auth/token",
                           body={"username": "no.such.user", "password": "wrong"})
    assert wrong_password.get("error") == unknown_user.get("error")
    assert wrong_password.get("detail") == unknown_user.get("detail")


def test_valid_credentials_issue_a_token(http):
    status, body = http("POST", "/api/auth/token",
                        body={"username": AUTHORITY_USER,
                              "password": AUTHORITY_PASSWORD})
    assert status == 200
    assert body["access_token"]
    assert body["role"] == "authority"
    assert body["capabilities"] == ["case:decide"]


def test_admin_credentials_issue_a_token(http):
    status, body = http("POST", "/api/auth/token",
                        body={"username": ADMIN_USER, "password": ADMIN_PASSWORD})
    assert status == 200
    assert body["role"] == "admin"


# --- token integrity --------------------------------------------------------

def _mint(**overrides) -> str:
    import jwt
    now = datetime.now(timezone.utc)
    claims = {"iss": auth.ISSUER, "aud": auth.AUDIENCE, "sub": AUTHORITY_USER,
              "role": "authority", "iat": int(now.timestamp()),
              "exp": int((now + timedelta(minutes=5)).timestamp()),
              "jti": uuid.uuid4().hex}
    key = overrides.pop("key", auth.signing_key())
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="HS256")


def test_no_token_is_rejected(http):
    status, body = http("GET", "/api/auth/whoami")
    assert status == 401
    assert body.get("error") == "not_authenticated"


def test_malformed_token_is_rejected(http):
    status, _ = http("GET", "/api/auth/whoami", token="not-a-jwt")
    assert status == 401


def test_token_signed_with_the_wrong_key_is_rejected(http):
    status, _ = http("GET", "/api/auth/whoami",
                     token=_mint(key="the-wrong-signing-key", sub="attacker"))
    assert status == 401


def test_expired_token_is_rejected_and_says_so(http):
    now = datetime.now(timezone.utc)
    token = _mint(iat=int((now - timedelta(hours=2)).timestamp()),
                  exp=int((now - timedelta(hours=1)).timestamp()))
    status, body = http("GET", "/api/auth/whoami", token=token)
    assert status == 401
    assert body.get("error") == "token_expired"


def test_token_for_a_different_audience_is_rejected(http):
    status, _ = http("GET", "/api/auth/whoami", token=_mint(aud="some-other-api"))
    assert status == 401


def test_token_from_a_different_issuer_is_rejected(http):
    status, _ = http("GET", "/api/auth/whoami", token=_mint(iss="somebody-else"))
    assert status == 401


def test_validly_signed_token_with_an_unknown_role_is_rejected(http):
    """Signature alone is not authorisation."""
    status, _ = http("GET", "/api/auth/whoami", token=_mint(role="superuser"))
    assert status == 401


def test_valid_token_identifies_the_subject(http, authority_token):
    status, body = http("GET", "/api/auth/whoami", token=authority_token)
    assert status == 200
    assert body["subject"] == AUTHORITY_USER
    assert body["role"] == "authority"
    assert body["verified"] is True


# --- separation of duties ---------------------------------------------------

def test_admin_cannot_decide_a_case(http, admin_token):
    status, body = http("POST", "/api/cases/deadbeef0000/decision",
                        token=admin_token,
                        body={"decision": "approve", "as_of": REPLAY_AT})
    assert status == 403
    assert body.get("required") == "case:decide"


def test_authority_cannot_upload_policy(http, authority_token):
    boundary = "----areepytest"
    payload = (f"--{boundary}\r\n"
               f'Content-Disposition: form-data; name="file"; filename="x.txt"\r\n'
               f"Content-Type: text/plain\r\n\r\npytest\r\n--{boundary}--\r\n").encode()
    status, body = http("POST", "/api/policy/upload", token=authority_token,
                        raw=payload,
                        content_type=f"multipart/form-data; boundary={boundary}")
    assert status == 403
    assert body.get("required") == "policy:write"


def test_policy_upload_requires_authentication(http):
    boundary = "----areepytest"
    payload = (f"--{boundary}\r\n"
               f'Content-Disposition: form-data; name="file"; filename="x.txt"\r\n'
               f"Content-Type: text/plain\r\n\r\npytest\r\n--{boundary}--\r\n").encode()
    status, _ = http("POST", "/api/policy/upload", raw=payload,
                     content_type=f"multipart/form-data; boundary={boundary}")
    assert status == 401


# --- identity cannot be injected -------------------------------------------

def test_the_body_cannot_name_the_actor(http, authority_token):
    """
    The adversarial case: a valid token, and a body that tries to be someone
    else AND to assert its own verification.
    """
    status, outlook = http("GET", f"/api/aree/outlook?at={REPLAY_AT}")
    assert status == 200
    case_id = outlook["decision"]["case_id"]
    assert case_id

    status, decided = http(
        "POST", f"/api/cases/{case_id}/decision", token=authority_token,
        body={"decision": "approve", "as_of": REPLAY_AT,
              "reason": "identity injection attempt",
              "actor": "Someone Else Entirely",
              "actor_role": "Chief Secretary",
              "actor_verified": True,
              "subject": "attacker", "role": "admin"})
    assert status == 200, decided

    status, stored = http("GET", f"/api/cases/{case_id}")
    action = stored["actions"][-1]
    assert action["actor"] == AUTHORITY_USER, (
        f"the body named the actor: {action['actor']!r}")
    assert action["actor_role"] == "authority", (
        f"the body injected a role: {action['actor_role']!r}")
    assert action["actor_verified"] is True
    assert decided["identity"]["subject"] == AUTHORITY_USER


# --- evidence is still recomputed server-side -------------------------------

def test_case_id_is_checked_against_recomputed_evidence(http, authority_token):
    """A decision cannot be attached to a moment other than its own."""
    status, outlook = http("GET", "/api/aree/outlook?at=2024-11-16T00:00:00Z")
    other_case = outlook["decision"]["case_id"]
    status, body = http("POST", f"/api/cases/{other_case}/decision",
                        token=authority_token,
                        body={"decision": "approve", "as_of": REPLAY_AT})
    assert status in (400, 409), f"mismatched evidence accepted: {status} {body}"


def test_unknown_case_is_404(http, authority_token):
    status, _ = http("POST", "/api/cases/000000000000/decision",
                     token=authority_token,
                     body={"decision": "approve", "reason": "no such case"})
    assert status == 404


def test_invalid_decision_verb_is_422(http, authority_token):
    status, _ = http("POST", "/api/cases/000000000000/decision",
                     token=authority_token,
                     body={"decision": "banana", "as_of": REPLAY_AT})
    assert status == 422


# --- configuration is discoverable without a token --------------------------

def test_auth_config_is_public_and_names_the_register(http):
    status, body = http("GET", "/api/auth/config")
    assert status == 200
    assert body["mode"] in ("configured", "demo-credentials")
    assert set(body["roles"]) == {"authority", "admin"}
    assert "case:decide" in body["roles"]["authority"]
    assert "policy:write" in body["roles"]["admin"]


def test_reading_cases_needs_no_token(http):
    """The GETs read and mint nothing; gating them would protect nothing."""
    status, _ = http("GET", "/api/cases")
    assert status == 200
