"""
Case management: the human-authority half of the decision chain.

    GET  /api/cases                    the queue
    GET  /api/cases/{case_id}          one case, with its full action history
    POST /api/cases/{case_id}/decision approve or reject

WHY THE DECISION ENDPOINT RECOMPUTES RATHER THAN TRUSTING THE CALLER
    The body carries only who decided and why. The evidence is not accepted from the
    client and is not read from the screen: the case already holds the snapshot it
    was opened with, and that snapshot came from a deterministic recomputation of the
    forecast moment. A reviewer months later can re-run the same `as_of` and compare.

    This is the difference between an audit trail and a log of what a browser said.

WHY GET STAYS PURE
    A case is opened by the decision endpoint (create-or-update on a deterministic id),
    never as a side effect of viewing the outlook. Reloading a page must not mint
    regulatory records.

AUTHORITY
    The decision endpoint requires a verified access token carrying the
    `case:decide` capability. The actor written into the audit trail is the token
    subject; `actor` in the request body is accepted for backwards compatibility
    and ignored. Actions recorded this way carry actor_verified = true, and a
    client has no path to that flag.

    The two GETs are deliberately left open. They read; they mint nothing. Putting
    a token in front of viewing the queue would not protect anything that writing
    is not already protecting.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ...backfill import db
from .. import auth
from ...streaming import case_store as cs

router = APIRouter(tags=["cases"])


class DecisionRequest(BaseModel):
    decision: str = Field(..., description="approve | reject")
    #: The forecast moment the case rests on, ISO-8601. The server recomputes the
    #: assessment from this and checks that the derived case id matches the path, so a
    #: decision cannot be attached to a moment other than the one it was raised for.
    #: Omit for a case already opened.
    as_of: Optional[str] = Field(None, description="ISO-8601 forecast moment")
    actor: Optional[str] = Field(None, description="Who is deciding. Self-declared.")
    actor_role: Optional[str] = None
    reason: Optional[str] = Field(None, description="Why. Recorded verbatim.")


def _recompute(conn, as_of_raw: str) -> dict[str, Any]:
    """Re-derive the assessment for a moment, using the outlook's own function.

    Imported inside the call rather than at module scope: routes/__init__ imports both
    modules, and a top-level import here would make the two files circular.
    """
    from datetime import datetime, timezone
    from . import outlook

    try:
        moment = datetime.fromisoformat(as_of_raw.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_timestamp",
                    "detail": f"{as_of_raw!r} is not an ISO-8601 timestamp."})
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    # DELIBERATELY the uncached `compute`, not `compute_cached`.
    #
    # This is the call that decides what an approval is recorded against. A cached
    # value is a claim that nothing relevant changed; an audit trail should not
    # rest on that claim when the cost of being certain is one recomputation on a
    # rare POST. Correctness over performance, and the trail is where it matters
    # most. Do not "optimise" this to the cached path.
    return outlook.compute(conn, moment)


def _identity_notice(principal: auth.Principal | None = None) -> dict[str, Any]:
    """
    Who the server established the caller to be.

    Reported on every decision response so a screen never has to infer whether the
    name attached to a regulatory action was checked. When the instance is running
    on generated demo credentials that is said here too - a verified identity from
    a demo operator is genuinely verified, but the operator register is not real,
    and those are different claims.
    """
    if principal is None:
        return {
            "authenticated": False,
            "note": ("Unauthenticated. Any actor would be self-declared and the "
                     "recorded action would carry actor_verified = false."),
        }
    return {
        "authenticated": True,
        "subject": principal.subject,
        "role": principal.role,
        "capabilities": sorted(principal.capabilities),
        "operator_register": "demo-credentials" if auth.is_demo_mode() else "configured",
        "note": ("Identity was taken from a verified access token; the request "
                 "body cannot influence it. This action is recorded with "
                 "actor_verified = true."
                 + (" NOTE: this instance is running on demo operators generated "
                    "at startup, so the identity is verified but the register is "
                    "not a real one." if auth.is_demo_mode() else "")),
    }


@router.get("/cases", summary="Case queue, newest first")
def list_cases(status: Optional[str] = Query(
                   None, description="AWAITING_APPROVAL | APPROVED | REJECTED"),
               limit: int = Query(50, ge=1, le=200)) -> dict[str, Any]:
    if status and status not in (cs.AWAITING, cs.APPROVED, cs.REJECTED):
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_status", "detail": f"Unknown status {status!r}.",
                    "valid": [cs.AWAITING, cs.APPROVED, cs.REJECTED]})

    conn = db.connect()
    try:
        cases = cs.listing(conn, status=status, limit=limit)
        counts = {s: 0 for s in (cs.AWAITING, cs.APPROVED, cs.REJECTED)}
        for row in conn.execute("SELECT status, COUNT(*) n FROM cases GROUP BY status"):
            counts[row["status"]] = row["n"]
        return {"total": sum(counts.values()), "counts": counts, "cases": cases,
                "identity": _identity_notice()}
    finally:
        conn.close()


@router.get("/cases/{case_id}", summary="One case with its full action history")
def get_case(case_id: str) -> dict[str, Any]:
    conn = db.connect()
    try:
        case = cs.get(conn, case_id)
        if case is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "case_not_found",
                        "detail": f"No case {case_id}.",
                        "hint": "A case exists once its decision point has been "
                                "opened. Call GET /api/cases for the queue."})
        case["identity"] = _identity_notice()
        return case
    finally:
        conn.close()


@router.post("/cases/{case_id}/decision",
             summary="Record an authority's approval or rejection")
def decide(case_id: str, body: DecisionRequest,
           principal: auth.Principal = Depends(auth.requires("case:decide"))
           ) -> dict[str, Any]:
    """
    Record a decision against a case.

    IDENTITY COMES FROM THE TOKEN, AND ONLY FROM THE TOKEN.
        `principal` is produced by verifying a signed token before this function
        runs. `body.actor` and `body.actor_role` are accepted by the schema for
        backwards compatibility and are then IGNORED - what lands in the audit
        trail is `principal.subject` and `principal.role`. A client cannot name
        the actor, and it has no way to reach `actor_verified` at all.

        The request body is therefore untrusted for identity while remaining
        trusted for intent (approve/reject, the reason, and which moment to
        recompute) - and even the moment is only used to RE-DERIVE evidence the
        server computes for itself.
    """
    decision = (body.decision or "").strip().lower()
    if decision not in cs.DECISIONS:
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_decision",
                    "detail": f"{body.decision!r} is not a decision.",
                    "valid": sorted(cs.DECISIONS)})

    conn = db.connect()
    try:
        # OPEN-ON-DEMAND, FROM RECOMPUTED EVIDENCE.
        #
        # Viewing an outlook does not write a case, so the first decision on a moment
        # has nothing to update. Rather than have the client post the evidence, the
        # server re-derives the whole assessment from `as_of` and only accepts it if
        # the case id that falls out matches the one in the path. A caller therefore
        # cannot approve case X while supplying the evidence of case Y.
        if cs.get(conn, case_id) is None and body.as_of:
            core = _recompute(conn, body.as_of)
            case = core["case"]
            if case is None:
                raise HTTPException(
                    status_code=409,
                    detail={"error": "no_case_at_that_moment",
                            "detail": (f"The assessment for {body.as_of} does not "
                                       f"trigger a case, so there is nothing to "
                                       f"approve.")})
            if case["case_id"] != case_id:
                raise HTTPException(
                    status_code=400,
                    detail={"error": "case_id_mismatch",
                            "detail": ("The recomputed assessment for that moment "
                                       "produces a different case id."),
                            "expected": case["case_id"], "received": case_id})
            cs.ensure_open(conn, case, core["mode"])

        try:
            case = cs.decide(conn, case_id, decision,
                             principal.subject, principal.role, body.reason,
                             actor_verified=True)
        except KeyError:
            raise HTTPException(
                status_code=404,
                detail={"error": "case_not_found",
                        "detail": f"No case {case_id}.",
                        "hint": "Send `as_of` so the case can be opened from a "
                                "recomputed assessment."})
        except cs.CaseConflict as exc:
            # A decided case is terminal. Refusing beats silently overwriting: an
            # audit trail whose last write wins is not an audit trail.
            raise HTTPException(
                status_code=409,
                detail={"error": "already_decided",
                        "detail": f"Case {case_id} is already {exc.status}.",
                        "status": exc.status,
                        "hint": "A decision is final in this build. The history is "
                                "at GET /api/cases/{case_id}."}) from exc

        case["identity"] = _identity_notice(principal)
        return case
    finally:
        conn.close()
