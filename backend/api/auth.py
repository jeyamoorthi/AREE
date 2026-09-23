"""
The authority boundary.

WHAT THIS REPLACES
    Before this module, `POST /api/cases/{id}/decision` accepted a JSON body
    carrying `actor: "A. Sharma"` and wrote it into the audit trail. The system
    was honest about it - every stored action carried `actor_verified = 0` and the
    API said so - but honesty is not authorisation. Anyone who could reach the
    endpoint could record a regulatory approval under any name they liked.

    Identity now comes from a signed token that the server issued, and NOTHING
    else. The request body cannot influence who the actor is, and it cannot
    influence whether the actor is verified.

WHAT THIS IS, STATED PRECISELY
    A LOCAL token issuer using HS256, not an OIDC deployment. There is no
    external identity provider in this project, so nothing here has been verified
    against one, and this module does not claim otherwise. What it does provide is
    the shape that lets one be dropped in: every route depends on a `Principal`
    produced by a `TokenVerifier`, so replacing `LocalHS256Verifier` with an
    RS256/JWKS verifier against a real IdP is a change to this file alone.

    Claims are deliberately OIDC-shaped (iss, aud, sub, exp, iat, jti) so that
    swap does not become a claims migration.

WHY PyJWT AND NOT FIFTY LINES OF hmac
    Signature checking is the easy part. The parts that are easy to get subtly
    wrong are algorithm confusion (`alg: none`, HS256 verified against an RS256
    public key), constant-time comparison, and the exp/nbf/aud/iss checks that
    people forget. `algorithms=` is pinned to a single value here so a token
    cannot select its own verification algorithm.

SEPARATION OF DUTIES
    Roles map to capabilities, and no role holds both:

        authority  -> case:decide     regulatory decisions
        admin      -> policy:write    policy document management

    An administrator who can load the policy corpus should not also be able to
    approve escalations against it. The split is cheap to define now and
    expensive to retrofit after decisions exist in the audit trail.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Protocol

import jwt
from fastapi import Depends, HTTPException, Request

log = logging.getLogger("aree.auth")

ISSUER = "aree-local"
AUDIENCE = "aree-api"
ALGORITHM = "HS256"
TOKEN_TTL_SECONDS = 900          # 15 minutes; a decision takes seconds, not hours

# Capability sets. Kept as data rather than `if role == "admin"` scattered through
# the routes, so the full authorisation model is readable in one place.
ROLE_CAPABILITIES: dict[str, frozenset[str]] = {
    "authority": frozenset({"case:decide"}),
    "admin": frozenset({"policy:write"}),
}

PBKDF2_ITERATIONS = 480_000      # OWASP guidance for PBKDF2-HMAC-SHA256


@dataclass(frozen=True)
class Principal:
    """Who the server has established the caller to be. Never built from a body."""

    subject: str
    role: str
    capabilities: frozenset[str] = field(default_factory=frozenset)
    token_id: str = ""

    def can(self, capability: str) -> bool:
        return capability in self.capabilities


# --- password storage ------------------------------------------------------

def hash_password(password: str, *, salt: bytes | None = None) -> str:
    """PBKDF2-HMAC-SHA256, in a self-describing format so iterations can rise."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt,
                                 PBKDF2_ITERATIONS)
    return (f"pbkdf2_sha256${PBKDF2_ITERATIONS}"
            f"${base64.b64encode(salt).decode()}"
            f"${base64.b64encode(digest).decode()}")


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check. Returns False on any malformed record, never raises."""
    try:
        scheme, iterations, salt_b64, digest_b64 = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                     base64.b64decode(salt_b64), int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# --- the operator register -------------------------------------------------

@dataclass(frozen=True)
class Operator:
    username: str
    role: str
    password_hash: str


_operators: dict[str, Operator] | None = None
_demo_mode = False


def _parse_operators(raw: str) -> dict[str, Operator]:
    """
    AREE_OPERATORS format:  username:role:pbkdf2_hash;username:role:pbkdf2_hash

    Split on the FIRST two colons only, because a PBKDF2 record contains '$' but
    base64 may contain characters that a naive split would mangle.
    """
    out: dict[str, Operator] = {}
    for entry in raw.split(";"):
        entry = entry.strip()
        if not entry:
            continue
        parts = entry.split(":", 2)
        if len(parts) != 3:
            log.error("AREE_OPERATORS: ignoring malformed entry (expected "
                      "username:role:hash)")
            continue
        username, role, password_hash = parts
        if role not in ROLE_CAPABILITIES:
            log.error("AREE_OPERATORS: ignoring '%s', unknown role '%s' "
                      "(known: %s)", username, role,
                      ", ".join(sorted(ROLE_CAPABILITIES)))
            continue
        out[username] = Operator(username, role, password_hash)
    return out


def operators() -> dict[str, Operator]:
    """
    The configured operators, loaded once.

    WHEN AREE_OPERATORS IS UNSET
        Two demo operators are seeded with RANDOMLY GENERATED passwords, printed
        once to the startup log. Random rather than a default, because a shipped
        default password is a backdoor that travels with the image; and seeded
        rather than empty, because an unconfigured deployment that silently
        refuses every decision is indistinguishable from a broken one.

        This state is reported by GET /api/auth/config as mode "demo-credentials"
        so nothing has to guess whether it is looking at real authority.
    """
    global _operators, _demo_mode
    if _operators is not None:
        return _operators

    raw = os.getenv("AREE_OPERATORS", "").strip()
    if raw:
        _operators = _parse_operators(raw)
        _demo_mode = False
        log.info("auth: %d operator(s) loaded from AREE_OPERATORS",
                 len(_operators))
        return _operators

    _demo_mode = True
    _operators = {}
    for username, role in (("demo.authority", "authority"), ("demo.admin", "admin")):
        password = secrets.token_urlsafe(12)
        _operators[username] = Operator(username, role, hash_password(password))
        log.warning("auth: DEMO CREDENTIAL  %s / %s  (role=%s)",
                    username, password, role)
    log.warning("auth: AREE_OPERATORS is unset, so the two demo operators above "
                "were generated with random passwords for THIS PROCESS ONLY. "
                "Set AREE_OPERATORS to configure real ones.")
    return _operators


def is_demo_mode() -> bool:
    operators()
    return _demo_mode


def authenticate(username: str, password: str) -> Operator | None:
    """
    Check a username and password.

    A hash is verified even when the user does not exist, against a dummy record,
    so that a wrong username and a wrong password take the same time. Otherwise
    response timing enumerates valid usernames.
    """
    register = operators()
    operator = register.get(username)
    stored = operator.password_hash if operator else _DUMMY_HASH
    ok = verify_password(password, stored)
    return operator if (ok and operator) else None


_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


# --- signing key -----------------------------------------------------------

_secret: str | None = None


def signing_key() -> str:
    """
    The HS256 key.

    An unset AREE_JWT_SECRET yields a RANDOM per-process key rather than a baked-in
    default. The consequence is stated plainly: tokens stop working when the
    process restarts. That is a far better failure than every deployment of this
    image sharing one signing key that is readable in the source.
    """
    global _secret
    if _secret is None:
        configured = os.getenv("AREE_JWT_SECRET", "").strip()
        if configured:
            _secret = configured
        else:
            _secret = secrets.token_urlsafe(48)
            log.warning("auth: AREE_JWT_SECRET is unset; using a random key for "
                        "this process. Tokens will not survive a restart.")
    return _secret


# --- issuing and verifying -------------------------------------------------

def issue_token(operator: Operator) -> tuple[str, int]:
    """Mint a short-lived access token. Returns (token, expires_in_seconds)."""
    now = datetime.now(timezone.utc)
    claims = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": operator.username,
        "role": operator.role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=TOKEN_TTL_SECONDS)).timestamp()),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(claims, signing_key(), algorithm=ALGORITHM), TOKEN_TTL_SECONDS


class TokenVerifier(Protocol):
    """The seam an external OIDC provider slots into."""

    def verify(self, token: str) -> Principal: ...


class LocalHS256Verifier:
    """Verifies tokens minted by this process's issuer."""

    def verify(self, token: str) -> Principal:
        try:
            claims = jwt.decode(
                token,
                signing_key(),
                # Pinned to one algorithm. Without this a token could nominate its
                # own, which is the classic JWT forgery route.
                algorithms=[ALGORITHM],
                audience=AUDIENCE,
                issuer=ISSUER,
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            )
        except jwt.ExpiredSignatureError:
            raise _unauthorised("token_expired", "The access token has expired.")
        except jwt.InvalidTokenError as exc:
            raise _unauthorised("invalid_token", f"Token rejected: {exc}")

        role = claims.get("role", "")
        if role not in ROLE_CAPABILITIES:
            raise _unauthorised("invalid_token",
                                f"Token carries unknown role '{role}'.")
        return Principal(subject=claims["sub"], role=role,
                         capabilities=ROLE_CAPABILITIES[role],
                         token_id=claims.get("jti", ""))


_verifier: TokenVerifier = LocalHS256Verifier()


def verifier() -> TokenVerifier:
    return _verifier


# --- FastAPI wiring --------------------------------------------------------

def _unauthorised(error: str, detail: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={"error": error, "detail": detail,
                "hint": "Obtain a token from POST /api/auth/token and send it as "
                        "'Authorization: Bearer <token>'."},
        headers={"WWW-Authenticate": "Bearer"},
    )


def current_principal(request: Request) -> Principal:
    """
    The authenticated caller, or 401.

    The header is read from the raw request rather than through a body model, so
    there is no code path in which a request body can reach this function.
    """
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise _unauthorised("not_authenticated",
                            "This endpoint requires an access token.")
    return verifier().verify(token.strip())


def requires(capability: str):
    """Dependency factory: 401 without a token, 403 with the wrong one."""

    def _dependency(principal: Principal = Depends(current_principal)) -> Principal:
        if not principal.can(capability):
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "insufficient_capability",
                    "detail": (f"Role '{principal.role}' cannot perform "
                               f"'{capability}'."),
                    "required": capability,
                    "held": sorted(principal.capabilities),
                },
            )
        return principal

    return _dependency
