"""
The protected baseline.

3,274 fields across three replay moments. Every optimisation, refactor and
cleanup in this repository has been required to leave them byte-identical, and
this is the file that enforces it.

WHAT IT WOULD CATCH
    A bounded query that changed which observations reach the model. A cache that
    served a stale answer. A "harmless" default that altered an assessment. Each
    of those has been attempted in this project; the baseline is why none of them
    shipped.

WHAT IT DELIBERATELY IGNORES
    `assessed_at`, `opened_at`, `generated_at` — wall-clock stamps recording WHEN
    the answer was computed, not what it says. They are excluded by name, and the
    committed baseline does not store them at all. The first version of this
    comparison reported a regression because it diffed them; the fix was to name
    them, not to loosen the comparison until it passed.

Regenerate deliberately, never to make a red test green:
    python -m backend.tests.build_fixture_db     # if the store slice changed
    # then re-emit backend/tests/golden/*.json and REVIEW THE DIFF
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from .conftest import REPLAY_CASES, flatten, strip_wallclock


def _compute(as_of_iso: str) -> dict:
    from backend.api.routes import outlook as outlook_route
    from backend.backfill import db

    moment = datetime.fromisoformat(as_of_iso.replace("Z", "+00:00"))
    # The UNCACHED path: the baseline must describe what the engine computes,
    # not what a cache happened to retain.
    core = outlook_route.compute(db.connect(), moment)
    payload = {
        "as_of": str(core["as_of"]),
        "mode": core["mode"],
        "series": core["forecast"]["series"],
        "observed_now": core["forecast"]["observed_now"],
        "summary": core["forecast"]["summary"],
        "provenance": core["forecast"]["provenance"],
        "ventilation": core["ventilation"],
        "assessment": core["assessment"],
        "case": core["case"],
    }
    return strip_wallclock(json.loads(json.dumps(payload, default=str)))


@pytest.mark.parametrize("name,as_of", sorted(REPLAY_CASES.items()))
def test_replay_matches_baseline(fixture_db, golden, name, as_of):
    current = dict(flatten(_compute(as_of)))
    expected = golden[name]

    missing = sorted(set(expected) - set(current))
    added = sorted(set(current) - set(expected))
    changed = sorted(f for f in set(current) & set(expected)
                     if current[f] != expected[f])

    detail = []
    if missing:
        detail.append(f"{len(missing)} field(s) disappeared: {missing[:5]}")
    if added:
        detail.append(f"{len(added)} new field(s): {added[:5]}")
    for field in changed[:8]:
        detail.append(f"{field}: baseline={expected[field]!r} now={current[field]!r}")

    assert not (missing or added or changed), (
        f"{name} diverged from the protected baseline in "
        f"{len(missing) + len(added) + len(changed)} field(s):\n  "
        + "\n  ".join(detail))


def test_baseline_covers_the_whole_payload(golden):
    """Guards the guard: a truncated baseline would pass while proving nothing."""
    total = sum(len(fields) for fields in golden.values())
    assert total == 3274, (
        f"the baseline covers {total} fields, expected 3274. If this changed "
        f"deliberately, review the diff and update this number in the same "
        f"commit — do not adjust it to silence a failure.")


@pytest.mark.parametrize("name,as_of", sorted(REPLAY_CASES.items()))
def test_replay_is_deterministic(fixture_db, name, as_of):
    """Same moment, twice, same answer. Determinism is the replay's whole claim."""
    first = dict(flatten(_compute(as_of)))
    second = dict(flatten(_compute(as_of)))
    differing = [f for f in set(first) | set(second) if first.get(f) != second.get(f)]
    assert not differing, f"{name} is not deterministic; {differing[:5]} moved"
