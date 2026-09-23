"""
Persistence for regulatory cases and the decisions taken on them.

WHAT THIS CLOSES
    The decision layer produced a case whose status was the string AWAITING_APPROVAL
    and then stopped. There was no row, no transition, no approver and no record, so
    "the system proposes, the authority disposes" described an intention rather than
    something the software could be shown doing. This module is the missing half.

THE STATE MACHINE, AND WHY IT IS THIS SMALL

        AWAITING_APPROVAL ──APPROVE──> APPROVED
                          └─REJECT──-> REJECTED

    Terminal on both sides. A decided case does not accept a second decision - a
    second POST is refused with the current state rather than silently overwriting
    it, because an audit trail whose last write wins is not an audit trail. Reopening
    is deliberately absent: it is a real workflow need and a real design question
    (who may reopen, on what grounds), and inventing an answer to it here would add
    surface without adding evidence.

WHAT IS RECORDED, AND WHAT IS HONESTLY NOT
    Recorded: the case, its trigger, the forecast moment it rests on, the full
    evidence snapshot, and every action with its actor and timestamp.

    NOT recorded, because it does not exist: a verified identity. This build has no
    authentication, so `actor` is whatever the caller typed. Every action row carries
    actor_verified = 0 to say so, and the API surfaces it. A demo that showed a name
    beside a regulatory decision without that caveat would be claiming an access
    control it does not have.

WHY THE EVIDENCE IS RE-COMPUTED AT DECISION TIME
    The caller does not send the evidence; the endpoint recomputes the assessment from
    the case's own forecast_as_of. Because that computation is deterministic, the
    snapshot stored against a decision is provably the evidence that existed when the
    decision was taken - not whatever the browser happened to be displaying. It also
    means a reviewer can re-run the same as_of months later and compare.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

AWAITING = "AWAITING_APPROVAL"
APPROVED = "APPROVED"
REJECTED = "REJECTED"

TERMINAL = (APPROVED, REJECTED)

# decision word from the caller -> (case status, action recorded)
DECISIONS: dict[str, tuple[str, str]] = {
    "approve": (APPROVED, "APPROVED"),
    "reject": (REJECTED, "REJECTED"),
}

# There is no auth in this build. These are the defaults the demo uses, and they are
# labelled as such everywhere they surface.
DEMO_ACTOR = "Demo Authority"
DEMO_ROLE = "Air Quality Officer"


class CaseConflict(RuntimeError):
    """A decision was attempted on a case that has already been decided."""

    def __init__(self, case_id: str, status: str):
        super().__init__(f"case {case_id} is already {status}")
        self.case_id = case_id
        self.status = status


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _row_to_case(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "case_id": row["case_id"],
        "created_at": row["created_at"],
        "status": row["status"],
        "risk_status": row["risk_status"],
        "priority": row["priority"],
        "trigger": row["trigger"],
        "jurisdiction": row["jurisdiction"],
        "mode": row["mode"],
        "forecast_as_of": row["forecast_as_of"],
        "crossing_at": row["crossing_at"],
        "snapshot": json.loads(row["recommendation_snapshot"]),
    }


def get(conn: sqlite3.Connection, case_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM cases WHERE case_id = ?", (case_id,)).fetchone()
    if row is None:
        return None
    case = _row_to_case(row)
    case["actions"] = actions(conn, case_id)
    return case


def status_of(conn: sqlite3.Connection, case_id: str | None) -> str | None:
    """The persisted status, or None when this case has never been written.

    Used by the outlook so a screen can show APPROVED for a decision already taken
    instead of re-offering the same case for approval on every reload.
    """
    if not case_id:
        return None
    row = conn.execute("SELECT status FROM cases WHERE case_id = ?",
                       (case_id,)).fetchone()
    return row["status"] if row else None


def actions(conn: sqlite3.Connection, case_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT action_id, action, actor, actor_role, actor_verified, timestamp, reason "
        "FROM case_actions WHERE case_id = ? ORDER BY action_id", (case_id,)).fetchall()
    return [
        {
            "action_id": r["action_id"],
            "action": r["action"],
            "actor": r["actor"],
            "actor_role": r["actor_role"],
            "actor_verified": bool(r["actor_verified"]),
            "timestamp": r["timestamp"],
            "reason": r["reason"],
        }
        for r in rows
    ]


def listing(conn: sqlite3.Connection, status: str | None = None,
            limit: int = 50) -> list[dict[str, Any]]:
    sql = "SELECT * FROM cases"
    params: list[Any] = []
    if status:
        sql += " WHERE status = ?"
        params.append(status)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    out = []
    for row in conn.execute(sql, params).fetchall():
        case = _row_to_case(row)
        acts = actions(conn, case["case_id"])
        decided = next((a for a in reversed(acts) if a["action"] in ("APPROVED", "REJECTED")),
                       None)
        case["decided_at"] = decided["timestamp"] if decided else None
        case["decided_by"] = decided["actor"] if decided else None
        # The listing does not carry the full snapshot: it is a queue, not a record.
        case.pop("snapshot", None)
        out.append(case)
    return out


def ensure_open(conn: sqlite3.Connection, case: dict[str, Any],
                mode: str) -> dict[str, Any]:
    """
    Write the case if it is not already there, and return the stored row.

    Idempotent by design: the id is deterministic, so opening the same decision point
    twice updates nothing and creates nothing. An already-DECIDED case is never
    reopened by this call - the snapshot of a decided case must stay as it was when
    it was decided.
    """
    existing = get(conn, case["case_id"])
    if existing is not None:
        return existing

    now = _iso(datetime.now(timezone.utc))
    evidence = case.get("evidence") or {}
    crossing = (evidence.get("collapse") or {}).get("onset")

    with conn:
        conn.execute(
            "INSERT INTO cases (case_id, created_at, status, risk_status, priority, "
            "trigger, jurisdiction, mode, forecast_as_of, crossing_at, "
            "recommendation_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                case["case_id"],
                now,
                AWAITING,
                case.get("risk_status"),
                case.get("priority"),
                case.get("trigger_rule"),
                case.get("jurisdiction"),
                mode,
                _iso(case.get("forecast_as_of")),
                _iso(crossing),
                json.dumps(case, default=str),
            ),
        )
        conn.execute(
            "INSERT INTO case_actions (case_id, action, actor, actor_role, "
            "actor_verified, timestamp, reason) VALUES (?,?,?,?,?,?,?)",
            (case["case_id"], "OPENED", "AREE decision engine", "system", 0, now,
             "Trigger conditions met: " + (case.get("trigger_rule") or "")),
        )
    return get(conn, case["case_id"])


def decide(conn: sqlite3.Connection, case_id: str, decision: str,
           actor: str | None, actor_role: str | None,
           reason: str | None, *, actor_verified: bool = False) -> dict[str, Any]:
    """
    Record an authority's decision. Raises CaseConflict if one is already recorded.

    The caller supplies only who and why. What the decision was TAKEN ON is the
    snapshot already stored against the case, so a decision cannot be attached to
    evidence other than the evidence that opened it.

    `actor_verified` is KEYWORD-ONLY and defaults to False.

    Both of those are deliberate. Keyword-only means no caller can set it by
    position while meaning something else, and defaulting to False means a caller
    that has not thought about identity records an unverified action rather than
    silently asserting a verified one. The only caller that passes True is the
    decision route, and only after `auth.requires("case:decide")` has produced a
    Principal from a signed token - never from anything in the request body.
    """
    case = get(conn, case_id)
    if case is None:
        raise KeyError(case_id)
    if case["status"] in TERMINAL:
        raise CaseConflict(case_id, case["status"])

    status, action = DECISIONS[decision]
    now = _iso(datetime.now(timezone.utc))

    with conn:
        conn.execute("UPDATE cases SET status = ? WHERE case_id = ?", (status, case_id))
        conn.execute(
            "INSERT INTO case_actions (case_id, action, actor, actor_role, "
            "actor_verified, timestamp, reason) VALUES (?,?,?,?,?,?,?)",
            (
                case_id,
                action,
                (actor or DEMO_ACTOR).strip()[:120] or DEMO_ACTOR,
                (actor_role or DEMO_ROLE).strip()[:120] or DEMO_ROLE,
                # 1 only when the caller established this identity from a verified
                # token. A self-declared name still writes 0, so the trail keeps
                # distinguishing "the server checked this" from "someone typed it".
                1 if actor_verified else 0,
                now,
                (reason or "").strip()[:500] or None,
            ),
        )
    return get(conn, case_id)
