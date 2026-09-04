"""Token issuance and identity introspection for the authority boundary."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import auth

router = APIRouter(tags=["auth"])


class TokenRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=512)


@router.post("/auth/token", summary="Exchange operator credentials for a token")
def token(body: TokenRequest) -> dict[str, Any]:
    """
    Issue a short-lived access token.

    The failure response is deliberately identical for an unknown user and a wrong
    password, and `authenticate()` verifies a hash either way so the two also take
    the same time. Distinguishing them turns this endpoint into a directory of
    valid operator names.
    """
    operator = auth.authenticate(body.username, body.password)
    if operator is None:
        raise HTTPException(
            status_code=401,
            detail={"error": "invalid_credentials",
                    "detail": "Username or password is incorrect."},
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token, expires_in = auth.issue_token(operator)
    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": expires_in,
        "subject": operator.username,
        "role": operator.role,
        "capabilities": sorted(auth.ROLE_CAPABILITIES[operator.role]),
    }


@router.get("/auth/whoami", summary="The identity the server derives from a token")
def whoami(principal: auth.Principal = Depends(auth.current_principal)) -> dict[str, Any]:
    """Echoes the token's claims as the server read them. Useful for verifying
    that identity comes from the token and not from anything a client sent."""
    return {
        "subject": principal.subject,
        "role": principal.role,
        "capabilities": sorted(principal.capabilities),
        "verified": True,
    }


@router.get("/auth/config", summary="How authority is configured on this instance")
def config() -> dict[str, Any]:
    """
    Unauthenticated on purpose: a client has to be able to discover how to
    authenticate before it holds a token, and this exposes no secret.

    `mode` distinguishes real configured operators from the randomly generated
    demo pair, so a screen can never present demo authority as if it were real.
    """
    demo = auth.is_demo_mode()
    return {
        "mode": "demo-credentials" if demo else "configured",
        "issuer": auth.ISSUER,
        "audience": auth.AUDIENCE,
        "algorithm": auth.ALGORITHM,
        "token_ttl_seconds": auth.TOKEN_TTL_SECONDS,
        "roles": {role: sorted(caps) for role, caps in auth.ROLE_CAPABILITIES.items()},
        "note": (
            "Demo credentials were generated at startup with random passwords and "
            "printed to the server log. They exist for this process only. Set "
            "AREE_OPERATORS to configure real operators."
            if demo else
            "Operators are configured server-side via AREE_OPERATORS."
        ),
    }
